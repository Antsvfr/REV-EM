---
name: revem-math
description: Moteur mathématique déterministe de REV-EM (math-core/fast/verify/engine, CAS SymPy/Pyodide, rendu KaTeX, mode exercice). À consulter avant de toucher aux calculs, aux problèmes de maths dans le chat, à math-*.js, math-cas.py ou vendor/.
---

# REV-EM Math Engine

Lire d'abord `AI_MATH.md` (architecture, mesures, limites). Principe non négociable :
**le LLM n'est ni une calculatrice ni un CAS.** Un résultat mathématique n'est jamais fiable parce que WebLLM l'a produit.

## Règles

1. **Calculer, vérifier, puis expliquer.** Pipeline : `analyze` → Fast Engine (exact) → CAS si `NEEDS_CAS` → MathVerifier → carte + bloc LLM. Ne pas créer de second pipeline.
2. **Jamais d'invention.** Si le moteur ne sait pas ou ne peut pas vérifier : `UNSUPPORTED` / `COMPUTED_NOT_INDEPENDENTLY_VERIFIED` / `AMBIGUOUS` — jamais un résultat « propre ». Un contrôle numérique est `VERIFIED_NUMERICALLY`, **jamais** une preuve.
3. **Le moteur ne doit jamais s'auto-valider sur une interprétation fausse.** Toute modification de l'analyseur (`analyze`, `cleanExpr`, regex de mots-clés) doit passer le test par propriété de `tests/math-engine.test.js` (§2ter) : une régression passée (signe « − » en tête perdu) donnait un résultat « vérifié » mais faux.
4. **Sécurité** : jamais `eval`, `Function`, `sympify`, `parse_expr`, `exec`, `__import__`. L'utilisateur fournit une expression ; le parseur (liste blanche) produit un AST JSON ; `math-cas.py` le convertit par une table fermée. Tout nouveau nœud/fonction s'ajoute **aux deux côtés** (FUNCS dans `math-core.js` + table `build()` dans `math-cas.py`) avec test.
5. **Conventions explicites** : domaine réel par défaut, `log` = base 10 (noté), variance population ET échantillon quand non précisé, `N(a, b)` ambigu → refus. Ne jamais choisir en silence.
6. **Pur + branchement** : `math-*.js` ne connaissent ni DOM ni `state` ; le rendu (carte, KaTeX, i18n, chat) vit dans `index.html`. KaTeX est chargé **à la demande** (`vendor/katex/`).
7. **Lazy** : rien de lourd au démarrage. `vendor/pyodide`, `vendor/py` ne sont téléchargés qu'au premier calcul formel ; « Initialisation du moteur mathématique… » seulement pendant un vrai chargement. Le Worker est tué à l'échéance (`terminate`) ou au bouton Arrêter.
8. **PWA** : `math-*.js` / `math-cas.py` sont dans `SHELL_URLS` ; `vendor/` dans `MATH_CACHE` (cache-d'abord, indépendant de `CACHE_VERSION`). Changer une version vendor = changer `MATH_CACHE` + `vendor/README.md` (SHA-256).
9. **i18n** : statut, notes, erreurs, types → clés `math.*` dans les 5 langues (`translations.js`). Les libellés calculés par les moteurs (statistiques, cas particuliers) passent par `E.localize` (table fermée). Les étapes sont en français uniquement (masquées ailleurs).
10. **Tests honnêtes** : `math-engine.test.js` (pur + faux CAS = PASS MOCK), `math-cas.test.mjs` (vrai SymPy), `math-ui.test.mjs` (vrai Chromium). Ne jamais annoncer Safari / WKWebView / Mac / GitHub Pages sans test réel (`NOT TESTED …`).

## Ajouter une capacité
1. Fast Engine si exact et élémentaire (math-fast.js), sinon route CAS (`casRequest` + `op_*` dans math-cas.py).
2. Un **contrôle indépendant** dans `math-verify.js` (sinon le statut reste `COMPUTED_NOT_INDEPENDENTLY_VERIFIED`).
3. Mots-clés d'analyse dans les 5 langues + tests « ne déclenche pas sur une question de cours ».
4. Test de référence + test piège + (CAS) test avec faux CAS qui se trompe.
