# REV-EM Knowledge — comment ajouter une connaissance

Ces fichiers sont les **données** du moteur `knowledge-engine.js`. Ajouter une
connaissance = **ajouter un fichier JSON + une ligne dans `index.json`**.
**Le moteur ne change pas.** Principe d'ensemble : `AI_KNOWLEDGE.md`.

> **Règle absolue** (skill `revem-knowledge-quality`). Une connaissance écrite par une
> IA, ou de mémoire, n'est **pas** une connaissance vérifiée. Elle entre avec
> `"verified": false`. Elle ne devient `true` que lorsqu'une **source réelle** est
> renseignée et que quelqu'un l'a relue. Ne jamais inventer un livre, un auteur, une
> URL, une étude, un chiffre. Le contenu actuel de ce dossier est de la **démo**
> (`"status": "demo"`), jamais envoyé au modèle en mode « Auto ».

## Les 5 gestes

1. **Choisir le domaine** : `finance`, `economics`, `accounting`, `mathematics`,
   `statistics`, `marketing`, `management`. Le fichier va dans le dossier du même nom.
2. **Écrire le fichier** `ai-knowledge/<domaine>/<nom-en-kebab>.json` (modèle ci-dessous).
3. **Déclarer les sujets** dans `topics.json` s'il en introduit un nouveau (identifiant
   en `snake_case` + les mots qui le désignent, dans toutes les langues utiles).
4. **Le lister** dans `index.json` → tableau `files`. *Un fichier absent d'ici n'est jamais chargé.*
5. **Tester** : `node tests/knowledge-engine.test.js` — il valide le schéma, les doublons,
   les références, le manifeste, et le service worker (le précache doit lister le fichier :
   ajoute-le aussi dans `SHELL_URLS` de `sw.js` et incrémente `CACHE_VERSION`).
   Puis vérifie la **récupération** (section « Tester le retrieval » plus bas).

## Un exemple complet

Fichier `ai-knowledge/finance/compound-interest.json` — *exemple de guide : il n'est PAS
dans la base, il sert seulement à montrer chaque champ* :

```json
{
  "id": "finance.compound-interest",
  "domain": "finance",
  "topic": "compound_interest",
  "topics": ["compound_interest"],
  "title": "Intérêts composés",
  "aliases": ["intérêts composés", "capitalisation", "compound interest", "interés compuesto", "Zinseszins", "interesse composto"],
  "keywords": ["capitaliser", "valeur future", "future value", "taux annuel", "intérêts sur les intérêts"],
  "level": "beginner",
  "lang": "fr",
  "summary": "Avec les intérêts composés, les intérêts d'une période sont ajoutés au capital et produisent eux-mêmes des intérêts les périodes suivantes.",
  "facts": [
    "Capital final = capital initial × (1 + t)^n, pour un taux t par période et n périodes.",
    "À taux égal, les intérêts composés rapportent plus que les intérêts simples dès la deuxième période."
  ],
  "mechanisms": [
    "Chaque période, la base de calcul grossit : on touche des intérêts sur le capital ET sur les intérêts déjà acquis."
  ],
  "formulas": [
    { "name": "Valeur future", "expression": "VF = C0 × (1 + t)^n", "note": "C0 : capital initial ; t : taux par période ; n : nombre de périodes" }
  ],
  "examples": [
    "1 000 € à 5 % par an pendant 4 ans : 1 000 × 1,05^4 = 1 215,51 €."
  ],
  "commonMistakes": [
    "Multiplier le taux par la durée (c'est le calcul des intérêts simples).",
    "Mélanger un taux annuel et des périodes mensuelles."
  ],
  "avoid": [],
  "relatedConcepts": [],
  "sources": [],
  "verified": false,
  "status": "draft",
  "lastReviewed": null,
  "version": 1,
  "timeSensitive": false
}
```

Et dans `topics.json`, le sujet qu'il utilise :

```json
"compound_interest": { "domain": "finance", "terms": ["intérêts composés", "capitalisation", "compound interest", "interés compuesto", "zinseszins", "interesse composto"] }
```

Et dans `index.json` → `files` : `"finance/compound-interest.json"`.

### Chaque champ, en une ligne

| Champ | Rôle |
|---|---|
| `id` | **Unique et stable** : `domaine.nom-en-kebab` (`finance.npv`). Il commence par le domaine. Ne change jamais : d'autres éléments peuvent s'y référer. |
| `domain` / `topic` / `topics` | Où ranger l'élément ; `topic` = sujet principal, `topics` = tous ses sujets. Chaque sujet doit exister dans `topics.json`. |
| `title` | Le nom canonique du concept. Il vaut **100 points** s'il apparaît dans la question. |
| `aliases` | Les autres noms, **dans toutes les langues** (« obligation », « bond », « Anleihe »…). **80 points.** Une seule fiche pour les 5 langues : ne recopie pas l'élément. |
| `keywords` | Mots-clés **forts**, 15 points chacun (plafonné à 45). Pas de mots génériques (« taux » seul, « prix »…). |
| `avoid` | Expressions qui **annulent** l'élément (« obligation légale » pour les obligations financières). |
| `level` | `beginner` / `intermediate` / `advanced`. |
| `summary` | **L'idée clé en 1–2 phrases.** C'est ce qui est toujours envoyé. |
| `facts`, `mechanisms`, `formulas`, `examples`, `commonMistakes` | Le contenu. Court et **atomique** : 2–3 faits, 1–2 mécanismes, 1–2 formules, 1 exemple, 2 erreurs. Un élément long est un avertissement du validateur. |
| `relatedConcepts` | `id` d'autres éléments (doivent exister). Donne un petit bonus de classement, jamais un résultat à lui seul. |
| `sources` | **Uniquement des sources RÉELLES** : `{ "name", "type", "reference" }`. Vide tant qu'on n'en a pas. Elles seules peuvent être citées. |
| `verified` | `true` seulement si : au moins une source **ET** `lastReviewed` renseigné **ET** `status` ≠ `demo`. Le validateur refuse sinon. |
| `status` | `demo` (exemple pour tester), `draft` (brouillon : **jamais** envoyé), `reviewed` (relu). |
| `lastReviewed` | `AAAA-MM-JJ` de la dernière relecture, ou `null`. |
| `version` | Entier ≥ 1, à incrémenter à chaque changement de sens. |
| `timeSensitive` | `true` pour tout ce qui peut devenir faux (taux, fiscalité, réglementation, chiffres, entreprises). Le modèle reçoit alors « ne jamais présenter comme actuel ». |

### Le devenir « vérifié »

Quand tu as relu l'élément **contre une source réelle** :

```json
"sources": [ { "name": "<<NOM RÉEL DE LA SOURCE>>", "type": "book", "reference": "<<chapitre / page / lien réel>>" } ],
"verified": true,
"status": "reviewed",
"lastReviewed": "AAAA-MM-JJ",
"version": 2
```

Seul un élément `verified: true` est envoyé au modèle en mode « Auto » (le mode normal).

## Tester le retrieval

Dans `tests/knowledge-engine.test.js`, la section « 2. retrieval » est la liste des questions
attendues → éléments attendus. Pour ton nouvel élément, ajoute **deux** lignes :
une question qui **doit** le retrouver (dans plusieurs formulations / langues), et une
question voisine qui **ne doit pas** (c'est ce qui évite les faux positifs). Ou, dans la
console du navigateur (mode Démo) : `revemKnowledgeCompare("ta question")`.

## Ce que le moteur ne fait pas

Il ne vérifie pas que ce que tu écris est **vrai** : il vérifie la **forme** (schéma,
références, doublons, provenance). La justesse, c'est ta relecture, avec une source.
