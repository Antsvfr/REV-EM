---
name: course-library-import
description: Bibliothèque de matières/chapitres, import de documents, génération de contenu pédagogique (fiche/quiz/flashcards) à partir d'un cours. À consulter avant de toucher à l'import, au traitement de fichiers, ou à la génération de contenu depuis un cours.
---

# Course Library & Import

## Ce qui existe réellement

- **Bibliothèque** (`state.tab === "library"`) : matières intégrées
  (`SUBJECTS`) + matières créées par l'utilisateur (`state.userSubjects`),
  chapitres intégrés (`CHAPTERS`) + chapitres utilisateur
  (`state.userChapters`, forme : `{id, subjectId, num, title, desc,
  content, summary, aiQuiz:[], aiFlashcards:[]}`).
- **Documents** (`state.documents`, section « 15septies. DOCUMENTS ») :
  import local de fichiers (ressources, sujets d'examen), séparé de
  l'import de cours ci-dessous.
- **Import de cours** (`state.courseImport`, section « 7ter. IMPORTATION
  DE COURS ») : pipeline complet fichier → contenu pédagogique structuré.
- **Fichier PDF original** : stocké tel quel dans **IndexedDB**
  (`em-lyon-revision-files`/`pdfs`, indexé par identifiant de chapitre —
  `saveCourseFileBlob`/`getCourseFileBlob`/`deleteCourseFileBlob`), pas
  dans `localStorage` (trop volumineux). **Point d'attention réel** : ce
  stockage n'est actuellement **pas** namespacé par compte contrairement
  à `localStorage` (voir `supabase-auth-data`) — à garder en tête avant
  toute évolution qui en dépendrait pour plusieurs comptes sur le même
  navigateur.

## Il n'y a pas d'objet « cours » séparé du chapitre

**Le chapitre EST le cours.** `state.userChapters` porte directement
`content` (la fiche), `summary`, `aiQuiz`, `aiFlashcards`,
`aiReviewQuestions`, `originalText`, `keyNotions`, `sourceFileName`,
`hasOriginalFile`, `heuristicMode`, `generationPending` — un chapitre créé
par import n'est distingué d'un chapitre créé à la main que par ces champs
remplis. Voir `COURSE_PIPELINE_AUDIT.md` pour pourquoi aucun `courseId`
séparé n'a été introduit (la relation `flashcard.chapterId → chapitre →
subjectId → matière` existe déjà, et l'appartenance au compte vient du
cloisonnement de stockage + RLS, jamais d'un `userId` stocké côté client).

## Pipeline d'import de cours (vérifié dans index.html)

1. `courseImportProcessFile(index)` — extraction du texte, puis détection
   (IA ou heuristique) du titre/de la matière/du chapitre/des notions.
   - **Contexte prioritaire** : si l'import a été lancé depuis une matière
     déjà ouverte (`goToCourseImport(subjectId)`, bouton "Importer un
     cours" de `renderSubjectDetail`), `state.courseImport.lockedSubjectId`
     impose cette matière — ni l'IA ni la détection heuristique ne peuvent
     en proposer une autre (le prompt ne demande même plus de matière,
     voir `detectCourseMeta`).
   - **Correspondance de chapitre** : dans la matière résolue,
     `LyonSubjectSearch.bestMatch(chapterTitle, chaptersOfSubject(id), c =>
     c.title)` propose un chapitre existant si la correspondance est forte
     (nom identique ou qui commence par) — jamais sur un simple mot en
     commun, qui fusionnerait deux cours différents en silence. Réutilise
     `subject-search.js` exactement comme documenté dans
     `SUBJECT_SEARCH.md` (« un deuxième usage »).
2. Si le texte dépasse `COURSE_CONDENSE_THRESHOLD` (20 000 caractères) :
   `buildWorkingCourseText()` découpe en morceaux (`chunkCourseText()`) et
   condense chaque morceau (`condenseCourseChunk()`, un appel IA par
   morceau, annulable via `signal.cancelled`) pour rester dans la capacité
   du modèle sans perdre d'information — puis recompose un texte de
   travail borné à `COURSE_GEN_CONTEXT_CHARS` (7 000 caractères).
3. **`courseImportResolveTarget(item)`** — appelée une seule fois, avant
   toute génération IA (chemin "avec IA" comme "sans IA") : résout/crée la
   matière, résout le chapitre cible (choisi à la main, sinon
   `findDuplicateChapterInSubject` par nom de fichier ou texte source
   identique), demande confirmation (`dsConfirm`, trois issues : remplacer
   / nouvelle entrée / annuler) SEULEMENT si la cible a déjà du contenu
   (`courseChapterHasContent` — un chapitre vide ne déclenche jamais cette
   question), puis **enregistre immédiatement** un chapitre avec ses
   métadonnées et son texte source. Le cours existe donc en base AVANT
   qu'aucune étape IA n'ait tourné — fermer l'onglet à ce moment, ou à
   n'importe quel moment après, ne perd plus rien (voir
   `COURSE_PIPELINE_AUDIT.md`, défaut D1).
4. Génération, **deux chemins possibles** :
   - **Avec IA** : `courseImportGenerate(index)` → `courseImportRunAllSteps()`
     (fiche, résumé, quiz, flashcards, questions de révision). Chaque étape
     réussie est écrite **immédiatement** dans le chapitre déjà enregistré
     (`courseImportApplyGeneratedToChapter(ch, item, [key])`) — une étape en
     échec n'empêche pas les suivantes, et n'efface jamais un contenu déjà
     obtenu.
   - **Sans IA** : `courseImportSaveWithoutAI(index)` → règles locales
     `buildHeuristicCourseMaterials()` (mode simplifié, voir `ai-system`),
     qui déclare honnêtement dans `item.failedSteps` les étapes qu'elle
     n'a pas pu produire (`summary`/`reviewQuestions` toujours absents en
     mode heuristique) plutôt que de simuler un résultat.
5. **Reprise** (`libGenerateChapterAI`, bandeau "Génération IA en attente"
   du chapitre) : `coursePendingStepKeys(ch)` calcule ce qui manque
   réellement à partir des champs déjà présents (`ch.content`,
   `ch.aiQuiz.length`…) — **aucun champ supplémentaire, aucune migration**.
   Deux régimes : un chapitre en mode simplifié (`heuristicMode`) régénère
   les 5 étapes en entier (mise à niveau complète, son contenu heuristique
   est volontairement sommaire) ; un chapitre déjà passé par l'IA ne
   redemande que ce qui manque (échec ou interruption), jamais tout —
   voir `COURSE_PIPELINE_AUDIT.md`, défauts D1/D6.

## Règles

- **Ne jamais détruire le texte source.** Le texte extrait du fichier
  original (`item.extractedText`/`ch.originalText`) est conservé même
  après condensation/génération — la condensation ne sert qu'à construire
  un texte de travail plus court pour l'IA, jamais à remplacer la source.
  C'est cette source qui permet la citation exacte "Dans ton cours" (voir
  `quiz-system`/`learning-modes`).
- **Conserver les sources**, ne jamais les écraser lors d'une régénération
  (voir "Régénérer le quiz"/"Régénérer les flashcards" dans la
  bibliothèque : le contenu précédent n'est remplacé qu'après succès de
  la nouvelle génération, jamais avant).
- **Gérer les erreurs explicitement.** `classifyGenerationError(e)`
  distingue mémoire/WebGPU/annulation/timeout/générique avec un message
  utilisateur adapté à chacun (voir `ai-system`) — ne jamais afficher un
  message d'erreur générique quand la cause réelle est identifiable.
- **États de chargement visibles.** `courseImportRunAllSteps` avance étape
  par étape avec un état affiché (`item.status`, `item.genStepIndex`) —
  toute nouvelle étape longue doit avoir un état intermédiaire visible,
  jamais un écran figé sans indication.
- **Permettre la correction du contenu généré automatiquement.** Voir les
  éditeurs déjà en place pour un quiz/des flashcards générés
  (`ch.aiQuiz`/`ch.aiFlashcards` éditables carte par carte/question par
  question dans la bibliothèque) — tout nouveau contenu généré doit rester
  corrigible par l'utilisateur, jamais figé.
- **Documents volumineux.** Le découpage/condensation (`chunkCourseText`/
  `buildWorkingCourseText`) existe précisément pour ça — réutiliser ce
  mécanisme plutôt qu'en écrire un nouveau pour toute future
  fonctionnalité qui doit traiter un texte long avec l'IA.
- **Éviter les appels IA inutiles.** Un texte sous le seuil de
  condensation ne déclenche aucun appel de condensation. Une reprise ne
  redemande que ce qui manque réellement (`coursePendingStepKeys`), jamais
  tout le pipeline pour corriger une seule étape.
- **Jamais de doublon silencieux.** Réimporter un fichier déjà présent dans
  une matière (même nom, ou même texte source) déclenche une confirmation
  explicite (`courseImportResolveTarget`) — jamais une création silencieuse
  d'un second chapitre identique, jamais un écrasement sans le dire.
- **Le contexte d'où part l'import est plus fort que la détection.** Un
  import lancé depuis une matière ouverte ne doit jamais être déplacé par
  l'IA vers une autre matière (`lockedSubjectId`) — la détection garde le
  contrôle uniquement sur le titre, le chapitre, le niveau et les notions.
- **`matchSubjectByName`/`bestMatch`, pas de containment brut.** Comparer
  deux noms de matière ou de chapitre passe par
  `LyonSubjectSearch.bestMatch` (exact, préfixe, mot), jamais par un
  `includes()` bidirectionnel : avec « Management » et « Management
  commercial » toutes deux présentes, un containment brut peut
  présélectionner silencieusement la mauvaise.
