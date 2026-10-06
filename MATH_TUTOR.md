# Tuteur Maths & Stats — Résoudre · Expliquer · M'entraîner

> Complète [`AI_MATH.md`](AI_MATH.md) (le moteur de calcul). Ici : ce qui fait de « Maths & Stats » un
> tuteur interactif. **Règle cardinale, jamais inversée : le Math Engine est la vérité calculatoire,
> WebLLM est la pédagogie.**

```
                         ┌──────────────────────── carte « Maths & Stats » (index.html, mt*) ────────────────────────┐
  RÉSOUDRE   question ──▶ Math Engine (analyse · Fast Engine / CAS · MathVerifier) ──▶ carte vérifiée ──▶ WebLLM explique
  EXPLIQUER  notion   ──▶ (Math Engine si un problème est détecté) ─────────────────▶ WebLLM : 6 sections, détail réglable
  M'ENTRAÎNER  math-tutor.js : génère · VÉRIFIE l'énoncé (Fast Engine) · compare la réponse (MathVerifier) · indices ·
               méthode · solution · explication déterministe · suivi        ── aucun appel IA, jamais ──
                         └────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 1. Les trois modes

| Mode | Ce que fait REV-EM | Rôle de l'IA |
|---|---|---|
| **Résoudre** | comprend le problème, le calcule avec le Math Engine, le **vérifie**, affiche la carte (résultat + statut + étapes), puis explique | explique le résultat déjà calculé (stratégie `mathExplain` : ≤ 320 jetons, T 0,3, « ne recalcule pas ») ; **sans modèle, la carte s'affiche quand même** |
| **Expliquer** | intuition · définition · méthode · formule · exemple · interprétation, dans cet ordre, libellés dans la langue de l'élève ; niveau de détail **Concis / Standard / Détaillé** (≈ 80 / 180 / 330 mots ; budget de jetons 200 / 420 / 640 en Rapide, 260 / 560 / 900 en Avancé, 800 / 1400 / 2000 en Expert) | tout le contenu ; si un problème chiffré est détecté, le Math Engine le résout d'abord et le modèle ne le recalcule pas |
| **M'entraîner** | génère un exercice, **ne montre pas la solution**, vérifie la réponse, propose Indice / Nouvel essai / Voir la méthode / Voir la solution | **facultative**, uniquement après validation (« Expliquer avec l'IA ») ; ne décide jamais si une réponse est juste |

## 2. M'entraîner — `math-tutor.js` (moteur pur, `RevemMath.tutor`)

* **Catalogue** : 33 types d'exercices, 8 domaines (algèbre, fonctions, dérivées, intégrales, probabilités,
  statistiques, matrices, maths financières) × 3 niveaux (débutant, intermédiaire, avancé) × 2 contextes
  (« mathématiques » ou **école de commerce** : croissance, PIB, rendement, VAN, actualisation, risque/volatilité,
  statistiques commerciales, régression, probabilités). Un niveau sans version « commerce » retombe, **en le disant**, sur
  l'exercice de maths pur (`contextFallback`).
* **Déterminisme** : un exercice = `{ type, niveau, contexte, graine, langue }`. On ne le stocke jamais, on le régénère. Énoncés,
  indices concept/méthode : 5 langues (`textsComplete()` le vérifie).
* **La vérité de l'énoncé** : avant d'être proposé, **chaque** exercice est **recalculé indépendamment par le Fast Engine**
  (`solveEquation`, `integralPoly`, `binomial`, `bayes`, `descriptive`, `covariance`, `npv`, `cagr`, `detLaplace`, `matMul`,
  `solveSystem`, `derivativePoly`/`verifyDerivative`…). S'il ne retrouve pas la réponse attendue, l'exercice est **jeté** (`NOT_VERIFIED`).
  Balayage de test : 7 832 exercices construits (types × niveaux × contextes × 5 langues × graines), 0 rejeté.
* **La vérité de la réponse** : `MathVerifier.compareAnswer` — équivalence mathématique, pas de chaînes.
  * `1/2 = 0,5 = 2/4 = 50 %`, `(x−2)(x−3) = (x−3)(x−2)`, `x = 2 ou x = 3 = {3, 2} = 3 ; 2`, `x = 3 ; y = 4 = (3 ; 4)`, `12 500 € = 12 500`.
  * Une valeur arrondie légitime est acceptée (« correct (arrondi) », la valeur exacte est affichée) ; un montant au centime aussi.
  * Diagnostics sans révéler la réponse : signe inversé, oubli d'une solution, valeur en trop, valeurs inversées, forme non factorisée,
    unité (taux décimal au lieu de %), « tu es proche ». Réponse illisible/vide : **ne compte pas comme un essai**.
  * Aucune exécution de code : parseur à liste blanche du Math Engine.
* **Séance** (`tutor.session(ex)`, machine à états pure) : indices **1 concept → 2 méthode → 3 début du calcul** (première étape seulement) ;
  « Voir la méthode » = démarche + étapes **sauf la dernière** (vaut le dernier indice dans le suivi) ; « Voir la solution » n'est
  offerte **qu'après un effort** (une réponse ou un indice), clôt l'exercice **sans le compter comme réussi**.
* **Explication après validation** : déterministe (idée, méthode, étapes, « vérifiée par le moteur, pas par l'IA »). Le bouton
  « Expliquer avec l'IA » envoie au modèle un bloc `MATH ENGINE RESULT … do not recompute` (énoncé + réponse vérifiée + étapes du moteur).

## 3. Suivi : `attempts · success · topic · difficulty · hintsUsed · mastery`

Le **journal** stocke un exercice **terminé** (résolu, solution montrée, ou quitté après effort) :
`{ ts, topic (= domaine), kind, difficulty 0|1|2, context, attempts, hintsUsed 0-3, success, solutionShown }`.
Jamais l'énoncé, jamais la réponse de l'élève. La **maîtrise est calculée**, jamais stockée :

* valeur d'un exercice : 1 si résolu seul ; −0,15 par indice ; −0,10 par réponse fausse avant la bonne (≤ −0,30) ; plancher 0,3 si résolu ;
  **0** si la solution a été montrée ou si l'élève a abandonné ;
* maîtrise d'un thème = moyenne pondérée par la difficulté (1 / 1,5 / 2) des **20 derniers** exercices ; `null` sans donnée (jamais un chiffre inventé) ;
* confiance : mêmes seuils que `smart-revision.js` (0 → insuffisante, 1-2 → faible, 3-9 → moyenne, ≥ 10 → haute) ; « à confirmer » affiché sous 3 exercices ;
* niveau conseillé : monter si ≥ 75 % sur ≥ 3 exercices du niveau, redescendre si < 40 %, sinon aucun conseil.

Stockage : `lsGet/lsSet` (clé `math-practice`, **scopée par compte**, comme tout le reste) ; invité = local seulement. Préférences
(domaine, niveau, contexte, mode) : clé `math-tutor-prefs`, locale, **jamais synchronisée**.

## 4. Supabase (compte connecté) — `006_math_practice.sql`

Table `public.math_practice` : une ligne par exercice terminé, colonnes ci-dessus (+ `id`, `user_id`, `created_at`), `unique (user_id, ts)`.
* **RLS** : 4 policies strictement `auth.uid() = user_id` ; accès `anon` retiré ; contraintes `CHECK` (thème dans la liste fermée, difficulté 0-2,
  indices 0-3, essais 0-99, contexte) : la base refuse une valeur absurde, pas seulement le client.
* **Journal « union »** (`keyCol: null` dans `user-data.js`, comme `activities`) : deux appareils hors ligne s'ajoutent leurs lignes sans s'écraser ;
  aucun compteur agrégé (qui perdrait des écritures). Une entrée invalide est écartée côté client sans faire échouer le lot.
* Testé contre **PostgreSQL réel** (`tests/user-data.test.mjs` scénario 18 ; `supabase/tests/rls_tests.sql` : A↔B lecture/modif/suppression/insertion usurpée = refus).

## 5. Interface

Carte « Maths & Stats » dans l'Assistant (sous la zone de question libre, au-dessus des actions) : onglets ARIA (`tablist`, flèches ← →), segments `radiogroup`,
formules rendues par **KaTeX** (déjà auto-hébergé, chargé à la première formule) avec repli texte, zones `aria-live` pour le retour, cibles ≥ 44 px,
saisie ≥ 16 px (pas de zoom iOS), aucun débordement à 390 px, remplacement **ciblé** du DOM (la saisie et le focus survivent). Tout texte dynamique passe par `escapeHtml`.

## 6. Tests

| Fichier | Contenu | Statut |
|---|---|---|
| `tests/math-tutor.test.js` | couverture, balayage, recoupement avec le Math Engine complet, équivalence, indices, séance complète, suivi, génération, sécurité | PASS |
| `tests/math-tutor-ui.test.mjs` | vrai Chromium : 3 modes, session complète, 48 combinaisons, 5 langues, mobile, XSS, persistance, non-régression | PASS (+ PASS MOCK pour les parties qui touchent le modèle simulé) |
| `tests/assistant-core.test.js` | stratégie « Expliquer » (sections, détail, langues, Expert) | PASS |
| `tests/user-data.test.mjs` § 18 + `supabase/tests/*.sql` | journal, RLS, CHECK, idempotence, union | PASS (PostgreSQL réel) |

**NON TESTÉ** : vrai WebLLM / GPU / Mac / WKWebView ; vrai projet Supabase en ligne (la migration 006 doit être exécutée dans le SQL Editor).

## 7. Limites et suites possibles

* L'exercice en cours n'est pas persisté (recharger = en démarrer un nouveau) ; quitter après effort n'est enregistré que sur « Nouvel exercice ».
* Le suivi n'alimente pas encore « Révision intelligente », « Mes statistiques » ni le planning : la maîtrise par thème est prête à être consommée.
* Pas d'exercices sur les limites, les lois normales ni les intervalles de confiance (le moteur sait les résoudre en mode Résoudre).
* L'ancien raccourci du chat (« donne-moi un exercice » → `RMath.engine.practice`) est conservé tel quel ; le tuteur est la surface complète.
