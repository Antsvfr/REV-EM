# REV-EM — Moteur mathématique avancé (déterministe, exact, vérifiable)

> **Principe : WebLLM n'est ni une calculatrice ni un CAS.** Il explique ; il ne calcule pas.
> Le moteur mathématique calcule de façon déterministe, **vérifie** son propre résultat, puis le donne au modèle
> comme **donnée d'entrée faisant autorité**. Si le moteur ne sait pas résoudre ou ne peut pas vérifier, il le
> dit — un résultat inventé n'est jamais affiché comme calculé.

```
QUESTION
  → MathAnalyzer (déterministe, sans modèle)         math-engine.js · analyze()
  → représentation du problème (AST JSON, liste blanche)   math-core.js
  → Fast Engine (exact, instantané)                  math-fast.js
        └─ NEEDS_CAS ─→ CAS avancé (SymPy/Pyodide, Web Worker, à la demande)   math-cas-*.js + math-cas.py
  → MathVerifier (contrôle INDÉPENDANT du CAS)       math-verify.js
  → RÉSULTAT VÉRIFIÉ + statut                        math-engine.js · solve()
  → carte affichée (KaTeX)   +   bloc « MATH ENGINE RESULT » pour le prompt
  → WebLLM → EXPLICATION pédagogique                 assistant-core.js (calc.header) + index.html
```

## 1. Audit avant modification (état trouvé)

| Existant | Constat |
|---|---|
| `assistant-core.js` → `localCalculation` / `parseExpression` | Calculatrice locale **à virgule flottante** pour quelques opérations (pourcentage, intérêts…). Pas de rationnels, pas de symbolique, pas de vérification. **Conservée** comme repli quand le nouveau moteur ne reconnaît pas la question (aucune régression). |
| Rendu mathématique | Aucun (ni KaTeX, ni MathJax) : formules en texte brut. |
| Moteur de calcul formel | Aucun. Aucun `MathEngine` préexistant à réutiliser. |
| WebLLM | `SYSTEM_BASE` demande de « réutiliser les chiffres d'un bloc VERIFIED CALCULATION » : le pipeline avait déjà la notion de calcul fait avant le modèle. Le nouveau moteur s'y branche (en-tête `calc.header`) au lieu de créer un second pipeline IA. |
| Knowledge Engine | Connaissances **pédagogiques** (définitions). Reste distinct du moteur mathématique (≠ calcul). |
| Service worker | Précache « tout ou rien » + `activate` qui supprime les caches inconnus : adaptés (cf. §9). |

Pas de moteur parallèle : un seul pipeline `aiGeneralAsk()` → moteur → LLM.

## 2. Modules (même patron que le reste du projet : **moteur pur + branchement**)

| Fichier | Rôle | Poids brut / gzip |
|---|---|---|
| `math-core.js` | Rationnels exacts (BigInt), normalisation (`1 000`, `0,5`, `x²`, `√`, `|x|`), parseur à **liste blanche** → AST JSON, évaluation exacte/flottante, polynômes, mise en forme texte/LaTeX | 48 Ko / 14 Ko |
| `math-fast.js` | **Fast Engine** : arithmétique exacte, polynômes (racines rationnelles, factorisation, dérivée, primitive), systèmes/matrices (exact), statistiques, probabilités, finance | 76 Ko / 22 Ko |
| `math-verify.js` | **MathVerifier** : substitution, redérivation, quadrature, évaluation de limites, A·A⁻¹, comparaison de réponses d'élève | 18 Ko / 6 Ko |
| `math-engine.js` | **MathAnalyzer** (5 langues), orchestrateur `solve()`, bloc LLM, carte, mode exercice, API réutilisable | 99 Ko / 30 Ko |
| `math-cas-client.js` | Client du CAS : Worker créé à la demande, file, délais, `terminate()` | 8 Ko / 3 Ko |
| `math-cas-worker.js` | Web Worker **module** : charge Pyodide + SymPy, n'exécute que `run_request(json)` | 3 Ko |
| `math-cas.py` | Couche Python : **AST → SymPy** par table de construction fermée (jamais `sympify`/`eval`) | 22 Ko / 6 Ko |
| `vendor/` | Pyodide 314.0.7, SymPy 1.14.0, mpmath 1.4.1, KaTeX 0.19.0 — auto-hébergés (`vendor/README.md`) | voir §4 |

Ordre de chargement dans `index.html` (après `revision-bank.js`) : `math-core → math-fast → math-verify → math-engine → math-cas-client`.
Coût au démarrage : **≈ 250 Ko de JavaScript** (≈ 75 Ko gzip) — rien d'autre n'est téléchargé tant qu'aucun calcul n'est demandé.
`math-cas-worker.js`, `vendor/pyodide`, `vendor/py` et `vendor/katex` ne sont jamais chargés au démarrage.

## 3. Routage automatique (Fast Engine → CAS)

Le routage est **déterministe** (aucun appel au modèle) :

* **Fast Engine** (résultat exact, quelques ms) : arithmétique, polynômes dont les racines sont rationnelles ou du second degré, dérivées/primitives de polynômes,
  systèmes linéaires, matrices rationnelles (somme, produit, transposée, déterminant, inverse, rang, valeurs propres 2×2, `A·x = b`), statistiques, probabilités, finance.
* **CAS avancé** (SymPy) seulement quand le Fast Engine répond `NEEDS_CAS` : limites, intégrales/dérivées non polynomiales, équations transcendantes ou de degré ≥ 5,
  irrationnels (`√2·√8 → 4`, `π/4 + π/4 → π/2`), valeurs propres > 2×2, etc.
* Si le CAS est indisponible (réseau, navigateur sans worker de module…), le résultat est `UNSUPPORTED` / `CAS_UNAVAILABLE` ; pour un calcul irrationnel on garde l'**approximation étiquetée** — jamais présentée comme exacte.

## 4. Choix du CAS — pourquoi SymPy via Pyodide (et ses alternatives)

Décision confirmée par l'utilisateur : **« SymPy via Pyodide + Fast Engine JS exact »**, **auto-hébergé dans `vendor/`**.

| Option | Lourdeur (mesurée) | Verdict |
|---|---|---|
| **SymPy 1.14 + Pyodide 314** (retenu) | 20,4 Mo bruts (wasm 9,6 Mo, stdlib 2,5 Mo, asm 1,25 Mo, sympy 6,3 Mo, mpmath 0,57 Mo, index 0,12 Mo) ; ≈ 13 Mo avec gzip (mesuré en local ; la compression réellement appliquée par GitHub Pages à `.wasm`/`.whl` n'est pas vérifiée) ; démarrage à froid ≈ 8–9 s (mesuré) | CAS **complet et mature** : `solveset` avec domaines, limites (Gruntz), intégration, matrices exactes, précision arbitraire. Coût payé **une seule fois, à la première question formelle**, puis mis en cache (hors ligne). |
| math.js 15 | 650 Ko (≈ 175 Ko gzip) | Pas d'intégrale ni de limite (`math.integral`/`math.limit` absents au test), simplification limitée, fractions exactes seulement partielles. Insuffisant. |
| Nerdamer 2.0 | 541 Ko (≈ 135 Ko gzip) | **Candidat sérieux et 100× plus léger** : factor/solve/diff/∫/limite corrects sur notre jeu de référence, sauf `defint` (erreur sur les bornes numériques). Moins de garanties que SymPy sur les cas difficiles (domaines, limites subtiles, intégrales spéciales) et pas de précision arbitraire. Piste « mode léger » possible si les 20 Mo deviennent un problème (§13). |
| Algebrite 1.4 | 851 Ko (≈ 168 Ko gzip) | `limit` non évaluée (renvoie l'expression) ; maintenance faible. Écarté. |
| Pseudo-CAS maison (regex) | — | **Refusé** (consigne de la tâche). Le Fast Engine n'est pas un pseudo-CAS : arithmétique **rationnelle exacte** + théorèmes élémentaires, avec renvoi au vrai CAS dès qu'on en sort. |

Mesures de poids : voir « Poids réels » dans `vendor/README.md` et §10. La compatibilité GitHub Pages / Chrome / Safari / WKWebView est traitée au §11 (ce qui est prouvé et ce qui ne l'est pas).

## 5. Exactitude et conventions (jamais de choix silencieux)

* **Exact d'abord** : `1/3`, `√2`, `π`, `194481/160` restent exacts ; l'arrondi n'existe qu'à l'**affichage** (`1000 € à 5 % sur 4 ans = 194481/160 = 1215,50625 → 1215,51 €`).
* **Domaine réel par défaut** : `√(−1)`, `ln(0)`, `ln(−3)` sont refusés (`DOMAIN`) avec la note « dans ℂ, √(−1) = i » ; une équation sans racine réelle donne ses **solutions complexes** avec la note ; « dans les réels / dans ℂ » est reconnu.
* **Logarithme** : `log(x)` = base 10 **et la note le dit** ; `ln` = népérien.
* **Statistiques** : variance / écart-type sans précision → **population ET échantillon** affichés, avec « convention non précisée ». Quartiles : inclusif (Excel `QUARTILE.INC`) + exclusif affichés.
* **Loi normale** : `N(μ ; σ)` (convention française, 2ᵉ paramètre = σ) ; `N(a, b)` est `AMBIGUOUS` (σ ou σ² ?) — jamais deviné.
* **Finance** : intérêts composés par défaut (signalé) ; mensualités : taux périodique proportionnel (signalé) ; TRI : plusieurs TRI possibles signalé.
* **Notation** : `x^2`, `x²`, `sqrt(x)`, `√x`, `|x|`, `1/2`, `0,5`, `0.5`, `1 000,50`, `50 %`. Virgule ambiguë (`0,5,3`) et groupes de milliers ambigus (`500 600 300`) : **refus explicite**, jamais une lecture inventée.

## 6. MathVerifier et statuts

Statuts internes : `VERIFIED_EXACT` · `VERIFIED_NUMERICALLY` · `COMPUTED_NOT_INDEPENDENTLY_VERIFIED` · `UNSUPPORTED` · `INVALID_INPUT` · `AMBIGUOUS`.

| Résultat | Contrôle (indépendant du moteur qui l'a produit) | Statut |
|---|---|---|
| Racines, systèmes | réinjection **exacte** (rationnels BigInt) | `VERIFIED_EXACT` |
| Factorisation / développement polynomial | redéveloppement exact | `VERIFIED_EXACT` |
| Dérivée / primitive polynomiales | dérivation de la primitive, différences centrées | `VERIFIED_EXACT` |
| Inverse de matrice | `A·A⁻¹ = A⁻¹·A = I` exact | `VERIFIED_EXACT` |
| Dérivée / primitive non polynomiales (CAS) | différences centrées (Richardson) en plusieurs points | `VERIFIED_NUMERICALLY` |
| Intégrale définie (CAS) | quadrature de Gauss-Legendre ; **bornes infinies** : changement de variable `x = a + t/(1−t)` puis quadrature | `VERIFIED_NUMERICALLY` |
| Limite (CAS) | évaluation de part et d'autre / à grande valeur, **chaque côté séparément** ; limite inexistante → les deux limites unilatérales | `VERIFIED_NUMERICALLY` |
| Équation transcendante (CAS) | substitution flottante des solutions réelles ; les candidats **parasites** (qui ne vérifient pas l'équation de départ, ex. `ln x + ln(x−1) = ln 6 → −2`) sont **écartés** | `VERIFIED_NUMERICALLY` |
| Système non linéaire (CAS) | chaque solution réinjectée dans chaque équation (l'absence d'autres solutions n'est pas contrôlée, et c'est dit) | `VERIFIED_NUMERICALLY` |
| Valeurs propres > 2×2 (CAS) | `det(A−λI) ≈ 0` pour chacune + somme = trace + produit = déterminant (une valeur manquante est détectée) | `VERIFIED_NUMERICALLY` |
| Cas non contrôlable indépendamment | — | `COMPUTED_NOT_INDEPENDENTLY_VERIFIED` |

**Un contrôle numérique n'est jamais présenté comme une preuve** : la carte dit « Vérifié numériquement » + « c'est une vérification, pas une démonstration », et le bloc LLM impose « checked numerically, not proven ».
**Un CAS qui se trompe n'est pas cru — et n'est pas affiché.** Quand un contrôle **concret** échoue (dérivée/primitive/racines/système/inverse faux, limite dont les valeurs se stabilisent ailleurs, résultat non équivalent), le contrôle renvoie `refuted` et l'orchestrateur répond `UNSUPPORTED / CAS_RESULT_REFUTED` (« le contrôle indépendant contredit ce résultat : il n'est pas affiché »). « Je ne sais pas contrôler » (`COMPUTED_NOT_INDEPENDENTLY_VERIFIED`) reste distinct de « le contrôle a échoué ». Les intégrales ne sont volontairement **pas** « réfutables » (la quadrature d'une singularité intégrable est imprécise : on ne cache pas un résultat juste). Tests `PASS MOCK` : faux CAS renvoyant `lim sin x/x = 2` ou `(sin x)′ = −sin x`.
Le modèle de langage **ne vérifie jamais** le CAS.

## 7. Intégration au chat (Questions libres)

`aiGeneralAsk()` (index.html) :

1. `RAssist.analyzeQuestion` (existant) puis `mathProblemFor()` → `RevemMath.engine.analyze()` — **gratuit, sans modèle**. Une question de cours (« Qu'est-ce que la VAN ? », « Comment calculer la VAN ? ») **ne déclenche pas** le moteur (garde : aucun chiffre, ou question de définition) ; « what is 2+2 », « qu'est-ce que 15 % de 80 », « what is the derivative of x^2 » sont des calculs.
2. `mathSolve()` → Fast Engine ou CAS (statut « Calcul en cours… » / « Initialisation du moteur mathématique… » **uniquement pendant un vrai chargement**).
3. **Carte** de résultat (statut, type, problème/résultat en KaTeX, étapes en français, notes traduites) affichée **au-dessus** de l'explication.
4. **Stratégie dédiée** (`assistant-core.js` → `mathStrategy`) : budget réduit (≤ 320 jetons pour une question normale), température 0,3, format imposé « méthode / équations une fois / résultat / vérification courte / STOP », lexique français — voir `AI_OUTPUT.md` §14. Les équations nues (`x² - 5x + 6 = 0`) sont reconnues sans verbe.
   Si le modèle est prêt : prompt avec le bloc `MATH ENGINE RESULT (… authoritative)` (en-tête propre via `calc.header`, `SYSTEM_BASE` inchangé) → le modèle **explique**, il n'a pas le droit de recalculer ni de remplacer un nombre. Si le calcul est `UNSUPPORTED`/`AMBIGUOUS`/invalide, le bloc interdit d'énoncer un résultat.
5. Sans modèle : le résultat vérifié est **quand même affiché** (la barre de question n'est plus désactivée) + indice « charge le modèle IA pour une explication ». Une question non mathématique garde l'erreur habituelle « modèle non chargé ».
6. Si l'explication échoue (erreur du modèle) : la carte reste affichée, l'erreur est annoncée.
   **Calcul chiffré non reconnu** (« calcule 12 m × 3 m », « f(3) avec f(x)=… », intention `CALCULATION` avec des chiffres, ni le moteur ni l'ancienne calculatrice ne le reconnaissent) : le prompt reçoit un `MATH ENGINE REPORT` (« aucun résultat vérifié n'existe : donne une estimation non vérifiée, dis-le, montre la méthode ») et l'élève voit une note sous la réponse « Calcul non vérifié : … ce résultat vient du modèle seul ». Limite : seules les questions classées `CALCULATION` sont couvertes (« 5 kg à 3 € le kg », « TVA 20 % sur 150 € » ne le sont pas).
7. **Arrêter** : un calcul formel en cours est **tué** (`worker.terminate()`), aucune carte n'est ajoutée.
8. Les connaissances REV-EM ne sont pas injectées pour un calcul (le moteur fait autorité) — `diag.knowledgeStatus = "skipped:calculation"`.

**M'ENTRAÎNER** : « donne-moi un exercice sur les dérivées » → exercice généré de façon **déterministe** (graine) ; la réponse de l'élève est **comparée mathématiquement** (`1/2 = 0,5 = 2/4`, `(x+1)² = x²+2x+1`, forme factorisée exigée si demandé) ; erreur → pistes **Réessayer / Indice / Étape suivante / Voir la solution** (la solution n'est jamais donnée d'emblée). Fonctionne sans modèle.
**EXPLIQUER** : une demande d'explication sans calcul n'active **pas** le moteur (zéro coût).

## 8. Sécurité

* **Interdits respectés** : `eval()`, `Function(userInput)`, JS arbitraire, Python arbitraire. L'utilisateur fournit une **expression mathématique**, jamais du code.
* Couche de parsing/validation : normalisation → jetons → **grammaire à liste blanche** (nombres, symboles de 1 lettre, constantes `pi e i oo`, opérateurs, ~25 fonctions nommées) ; longueur ≤ 1200, jetons ≤ 400, profondeur ≤ 60, entiers/exposants/factorielles bornés.
* Le CAS ne reçoit **pas du texte** mais l'**AST JSON** ; `math-cas.py` le convertit par une **table de construction fermée** : nœud/fonction inconnu → refus ; noms de variables validés (`^[A-Za-z][A-Za-z0-9_]{0,15}$`) ; entiers validés ; nombre de nœuds ≤ 600 **avant** construction. Aucun `sympify`, `parse_expr`, `eval`, `exec`, `__import__`, `compile`, `open`, `getattr` (test statique + 15 requêtes forgées envoyées directement à Python).
* Aucune donnée utilisateur ne quitte l'appareil : tout s'exécute en local ; aucun secret ; aucun appel réseau autre que le chargement des fichiers de `vendor/`.
* Rendu : KaTeX avec `trust:false`, `strict:"ignore"`, `maxExpand:200` ; tout texte injecté dans le DOM passe par `escapeHtml` (les attributs `data-tex` sont échappés).
* Délais : le calcul formel est borné (20 s par défaut) ; à l'expiration le Worker est **tué** (SymPy n'est pas interruptible) et recréé à la demande.

## 9. Performance, cache, PWA

* **Pas de blocage du démarrage** : chargement paresseux ; « Initialisation du moteur mathématique… » n'est affiché que pendant un chargement réel (jamais quand le moteur est prêt, jamais au démarrage).
* **Web Worker dédié** (`math-cas-worker.js`, module) — séparé d'`ai-worker.js` : le calcul formel et la génération WebLLM n'ont aucune raison de se partager un fil ni de s'attendre.
* **Service worker** : `math-*.js` et `math-cas.py` sont dans le shell précaché (`CACHE_VERSION = rev-em-v11`) ; `vendor/` **n'est pas précaché** (le précache est « tout ou rien » et pèserait sur chaque installation) mais entre, à la première utilisation réelle, dans un cache **cache-d'abord** `rev-em-math-v1`, **indépendant de `CACHE_VERSION`** (monter la version de l'app ne re-télécharge pas 20 Mo) et protégé dans `activate`. Les `.py` sont « réseau d'abord » comme les `.js`.
* Aucun cache de résultats : les calculs sont recalculés à la demande (volumétrie négligeable, cf. règle du projet).

## 10. Performances **mesurées** (Linux, Node 22 / Chromium headless ; réseau local, donc le temps de téléchargement réel n'est PAS inclus)

| Mesure | Valeur |
|---|---|
| Fast Engine + vérification (10 problèmes de référence × 5) | moyenne ≈ 0,5 ms, pire ≈ 3 ms (Node) |
| Chargement Pyodide + SymPy (fichiers locaux) | ≈ 7,9–8,5 s (Node), ≈ 7,8–9,0 s (Chromium, `casLoadTime`, plusieurs exécutions) |
| 1ʳᵉ question formelle, chargement compris (Chromium) | ≈ 8,1–8,7 s |
| Calcul SymPy une fois chargé (limite 270 ms ; dérivée, intégrale, équation : de 3 ms à ≈ 0,5 s ; 1ʳᵉ intégrale 200–530 ms) | « à chaud » ; la 1ʳᵉ résolution d'un polynôme de degré 5 coûte ≈ 4,6 s (import différé de SymPy) |
| 2ᵉ question formelle (aller-retour complet dans la page) | ≈ 1,1 s |
| Arrêt d'un calcul (bouton Arrêter) | < 2 s (worker tué) |
| Redémarrage du CAS après un kill / timeout | ≈ 8,9 s (re-création de l'interpréteur ; fichiers déjà en cache) |
| Hors ligne après un premier usage (Chromium + service worker réel) | fonctionne (≈ 8,8 s, redémarrage du CAS depuis le cache) |
| Compilation + exécution des 5 scripts `math-*` au démarrage de la page | ≈ 8 ms (V8 sous Node ; **non mesuré sur navigateur ni sur téléphone**) |
| Fichiers `vendor/` absents (404) | échec expliqué en < 1 s, moteur exact intact, nouvel essai possible |

## 11. Compatibilité — ce qui est prouvé, et ce qui ne l'est pas

| Environnement | Statut |
|---|---|
| Chromium (Playwright, Linux) — page réelle, worker de module réel, Pyodide/SymPy réels, service worker réel, hors ligne | **PASS** |
| GitHub Pages (hébergement statique) | Conçu compatible : fichiers relatifs (`new URL("./", import.meta.url)`), `.wasm` servi en `application/wasm` par Pages. **NOT TESTED REAL GITHUB PAGES** (non publié : la branche Pages n'a pas été avancée sans accord explicite). |
| Safari (macOS/iOS) | **NOT TESTED SAFARI.** Exigences connues : BigInt (Safari ≥ 14), Worker de module + `import()` dans un worker (Safari ≥ 15), WebAssembly. Aucune regex lookbehind (test `compat-syntax`). |
| WKWebView / application macOS | **NOT TESTED WKWEBVIEW**, **NOT TESTED MAC.** Les mêmes exigences s'appliquent ; le chargement de 20 Mo + démarrage ≈ 9 s est à mesurer sur l'appareil réel. |
| Navigateur sans Worker de module | Le CAS répond `CAS_UNSUPPORTED_ENV` ; le Fast Engine (≈ 80 % des cas courants) fonctionne quand même. |

## 12. Limites actuelles et opérations non prises en charge

* **Dérivées d'ordre > 1** non polynomiales, intégrales impropres à singularité aux bornes (`∫₀^∞ x^(−1/2) e^(−x) dx`…), limites à convergence très lente : calculées par SymPy mais **non re-contrôlables** → `COMPUTED_NOT_INDEPENDENTLY_VERIFIED` (ou `UNSUPPORTED` si SymPy ne conclut pas).
* **Équations** : toute équation **non polynomiale** (log, racine, puissance variable, exp, trigonométrie…) est résolue **dans les réels** (signalé) — SymPy sur ℂ renvoie des racines parasites pour ces équations ; polynomiales → solutions complexes incluses ; famille infinie (`sin x = 0`) vérifiée sur un échantillon ; degré ≥ 5 → racines **approchées**, étiquetées ; systèmes non linéaires → CAS (non re-contrôlés exactement).
* **Statistiques** : intervalle de confiance avec σ inconnu (loi de Student) **non pris en charge** (message explicite) ; régression/corrélation : séries entre crochets obligatoires.
* **Probabilités** : binomiale, normale, Bayes, espérance/variance de la binomiale ; Poisson, loi exponentielle, etc. : non pris en charge.
* **Finance** : valeur actuelle/future, intérêts simples/composés, VAN, TRI (bissection), mensualités, taux équivalent/proportionnel, TCAM, pourcentages, évolutions. Annuités et rentes générales : seule la mensualité d'un emprunt est prise en charge.
* **Matrices** : taille ≤ 8×8 en exact ; valeurs propres 2×2 exactes, > 2×2 via le CAS ; vecteurs propres via le CAS.
* **Unités** : `€`, `%`, années, mois sont interprétées ; `kg`, `m`, `m²`… **ne sont pas** interprétées (la question n'est pas reconnue ; voir « calcul chiffré non reconnu » §7). Fonctions définies (`f(x)=…, calcule f(3)`), indépendance d'événements, espérance d'une loi discrète en tableau, lois de Poisson/exponentielle, annuités générales : **non pris en charge**.
* **Libellés des étapes** (« polynôme : … », indices de l'exercice) : **français uniquement** ; dans les autres langues les étapes sont masquées et c'est le modèle qui explique dans la langue de l'utilisateur. Le statut, les notes, les erreurs, les libellés de statistiques et les cas particuliers sont traduits (FR/EN/ES/DE/IT).
* La carte suit la langue de l'**interface** pour ses libellés et la langue de la **question** pour les nombres et libellés calculés ; elles coïncident presque toujours.
* **Poids** : 20,4 Mo au premier calcul formel (puis cache). Une option « mode léger » (Nerdamer, 135 Ko gzip) reste possible si ce coût gêne.
* `localCalculation` (ancienne calculatrice flottante d'`assistant-core.js`) **n'est plus appelée** quand le nouveau moteur reconnaît la question, mais reste en repli : à retirer plus tard, après observation.

## 13. API réutilisable (futur REV-EM Excel Lab — non construit ici)

`RevemMath.api` : `parse`, `evalExact`, `evalFloat`, `toLatex`, `toText`, `Rat`/`rat`, `mean`, `descriptive`, `covariance`, `binomial`, `normalCdf`, `normalInv`,
`npv`, `irr`, `compound`, `annuityPayment`, `compareAnswer`, `equivalent`. Toutes sont pures, exactes quand c'est possible, et ne dépendent ni du DOM ni de `state`.
`RevemMath.engine.solve(texte, { cas, lang, timeoutMs })` est l'entrée de haut niveau (asynchrone) ; `RevemMath.engine.analyze` n'exécute rien.

## 14. Diagnostic développeur (panneau de diagnostic de l'assistant uniquement)

`mathProblemType`, `engineUsed` (`fast`/`cas`), `exactResult`, `approximateResult`, `verificationMethod`, `verificationStatus`, `calculationTimeMs`, `fastMs`, `casMs`, `casLoadTimeMs`, `errorCode`.
Réglage console : `window.revemMathConfig = { timeoutMs: 20000 }`.

## 15. Tests

| Fichier | Contenu | Statut |
|---|---|---|
| `tests/math-engine.test.js` (182 PASS + 13 PASS MOCK) | moteur pur : références, notations, pièges, sécurité (22 charges hostiles), MathVerifier (un résultat faux n'est jamais « vérifié »), réponses d'élève, stats/probas/finance, routage avec **faux CAS**, bloc LLM, analyseur (19 questions de cours sans faux positif), exercices, **tests aléatoires** (400 polynômes interprétés fidèlement, 300 expressions rationnelles contre un oracle BigInt indépendant, 120 trinômes), performance | PASS / PASS MOCK (CAS) |
| `tests/math-cas.test.mjs` (58 PASS) | **vrai SymPy** sous Node : références, pièges (non-élémentaire, divergence, `x^x=2`…), **requêtes forgées** envoyées à `math-cas.py`, performance | PASS |
| `tests/math-ui.test.mjs` (85 PASS + 5 PASS MOCK) | **vrai Chromium** : démarrage sans téléchargement, chargement paresseux + message, timeout qui tue le worker, bouton Arrêter, prompt réellement posté au modèle (**faux** transport → PASS MOCK), exercice, 5 langues, responsive 375/768 px, service worker + **hors ligne**, **fichiers du CAS injoignables** | PASS / PASS MOCK (LLM) |

Régression : toutes les autres suites existantes (voir le rapport de livraison).

**NOT TESTED** : vrai WebLLM avec le bloc math (la qualité de l'explication d'un vrai modèle n'est pas mesurée), Safari, WKWebView, Mac, GitHub Pages réel.

## 16. Protocole à exécuter sur Mac (Safari, application WKWebView) — non fait ici

Rien de ce qui suit n'a pu être testé dans l'environnement de développement (Linux, Chromium seulement). À faire avec la version publiée ou un serveur local :

1. **Le moteur sans CAS** (Safari, puis l'app) — console : `await RevemMath.engine.solve("factorise x^2-5x+6")` → `exact.text === "(x - 2)(x - 3)"`, `status === "VERIFIED_EXACT"`. Si cette ligne échoue, BigInt ou un script est en cause (Safari < 14).
2. **Le CAS** — poser dans le chat : `limite de sin(x)/x quand x tend vers 0`. Attendu : « Initialisation du moteur mathématique… » (≈ 8–15 s la première fois), puis une carte « Calcul formel · Vérifié numériquement » avec `1`. Console : `state.aiChat.diag.math` (`casLoadTimeMs`, `calculationTimeMs`) — **notez les valeurs**. Si la carte annonce « Le moteur de calcul formel n'a pas pu être chargé », ouvrez la console : le code est `CAS_UNSUPPORTED_ENV` (worker de module non supporté — Safari < 15), `CAS_ASSET_MISSING` (un fichier de `vendor/` n'est pas servi) ou `CAS_INIT_TIMEOUT`.
3. **Second calcul** — `dérivée de sin(x)*exp(x)` : doit répondre en ≈ 1 s sans nouvelle initialisation.
4. **Arrêter / délai** — poser `intégrale de exp(-x^2)*sin(x)^5*x^3 de 0 à oo`, cliquer Arrêter (arrêt < 2 s attendu) ; recommencer sans cliquer : au bout de 20 s, « Le calcul a pris trop de temps ».
5. **Hors ligne** — après l'étape 2, couper le Wi-Fi, recharger, refaire l'étape 3. Attendu : fonctionne (cache `rev-em-math-v1`). Vérifiez dans Safari → Développement → Stockage que le cache existe.
6. **Rendu** — la formule de la carte est composée par KaTeX (polices mathématiques), pas en texte brut ; test en mode sombre et à 375 px.
7. **Mémoire** — Moniteur d'activité pendant l'étape 2 (le CAS ajoute l'interpréteur Python : quelques centaines de Mo possibles) ; vérifiez que WebLLM chargé en même temps reste stable (**GPU/mémoire unifiée non mesurés ici**).
8. **Avec le vrai WebLLM** — poser `Résous x^2-5x+6=0`, `Dérive x^3+2x^2-5x+3`, `1000 € à 5 % pendant 4 ans`, puis un cours (`Qu'est-ce que la VAN ?`) : le modèle doit **reprendre** (2 ; 3), (3x²+4x−5), 194481/160 sans changer un nombre, et ne pas déclencher le moteur sur la question de cours. La **qualité de l'explication d'un vrai modèle n'a pas été mesurée**.
9. Reporter tout écart (statut réel : `PASS` / `FAIL` / `NOT TESTED`) dans une issue : navigateur + version, console, `diag.math`.

---

> **Tuteur Maths & Stats** (Résoudre · Expliquer · M'entraîner, exercices générés et vérifiés par ce moteur, suivi et maîtrise) : voir [`MATH_TUTOR.md`](MATH_TUTOR.md).
