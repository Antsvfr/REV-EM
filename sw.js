/* ============================================================================
   sw.js — le service worker de REV-EM
   ----------------------------------------------------------------------------
   Trois travaux, et rien de plus :
     1. précharger l'app shell pour qu'elle s'ouvre hors ligne ;
     2. servir chaque requête selon une stratégie qui dépend de CE QU'ELLE EST
        (une page, un module applicatif, une police, une donnée) ;
     3. faire savoir qu'une nouvelle version existe, sans jamais l'imposer.

   Ce fichier ne connaît ni `state`, ni le DOM — comme les moteurs purs du
   projet (`smart-revision.js`, `command-center.js`…), il tourne dans son
   propre contexte d'exécution, séparé de la page. Voir PWA.md pour le
   pourquoi de chaque choix.
   ========================================================================== */
"use strict";

/* Changer ce nom à chaque évolution du contenu précaché force la création
   d'un nouveau cache ; l'ancien est supprimé à l'activation (voir plus bas).
   Ce n'est PAS ce qui garantit que index.html reste à jour — voir la
   stratégie « réseau d'abord » plus bas, qui s'en charge sans dépendre d'un
   humain qui penserait à incrémenter ce numéro à chaque déploiement. */
const CACHE_VERSION = "rev-em-v14";
const SHELL_CACHE = CACHE_VERSION + "-shell";
const RUNTIME_CACHE = CACHE_VERSION + "-runtime";

/* Dépendances LOURDES du moteur mathématique (vendor/ : Pyodide + SymPy ≈ 19 Mo, KaTeX). Elles ne sont JAMAIS préchargées à
   l'installation (le préchargement est « tout ou rien » et pèserait sur chaque installation) : elles entrent dans ce cache
   à leur première utilisation réelle, puis sont servies cache d'abord — hors ligne compris. Nom VOLONTAIREMENT indépendant de
   CACHE_VERSION : monter la version de l'app ne doit pas re-télécharger 19 Mo. Le nom des fichiers vendor/ porte déjà leur version ;
   changer de version d'une dépendance = changer MATH_CACHE (voir vendor/README.md). */
const MATH_CACHE = "rev-em-math-v1";

/* L'app shell : tout ce qu'il faut pour que l'application s'OUVRE hors
   ligne. Chaque chemin est relatif — jamais de "/" en tête — pour rester
   correct qu'on serve depuis la racine d'un domaine ou depuis un sous-chemin
   de projet (github.io/REV-EM/). `self.registration.scope` donne la racine
   réelle du service worker, quel que soit le déploiement. */
const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./auth.js",
  "./translations.js",
  "./smart-revision.js",
  "./statistics.js",
  "./planning.js",
  "./content-sources.js",
  "./sync-engine.js",
  "./source-adapters.js",
  "./user-data.js",
  "./command-center.js",
  "./quick-actions.js",
  "./subject-search.js",
  "./ai-engine.js",
  "./knowledge-engine.js",
  "./output-processor.js",
  "./assistant-core.js",
  "./import-center.js",
  "./course-hub.js",
  "./connected-apps.js",
  "./revision-bank.js",
  "./math-core.js",
  "./math-fast.js",
  "./math-verify.js",
  "./math-engine.js",
  "./math-tutor.js",
  "./math-cas-client.js",
  "./math-cas-worker.js",
  "./math-cas.py",
  "./ai-knowledge/index.json",
  "./ai-knowledge/topics.json",
  "./ai-knowledge/finance/npv.json",
  "./ai-knowledge/finance/irr.json",
  "./ai-knowledge/finance/bond-interest-rates.json",
  "./ai-knowledge/economics/inflation.json",
  "./ai-knowledge/statistics/normal-distribution.json",
  "./ai-host.js",
  "./ai-worker.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

/* `supabase-config.js` n'est PAS dans SHELL_URLS : il est absent des dépôts
   qui n'ont pas encore configuré Supabase (voir SETUP_SUPABASE.md), et un
   `cache.addAll()` échoue en bloc si UNE SEULE requête échoue. On le
   précharge séparément, en best-effort, pour ne jamais faire échouer
   l'installation entière à cause d'un fichier optionnel. */
const OPTIONAL_SHELL_URLS = ["./supabase-config.js"];

/* Ressources tierces qu'on accepte de mettre en cache : des polices et le
   SDK Supabase, statiques et peu changeants. Tout le reste (les imports
   différés de pdf.js/mammoth/WebLLM, potentiellement volumineux et déjà
   gérés par leur propre cache — voir `ai-system` et `course-library-import`)
   n'est délibérément PAS intercepté : moins de surface, moins de risque de
   servir une version bloquée d'une dépendance lourde. */
const THIRDPARTY_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

/* ── INSTALL ────────────────────────────────────────────────────────────── */
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_URLS);
    await Promise.all(
      OPTIONAL_SHELL_URLS.map((url) =>
        cache.add(url).catch(() => { /* absent chez qui n'a pas configuré Supabase : normal */ })
      )
    );
  })());
  /* Ne PAS appeler self.skipWaiting() ici : un nouveau service worker installé
     reste "en attente" tant que des onglets utilisent l'ancien. C'est
     exactement ce qui permet à index.html de proposer la mise à jour au
     moment choisi par l'utilisateur plutôt que de la lui imposer pendant
     qu'il révise (voir PWA.md « Mise à jour »). */
});

/* ── ACTIVATE ───────────────────────────────────────────────────────────── */
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE && k !== MATH_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* Le worker écoute un seul message : "prends le contrôle maintenant". Envoyé
   par index.html quand l'utilisateur clique "Recharger" sur la bannière de
   mise à jour — jamais automatiquement. */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ── STRATÉGIES ─────────────────────────────────────────────────────────── */

/* Réseau d'abord, cache en secours. Utilisée pour la NAVIGATION (index.html
   lui-même) : c'est ce qui garantit qu'un utilisateur en ligne reçoit
   TOUJOURS la version la plus récente de la page — sans dépendre d'une
   invalidation de cache bien faite côté service worker. Le cache ne sert que
   quand le réseau échoue réellement (hors ligne, ou coupure). */
async function networkFirst(request){
  try{
    const fresh = await fetch(request);
    if(fresh && fresh.ok){
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  }catch(err){
    const cached = await caches.match(request, { ignoreSearch: true });
    if(cached) return cached;
    /* Ni réseau, ni cache : le cas d'un tout premier chargement hors ligne,
       qui n'a donc jamais pu précharger quoi que ce soit. Rien à inventer. */
    throw err;
  }
}

/* Cache d'abord, réseau en tâche de fond pour la PROCHAINE visite. Utilisée
   pour les modules applicatifs, les polices, les icônes : rapide à servir,
   et jamais périmée plus d'une session — la prochaine ouverture aura déjà la
   version fraîche récupérée pendant que celle-ci tournait. */
async function staleWhileRevalidate(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((fresh) => {
    if(fresh && (fresh.ok || fresh.type === "opaque")) cache.put(request, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

/* Cache d'abord, sans revalidation : pour des fichiers dont la version est dans leur nom (vendor/). Seules les réponses 200 entrent dans le cache. */
async function cacheFirst(request, cacheName){
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if(cached) return cached;
  const fresh = await fetch(request);
  if(fresh && fresh.status === 200) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /* Seules les lectures sont concernées. Une écriture (POST/PATCH/DELETE —
     Supabase, entre autres) passe toujours en direct : jamais de version en
     cache d'une mutation, et jamais d'interférence avec l'authentification. */
  if(request.method !== "GET") return;

  const url = new URL(request.url);

  /* Le projet Supabase : jamais intercepté. Les données d'un compte doivent
     toujours venir du réseau — les servir depuis un cache violerait la
     règle « aucune donnée d'un utilisateur visible par un autre appareil
     dans un état périmé », et la panne réseau est déjà gérée proprement côté
     application (voir user-data.js : échec silencieux, nouvelle tentative à
     la reconnexion — jamais une exception qui casse l'écran). */
  if(/\.supabase\.co$/.test(url.hostname)) return;

  /* La page elle-même : réseau d'abord. `mode: "navigate"` couvre toute
     navigation réelle — adresse tapée, lien cliqué, retour d'un lien reçu
     par e-mail avec ses paramètres de confirmation en requête. */
  if(request.mode === "navigate"){
    event.respondWith(networkFirst(request));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const allowedThirdParty = THIRDPARTY_HOSTS.includes(url.hostname);

  /* Les modules JavaScript de l'application : réseau d'abord, comme la page
     qui les charge. Ils dépendent les uns des autres (index.html ↔
     user-data.js…) : servir un ancien module à côté d'une page neuve casse
     le contrat entre les deux. Hors ligne, le cache reprend la main. */
  /* vendor/ (Pyodide, SymPy, KaTeX) : cache d'abord dans MATH_CACHE (voir plus haut). Testé AVANT la règle « .js » : vendor/katex/katex.min.js
     est un .js mais ne doit PAS être re-téléchargé à chaque visite. */
  if(sameOrigin && /\/vendor\//.test(url.pathname)){
    event.respondWith(cacheFirst(request, MATH_CACHE));
    return;
  }

  if(sameOrigin && /\.(js|py)$/.test(url.pathname)){
    event.respondWith(networkFirst(request));
    return;
  }

  if(sameOrigin || allowedThirdParty){
    event.respondWith(staleWhileRevalidate(request, sameOrigin ? SHELL_CACHE : RUNTIME_CACHE));
    return;
  }

  /* Tout le reste (imports différés esm.run, requêtes non prévues) : on ne
     répond pas, le navigateur traite la requête normalement, sans passer par
     ce service worker. Une absence de `respondWith` n'est jamais une erreur. */
});
