# Hub de révision d'un cours

La page d'un cours importé (ou créé à la main) est un **hub** : une section
« Outils de révision » donne cinq accès — Fiche, Résumé, Quiz, Flashcards,
Questions — toujours cliquables, même avant qu'un seul contenu existe.

Le hub ne crée **aucun second modèle de données** : chaque accès est un raccourci
vers ce qui existe déjà (voir `COURSE_PIPELINE_AUDIT.md`).

## Architecture avant / après

**Avant** : la page du chapitre affichait un bandeau « Ce cours est enregistré…
Générer avec l'IA », puis, *seulement si la fiche existait*, la fiche, le résumé,
un bouton « Réviser » et un tiroir « Outils IA ». Un PDF importé dont la fiche
n'était pas encore générée affichait « Ce chapitre n'a pas encore de contenu » :
faux, puisqu'un PDF et son texte existaient.

**Après** : même schéma « moteur pur + branchement » que les autres modules.

| Fichier | Rôle |
|---|---|
| `course-hub.js` | Moteur **pur** (`RevemHub`) : états des ressources, file séquentielle, référence stable d'un cours. Ni DOM, ni `state`, ni WebLLM. Testé sous Node. |
| `index.html` section « 7ter-ter » | Branchement : `renderCourseHub`, `renderChapterResource` (vue d'une ressource), `courseHubGenerate` / `courseHubPump` (file), `courseCrumbHtml` (fil d'Ariane des quiz et flashcards). |
| `translations.js` | Clés `hub.*` dans les 5 langues. |

## Les cinq accès

| Accès | Sous-titre | Ouvre |
|---|---|---|
| Fiche | Réviser l'essentiel | une vue du cours (fiche, ou « à générer ») |
| Résumé | Comprendre rapidement | une vue du cours (résumé, ou « à générer ») |
| Quiz | Tester mes connaissances | **le quiz existant** (`startQuiz`) s'il existe, sinon la vue « Ton quiz n'a pas encore été généré. » + [Générer le quiz] |
| Flashcards | Mémoriser les notions | **les flashcards existantes** (`startFlashDeck`), sinon la vue à générer |
| Questions | Interroger REV-EM | l'assistant, avec CE cours pour contexte (`libRunUserChapterFree`) |

« Questions » pose aussi `state.aiCourseContext = { courseId, chapterId, subjectId }`
pour qu'un futur RAG s'y branche ; aujourd'hui le contexte envoyé à l'assistant est
le texte du cours.

## États

`NOT_GENERATED · QUEUED · GENERATING · READY · ERROR`, calculés par
`RevemHub.resourceState(chapitre, file, clé)` :

- des données existent dans le chapitre → **READY** (on ne régénère *jamais* d'office) ;
- sinon un travail tourne → **GENERATING** ; il attend → **QUEUED** ;
- sinon le dernier essai a échoué → **ERROR** ;
- sinon → **NOT_GENERATED**.

READY se **déduit** des champs réellement enregistrés (`content`, `summary`,
`aiQuiz`, `aiFlashcards`). QUEUED / GENERATING / ERROR n'existent que pendant la
session (`state.courseGen`) : jamais persistés, donc aucune migration et jamais
d'état inventé au rechargement. Les compteurs affichés (« 8 questions »,
« 14 cartes ») sont les longueurs réelles des tableaux.

## courseId / chapterId / subjectId

Dans REV-EM le chapitre **est** le cours : `courseId === chapterId`
(`RevemHub.courseRef`). Aucune recherche par titre : tout passe par les
identifiants stockés (deux cours de même titre ne se mélangent pas — testé).

## File séquentielle (un seul travail WebLLM à la fois)

`courseHubGenerate(chapterId, clés)` est **le** point d'entrée : il ajoute à
`state.courseGen` (sans doublon — un double clic n'ajoute rien), puis
`courseHubPump` exécute **un travail à la fois** en réutilisant le pipeline
existant `courseImportRunAllSteps(item, null, [clé])`, qui persiste chaque étape
dès qu'elle réussit. Le verrou partagé `state.libGenerateBusy` rend
`aiEngineBusy()` vrai pendant toute la génération.

Si l'IA est indisponible : tout ce qui attendait pour ce cours passe en ERROR
(`AI_UNAVAILABLE`), la vue affiche « L'assistant IA doit être disponible pour
générer cette ressource. » avec [Réessayer]. Rien ne reste « en préparation » à vie.

Changement de compte : `resetUserStateInMemory()` remplace `state.courseGen` ; la
boucle de `courseHubPump` s'arrête dès que `state.courseGen !== gen` — rien n'est
écrit dans les chapitres du compte suivant.

## Après un import

`courseImportFinishAfterGeneration` : pour **un seul** fichier importé, on
navigue directement sur le cours (`courseHubOpenAfterImport`) ; les étapes
échouées s'affichent sur leur carte. Plusieurs fichiers : le récapitulatif reste.

## « Ce chapitre n'a pas encore de contenu »

N'apparaît plus que s'il n'y a **aucune source**. Avec un PDF conservé :
« Ton cours est disponible depuis le PDF importé. » ; avec un texte d'origine
seulement : « Ton cours est enregistré. Génère la fiche pour la retrouver ici. »

## Préparer l'automatisation

Une automatisation future (préparer les ressources dès l'import, sans clic)
n'a qu'à appeler `courseHubGenerate(chapterId, ["fiche","summary","quiz","flashcards"])`.
Les cartes se mettent à jour d'elles-mêmes à chaque étape persistée.

## Ce qui n'est PAS prouvé

Les tests utilisent un **double déterministe** de WebLLM (voir
`tests/course-hub-ui.test.mjs`). Aucune génération avec un vrai modèle sur un vrai
GPU n'est testée ici : à valider sur un Mac avec WebGPU.
