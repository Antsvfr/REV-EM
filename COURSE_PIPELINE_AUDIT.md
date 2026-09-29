# Audit — pipeline « import de cours → fiche/flashcards/quiz »

> Étape « Automatisation complète des cours, fiches, flashcards et quiz par
> matière + compte utilisateur ». Ce document répond à la consigne « COMMENCE
> PAR L'AUDIT COMPLET. NE MODIFIE PAS LE CODE AVANT D'AVOIR COMPRIS LE
> PIPELINE ACTUEL. » Écrit avant toute modification de code de cette étape.
> Complète [`SYNC_AUDIT.md`](SYNC_AUDIT.md) (compte/synchronisation) et
> [`SUBJECT_SEARCH.md`](SUBJECT_SEARCH.md) (recherche), sans les répéter.

## 1. Ce qui existe réellement aujourd'hui

**Il n'y a pas d'objet « cours » séparé.** Dans REV-EM, **le chapitre EST le
cours** : `state.userChapters` (`{id, subjectId, num, title, desc, content,
originalText, summary, aiQuiz:[], aiFlashcards:[], aiReviewQuestions:[],
keyNotions:[], sourceFileName, pageCount, hasOriginalFile, level,
markedReviewed, generationPending, heuristicMode, createdAt, updatedAt}`).
Un import de cours crée **un chapitre**, jamais un objet séparé qui serait
ensuite « lié » à un chapitre. Les quiz/flashcards générés ne portent qu'un
`chapterId` (ajouté à l'écriture) — pas de `courseId`, parce qu'il n'y a rien
d'autre à référencer que le chapitre lui-même.

**Le pipeline réel** (`index.html`, section « 7ter. IMPORTATION DE COURS »,
fonctions `courseImport*`) :

```
courseImportAddFiles()               fichier(s) ajoutés à la file (state.courseImport.files)
        │
courseImportStart() → libGoto("import")
        │
courseImportProcessFile(index)
        ├─ extractCourseFileText()   texte brut (PDF/DOCX/TXT/MD)
        ├─ buildWorkingCourseText()  condensation si > 20 000 caractères
        ├─ detectCourseMeta()        IA : titre, matière, chapitre, niveau, notions
        │  (ou heuristicDetectMeta() si IA indisponible — matière TOUJOURS vide)
        └─ matchSubjectByName()      matière existante ou "Autre"
        │
   écran de révision (statut "review") — l'utilisateur voit/corrige tout,
   rien n'est encore enregistré
        │
   ┌────┴─────────────────────────┐
   │                               │
courseImportGenerate()      courseImportSaveWithoutAI()
   │ (5 étapes IA, une par une,    │ (règles locales : fiche/flashcards/
   │  chacune rejouable seule)     │  quiz simples, jamais de résumé/questions)
   └────┬──────────────────────────┘
        │
courseImportFinalize(index, opts)
        ├─ résout/CRÉE la matière si besoin
        ├─ crée un NOUVEAU chapitre (toujours — jamais de correspondance)
        ├─ enregistre le PDF original dans IndexedDB si présent
        └─ saveUserChapters()   ← SEUL point où quelque chose est persisté
```

**Deux chemins de génération IA**, tous deux déjà séparés en étapes
individuellement rejouables (`courseImportRetryStep`) : `generateCourseFiche`,
`generateCourseSummary`, `generateCourseQuizFromText`,
`generateCourseFlashcardsFromText`, `generateCourseReviewQuestions` — chacune
n'utilise QUE le texte du cours courant (`courseGenContext`), jamais les
autres matières/cours/utilisateurs (§27 déjà satisfait).

**Identification de la matière** (`matchSubjectByName`) : comparaison
insensible à la casse, **substring bidirectionnel** (`sn.includes(n) ||
n.includes(sn)`) sur `allSubjects()` = matières intégrées (`SUBJECTS`) +
matières utilisateur (`state.userSubjects`). Le prompt de `detectCourseMeta`
donne au modèle la liste des noms de matières existantes et lui demande de
réutiliser l'une d'elles si elle correspond.

**Identification du chapitre** : `detectCourseMeta` propose un titre de
chapitre, mais **rien ne le compare aux chapitres déjà présents dans la
matière** — un nouveau chapitre est toujours créé.

**Compte utilisateur** : aucun objet ne porte de `userId`. L'appartenance à
un compte se fait exclusivement par le cloisonnement `localStorage`
(`u.<uuid>.`, voir `SYNC_AUDIT.md`) et par la synchronisation Supabase
(RLS sur `auth.uid()`), jamais par un champ stocké côté client — c'est une
règle de sécurité du projet, pas un oubli (voir §2 ci-dessous).

## 2. Réponses aux questions de l'audit (partie 1 du cahier des charges)

**Comment un cours est-il importé ?** Fichier ou texte collé →
`courseImportAddFiles`/`courseImportAddPasteAsFile` → extraction → détection
→ écran de révision → génération → un chapitre est créé.

**Où son contenu est-il stocké ?** Le texte (fiche, résumé, texte source
tronqué à 20 000 caractères) dans le chapitre lui-même (`localStorage` puis
Supabase, table `chapters`). Le fichier binaire original (PDF), séparément,
dans IndexedDB — jamais envoyé à Supabase (voir `SYNC_AUDIT.md` §7).

**Comment une matière est-elle identifiée ?** `matchSubjectByName` :
substring bidirectionnel sur le nom proposé par l'IA (ou vide en mode
heuristique, auquel cas une matière « Autre » est toujours créée — aucune
tentative de rattachement en mode sans IA).

**Comment un chapitre est-il identifié ?** Il ne l'est pas : toujours créé.

**Comment une fiche/des flashcards/un quiz sont-ils liés au cours ?** Ce sont
des **champs du chapitre** (`content`, `aiFlashcards`, `aiQuiz`), pas des
lignes séparées reliées par une clé. Chaque flashcard/question porte
`chapterId` une fois ajoutée à ce chapitre.

**Comment les données sont-elles sauvegardées ?** `saveUserChapters()` →
`lsSet(KEY_USER_CHAPTERS, ...)` → `cloudNoteLocalWrite` → synchronisé comme
tout `userChapters` (domaine `chapters` de `user-data.js`, déjà couvert par
`SYNC_AUDIT.md`).

**Quelles données sont locales / Supabase / déjà synchronisées ?** Voir
tableau §3.

## 3. Classification (partie 5 du cahier des charges)

| Donnée | Classe | Table / stockage |
|---|---|---|
| Matière (créée à l'import ou choisie) | **LOCAL + SYNC** | `subjects` |
| Chapitre = « cours » (titre, fiche, résumé, notions) | **LOCAL + SYNC** | `chapters` |
| Quiz généré (`aiQuiz`) | **LOCAL + SYNC** | `chapters.ai_quiz` (jsonb, dans la ligne du chapitre) |
| Flashcards générées (`aiFlashcards`) | **LOCAL + SYNC** | `chapters.ai_flashcards` |
| Questions de révision (`aiReviewQuestions`) | **LOCAL + SYNC** | `chapters.ai_review_questions` |
| Texte source (tronqué à 20 000 car.) | **LOCAL + SYNC** | `chapters.original_text` |
| Fichier binaire original (PDF) | **LOCAL SEULEMENT** | IndexedDB, non namespacé par compte (risque déjà documenté) |
| Progression sur le quiz/les flashcards du cours | **LOCAL + SYNC** | `progress` (clé `chapter:<id>`) |
| `state.courseImport` (file en cours, texte extrait avant sauvegarde, corrections de l'écran de révision) | **NON SYNCHRONISÉ, PAS MÊME LOCAL** | mémoire uniquement — **voir défaut D1 §5** |

## 4. Défauts réels trouvés (avant toute modification)

| # | Défaut | Où | Gravité |
|---|---|---|---|
| **D1** | **`state.courseImport` n'est jamais persisté.** Fermer l'onglet, recharger la page ou perdre la connexion à N'IMPORTE QUEL moment AVANT la fin de `courseImportFinalize()` — pendant l'extraction, la détection, l'écran de révision, ou PENDANT les 5 étapes de génération — perd tout : le texte extrait, les corrections faites à la main, tout. Le chapitre n'existe pas encore en mémoire persistée. | tout le pipeline avant la finalisation | **perte de travail, contredit directement §16 du cahier des charges** |
| **D2** | **Aucun point d'entrée pour importer depuis une matière déjà ouverte.** `renderSubjectDetail()` (la page d'une matière précise) n'a pas de bouton « Importer un cours » — seuls les points d'entrée globaux (dashboard, liste « Mes matières », Ressources) existent, tous sans contexte. Le parcours décrit en partie 37 du cahier des charges (« j'ouvre Marketing, je clique sur Importer un cours ») **n'est pas possible aujourd'hui**. | `renderSubjectDetail`, `goToCourseImport` | **fonctionnalité manquante, cœur du parcours demandé** |
| **D3** | **Conséquence directe de D2 : aucune priorité au contexte.** Comme il n'y a pas de point d'entrée contextuel, il n'y a évidemment aucun verrouillage de la matière courante — la détection (IA ou heuristique) est toujours libre de proposer n'importe quelle matière. | `courseImportProcessFile` | contredit §5 |
| **D4** | **Aucune correspondance de chapitre.** Un nouveau chapitre est créé à CHAQUE import, y compris si un chapitre au titre quasi identique existe déjà dans la matière. | `courseImportFinalize` | contredit §7 |
| **D5** | **Aucune déduplication.** Réimporter deux fois le même fichier crée deux chapitres distincts, sans avertissement. | `courseImportFinalize` | contredit §8 |
| **D6** | **`libGenerateChapterAI` régénère toujours les 5 étapes**, même si certaines ont déjà réussi (ex. reprise après une interruption partielle) — aucune vérification de ce qui existe déjà. | `libGenerateChapterAI` | contredit §16 et §28 |
| **D7** | **Message trompeur pour un PDF importé sur un autre appareil.** `hasOriginalFile` est synchronisé, mais le fichier binaire ne l'est jamais (volontairement, voir `SYNC_AUDIT.md`). Cliquer « Lire le PDF »/« Télécharger le PDF » sur un appareil qui n'a jamais reçu ce fichier affiche *« Le PDF original n'est plus disponible dans ce navigateur »* — qui affirme une suppression alors que le fichier n'a simplement jamais été là. | boutons PDF de `renderChapterDetail` | contredit le principe « jamais présenter une donnée inventée comme réelle » (CLAUDE.md) |
| **D8** | **`matchSubjectByName` trop permissif.** Un substring bidirectionnel (`sn.includes(n) || n.includes(sn)`) peut, avec plusieurs matières au nom proche (« Management » / « Management commercial »), présélectionner silencieusement la mauvaise dans le menu déroulant de l'écran de révision. | `matchSubjectByName` | contredit l'esprit de §6 |
| **D9** | **`item.failedSteps`/`ch.aiSkipped` : champ mort.** `ch.aiSkipped` est écrit (à la création, et remis à `false` par `libGenerateChapterAI`) mais **jamais lu** nulle part dans le rendu. Pas un bug actif, mais un champ qui laisse croire à un comportement qui n'existe pas. | `courseImportFinalize`, `libGenerateChapterAI` | mineur, à documenter |

## 5. Ce qui est déjà satisfait (pour ne rien reconstruire inutilement)

- **États de pipeline visibles** (§14) : `item.status`
  (`pending/extracting/detecting/review/generating/done/error/cancelled`),
  `item.genStepIndex`, `COURSE_IMPORT_STEP_LABELS`, barre de progression avec
  pourcentage et minuteur — déjà complet pour la durée d'une session.
- **Ne jamais bloquer l'utilisateur** (§15) : la génération est une chaîne de
  promesses JavaScript ordinaires ; elle continue même si `state.tab` change
  (aucun verrou global sur la navigation). Vérifié et confirmé par test
  (§8 du plan d'implémentation).
- **Étapes individuellement rejouables** (§16 partiel, §28, §29) :
  `courseImportRetryStep(index, key)` ne relance qu'UNE étape, jamais tout le
  pipeline ; un échec affiche `classifyGenerationError` (message humain) sans
  jamais supprimer le cours.
- **Fidélité au texte source** (§10) : les prompts de génération exigent
  « sans rien inventer » et interdisent explicitement les tournures creuses
  (`isPlaceholderLine`) ; `sourceQuote`/`exampleQuote` sur quiz/flashcards
  citent le texte source — déjà la citation exacte demandée par
  `learning-modes`/`quiz-system`.
- **Quantité adaptative** (§13) : `courseItemCounts(charCount)` — 3 paliers.
- **Contexte IA minimal** (§27) : chaque génération ne reçoit que le texte du
  cours courant, jamais l'historique global.
- **Suppression avec avertissement de cascade** (§25) : déjà en place, à la
  fois pour un chapitre (« La fiche, le quiz, les flashcards et l'historique
  de révision de ce chapitre seront perdus ») et pour une matière — et le
  fichier IndexedDB associé est bien nettoyé (`deleteCourseFileBlob`).
- **Édition manuelle du contenu généré** (§22) : éditeurs déjà en place pour
  `aiQuiz`/`aiFlashcards`, régénération par section (`libRegeneratePart`).
- **Persistance Supabase de la quasi-totalité des champs du chapitre**
  (§17) : `content`, `original_text`, `summary`, `ai_quiz`, `ai_flashcards`,
  `ai_review_questions`, `key_notions`, `source_file_name`, `page_count`,
  `has_original_file`, `level`, `marked_reviewed`, `generation_pending`,
  `heuristic_mode` sont TOUS déjà des colonnes de `public.chapters` et déjà
  synchronisés dans les deux sens (`user-data.js`, domaine `CHAPTERS`).
- **Recherche non cassée** (§26) : la recherche de « Mes matières »
  (`subject-search.js`) ne filtre que les matières, jamais les chapitres —
  aucune dépendance sur ce pipeline, donc rien à casser ici. Elle est conçue
  pour être réutilisée sur une autre liste nommée le jour venu (voir
  `SUBJECT_SEARCH.md`).

## 6. Ce qui ne sera délibérément PAS construit maintenant, et pourquoi

- **Un objet « cours » séparé du chapitre, avec `courseId` distinct.** Le
  chapitre remplit déjà exactement ce rôle (un chapitre = un cours importé,
  avec sa fiche, son quiz, ses flashcards). Ajouter un `courseId` qui vaudrait
  systématiquement l'id du chapitre serait une couche redondante, contraire à
  la règle « pas de réécriture sans nécessité ». Les relations demandées en
  §24 existent déjà : `flashcard.chapterId` → chapitre, `chapitre.subjectId`
  → matière, matière/chapitre → compte par le cloisonnement de stockage +
  RLS (jamais par un champ `userId` stocké côté client, ce qui serait
  d'ailleurs contraire à la règle de sécurité « ne jamais faire confiance à
  un `user_id` envoyé par le frontend »).
- **Version de cours (§21).** Le cahier des charges le dit lui-même : « NE
  PAS forcément implémenter maintenant ». Pas de champ de version ajouté
  cette étape ; la déduplication (D5) couvre le cas réel demandé (réimport
  du même fichier), avec un choix explicite plutôt qu'une notion de version.
- **Stockage Supabase du contenu binaire des documents/PDF.** Déjà documenté
  comme non implémenté dans `SYNC_AUDIT.md` §7 ; aucune découverte nouvelle
  ne change ce constat, donc pas de nouvelle tentative ici.
- **Internationalisation de l'écran d'import et de la bibliothèque.** Tout ce
  pipeline (écran de révision, bibliothèque, confirmations de suppression)
  est déjà, et de longue date, en français codé en dur — pas de second
  système de traduction partiel introduit pour seulement les nouvelles
  chaînes de cette étape : elles suivent la convention déjà en place dans ce
  fichier (voir §33 du cahier des charges, qui ne demande de traduire que les
  chaînes NOUVELLES — celles-ci restent cohérentes avec leur environnement
  immédiat). Signalé explicitement dans le rapport final comme limite
  préexistante, pas comme un oubli de cette étape.

## 7. Ce qui a été implémenté (voir le rapport final pour le détail)

Un audit honnête sépare ce qui est déjà solide de ce qui manque. Les défauts
D1 à D8 ci-dessus étaient réels, concrets, et couvraient la quasi-totalité du
cahier des charges sans nécessiter de refonte. Tous ont été corrigés :

1. **D2 + D3** — corrigé. Bouton « Importer un cours » sur la page d'une
   matière (`renderSubjectDetail`), contexte transmis et **verrouillé**
   (`state.courseImport.lockedSubjectId` : ni l'IA ni la détection
   heuristique ne peuvent en proposer une autre).
2. **D4** — corrigé. Proposition de chapitre existant dans la matière
   résolue, via `LyonSubjectSearch.bestMatch(chapterTitle, ..., c=>c.title)`
   — exactement l'usage « future-proof » que `subject-search.js`
   documentait déjà sans l'avoir encore (voir `SUBJECT_SEARCH.md`).
3. **D5** — corrigé. Détection de doublon (`findDuplicateChapterInSubject` :
   même nom de fichier ou même texte source déjà enregistré dans la
   matière) → confirmation explicite à trois issues (remplacer / nouvelle
   entrée / annuler), jamais silencieuse — et jamais déclenchée pour un
   chapitre vide (`courseChapterHasContent`), où l'écraser est le but
   recherché, pas un risque.
4. **D1 + D6** — corrigés. `courseImportResolveTarget()` enregistre le
   chapitre (métadonnées + texte source) **avant** toute génération IA ;
   chaque étape réussie est écrite immédiatement
   (`courseImportApplyGeneratedToChapter(ch, item, [key])`) ; une reprise
   (`libGenerateChapterAI`, via `coursePendingStepKeys()`) ne régénère que ce
   qui manque réellement pour un chapitre déjà passé par l'IA — un chapitre
   en mode simplifié, lui, est entièrement remis à niveau (voir le rapport
   final pour la distinction).
5. **D7** — corrigé. Message honnête, identique quelle que soit la raison
   réelle de l'absence du fichier sur cet appareil.
6. **D8** — corrigé. `matchSubjectByName` resserré : exact d'abord, puis
   préfixe/mot via `LyonSubjectSearch.bestMatch`, jamais un substring
   bidirectionnel ambigu.
7. **D9** — corrigé. `aiSkipped`/`generationFailedSteps`, confirmés morts
   (zéro lecture dans tout le fichier), supprimés plutôt que laissés traîner.

Rien de tout cela n'a ajouté de table Supabase ni de migration : tout
réutilise des champs déjà synchronisés (`content`, `aiQuiz`, `aiFlashcards`,
`aiReviewQuestions`, `summary`, `sourceFileName`, `originalText`). Détail
complet, tests et bilan PASS/PARTIAL/NOT TESTED dans le rapport final de
cette étape (message de fin de conversation).
