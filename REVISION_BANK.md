# Banque de révision et sessions mélangées

Un cours importé n'a plus UN quiz figé : il a une **banque** de questions et une
**banque** de flashcards. À chaque clic sur Quiz, Quiz Flash ou Flashcards, une
**session** nouvelle est construite **en JavaScript, sans IA, instantanément**.

```
IMPORT → cours enregistré → page du cours (tout de suite)
                              ↓ (arrière-plan, UNE file, un travail GPU à la fois)
                  Fiche · Résumé · Banque de questions · Banque de flashcards
                              ↓
        clic Quiz / Quiz Flash / Flashcards → SessionBuilder (revision-bank.js)
                              ↓
        sélection + ordre + ordre des choix NOUVEAUX → session
```

## Constats AVANT (audit)

| Question | Constat |
|---|---|
| Quand les quiz sont générés | à l'import, UN appel IA : 4 à 8 questions (`courseItemCounts`), puis plus jamais |
| Où ils vivent | `chapter.aiQuiz` / `aiFlashcards` (localStorage par compte ; Supabase `chapters.ai_quiz` / `ai_flashcards`, colonnes **jsonb**) |
| IDs stables | oui : `uid` (`import-<ts>-<i>`), utilisé par `qstats` |
| Une banque existait-elle | non : « la liste » = le quiz entier |
| Ordre des questions | déjà mélangé par `shuffle()` (Fisher-Yates) à chaque `startQuiz` — mais **toujours les mêmes 4 à 8 questions** |
| Ordre des réponses QCM | **jamais mélangé** (A/B/C/D figés, `correct` = index figé) |
| Flashcards | paquet entier, `shuffle` à l'ouverture ; « Rejouer » rejoue le même paquet |
| « Quiz Flash » | n'existait pas (seule « Révision express » : 10 questions) |
| Import | bloquait sur un écran de progression pendant TOUTE la génération |

## Où vit la banque : aucune migration

La banque **est** `chapter.aiQuiz` / `chapter.aiFlashcards`, en plus grand et avec
des métadonnées **par élément** (colonnes jsonb : champs libres, pas de migration,
RLS inchangée, cloisonnement par compte inchangé). Les anciennes questions (sans
métadonnées) restent jouables telles quelles.

Une question de banque :

```
uid / id        stable : "q_" + hash(courseId + énoncé normalisé)   (uid conservé pour qstats)
courseId, chapterId, subjectId      (courseId === chapterId : le chapitre EST le cours)
type            definition | comprehension | application | exemple | vrai_faux | association | calcul | mcq
q, opts[], correct, exp, sourceQuote, exampleQuote       (champs historiques inchangés)
concept         nom court de la notion (couverture)        section  tranche du cours d'où elle vient
difficulty      easy | medium | hard (si fournie par l'IA, sinon absente — rien d'inventé)
srcHash, srcLen empreinte du texte source à la génération (cours modifié ?)
```

Une flashcard : `id`, `front`, `back`, `concept`, `section`, `reversible`, `revTerm`,
`sourceQuote`, `exampleQuote`, rattachement et empreinte comme ci-dessus.

`userId` n'est **pas** stocké côté client (voir `COURSE_PIPELINE_AUDIT.md`) :
l'appartenance au compte vient du cloisonnement `localStorage` par compte et de la
RLS Supabase (`chapters.user_id`).

## Génération de la banque (IA) — `generateQuestionBank`

* **Taille adaptée au texte** (`bankTargets`) : < 1 500 car. → 6 ; < 4 000 → 10 ;
  < 12 000 → 16 ; < 30 000 → 22 ; au-delà → 28. Jamais 50.
* **Par lots courts** (8 questions / 10 cartes, 4 lots maximum) : un petit modèle
  réussit mieux un JSON court. Chaque lot voit une **tranche différente du cours**
  (couverture) et un **accent de types différent** (définition, compréhension,
  application, exemple, vrai/faux, association…) — sans forcer un type que le
  cours ne permet pas (« uniquement si le cours s'y prête »).
* **Qualité** (`validateQuestion`) : rejette « toutes les réponses… », « A et B »,
  choix en double, bonne réponse recopiée dans la question, bonne réponse
  beaucoup plus longue que les autres (indice par la longueur), question trop
  courte. Dédoublonnage par identifiant et par similarité (Jaccard ≥ 0,8). HTML retiré.
* **Banque partielle > rien** : si un lot échoue après d'autres réussis, on garde ce qui existe.
* **Un seul travail GPU à la fois** : les lots s'enchaînent à l'intérieur d'UN travail de la
  file du hub (`courseHubPump`).

## Sessions — `RevemBank.buildQuizSession` / `buildFlashSession`

* **Fisher-Yates** (`shuffleArray`) sur une **copie** ; jamais `sort(() => Math.random() - 0.5)`.
  Source d'aléa : `crypto.getRandomValues`, repli `Math.random` ; injectable pour les tests.
* **Taille** : Quiz = **10** (la taille de la « Révision express » existante) ;
  **Quiz Flash = 5** (seul chiffre nouveau) ; Flashcards = tout le paquet jusqu'à 15,
  sinon un tirage de 15.
* **Fraîcheur** : les éléments absents de la session précédente passent d'abord
  (`state.revisionLast`, en mémoire). Impossible si la banque est trop petite → on
  complète avec le reste ; l'ordre est alors forcé différent.
* **Couverture** : un tour de table par concept (ou par section) ; au sein d'un
  concept, la difficulté la moins représentée gagne. Résultat testé : jamais plus de
  2 questions du même concept sur 10, les 5 concepts toujours présents sur 5.
* **Jamais deux sessions identiques** (même ensemble et même ordre) tant qu'une
  autre possibilité existe.
* **Choix QCM mélangés, bonne réponse protégée** : `shuffleChoices` produit une
  *copie* avec `perm` (permutation) et recalcule `correct = perm.indexOf(ancien correct)`.
  Le Vrai/Faux garde son ordre naturel ; une question à choix « positionnel »
  (ancienne, sans validation) n'est pas mélangée.
* **Flashcards inversées** : seulement si `reversible` (recto « Qu'est-ce que X ? » ou
  terme court, verso = définition de 20 à 220 car. qui ne contient pas le terme), avec une
  probabilité de 30 %. Jamais une carte oui/non, numérique ou en liste.
* **Banque jamais modifiée** : tout est copie (testé sur des objets gelés).
* **Score lié à la session** : `state.playing.sessionId / questionIds` ; l'entrée
  `recentActivity` porte `sessionId`, `questionIds`, `answers`, `startedAt`, `completedAt`.
* **« Nouveau quiz » / « Recommencer »** : nouvelle session depuis la banque. Un double
  clic ne lance qu'une session (garde d'écran + rebond de 250 ms sur la première réponse).
* **Aucun appel WebLLM** pour une session : testé avec une IA qui lève une exception au moindre appel.

## Enrichissement et cours modifié

* `enrichQuestionBank(chapterId, "quiz" | "flashcards")` : demande à l'IA de **nouveaux**
  éléments (elle reçoit les énoncés existants à ne pas refaire) et les **ajoute** (l'existant
  reste en tête, plafond 60). Déclenché **à la demande** (outils IA du cours) — jamais à
  chaque session. Une automatisation future n'a qu'à appeler
  `courseHubGenerate(chapterId, ["enrich_quiz"])`.
* **Cours modifié** : chaque élément porte `srcHash` / `srcLen`. Si le texte source change de
  plus de 15 % de longueur, la carte passe en « À actualiser » et un bandeau propose
  « Actualiser » (régénération de la banque). Une ancienne banque sans empreinte n'est jamais
  déclarée obsolète. Une retouche mineure ne déclenche rien.

## Après l'import

`courseImportGenerate` enregistre le cours puis **ne bloque plus** : la page du cours
s'ouvre aussitôt, `courseHubGenerate(chapterId, [fiche, summary, quiz, flashcards,
reviewQuestions])` prépare le reste en arrière-plan. Plusieurs fichiers : le suivant n'est
**analysé** (appel WebLLM) que quand la file est vide.

**IA indisponible** : le cours est gardé ; les ressources passent en erreur « L'assistant IA
doit être disponible pour générer cette ressource. » ; le cours est marqué « en attente ».
Dès que l'assistant est prêt (`state.aiStatus === "ready"`), `courseHubMaybeResume` relance
les ressources en attente — sans recréer le cours. *Limite honnête* : « en attente » n'est
conservé qu'en mémoire ; après un rechargement de la page, c'est le bouton « Tout générer »
qui relance (rien n'est perdu).

## Ce qui n'est PAS prouvé

Tous les tests utilisent un **double** de WebLLM. La *qualité* des questions écrites par un
vrai modèle (plausibilité des mauvais choix, absence d'ambiguïté) et le temps de génération
réel d'une banque en plusieurs lots sont **NOT TESTED** : à valider sur un Mac avec WebGPU.
