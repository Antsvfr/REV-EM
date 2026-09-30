# Assistant IA local — audit, cause racine, nouvelle architecture

Ce document répond à l'audit demandé avant toute modification (partie A) et
décrit ce qui a été construit ensuite. **Chaque affirmation est étiquetée** :

| Étiquette | Sens |
|---|---|
| **PASS** | vérifié pour de vrai dans l'environnement de développement |
| **PASS MOCK** | vérifié contre un double (faux GPU, faux WebLLM, faux stockage) — la logique est prouvée, pas le matériel |
| **NOT TESTED GPU** | exige un vrai GPU : non vérifiable dans l'environnement de développement |
| **NOT TESTED WKWEBVIEW** | exige le vrai `REV-EM.app` (macOS) |

Rien ci-dessous ne dit « ça marche sur ton Mac » : **seule une initialisation
réellement réussie chez toi le prouve** (voir le protocole de test manuel en fin
de document).

## 1. Ce que l'audit a trouvé (avant tout changement)

| # | Question | Réponse | Preuve |
|---|---|---|---|
| 1 | Modèle actuel | Llama 3.2 3B (`large`, choisi par défaut sur un ordinateur récent) ou 1B (`small`) | `AI_MODELS`, `pickModelForDevice()` (index.html, avant) — PASS (lecture du code) |
| 2 | `model_id` exacts | `Llama-3.2-1B-Instruct-q4f16_1-MLC`, `Llama-3.2-3B-Instruct-q4f16_1-MLC` | idem |
| 3 | Version de WebLLM réellement chargée | **Non déterminée : aucune.** `import("https://esm.run/@mlc-ai/web-llm")` (page) et `import … from "https://esm.run/@mlc-ai/web-llm"` (worker) n'avaient **pas de version** → le CDN sert « la dernière ». Au jour de l'audit, le registre npm annonce **0.2.85** (publiée le 2026-09-08) | `npm view @mlc-ai/web-llm` — PASS. Ce que le CDN sert *à cet instant chez toi* : **NOT TESTED** (le CDN est injoignable depuis l'environnement de développement) |
| 4 | Où vit la liste des modèles | Deux tables écrites à la main dans index.html (`AI_MODELS`) ; jamais confrontées au `model_list` de WebLLM | lecture du code |
| 5 | Init du moteur dans le worker | `ai-worker.js` = 23 lignes, `WebWorkerMLCEngineHandler` de WebLLM. Toute la logique était dans la page (`CreateWebWorkerMLCEngine`) | lecture du code |
| 6 | Dialogue page ↔ worker | Protocole **interne de WebLLM** (`reload`, `chatCompletionStreamInit`, `completionStreamNextChunk`…) : opaque, non contrôlé par REV-EM | lecture de WebLLM 0.2.85 |
| 7 | Pourquoi WebGPU est détecté mais l'init échoue | Voir §2 : le diagnostic ne teste ni `shader-f16`, ni les limites, ni **WebGPU côté worker**, et l'échec réel était **masqué** | §2 |
| 8 | Problème propre à WebKit/WKWebView ? | **Non établi.** Plusieurs hypothèses plausibles (§3), aucune prouvable sans le vrai `REV-EM.app` | **NOT TESTED WKWEBVIEW** |
| 9 | Incompatibilité `model_id` / version | **Écartée pour les modèles actuels** : les deux `model_id` existent dans le `model_list` de 0.2.79 *et* 0.2.85 | script sur les paquets npm — PASS |
| 10 | Cache ancien corrompu | Possible, non prouvable à distance. Le bouton existant était fonctionnellement correct (mêmes noms `webllm/…`) mais imparfait (§5) | lecture du code |
| 11 | Plusieurs moteurs chargés par accident | Risque réel : `aiTeardownEngine()` faisait `worker.terminate()` **sans `unload()`** ; aucun garde contre un changement de modèle pendant une génération | lecture du code |
| 12 | Init concurrentes | Garde partiel (`state.aiStatus === "loading"`) mais pas d'état côté moteur | lecture du code |
| 13 | Message `postMessage` malformé | Aucun élément dans le code ne le suggère | lecture du code |
| 14 | Le modèle correspond-il au `model_list` de la version ? | **Oui** pour 0.2.79 et 0.2.85 | idem 9 |

Hypothèse écartée avec preuve : `Phi-4-mini-instruct-q4f16_1-MLC` **n'existe pas
dans 0.2.79** (il apparaît dans 0.2.85). Un CDN « latest » qui reculerait
casserait donc le palier Avancé : c'est l'une des raisons de l'épinglage.

## 2. Cause racine identifiée

### 2.1 Ce qui est **prouvé** (PASS, lecture du code de WebLLM 0.2.85 + test)

> **« Erreur inconnue pendant l'initialisation » est fabriqué par REV-EM lui-même : le vrai message d'erreur était jeté.**

- Dans WebLLM, `WebWorkerMLCEngineHandler.handleTask` fait
  `content: err.toString()` — l'erreur est transformée en **chaîne**.
- Côté page, `getPromise` fait `reject(msg.content)` : la promesse est rejetée
  avec une **chaîne**, pas un `Error`.
- L'ancien `buildAiDiagnostic("engine_init", raw)` lisait
  `raw && raw.message ? raw.message : "Erreur inconnue pendant l'initialisation."`.
  Une chaîne n'a pas de propriété `.message` → **toujours** « Erreur inconnue ».

C'est exactement le texte que tu voyais (« Étape : Pendant l'initialisation du
moteur… / Type : Le modèle n'a pas pu être initialisé / Détail : Erreur inconnue
pendant l'initialisation. »). Le vrai motif (limite GPU, mémoire, cache,
`shader-f16`…) existait, dans la chaîne, et n'était jamais affiché. Test :
`tests/ai-engine.test.js` (« la CAUSE RACINE ») et `tests/ai-integration.test.mjs`
scénario 5b — **PASS / PASS MOCK**.

Conséquence : **je ne peux pas te dire, sans ta machine, *pourquoi* l'init
échoue dans le WKWebView** — seulement que l'ancien code ne pouvait pas te le
dire non plus. La nouvelle version le dit (détail technique + code interne +
diagnostic copiable).

### 2.2 Défauts réels supplémentaires (PASS, lecture du code)

1. **Version non épinglée** (page et worker résolvaient séparément la « dernière »).
2. **`shader-f16` jamais vérifié.** Les entrées `q4f16_1` de ces trois familles
   ne déclarent **pas** `required_features` dans le `model_list` (vérifié) :
   WebLLM n'avertit donc pas quand l'adaptateur n'a pas `shader-f16`, et l'échec
   arrive plus tard, à la compilation des shaders — sous forme d'un message que
   l'ancien code jetait. Les variantes `q4f32_1` existent pour les trois paliers.
3. **Périphérique GPU de test jamais détruit** : `checkWebGPUCompatibility`
   appelait `adapter.requestDevice()` puis laissait le périphérique ouvert à côté
   de celui de WebLLM.
4. **WebGPU jamais testé dans le worker.** Le diagnostic de la page ne prouve rien
   sur le contexte du worker. Or WebLLM y appelle `navigator.gpu`.
5. **`engine.reload()` retourne sans erreur quand le chargement est interrompu**
   (`if error is AbortError → return`). « la promesse s'est résolue » ≠ « prêt ».
6. **Import statique du CDN en tête de `ai-worker.js`** : un échec réseau tuait le
   worker entier sans message exploitable (`worker.onerror` vide).
7. **Pas de plafond de sortie ni de compactage** : tout `state.aiThread` était
   renvoyé à chaque tour, avec une fenêtre de contexte de **4096 jetons**.
8. **Re-rendu complet de l'application à chaque message de progression.**
9. **Aucun premier jeton vérifié** avant d'annoncer « prêt ».
10. **`aiChangeModel` pendant une génération** terminait le worker en pleine
    génération (course sur le GPU).

## 3. Hypothèses WKWebView — à vérifier chez toi (NOT TESTED WKWEBVIEW)

Aucune n'est affirmée. Le nouveau diagnostic permet de les départager :

| Hypothèse | Comment le diagnostic la révèle | Réponse du code |
|---|---|---|
| WebGPU absent **dans le Worker** de WKWebView (présent dans la page) | ligne « WebGPU (worker) : non » ; code `WEBGPU_UNAVAILABLE` venant du worker | **relance automatique sur le fil principal** (mode compatibilité), même protocole |
| `shader-f16` absent (Safari/WebKit) | ligne « shader-f16 : non » | variante `q4f32_1` choisie d'office |
| Limites de tampon WebKit plus basses | ligne « Limites : maxBufferSize=…, maxStorageBufferBindingSize=… » ; code `OUT_OF_MEMORY_OR_RESOURCE_LIMIT` | repli sur un palier plus léger |
| Cache API refusé / quota (`WKWebsiteDataStore` non persistant) | code `MODEL_CACHE_CORRUPTED`, message `Quota…`/`Cache…` | 2ᵉ essai avec `cacheBackend: "indexeddb"` |
| Le worker ne démarre pas (module/import) | `WORKER_READY` jamais reçu (10 s) | mode compatibilité |

Ce sont des **stratégies conditionnées à une preuve mesurée**, pas un contournement
systématique : Chrome n'est pas concerné (le worker a WebGPU → aucun changement).

### ACTION MANUELLE XCODE REQUISE ? — **Aucune établie.**
Je n'ai trouvé aucun élément prouvant qu'un réglage natif soit nécessaire, et je
n'ai **pas** modifié (ni inventé) le projet Xcode. Si, après test, le diagnostic
montrait `shader-f16 : non` ou `WebGPU (worker) : non` **et** que le mode
compatibilité échouait aussi, il faudrait alors regarder côté natif — mais rien ne
permet aujourd'hui de nommer un entitlement, un fichier Swift ou une propriété de
`WKWebViewConfiguration`. Ne pas en inventer.

## 4. Architecture — avant / après

**Avant** : `index.html` importait WebLLM (~6,5 Mo à analyser sur le fil principal)
et pilotait `CreateWebWorkerMLCEngine`; `ai-worker.js` = le handler WebLLM brut.
Erreurs perdues, deux modèles Llama au choix, aucune mémoire, aucun repli.

**Après**

```
index.html (ModelManager, UI)        ai-engine.js  (moteur PUR : paliers, codes d'erreur,
   │  postMessage (protocole REV-EM)   machine d'états, mémoire, prompts, diagnostic)
   ▼                                          ▲ partagé (page + hôte)
ai-worker.js ──► ai-host.js ──► WebLLM 0.2.85 (import dynamique, épinglé)
   (branchement)   (UN moteur, UNE machine d'états, erreurs classées)
```

Le même hôte peut tourner **sur le fil principal** (mode compatibilité) : seul le
transport change.

### Protocole (page → hôte)
`INIT_MODEL`, `SWITCH_MODEL`, `GENERATE`, `ABORT`, `RESET_AI_CACHE`, `GET_STATUS`.
(hôte → page) `MODEL_DOWNLOAD_PROGRESS`, `MODEL_INITIALIZING`, `MODEL_READY`,
`MODEL_ERROR`, `GENERATION_TOKEN`, `GENERATION_COMPLETE`, `DEVICE_LOST`, plus
`WORKER_READY`, `GENERATION_ERROR`, `STATUS`, `CACHE_RESET_DONE`, `WORKER_ERROR`
(ajoutés : poignée de main du worker, erreur de génération distincte, réponses aux
requêtes). Chaque message est de la forme `{type, id, state, …}`.
Types inconnus/messages nuls → `MODEL_ERROR` explicite (`stage:"protocol"`), jamais
un silence. PASS MOCK (`tests/ai-host.test.mjs`).

### Machine d'états (dans l'hôte)
`IDLE → LOADING → READY ⇄ GENERATING`, `READY/GENERATING/ERROR → SWITCHING →
LOADING`, `→ ERROR`, `→ IDLE`. Une génération exige `READY`; un `INIT_MODEL`
pendant `LOADING`/`SWITCHING` reçoit `BUSY` (pas d'échec, pas de second moteur);
un changement pendant une génération l'**interrompt et attend sa fin propre**
avant de toucher au GPU. PASS MOCK.

### Les trois paliers (identifiants relevés dans `prebuiltAppConfig.model_list` de 0.2.85)

| MODE | MODÈLE | MODEL ID EXACT (f16 / f32 si pas de `shader-f16`) | TAILLE APPROX.¹ | ÉTAT |
|---|---|---|---|---|
| Rapide | Llama 3.2 1B Instruct | `Llama-3.2-1B-Instruct-q4f16_1-MLC` / `…-q4f32_1-MLC` | ≈ 0,9 Go (f16) | id vérifié PASS ; chargement réel **NOT TESTED GPU** |
| Avancé | Phi-4 Mini Instruct | `Phi-4-mini-instruct-q4f16_1-MLC` / `…-q4f32_1-MLC` | ≈ 3,4 Go (f16) | id vérifié PASS ; chargement réel **NOT TESTED GPU** |
| Expert | DeepSeek-R1 Distill Qwen 7B | `DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC` / `…-q4f32_1-MLC` | ≈ 5,1 Go (f16) | id vérifié PASS ; chargement réel **NOT TESTED GPU** |

¹ `vram_required_MB` publié par WebLLM (879 / 3438 / 5107 en f16 ; 1129 / 4221 / 5900
en f32) : **une estimation du moteur, pas une mesure sur ton appareil** et pas la
taille du téléchargement. Aucune VRAM n'est jamais « détectée » : sur Apple Silicon
la mémoire est unifiée et WebGPU ne l'expose pas. Le DeepSeek-R1-Distill-Qwen-7B
**est** compatible avec 0.2.85 (id présent), donc aucun modèle de remplacement n'a
été nécessaire ; son raisonnement `<think>…</think>` est masqué à l'affichage et
avant l'analyse JSON (`stripReasoning`).

Les identifiants ne sont **jamais construits à la main** au moment du chargement :
`ai-host.js` choisit la variante d'après l'adaptateur puis **vérifie** qu'elle existe
dans le `model_list` de la version chargée (sinon `MODEL_NOT_SUPPORTED`, sans rien
télécharger). `tests/ai-engine.test.js` relit le vrai `model_list` de
`@mlc-ai/web-llm@0.2.85` (installé en local) et échoue si un id disparaît.

### Choix du palier (jamais de VRAM devinée)
- **Recommandé** = « Avancé » seulement si l'adaptateur offre `shader-f16` **et**
  `maxBufferSize`/`maxStorageBufferBindingSize` ≥ 1 Gio (la valeur que WebLLM
  demande lui-même) ; sinon « Rapide ». **Jamais Expert.** (seuil = choix de
  conception documenté, pas une mesure de fiabilité.)
- **Lancement automatique** uniquement d'un palier qui a **déjà réellement
  fonctionné** sur cet environnement (il est en cache). Un premier téléchargement
  de plusieurs Go reste un clic. Expert exige une confirmation.
- **« Non recommandé »** n'apparaît que sur une preuve : historique d'échecs,
  limites GPU < 1 Gio, ou mémoire signalée ≤ 4 Go.

### Repli automatique (PASS MOCK)
Expert → Avancé → Rapide, uniquement pour `DEVICE_LOST`, `ENGINE_INIT_FAILED`,
`OUT_OF_MEMORY_OR_RESOURCE_LIMIT`, `DEVICE_FAILED`, `UNKNOWN`. Pas de repli pour
un échec réseau, d'import, de worker ou de WebGPU absent : changer de modèle n'y
change rien. Messages : « Le modèle Expert est trop exigeant pour cet
environnement. REV-EM est passé automatiquement en mode Avancé. » /
« REV-EM utilise le mode Rapide pour garantir la stabilité. »

### Mémoire du dernier palier stable
Clé **propre à l'appareil** (`revisions-etude-marche:ai-engine-memory`), hors
`lsGet/lsSet` (comme `storage-claimed-by`) : ni synchronisée, ni exportée, ni
effacée à la déconnexion ni par la purge d'un compte. Contenu : palier, dates,
codes d'erreur, clé d'environnement — jamais de contenu. Après **2** échecs
matériel/mémoire d'un palier sur un environnement, il n'est plus relancé
automatiquement ; l'utilisateur peut toujours le relancer à la main. Une vraie
réussite efface son passif. L'ancien réglage synchronisé `ai-model-choice`
(`small`/`large`) n'est lu qu'une fois pour migrer (`small` → Rapide) et n'est plus
écrit.

### Cache IA
Le bouton « Réinitialiser le cache IA » : décharge le moteur, supprime **uniquement**
les Cache Storage / bases IndexedDB dont le nom est **exactement** `webllm` ou
`webllm/…`, oublie l'historique d'échecs, redémarre un worker neuf. Il ne touche ni
à la session Supabase, ni aux matières, cours, progression, planning, historique
de conversations, préférences, ni aux caches du service worker. Les erreurs du
navigateur sont **remontées** (l'ancien code les écrivait dans la console et
comptait `onblocked` comme un succès). Testé sur le **vrai** Cache Storage / IndexedDB
de Chromium (PASS MOCK : le moteur est factice, le stockage est réel).

### Prompts, flux, mesures
Historique compacté (`compactHistory`) sous un budget de jetons, dernier message
jamais tronqué, plafond de sortie par tâche (`maxTokensFor`). Flux pour toutes les
conversations. Premier jeton et durée totale mesurés à chaque génération, visibles
**uniquement** dans le panneau de diagnostic.

### Diagnostic « État de mon assistant IA »
WebGPU, adaptateur, périphérique, `shader-f16`, limites, worker, version WebLLM,
palier/modèle, état, exécution (worker/fil principal), dernier repli, dernier stable.
« Copier le diagnostic » : liste blanche de champs + masquage (e-mails, jetons
Bearer/JWT, mots de passe, clés de session Supabase). Aucun contenu de cours.

## 5. Ce qui n'a PAS été modifié
`auth.js`, `user-data.js`, `sync-engine.js`, Supabase (schéma, RLS, profils),
matières, progression, planning. `KEY_AIMODEL` reste dans la liste des clés
synchronisées (compatibilité) mais n'est plus écrit.

## 6. Ce qui reste à vérifier chez toi

Voir le rapport final et le protocole ci-dessous.

### Protocole de test manuel (très court)
- **A — Rapide** : onglet Assistant IA → carte *Rapide* → attendre « Prêt » → poser une question (le texte doit apparaître en flux).
- **B — Avancé** : carte *Avancé* → « Prêt » → question.
- **C — Expert** : carte *Expert* → confirmer → soit « Prêt », soit le repli automatique avec son message.
- **D — Fermer/rouvrir REV-EM** : le dernier palier stable se recharge tout seul (quelques secondes, il est en cache).
- **E — Repli** : si Expert échoue, vérifier le message simple et qu'aucun écran d'erreur ne s'affiche quand un repli réussit.
- **F — REV-EM.app (macOS)** : ouvrir *État de mon assistant IA* → « Copier le diagnostic » → me le coller, **y compris** les lignes « WebGPU (worker) », « shader-f16 », « Limites » et le code d'erreur.
