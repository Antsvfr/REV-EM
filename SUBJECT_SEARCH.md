# Recherche de « Mes matières »

```
index.html                mesure ce qui est vrai (allSubjects(), la saisie)
   │
   ▼
subject-search.js         filtre et classe (ne connaît ni le DOM, ni les matières)
   │
   ▼
index.html                affiche, et exécute le clic sur un résultat
```

Même découpage que `smart-revision.js`, `command-center.js`,
`quick-actions.js` : un moteur pur, un branchement. `subject-search.js` se
teste sous Node en quelques millisecondes — `tests/subject-search.test.js`,
19 vérifications.

## Le classement — une cascade, jamais un mélange

Trois niveaux, du plus strict au plus permissif :

1. **commence par la saisie** — `"mar"` → *Marketing*
2. **un mot commence par la saisie** — `"mar"` → *Gestion du marketing*
3. **contient la saisie** — `"commercial"` → *Management commercial*

Dès qu'un niveau trouve au moins un résultat, les niveaux suivants ne sont
**pas** consultés. C'est ce qui empêche une correspondance faible de
s'intercaler entre deux correspondances fortes : pour `"mar"` sur
`[Management, Marketing, Gestion du marketing]`, seule *Marketing*
apparaît — *Gestion du marketing* ne sort que si rien ne COMMENCE par
`"mar"`.

Dans un même niveau, tri alphabétique via `Intl.Collator("fr", {sensitivity:
"base"})` : *Économie* se classe avec les E, jamais après le Z d'un tri par
code de caractère brut.

Accents et casse n'ont pas à être tapés justes : `"eco"` trouve *Économie*,
`"MARKETING"` trouve *Marketing* — même normalisation (NFD, marques
combinantes retirées) que `command-center.js`, dupliquée à dessein plutôt
que partagée, pour que ce fichier reste utilisable seul.

## Future-proof, sans construire la recherche globale

`filterAndSortSubjects(query, items, getText)` ne connaît pas les matières :
`getText` dit où lire le nom (`.name` par défaut), donc la même fonction
filtre déjà des chapitres dans ses propres tests
(`tests/subject-search.test.js`, scénario 11, sur `.title`). Le jour où une
recherche globale (chapitres, cours, examens…) rejoint le Command Center,
ce moteur n'a pas à être réécrit — seulement enregistré comme une source de
plus.

## L'interface

- **Aucun bouton, aucune touche Entrée** : le filtrage part de l'événement
  `input`, comme le Command Center.
- **Le focus ne se perd jamais.** Un ré-rendu complet à chaque frappe
  détruit et recrée l'`<input>` — sans restitution explicite du focus et de
  la position du curseur juste après, taper une seconde lettre serait
  impossible. Même pattern que `ccRender()` (voir COMMAND_CENTER.md).
- **Pas de focus automatique à l'arrivée sur la page.** Contrairement au
  Command Center — une palette qu'on ouvre exprès pour taper — cette
  recherche vit dans une page normale : voler le focus au premier rendu
  ferait surgir le clavier sur mobile sans qu'on l'ait demandé.
- **La barre n'apparaît que s'il y a plus d'une matière** : avec zéro ou une
  seule matière, il n'y a rien à chercher.
- **L'état vide sans recherche est inchangé** : zéro matière au total
  affiche toujours le même message qu'avant cette fonctionnalité — la
  recherche est une couche au-dessus, jamais un remplacement de l'existant.

## Aucune deuxième liste de matières

`filterAndSortSubjects` reçoit `allSubjects()` — la même source que
l'affichage groupé par semestre — et ne la copie ni ne la modifie : la
liste passée en argument ressort dans le même ordre qu'elle est entrée si
la recherche est vide (vérifié : `tests/subject-search.test.js`, scénario
12). Aucune donnée n'est dupliquée, aucun appel réseau n'est fait : tout
part de ce qui est déjà chargé côté client.

## Tests

| Suite | Vérifie |
|---|---|
| `tests/subject-search.test.js` — 19 | la cascade des trois niveaux, le tri sensible à la locale, les accents/la casse, un accesseur de texte personnalisé, la non-mutation de la liste d'origine, les entrées limites |
| `tests/library-search.test.mjs` — 61 | le champ réel, la frappe lettre par lettre, le focus qui survit au ré-rendu, le curseur qui ne revient jamais au début, le bouton ×, Échap, la tabulation, l'état « aucun résultat », le responsive à trois largeurs, les cinq langues, le mode invité, et qu'aucune navigation existante (ouvrir une matière, importer un cours, en ajouter une) n'a été cassée — depuis la liste groupée ET depuis un résultat de recherche |
