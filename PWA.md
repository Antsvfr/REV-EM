# REV-EM en application installable

```
manifest.webmanifest    ce que l'OS doit savoir pour proposer l'installation
sw.js                    l'app shell hors ligne, les stratégies de cache
index.html (fin)         enregistrement, bannières, écran de lancement
icons/                   un seul glyphe, décliné dans toutes les tailles utiles
```

Trois travaux séparés, comme partout ailleurs dans ce projet : un fichier
déclaratif que l'OS lit, un service worker qui décide requête par requête,
et un branchement dans `index.html` qui ne fait qu'écouter ses événements.

## Icônes

Le glyphe est celui qui existe déjà dans l'en-tête (`.brand-mark`) : quatre
barres ascendantes. Pas un second logo inventé pour l'occasion — l'icône
d'application et la marque dans la barre de navigation sont le même dessin,
seul le fond change (transparent dans l'en-tête, aplat `--accent` pour
l'icône, qui doit rester lisible seule, sans le reste de l'interface autour).

| Fichier | Rôle |
|---|---|
| `icons/icon.svg` | favicon vectoriel — net à toute résolution |
| `icons/icon-16.png`, `icon-32.png` | favicon PNG (navigateurs qui ignorent le SVG) |
| `icons/favicon.ico` | onglet/barre des tâches des navigateurs les plus anciens |
| `icons/apple-touch-icon.png` (180×180) | écran d'accueil iOS/iPadOS |
| `icons/icon-192.png`, `icon-512.png` | le minimum d'installabilité (Chrome/Edge/Android) |
| `icons/icon-192-maskable.png`, `icon-512-maskable.png` | icône adaptative Android |

**Maskable, concrètement** : Android peut recadrer l'icône dans un cercle, un
carré aux coins arrondis, une goutte — selon le launcher. Une icône « any »
juste rétrécie déborderait dans ce recadrage. La variante maskable resserre
le glyphe à l'intérieur des 80 % centraux (la « zone sûre » de la
[spécification](https://www.w3.org/TR/appmanifest/#purpose-member)) :
vérifié en simulant le pire cas, un recadrage circulaire.

## Le manifeste

Chemins **relatifs**, sans `/` en tête (`start_url: "."`, `scope: "."`) :
c'est ce qui permet au même fichier de fonctionner servi depuis la racine
d'un domaine (en local) ou depuis un sous-chemin de projet
(`antsvfr.github.io/ANAQUIZZ/`), sans réglage différent entre les deux.

`background_color` (l'aplat derrière l'icône pendant le tout premier
affichage, sur Android) et `theme_color` (la teinte du chrome du
navigateur/de l'app) valent tous deux `--accent`, le même rouge que l'écran
de lancement — voir « Design » plus bas pour pourquoi ce n'est pas un
oubli.

## Service worker — trois stratégies, pas une seule

Une question se pose à chaque requête : **qu'est-ce que c'est ?** La
réponse fixe la stratégie, jamais l'inverse.

| Requête | Stratégie | Pourquoi |
|---|---|---|
| Navigation (la page elle-même) | **réseau d'abord**, cache en secours | Un utilisateur en ligne reçoit TOUJOURS la version la plus récente — voir « Mise à jour » |
| Module JavaScript de l'application (`*.js`, même origine) | **réseau d'abord**, cache en secours | Les modules dépendent les uns des autres (`index.html` ↔ `user-data.js`…) : une page neuve avec un ancien module casse le contrat. Depuis `rev-em-v3` |
| Police, icône (même origine ou CDN autorisé) | **cache d'abord**, réseau en tâche de fond | Rapide à servir ; jamais périmé de plus d'une session |
| Le projet Supabase (`*.supabase.co`) | **jamais intercepté** | Une donnée de compte ne doit jamais venir d'un cache — voir « Sécurité » |
| Tout le reste (imports différés `esm.run`, requêtes imprévues) | **ignoré** | Moins de surface interceptée, moins de risque de servir une version bloquée d'une dépendance lourde |

> **Première session après ce changement.** Un utilisateur dont l'ancien
> service worker (`rev-em-v2`) est encore actif reçoit une page neuve mais,
> pour cette seule session, un ancien `user-data.js` servi par le cache.
> `index.html` le détecte (`LyonUserData.API_VERSION`, voir
> `userDataModuleIsCurrent()`), ne synchronise pas avec un module trop ancien
> et recharge **une seule fois** (garde `sessionStorage`, jamais de boucle)
> pour récupérer les modules revalidés en arrière-plan. Rien n'est perdu :
> la file « à envoyer » est déjà persistée.

### Pourquoi « réseau d'abord » pour la page, et pas une simple version de cache

La tentation naturelle est de précacher `index.html` et de le servir depuis
le cache pour aller vite. Le problème : rien ne garantit alors qu'un
utilisateur EN LIGNE reçoive la dernière version — il faudrait qu'un humain
pense à changer un numéro de version dans `sw.js` à **chaque** déploiement
pour que le cache s'invalide, et un oubli laisserait quelqu'un bloqué sur
une ancienne page sans même être hors ligne. Le réseau d'abord élimine cette
dépendance : le cache ne sert que quand le réseau échoue réellement.
Vérifié : modifier `index.html` sur le disque, puis simplement recharger la
page (en ligne) — la modification apparaît immédiatement, sans toucher à
`sw.js`.

### Pourquoi Supabase n'est jamais intercepté

Deux raisons, et les deux suffiraient seules :

1. **Sécurité** — mettre en cache une réponse authentifiée risquerait de la
   resservir dans un contexte où elle ne devrait pas apparaître.
2. **Ça existe déjà, correctement** — `user-data.js` gère déjà l'échec
   réseau proprement (statut `"error"`/`"partial"`, jamais une exception qui
   casse l'écran, le domaine reste en file d'attente pour la prochaine
   occasion — voir son commentaire dans `runCycle()`). Intercepter ces
   requêtes dans le service worker n'ajouterait rien, sinon un risque de
   servir une donnée périmée à la place d'une vraie erreur réseau que
   l'application sait déjà interpréter.

### L'app shell précaché

`index.html`, les onze modules JS chargés en `<script>`, `ai-worker.js`,
`manifest.webmanifest` et les icônes principales. `supabase-config.js` est
précaché **séparément, en best-effort** : ce fichier est absent des dépôts
qui n'ont pas encore configuré Supabase (voir `SETUP_SUPABASE.md`), et
`cache.addAll()` échoue en bloc si une seule requête échoue — un fichier
optionnel manquant n'a pas à faire échouer l'installation de tout le reste.

### Mise à jour — jamais imposée

```
sw.js change sur le disque
        │
        ▼
le navigateur installe le nouveau worker EN ARRIÈRE-PLAN, "waiting"
        │                                    (sw.js n'appelle jamais
        │                                     self.skipWaiting() lui-même)
        ▼
index.html le détecte → bannière "Nouvelle version disponible"
        │
        ▼           utilisateur clique "Recharger"
        └──────────────────────────────────────────┐
                                                     ▼
                                    postMessage({type:"SKIP_WAITING"})
                                                     │
                                                     ▼
                                    le nouveau worker prend la main
                                    → controllerchange → un SEUL reload
```

Un rechargement forcé et automatique perdrait un quiz ou un examen blanc en
cours — leur état (`state.pool`, `state.index`, `state.exam.pool`…) n'existe
qu'en mémoire, jamais persisté tel quel. La mise à jour est donc **toujours
une proposition**, jamais une interruption : l'utilisateur choisit son
moment, et **rien ne l'empêche de continuer à réviser** pendant que la
bannière attend en bas de l'écran.

Vérifié de bout en bout, avec de vrais fichiers modifiés sur le disque
pendant qu'une page reste ouverte (pas une simulation dans le DOM) :
`sw.js` change → un nouveau worker s'installe et attend → la bannière
apparaît → le clic envoie le message → le worker prend la main → la page
recharge **une seule fois** → le nouveau cache a remplacé l'ancien.

## Écran de lancement

Une page unique ne peut pas dépendre d'un système de build pour se
« précompiler » un écran de démarrage : la seule chose garantie d'arriver
en premier, c'est l'ordre dans lequel le HTML est écrit. L'écran de
lancement est donc le tout premier élément du `<body>`, peint dès que le
navigateur l'a reçu — **avant** qu'il rencontre le gros `<script>` inline
qui bloque le rendu pendant son exécution. C'est ce qui évite l'écran blanc
au démarrage, sur le web comme dans l'app installée.

Même aplat que la bannière du tableau de bord et `background_color` du
manifeste : le même rouge du premier pixel peint jusqu'au contenu réel,
jamais un flash neutre puis une bascule de couleur.

`hideBootSplash()` s'exécute que le chargement initial réussisse **ou**
échoue (`loadDataAndRefreshUi().then(hideBootSplash, hideBootSplash)`), plus
un filet de sécurité à 6 secondes : un écran de lancement qui resterait
bloqué serait pire que pas d'écran de lancement du tout.

### Ce qui n'a pas été fait, et pourquoi

Un vrai « splash screen » natif par device (les `apple-touch-startup-image`
d'iOS) exige une image différente par taille d'écran exacte, et Safari ne
lit de toute façon pas le manifeste pour ce réglage. Plutôt que de livrer un
mécanisme fragile et incomplet, l'écran de lancement HTML ci-dessus couvre
le même besoin (pas d'écran blanc au démarrage) sur toutes les plateformes
à la fois, avec un seul fichier à maintenir.

## Hors ligne — ce qui marche, et ce qui n'a jamais été promis

| Demandé | Statut | Comment |
|---|---|---|
| Ouverture de l'application | ✅ | App shell précaché par le service worker |
| Accès aux données déjà chargées | ✅ | `localStorage`/`IndexedDB` sont déjà la persistance locale — ni l'un ni l'autre n'a jamais eu besoin du réseau pour être lu (voir `supabase-auth-data`) |
| Consultation de cours déjà ouverts | ✅ | Même mécanisme : un chapitre déjà présent dans `state.userChapters` reste lisible |
| Consultation de flashcards déjà disponibles | ✅ | Idem |
| Écriture d'une donnée en étant hors ligne | ⚠️ **partiel, honnêtement** | `user-data.js` la garde en file (« la prochaine occasion réessaiera ») et retente à la reconnexion **si l'onglet reste ouvert** — voir « Reconnexion » ci-dessous. Rien n'est mis en file de façon **persistante** au-delà de la session : fermer l'onglet avant reconnexion perd la tentative de synchronisation, pas la donnée elle-même (qui reste dans le cache local). Une vraie file persistante demanderait la Background Sync API, hors du périmètre de cette étape. |

Vérifié réellement (pas seulement lu dans le code) : couper le réseau,
recharger la page, retrouver la barre de navigation, une matière et un
chapitre ajoutés juste avant la coupure — sans aucune erreur JavaScript.

### Reconnexion

`user-data.js` prévoyait déjà ce cas dans son propre commentaire
(« la prochaine occasion — nouvelle écriture, reconnexion, flush explicite —
réessaiera ») mais rien n'écoutait l'événement `online` avant cette étape.
Un seul ajout, qui appelle ce qui existe déjà :

```js
window.addEventListener("online", () => {
  if (cloud) cloud.flush().catch(() => {});
});
```

## Design

Le splash, l'icône, `theme_color` et `background_color` partagent
délibérément le même rouge `--accent` plutôt que le blanc de la barre de
navigation habituelle : une décision de marque assumée (« rouge, premium »),
pas un défaut technique. La barre de statut iOS reste en revanche
**opaque**, pas translucide (`apple-mobile-web-app-status-bar-style:
"default"`) — un choix plus sobre qui évite tout le travail de zone sûre
(encoche, île dynamique) qu'un contenu passant sous une barre translucide
exigerait, pour un bénéfice visuel marginal sur cette interface précise.

Zone sûre tout de même appliquée où elle coûte peu et sert vraiment :
`env(safe-area-inset-bottom)` sur le toast et sur la bannière d'action, pour
qu'aucun des deux ne s'installe sous la barre gestuelle d'un iPhone en app
autonome.

### Ce qui a été considéré et écarté

La bulle IA flottante (`.ai-fab`) est positionnée en pixels **par JavaScript**
(`applyAIFabPosition`, pour rester glissable au doigt) — une simple ligne CSS
`bottom: calc(... + env(safe-area-inset-bottom))` y serait totalement
inerte, écrasée par le style en ligne posé au chargement. La corriger
demanderait de toucher le calcul de position (`defaultAIFabPos()`), pas
seulement sa feuille de style — hors du périmètre de cette étape, notée
plutôt que masquée par du CSS mort qui aurait l'air de résoudre le problème
sans rien faire.

## Sécurité

Rien de nouveau ici ne contourne les règles déjà en place :

- aucune donnée de compte n'est mise en cache (voir « Service worker »
  ci-dessus) ;
- `escapeHtml()`/`textContent` partout où la bannière insère un texte —
  aucune des chaînes qu'elle affiche ne passe par une interpolation HTML ;
- rien de neuf ne touche à `lsGet`/`lsSet` : la seule nouvelle clé
  (`pwa-install-dismiss`, la date du dernier « Plus tard ») passe par eux
  comme le reste, et reste donc cloisonnée par compte comme toute autre
  préférence.

## Une chose que la mesure a corrigée

**La toute première visite se rechargeait toute seule, sans raison.**
`sw.js` appelle `self.clients.claim()` à l'activation pour que le service
worker prenne la main sur la page dès cette première visite, sans attendre
un second chargement. Mais cette prise de contrôle déclenche, elle aussi,
un événement `controllerchange` — **identique** à celui d'une vraie mise à
jour qui remplace un ancien worker. Le premier code de cette section
rechargeait sur n'importe quel `controllerchange`, confondant donc
« je prends la main pour la première fois » avec « je remplace une version
précédente » — un rechargement intempestif à chaque toute première visite,
qui aurait perdu exactement ce que « Mise à jour » plus haut promet de ne
jamais perdre.

Découvert par une régression sur `tests/dashboard.test.mjs`, pas par
lecture de code : le rechargement survenait à un moment précis pendant un
test qui ne rechargeait jamais explicitement la page, et un nœud du DOM
marqué comme témoin de « pas de re-rendu » disparaissait. Corrigé en
distinguant la première prise en charge (ignorée) d'un vrai remplacement
(qui recharge) — vérifié dans les deux sens : la première visite ne
recharge plus, et le cycle de mise à jour complet (fichier modifié →
bannière → clic → reload) continue de fonctionner exactement comme avant.

## Tests

| Suite | Vérifie |
|---|---|
| `tests/pwa.test.mjs` | manifeste (JSON valide, champs, icônes réellement servies et de la bonne taille en pixels), métadonnées de page, écran de lancement retiré, enregistrement et activation du service worker, ouverture hors ligne avec des données réelles, fraîcheur en ligne (fichier modifié sur le disque + simple reload), cycle de mise à jour complet (fichier modifié → bannière → clic → un seul reload → nouveau cache), cycle d'installation complet (événement natif → bannière → `prompt()` réellement appelé → `appinstalled` → toast), non-harcèlement du « Plus tard », reconnexion, responsive à trois largeurs, cinq langues, mode invité |

Le reste de la suite existante (`tests/dashboard.test.mjs`,
`tests/pages.test.mjs`, `tests/chrome.test.mjs`…) est rejoué sans
modification : cette étape n'a touché ni la logique Supabase, ni le système
de synchronisation multi-appareils, ni aucune fonctionnalité existante.
