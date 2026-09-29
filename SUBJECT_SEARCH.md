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
25 vérifications.

## Le classement — cinq niveaux, tous affichés

Du plus pertinent au moins pertinent :

1. **le nom EST la saisie** — `"marketing"` → *Marketing*
2. **le nom commence par la saisie** — `"mar"` → *Marketing*
3. **un mot commence par la saisie** — `"mar"` → *Gestion du marketing*
4. **le nom contient la saisie** — `"ting"` → *Marketing*
5. **égalité : ordre alphabétique** (`Intl.Collator`), puis ordre d'origine

Les niveaux se **mélangent dans une seule liste**, triée par niveau. Pour
`"mar"` sur `[Marketing, Management, Management commercial, Gestion du
marketing, Finance]` : *Marketing*, puis *Gestion du marketing* — la
correspondance forte d'abord, la plus faible ensuite, jamais masquée.

> **Changement délibéré (étape « Recherche premium + synchronisation »).**
> La première version était une *cascade* : dès qu'un niveau trouvait un
> résultat, les suivants n'étaient pas consultés — pour `"mar"`, seule
> *Marketing* sortait, et *Gestion du marketing* disparaissait alors qu'elle
> correspond bien. Le cahier des charges de cette étape exige le contraire
> (exemple `"mar"` → *Marketing*, *Gestion du marketing*). Le classement
> remplace donc le filtrage en cascade ; les tests qui affirmaient
> l'ancienne cascade ont été réécrits en conséquence, pas contournés.

**Plusieurs mots** (`"gestion mar"`) : chaque mot saisi doit commencer un mot
du nom (niveau 3) ou apparaître dans le nom (niveau 4).

**Accents et casse** : ignorés *pour la recherche seulement*. Le nom affiché
est toujours l'original (*Économie*, jamais *economie*). Même normalisation
(NFD, marques combinantes retirées) que `command-center.js`, dupliquée à
dessein plutôt que partagée, pour que ce fichier reste utilisable seul.

**Tri** : `Intl.Collator("fr", {sensitivity: "base", numeric: true})` —
*Économie* se classe avec les E, et *Chapitre 2* vient avant *Chapitre 10*.

**Vitesse** : 2 000 matières classées en quelques millisecondes, à chaque
frappe, sans index (mesuré dans `tests/subject-search.test.js`, scénario
6 septies : seuil 30 ms). Un index pré-calculé n'est donc **pas** construit :
il n'aurait à résoudre aucun problème réel, et il ajouterait un état à
invalider à chaque création/renommage de matière.

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
- **Le champ n'est jamais recréé.** Une frappe ne réécrit que la zone de
  résultats (`#lib-results`, voir `updateLibrarySearch()`) : le champ garde
  son focus, son curseur et une éventuelle composition de clavier mobile en
  cours. (La première version ré-affichait toute la page à chaque frappe et
  restituait le focus après coup ; la mise à jour ciblée supprime ce
  contournement.) Les cartes sont cliquables par délégation d'événement sur
  leur conteneur — un seul écouteur, jamais un par carte à ré-attacher.
- **Aucune requête réseau par lettre** — ni Supabase, ni rien d'autre : tout
  part de `allSubjects()`, déjà en mémoire (vérifié au navigateur : aucune
  requête sortante pendant la frappe).
- **Échap et ×** effacent la saisie et remettent le focus dans le champ ; le
  bouton × n'existe dans le DOM que s'il y a quelque chose à effacer.
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
| `tests/subject-search.test.js` — 25 | les cinq niveaux mélangés (exemple « mar »), les mots multiples, l'égalité stable, l'alias `searchSubjects`, la vitesse, le tri sensible à la locale, les accents/la casse, un accesseur de texte personnalisé, la non-mutation de la liste d'origine, les entrées limites |
| `tests/library-search.test.mjs` — 73 | le champ réel qui n'est jamais recréé (même nœud, focus, curseur, zéro rendu complet), aucune requête réseau, la frappe lettre par lettre, le focus qui survit au ré-rendu, le curseur qui ne revient jamais au début, le bouton ×, Échap, la tabulation, l'état « aucun résultat », le responsive à trois largeurs, les cinq langues, le mode invité, et qu'aucune navigation existante (ouvrir une matière, importer un cours, en ajouter une) n'a été cassée — depuis la liste groupée ET depuis un résultat de recherche |
