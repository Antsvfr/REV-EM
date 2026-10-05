# vendor/ — dépendances auto-hébergées du moteur mathématique

Rien ici n'est chargé au démarrage de l'application : ces fichiers ne sont téléchargés que lorsqu'un calcul
formel est réellement demandé (voir `math-cas-worker.js`, `AI_MATH.md`). Ils sont servis depuis le dépôt
(GitHub Pages) : aucune dépendance à un CDN, fonctionnement hors ligne après le premier usage (cache du
service worker, voir `sw.js`).

| Fichier | Rôle | Version | Licence | SHA-256 |
|---|---|---|---|---|
| `pyodide/pyodide.asm.wasm` | interpréteur CPython compilé en WebAssembly | Pyodide 314.0.7 (Python 3.14.2) | MPL-2.0 | `cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6` |
| `pyodide/pyodide.asm.mjs` | chargeur Emscripten | idem | MPL-2.0 | `f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635` |
| `pyodide/pyodide.mjs` | API JavaScript de Pyodide | idem | MPL-2.0 | `6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109` |
| `pyodide/python_stdlib.zip` | bibliothèque standard Python | idem | PSF-2.0 | `fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a` |
| `pyodide/pyodide-lock.json` | index des paquets Pyodide (exigé au démarrage) | idem | MPL-2.0 | `5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010` |
| `py/sympy-1.14.0-py3-none-any.whl` | calcul formel (SymPy) | 1.14.0 | BSD-3-Clause (`py/LICENSE-sympy.txt`) | `e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5` |
| `py/mpmath-1.4.1-py3-none-any.whl` | arithmétique à précision arbitraire (dépendance de SymPy) | 1.4.1 | BSD-3-Clause (`py/LICENSE-mpmath.txt`) | `dc4f0ea2304480d4a9a48a94c1020571558ade522b44a6912efac63a586e140f` |

Origine : paquet npm `pyodide@314.0.7` (fichiers du dossier racine) et roues pures-Python publiées sur PyPI.
Le texte de la licence MPL-2.0 de Pyodide est disponible sur https://www.mozilla.org/MPL/2.0/ ; les fichiers
Pyodide ne sont pas modifiés.

## Mettre à jour
1. Remplacer les fichiers, recalculer les SHA-256 ci-dessus (`sha256sum`).
2. Mettre à jour `WHEELS` dans `math-cas-worker.js` et `tests/helpers/node-cas.mjs`.
3. Incrémenter `MATH_CACHE_VERSION` dans `sw.js`.
4. Relancer `node tests/math-cas.test.mjs` (Pyodide + SymPy réels) et `tests/math-ui.test.mjs` (navigateur).

## KaTeX (rendu des formules)
| `katex/katex.min.js`, `katex/katex.min.css`, `katex/fonts/*.woff2` | rendu LaTeX → HTML | KaTeX 0.19.0 | MIT (`katex/LICENSE`) | js `103a5376…c8ae7`, css `144d9ea8…df303` |

La feuille de style est celle de KaTeX **sans** les formats de police `woff`/`ttf` (seul `woff2` est servi, supporté par Chrome, Safari ≥ 14 et WKWebView récents) et avec `font-display:swap`.
Chargé uniquement à la première carte de résultat mathématique (`mathLoadKatex()` dans `index.html`) ; s'il est indisponible, le texte brut de la formule reste affiché.
