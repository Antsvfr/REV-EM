# « Que veux-tu faire ? » — les actions qui suivent la situation

La deuxième chose qu'on voit en arrivant sur REV-EM, juste sous la bannière.
Une action forte, deux à quatre appuis. Jamais plus.

```
index.html                    mesure ce qui est VRAI
   │                          (qaContext : des chiffres, pas des suppositions)
   ▼
quick-actions.js              décide ce qui MÉRITE d'être proposé
   │                          (ne sait ni ce qu'est une matière, ni où ça mène)
   ▼
index.html                    traduit, affiche, et exécute
                              (qaRun → handleNavGoto, l'aiguilleur commun)
```

Même découpage que `smart-revision.js`, `statistics.js` et
`command-center.js` : un moteur pur, un branchement. Conséquence directe : le
moteur se teste sous Node en quelques millisecondes, sans navigateur —
`tests/quick-actions.test.js`, 58 vérifications.

## Les trois règles, et comment elles sont tenues

**1. Aucune action inutile.** Une action dont la condition est fausse n'existe
pas — même s'il ne reste rien d'autre à afficher. « Réviser mes erreurs »
n'apparaît pas sans erreurs ; « Continuer mon quiz » n'apparaît pas sans quiz
commencé ; « Passer un examen blanc » n'apparaît pas sous dix questions
disponibles, parce qu'un examen blanc sur trois questions n'est pas un examen
blanc. Le moteur préfère rendre **trois** actions vraies que cinq dont deux
mentent, et le test 2 vérifie chaque absence une par une.

**2. Une hiérarchie, pas une grille.** Cinq actions au maximum : une
principale, quatre secondaires. La principale est une tuile pleine largeur sur
aplat rouge ; les secondaires sont des tuiles compactes sur fond blanc. **Deux
tailles, et c'est tout ce qui fait la hiérarchie** — on voit laquelle compte
avant d'avoir lu un mot.

**3. Pas deux fois la même intention.** Au plus deux actions par famille.
Sans ce plafond, un compte bien rempli proposerait « Lancer un quiz »,
« Réviser mes flashcards » et « Passer un examen blanc » côte à côte,
c'est-à-dire trois fois la même chose.

| Famille | Actions |
|---|---|
| `resume` | continuer mon quiz · ma révision · mes flashcards · reprendre mon cours |
| `revise` | commencer ma révision · réviser mes erreurs · lancer un quiz · flashcards · examen blanc |
| `plan` | suivre mon plan · voir mon planning · installer mon emploi du temps |
| `library` | importer un cours · créer une matière · explorer mes matières |
| `tool` | ouvrir l'assistant IA |

## Un poids, pas un arbre de `if`

Les situations se combinent : on peut avoir un quiz en cours **et** des erreurs
**et** un cours récent **et** un planning. Un arbre de conditions deviendrait
illisible au troisième cas. Chaque action porte donc son poids, éventuellement
calculé à partir du contexte.

```js
{ id: "review_wrong", icon: "compass", family: "revise",
  when:   c => c.wrongCount > 0,
  weight: () => 80 }
```

C'est ce qui permet à la découverte de ne peser lourd **que** pour un compte
vide : `import_course` vaut 34 quand il y a déjà un historique, et 95 quand il
n'y en a aucun. Même catalogue, deux comportements.

Ce que ça donne, réellement mesuré dans le navigateur :

| Situation | Ce qui s'affiche |
|---|---|
| Quiz commencé à la question 3 | **Continuer mon quiz · Question 3 / 85** · Commencer ma révision · Réviser mes erreurs · Importer un cours · Explorer mes matières |
| Historique, planning, cours récent | **Commencer ma révision · 6 notions** · Reprendre mon dernier cours · Voir mon planning · Lancer un quiz · Importer un cours |
| Compte vide | **Importer un cours** · Créer une matière · Lancer un quiz · Installer mon emploi du temps · Réviser mes flashcards |

Dans le dernier cas, **aucune action de révision ni de reprise** : il n'y a
rien à reprendre, et le moteur ne l'invente pas.

## Aucun chiffre n'est inventé

`qaContext()` ne fabrique rien : chaque valeur vient d'une fonction qui
existait déjà.

| Donnée | Source |
|---|---|
| recommandations | `getSmartRevisionRecommendations()` — `smart-revision.js` |
| erreurs | `poolWrong()` |
| cours récent | `state.dash.recentChapters` |
| cours du jour | `state.planning.events`, `eventsOnCalendarDay()` |
| plan de révision | `state.studyPlan.days[].tasks` |
| contenus disponibles | `QUESTIONS`, `FLASHCARDS`, `state.userChapters` |

Et la même garde que la carte « Priorité » : **sans le moindre historique, on
n'annonce pas « N notions à réviser »** — tous les chapitres jamais ouverts
qualifieraient, et ce serait un chiffre sans rapport avec la réalité.

## Reprendre ne relance pas

Les trois actions de reprise sont les seules à ne pas passer par
`handleNavGoto()`, et pour une raison précise : l'aiguilleur remet l'écran à
son état neutre (`picker`, `setup`), ce qui perdrait justement la session
qu'on veut reprendre. Elles se contentent de changer d'onglet.

Vérifié dans le navigateur : on démarre un quiz, on répond à deux questions, on
revient à l'accueil, on clique « Continuer mon quiz » — et on retombe sur la
question 3, pas sur la première (`tests/dashboard.test.mjs`, section 13).

Une session guidée (révision intelligente, plan de révision) possède l'écran de
quiz pendant son déroulement : dans ce cas « Continuer mon quiz » **n'est pas**
proposé en plus de « Continuer ma révision », ce serait deux fois la même
reprise.

## Au clavier et au doigt

Chaque tuile est un `<button type="button">`, pas un `<div>` cliquable : la
tabulation l'atteint, `Entrée` et `Espace` l'exécutent, et l'anneau de focus
est celui du produit (2 px, rouge accent, décalé de 2 px). Vérifié dans le
navigateur : on tabule jusqu'à la première tuile, on appuie sur `Entrée`, et
l'écran d'import s'ouvre.

Les hauteurs mesurées vont de **62 px** (secondaire) à **74 px** (principale) —
très au-dessus des 44 px recommandés pour une cible tactile.

L'icône est `aria-hidden` : elle accompagne le libellé, elle ne le remplace
jamais.

## Le coût, mesuré

Le moteur ne se met pas en cache, comme `smart-revision.js` et
`statistics.js` : la volumétrie réelle ne le justifie pas. Mesuré dans le
navigateur, sur un compte semé de 402 jours d'activité :

| | |
|---|---|
| `qaContext()` — lire l'état réel | **0,13 ms** |
| `renderQuickActions()` — contexte + sélection + HTML | **0,12 ms** |
| `renderDashboard()` en entier | **1,75 ms** |
| 10 000 sélections du moteur seul, sous Node | **32 ms** (3,2 µs pièce) |

Ne pas ajouter de cache sans mesurer d'abord un vrai problème.

## Pourquoi pas le même catalogue que le Command Center

Les deux répondent à des questions différentes :

- le **Command Center** liste ce qu'on *peut* faire — tout, en permanence,
  parce qu'on vient y chercher quelque chose de précis ;
- **« Que veux-tu faire ? »** liste ce qu'on *devrait* faire maintenant — cinq
  lignes, choisies.

Les fusionner reviendrait soit à noyer le tableau de bord sous quinze boutons,
soit à priver la recherche de destinations qu'on tape justement parce qu'elles
ne sont pas à l'écran. Les deux partagent ce qui compte : le même jeu d'icônes
(`DASH_ICONS`) et le même aiguilleur (`handleNavGoto`).

## Ajouter une action

Une entrée dans le catalogue, une clé dans `qaRun()`, un libellé `qa.<id>` dans
les cinq langues. Rien à brancher dans l'interface : la zone entière n'a qu'un
seul écouteur, qui lit `data-qa`.

```js
{ id: "oral", icon: "spark", family: "revise",
  when:   c => c.chapterCount > 0,
  weight: () => 46 },
```

Une seconde ligne chiffrée se déclare dans `qaMeta()` — et seulement si le
chiffre existe : une tuile sans chiffre n'affiche pas de ligne vide.

## Ce qui a disparu, et où c'est parti

La section « Accès rapides » portait une grille de **huit boutons fixes**. Huit
destinations affichées en permanence, c'est huit fois la même importance :
aucune hiérarchie, et six d'entre elles inutiles la plupart du temps.

Aucune destination n'a été perdue. Elles restent servies par la barre de
navigation et par le Command Center (`Ctrl/⌘ + K`), et celles qui comptent à un
instant donné remontent d'elles-mêmes en haut de la page.
`tests/dashboard.test.mjs` les vérifie une par une, par leur identifiant
d'aiguillage : `import-course`, `library`, `library-add`, `activities`,
`smart`, `exams`, `planning`, `ai`.

La section garde ce qu'elle disait vraiment : **les matières**.

## Trois choses que la mesure a corrigées

**La tuile débordait de la carte au téléphone.** Mesuré à 375 px : 324 px de
tuile dans une colonne de 293. `1fr` ne descend pas sous la largeur minimale de
son contenu — il fallait `minmax(0, 1fr)`, plus `min-width: 0` sur la tuile,
qui est elle-même une boîte flexible à libellé insécable.

**Le blanc translucide de la seconde ligne était hors palette.** Il était à
88 % d'opacité ; `tests/detail.test.mjs` l'a refusé, et il avait raison — la
bannière avait tranché la même question au même endroit du produit. La seconde
ligne est maintenant en blanc plein : ce qui la distingue de la première, c'est
la taille, la graisse et l'interlettrage, pas une opacité qui fait perdre du
contraste sans rien gagner en lisibilité.

**Deux libellés étaient coupés.** « Continuar mi cuestionario » (es) et
« Continuare il mio quiz » (it) dépassaient la tuile principale à 375 px ;
« 5 Thema/Themen zu wiederholen » (de) et « 5 argomento/i da ripassare » (it)
dépassaient la seconde ligne. Un libellé tronqué par des points de suspension
se lit moins bien qu'un libellé sur deux lignes : les deux passent maintenant à
la ligne. Vérifié dans les cinq langues, à 375, 768 et 1280 px.

## Tests

| Suite | Vérifie |
|---|---|
| `tests/quick-actions.test.js` — 58 | normalisation du contexte, chaque absence d'action inutile, la priorité des reprises, les cas nommés au cahier des charges, la découverte sur compte vide, les deux plafonds, le déterminisme, les situations intermédiaires |
| `tests/dashboard.test.mjs` — section 13 | l'état réel de l'application est bien lu, la position exacte dans le quiz, reprendre ne rejoue pas depuis le début, un compte vide ne reçoit aucune action inventée, pas de doublon |
| `tests/dashboard.test.mjs` — sections 1, 3, 9, 10, 11 | l'ordre des cinq sections, les huit anciennes destinations toujours atteignables, une seule tuile principale, la hiérarchie tenue aux trois largeurs, les cinq langues |
