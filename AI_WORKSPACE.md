# AI Workspace V2 — la page « Assistant IA » comme espace de travail

> Complète [`AI_CHAT.md`](AI_CHAT.md) (la chaîne de conversation), [`AI_MATH.md`](AI_MATH.md) /
> [`MATH_TUTOR.md`](MATH_TUTOR.md) (Maths & Stats) et [`AI_AUDIT.md`](AI_AUDIT.md) (le moteur de modèle).
> **C'est une refonte d'INTERFACE.** Aucune de ces chaînes n'a été modifiée : `ai-worker.js`, `ai-host.js`, `ai-engine.js`,
> le Math Engine, `MathVerifier`, le Knowledge Engine, Supabase, Auth, Brightspace, l'Import Center, les quiz et flashcards sont intacts.

**Règle de conception :** « cet élément mérite-t-il de prendre de la place EN PERMANENCE pendant que l'étudiant discute ? »
Sinon : sidebar, menu, panneau, état vide, ou contextuel. **La conversation et la saisie gagnent toujours.**

```
┌ navbar REV-EM (inchangée) ──────────────────────────────────────────────────────────────────────────────┐
├──────────────┬──────────────────────────────────────────────────────────────────────────────────────────┤
│ + Nouvelle   │ ☰  Assistant IA   Mode : Discuter ▾                     ● Avancé · Prêt   ⛶   ⋯          │ ← en-tête 56 px
│ ASSISTANT    ├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Discussion  │ (barre contextuelle : seulement en Maths & Stats ou Mes cours)                           │
│  Mes cours   ├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Maths&Stats │                                                                                          │
│  Révisions   │            LA CONVERSATION  (seul élément qui défile)                                    │
│ HISTORIQUE ⋯ │            colonne de lecture ≤ 980 px, tableaux/formules/code pleine largeur            │
│  Aujourd'hui │                                                                                          │
│  Cette sem.  ├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Voir tout   │ [ Pose ta question…                                              (↑) ]  ← saisie fixe    │
└──────────────┴──────────────────────────────────────────────────────────────────────────────────────────┘
   252 px (64 replié)                       ≈ 75–80 % de la largeur
```

## 1. Ancien layout → nouveau layout

| Avant (page de cartes, ~3–5 écrans de défilement) | Après (espace de travail, 0 défilement de page) |
|---|---|
| Carte « Assistant personnel » + 5 modes + suggestions + actions spécifiques (grille) empilés | Sidebar (4 espaces) + en-tête compact + conversation + saisie |
| Chargement du modèle : gros bloc à barre, sélecteur de 3 cartes, diagnostic, tous dans la page | Pastille d'état « ● Avancé · Prêt » ; chargement = pastille + mini-barre ; détails, annulation et sélecteur dans un **panneau** ; diagnostic dans un **panneau à part** |
| Historique pleine largeur, « Vider » toujours visible | Historique dans la sidebar (Aujourd'hui / Cette semaine / Plus ancien, titres courts, 8 éléments + « Voir tout »), « Vider » dans le menu ⋯ **avec confirmation** |
| Maths & Stats : carte posée en bas de page | Un clic sur « Maths & Stats » : même zone, en-tête « Maths & Stats », sélecteur compact Résoudre / Expliquer / M'entraîner |
| Zone IA indisponible : gros encadré | Bandeau compact d'une ligne + « Détails » ; Résoudre et M'entraîner restent utilisables (moteur déterministe) |
| Bulle flottante **et** page = deux interfaces | La bulle ouvre CE workspace (même `state`) et se masque sur la page |

## 2. Architecture — « état d'interface ≠ état du moteur »

* **`aiw`** (variable de module, `index.html` §14ter) : `space` (`chat|courses|math|revise`), `collapsed`, `drawer`, `focus`, `menu`
  (menu/panneau ouvert), `diag`, `histAll`. **Ce n'est pas `state`** : changer d'espace, replier la sidebar, entrer en concentration
  ou ouvrir un panneau **n'envoie aucun message au moteur** (vérifié : aucun `LOAD/INIT/RESET`, `state.aiStatus/aiTier` intacts,
  `RevemMath` non réinitialisé, Knowledge Engine non rechargé). Seule `collapsed` est mémorisée (`lsSet(KEY_AIW_PREFS)`).
* **L'espace est dérivé de l'outil actif** (`aiwSpaceNow()`) : jamais un état parallèle qui diverge. Un outil « Comprendre/Mes cours »
  → Mes cours ; « Analyser / examen » → Révisions ; sinon le choix de l'élève.
* **Une seule saisie** (`#assistant-query-input`, textarea auto-ajustable ≤ 200 px) et **un seul point d'entrée** :
  `aiwSend(texte)` route vers la chaîne EXISTANTE — Maths & Stats → `aiGeneralAsk(…, { tutor })` ; conversation en cours →
  `aiFollowUp` (comme l'ancien champ de suivi : la saisie POURSUIT, elle ne re-détecte pas l'intention) ; outil actif →
  `aiRun` / `aiFollowUp` ; Mes cours (vide) → `aiRun("free")` ; sinon `aiRunPersonalQuery`. Entrée envoie, Maj+Entrée = ligne,
  Échap arrête une génération. En entraînement, la zone de réponse de l'exercice EST la saisie (pas de double champ).
* **`render()` complet conservé** (pattern du projet) mais encadré par `aiwCapture()` / `aiwRestore()` : position de défilement,
  « suivre la réponse seulement si l'élève est déjà en bas », focus et sélection du textarea. Les menus s'ouvrent/se ferment par le DOM
  (pas de re-rendu). Le flux s'écrit toujours dans `#ai-stream` par rAF.

## 3. Comportement défini : Discussion ↔ Maths ↔ Mes cours ↔ Révisions

* La conversation **générale** est partagée : passer d'un espace à l'autre **ne la supprime jamais**. L'espace change le contexte
  (placeholder, barre d'outils, mode tuteur appliqué à l'envoi), pas le fil.
* Quitter une conversation **d'outil** (ex. « Expliquer une notion ») la range dans l'historique ; elle n'est pas détruite.
* « + Nouvelle conversation » est le seul geste qui vide le fil (génération annulée proprement ; l'historique est conservé).
* Les placeholders suivent l'espace : « Pose ta question… », « Entre ton problème ou ton calcul… », « Pose une question sur tes cours… »,
  « Que veux-tu réviser ? » (suivi : « Poursuis la conversation… »).

## 4. Statut du modèle (réel, discret)

`aiwStatus()` lit `state.aiStatus` : Vérification · Indisponible (pas de WebGPU) · Chargement `NN %` (+ mini-barre, palier) ·
Erreur · Inactif · Hors ligne (`navigator.onLine`) · Prêt · Génération. Le panneau d'état (clic) contient, selon l'état : progression et
**Annuler**, message d'erreur et **Réessayer**, sélecteur Rapide/Avancé/Expert (inchangé, jamais de téléchargement automatique), réinitialisation
du cache IA (avec confirmation). Le **diagnostic** complet (mesures, test complet, copie, Knowledge) est un panneau latéral séparé, jamais en
permanence.

## 5. Responsive, WKWebView, accessibilité

* **≥ 901 px** : sidebar 252 px (64 px repliée, mémorisé). Largeur du workspace `min(1500px, 100vw − 32px)`, hauteur = fenêtre −
  navbar − marges : **la page ne défile pas**, seule la conversation défile (la sidebar ne défile que si l'historique l'exige).
* **≤ 900 px** : la sidebar devient un tiroir (scrim, Échap, focus rendu au bouton, fermé après un choix). Franchir le seuil à chaud
  recompose l'interface (`aria-expanded`, état du tiroir). **≤ 680 px** : en-tête minimal (titre masqué hors Maths, concentration
  dans ⋯), menus en feuille fixe dans l'écran, cibles 44 px, saisie collée en bas.
* **WKWebView / Safari (conçu, NON testé sur Mac)** : la hauteur ne repose pas sur `100vh` seul — `--aiw-top` et `--aiw-vh` sont mesurés
  en JS (`visualViewport`) et suivent le clavier virtuel ; la saisie est un enfant flex (pas de `position: sticky/fixed` à contourner) ;
  `overscroll-behavior: contain` ; textarea ≥ 16 px (pas de zoom iOS) ; `env(safe-area-inset-bottom)`.
* **Concentration** : masque sidebar, mode, état, bandeau et barres secondaires ; garde conversation, en-tête minimal et saisie.
  Échap en sort (jamais pendant une génération).
* **Accessibilité** : région et navigation nommées, `aria-current` sur l'espace actif, `aria-expanded/haspopup` sur les menus, rôle
  `tabpanel` + `aria-labelledby` en Maths & Stats, focus visible partout, Échap (menu → diagnostic → tiroir → concentration),
  `prefers-reduced-motion`, couleurs et rayons exclusivement par jetons du design system. Tous les textes : `aiw.*` dans 5 langues.

## 6. Tests

* `tests/ai-workspace-ui.test.mjs` — 14 scénarios dans un vrai Chromium : structure et mesures (sidebar 220–260, zone ≥ 70 %, 0 défilement
  de page, saisie visible), 9 tailles d'écran (1920×1080 → 360×640), conversation (envoi, flux, Maj+Entrée, hauteur bornée, arrêt, nouvelle
  conversation, historique), historique (bornage, groupes, confirmation avant de vider), Maths & Stats (un clic, même zone, Résoudre par le
  moteur, aucun rechargement du modèle), cohabitation des espaces, en-tête (modes, états chargement/erreur/indisponible, panneau, diagnostic),
  repli et concentration (mémorisation, rechargement), tiroir tactile et clavier virtuel simulé, franchissement du seuil, 5 langues × 2 largeurs,
  bulle, accessibilité, aucune action moteur depuis l'interface.
* Tests existants adaptés au nouveau DOM (même comportement vérifié) : `assistant-ui`, `generation-ui`, `knowledge-ui`, `output-ui`,
  `math-ui`, `math-tutor-ui`, `ai-integration`.
* **PASS MOCK** : le modèle est un faux transport. **NON TESTÉ** : vrai WebLLM, GPU, Mac, WKWebView/Safari réels, clavier iOS réel.

## 7. Évolutions prévues (rien n'est bloqué)

Le routage `aiwSend` et les espaces sont l'endroit où brancher : Mes cours + RAG, Brightspace, Knowledge, pièces jointes et images
(le bouton trombone existe déjà dans la barre « Mes cours »), Excel, outils mathématiques — sans retoucher la mise en page.
