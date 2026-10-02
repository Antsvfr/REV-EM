---
name: ai-system
description: Fonctionnement réel de l'assistant IA (WebLLM local, ai-worker.js et le pipeline dans index.html). À consulter avant de toucher à l'assistant IA, aux appels de génération, ou à ai-worker.js.
---

# AI System

## Ce qui est réellement en place

L'IA est **WebLLM** (`@mlc-ai/web-llm`, version **épinglée** dans
`ai-engine.js` → `WEBLLM_VERSION`), exécutée **entièrement dans le navigateur**
via WebGPU — **aucun serveur à nous, aucune clé API**. Le modèle est téléchargé
depuis Hugging Face par le navigateur et mis en cache par lui. Lire
`AI_AUDIT.md` avant de toucher à ce domaine : il contient la cause racine de
l'ancien « Erreur inconnue pendant l'initialisation » et l'architecture.

Découpage (même patron « moteur pur + branchement » que le reste du projet) :

| Fichier | Rôle |
|---|---|
| `ai-engine.js` | **Moteur pur** (`RevemAI`) : paliers, codes d'erreur (`classifyError`), machine d'états, mémoire locale, choix du palier, repli, compactage de prompts, diagnostic copiable, `resetAiStorage`. Testé sous Node (`tests/ai-engine.test.js`). |
| `ai-host.js` | **Hôte du moteur WebLLM** : un seul `MLCEngine`, protocole `INIT_MODEL / SWITCH_MODEL / GENERATE / ABORT / RESET_AI_CACHE / GET_STATUS`, sonde WebGPU du contexte, perte de périphérique. Peut tourner dans le worker **ou** sur le fil principal (mode compatibilité). |
| `ai-worker.js` | Simple branchement de l'hôte dans un Web Worker (+ `WORKER_READY`, `WORKER_ERROR`). |
| `index.html` §11bis | **ModelManager** côté page : `aiLoadModel`, repli automatique, transport, UI (cartes Rapide/Avancé/Expert), diagnostic. |

Trois paliers (`RevemAI.TIERS`) : **Rapide** (Llama 3.2 1B), **Avancé**
(Phi-4 Mini), **Expert** (DeepSeek-R1 Distill Qwen 7B). Les identifiants sont
relevés dans le `model_list` de la version épinglée ; `ai-host.js` choisit la
variante `q4f16_1`/`q4f32_1` d'après `shader-f16` puis **vérifie** l'existence de
l'id avant tout téléchargement. **Ne jamais inventer un `model_id`, ne jamais
changer `WEBLLM_VERSION` sans relancer `tests/ai-engine.test.js` (il relit le
vrai `model_list` du paquet npm).**

Règles à ne jamais enfreindre :
- **Un seul moteur, un seul modèle en mémoire.** Tout chargement passe par
  `aiLoadModel()` (une seule promesse à la fois) ; l'hôte sérialise et refuse
  (`BUSY`) un second `INIT_MODEL`.
- **Jamais de VRAM « détectée »** : seuls des faits mesurés (limites d'adaptateur,
  `shader-f16`, résultat réel d'une initialisation) décident. « Prêt » = premier
  jeton réellement généré.
- **Expert n'est jamais choisi automatiquement** et demande confirmation ; un
  palier jamais essayé n'est jamais chargé sans clic.
- **Les erreurs ne se masquent pas** : WebLLM les renvoie sous forme de *chaîne* ;
  passer par `RevemAI.classifyError`/`normalizeError`, jamais `raw.message`.
- **La mémoire du moteur (`ai-engine-memory`) est propre à l'appareil** (hors
  `lsGet/lsSet`, hors sauvegarde, hors synchronisation).
- **« Réinitialiser le cache IA » n'efface que `webllm/*`** (Cache Storage +
  IndexedDB) et l'état d'échecs : jamais la session Supabase, jamais de
  `localStorage` utilisateur.
- Tests : `PASS` / `PASS MOCK` / `NOT TESTED GPU` / `NOT TESTED WKWEBVIEW` — ne
  jamais écrire « fonctionne sur ton Mac » à partir d'un double.

## Séparation des responsabilités (déjà en place, à respecter)

1. **Préparation du contexte** : `buildPrompt(action, extra)` assemble le
   prompt à partir de builders de contexte dédiés —
   `chapterContext(chId)`, `questionContext(q, givenIdx)`,
   `errorsContext(limit)`, `profileContext()`. Une nouvelle action IA doit
   ajouter/réutiliser un builder de contexte, jamais construire son prompt
   à la main dans la fonction d'exécution.
2. **Appel IA** : `aiSend()`/`aiRun(action, extra)` (chapitre) et
   `courseAiSend()` (import de cours) pilotent l'appel réel, toujours
   avec un timeout (`withGenTimeout(promise, ms, label)`, qui interrompt
   proprement le moteur WebLLM — `aiAbortGeneration()` — au
   lieu de laisser une génération tourner indéfiniment).
3. **Validation** : la sortie structurée (JSON attendu pour
   quiz/flashcards/fiches) est extraite de façon tolérante
   (`extractJsonObject()`, répare les virgules traînantes) — **jamais
   imposée aveuglément** : chaque champ manquant a un repli sûr côté
   appelant.
4. **Affichage** : `renderAIMarkdown()`/`renderFicheStructuredHtml()`/
   `markdownLiteFicheHtml()`, toujours après échappement (voir
   `performance-security`).

Ne pas mélanger ces étapes dans une seule fonction pour une nouvelle
action IA — suivre ce découpage.

## Gestion des erreurs et timeouts (déjà en place)

`classifyGenerationError(e)` (qui lit d'abord `e.code` posé par l'hôte) classe toute erreur en 5 catégories avec un
message utilisateur français adapté, jamais un message technique brut :
`memory` (mémoire insuffisante), `webgpu` (accélération perdue),
`cancelled`, `timeout`, `generic` (avec `detail` conservé pour la
console). Réutiliser cette fonction pour toute nouvelle erreur liée à
l'IA, plutôt que d'inventer un nouveau message.

`checkWebGPUCompatibility()` distingue API absente / adaptateur
introuvable / adaptateur trouvé mais périphérique impossible à
initialiser — utilisé pour le diagnostic affiché à l'utilisateur
(`aiDiagnosticPanelHtml()`) avant même de tenter un chargement.

## Fallback — le principe le plus important de ce Skill

**L'IA doit compléter les systèmes déterministes existants, jamais les
remplacer sans repli.** Exemple déjà implémenté et à suivre pour toute
nouvelle action IA sur un chapitre du programme intégré :
`aiRunHeuristicChapterAction(action)` — si `state.aiStatus !== "ready"`
et que l'action est marquée `heuristic` dans `AI_ACTIONS`, on retombe sur
`buildHeuristicCourseMaterials()`/`heuristicSummary()` (règles locales,
sans modèle, à partir de la fiche déjà rédigée) plutôt que de bloquer
l'utilisateur. Le mode simplifié se signale explicitement
(« ⚙️ Mode simplifié (sans IA) ») — **jamais présenté comme une vraie
réponse IA**.

## Ne jamais présenter une réponse IA comme une vérité

Tout contenu généré (quiz, flashcards, fiches, réponses libres) reste
**corrigible par l'utilisateur** (voir `course-library-import`) et n'est
jamais marqué comme faisant autorité au même titre que le contenu du
programme officiel. Une citation "Dans ton cours" doit toujours être une
citation exacte du texte source, jamais une paraphrase du modèle (voir
`quiz-system`).

## Éviter les appels inutiles

- Un texte sous `COURSE_CONDENSE_THRESHOLD` ne déclenche aucun appel de
  condensation (voir `course-library-import`).
- Une régénération ne relance que l'étape demandée
  (`courseImportRetryStep`), jamais tout le pipeline.
- `aiEngineBusy()` empêche de lancer une action IA pendant qu'une autre
  est déjà en cours — toute nouvelle action doit vérifier cet état avant
  de démarrer.

## Secrets

Aucune clé API, aucun secret ne doit jamais être introduit pour l'IA —
WebLLM ne nécessite ni clé ni compte. Si une future fonctionnalité
introduit un vrai appel à un service IA distant, voir
`performance-security` avant de toucher au frontend.

## Questions libres — Mode Général (voir `AI_CHAT.md`)

Une question libre passe par **`aiGeneralAsk()`** (index.html, section 13bis) et la logique pure de
`assistant-core.js` (`RevemAssistant`) : `analyzeQuestion` → `localAnswer` (temps réel / fausse source :
réponse locale, **0 appel au modèle**) → `localCalculation` (calcul exact, jamais eval) → `selectHistory`
(historique pertinent, comprimé, budget RÉEL de 4096 jetons) → `buildGeneralPrompt` (`system` + historique +
question ; palier Expert = consignes dans le premier message utilisateur) → `webllmChat` avec `temperature` /
`topP` / `maxTokens` propres à la question → `cleanAnswer`. **Ne jamais** ajouter un second chemin d'envoi, ni
un appel LLM pour classer / résumer l'historique, ni un chargement de palier déclenché par une question.
Une seule génération à la fois : machine `IDLE/PREPARING/GENERATING/COMPLETE/ABORTED/ERROR`
(`state.aiChat.phase`). Les intentions personnelles (planning, erreurs, réviser) et les actions à panneau
gardent leur flux historique. Pas de lookbehind regex dans le code chargé par la page (`tests/compat-syntax.test.js`).

