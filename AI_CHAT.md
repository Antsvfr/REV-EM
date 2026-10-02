# Questions libres — Mode Général : chaîne de traitement, mesures, protocole

Cette intervention porte sur la chaîne COMPLÈTE d'une question libre posée à
l'assistant local (WebLLM), pas sur quelques phrases de prompt. Voir aussi
`AI_AUDIT.md` (moteur WebLLM, paliers, worker).

> **Ce que ce document prouve et ne prouve pas.** Les tests sont `PASS` (logique
> pure, analyse statique) ou `PASS MOCK` (vraie page, **faux** moteur : on lit les
> messages exacts envoyés au moteur, mais aucun modèle ne répond). Rien ici ne dit
> qu'un vrai modèle sur un vrai GPU écrit de meilleures réponses :
> `NOT TESTED REAL WEBLLM`, `NOT TESTED MAC`, `NOT TESTED WKWEBVIEW`. Le protocole de
> la fin de ce fichier sert à le vérifier sur ton Mac.

## 1. Architecture AVANT (constatée dans le code)

```
barre « Pose ta question… » (#assistant-query-input)
  → aiRunPersonalQuery
  → detectAssistantIntent            mots-clés ; repli « chapter »
  → buildAssistantContext("chapter") = assistantPerformanceContext()
                                       tableau de maîtrise de l'étudiant (≤ 6 000 car.)
  → state.aiThread[0] = { role:"user",
        content: AI_SYSTEM_BASE + langue + CONTEXTE + « QUESTION… : » + question }
  → aiSend → webllmChat(TOUT le fil) → aiHostGenerate
  → AIE.compactHistory(budget ≈ 2 946 jetons, réponse max 1 000)
  → GENERATE { temperature: 0.6 (fixe), maxTokens: 1000 (fixe) }
  → flux → #ai-stream (innerHTML à chaque jeton) → réponse
suite : aiFollowUp → thread.push(texte brut) → même chaîne
```

## 2. Problèmes réellement trouvés

| # | Problème | Preuve |
|---|---|---|
| 1 | Une question **générale** reçoit le **tableau de maîtrise** de l'étudiant (contexte hors sujet, jusqu'à 6 000 car.) | `detectAssistantIntent` retombe sur `"chapter"` → `assistantPerformanceContext()` |
| 2 | Prompt système **contradictoire** en mode Général : « tu t'appuies en priorité sur le contenu du cours fourni » alors qu'**aucun cours** n'est fourni ; « concis » mais 1 000 jetons autorisés ; aucune règle d'honnêteté | `AI_SYSTEM_BASE` |
| 3 | Les consignes sont dans un message **`user`** (pas de rôle `system`), recopiées avec le contexte au **premier** message du fil | `state.aiThread[0].content` |
| 4 | **Tout l'historique** est renvoyé à chaque message ; quand ça dépasse le budget, `compactHistory` retire d'abord les **échanges du milieu** — donc la réponse à « simplifier » peut disparaître | banc : avec des réponses réelles (≈ 750 jetons) le message 5 d'un fil perd un échange |
| 5 | Température **fixe 0,6** et 1 000 jetons pour TOUT (définition d'une ligne comme dissertation) ; `top_p` jamais utilisé | `aiHostGenerate` |
| 6 | **Pas de bouton Arrêter** dans le chat personnel (la rangée « Annuler » n'existe que pour les actions à panneau) | `renderAI`, branche `!isPersonal` |
| 7 | **Pas de Régénérer** pour une question libre (« Relancer » réinitialise le fil) | `renderAI` |
| 8 | Les 4 boutons rapides (« plus simplement »…) sont **identiques** après toute réponse et envoient des phrases figées | `assistantExplainQuickActionsHtml` |
| 9 | Aucune protection contre l'invention : temps réel (« cours du Bitcoin ») traité comme « mon planning » à cause du mot « aujourd'hui » ; références/URL inventées jamais filtrées | `detectAssistantIntent` |
| 10 | Calculs entièrement confiés au modèle | aucun moteur de calcul |
| 11 | Marqueur « *(génération interrompue)* » **écrit dans le contenu** de la réponse, donc renvoyé au modèle au tour suivant | `aiSend` |
| 12 | Erreurs : « L'assistant n'a pas pu répondre (message technique brut) » ; code de l'hôte (`DEVICE_LOST`, `contextExceeded`…) ignoré par le chat | `aiErrorMessage` |
| 13 | Le palier **Expert** (DeepSeek-R1 : raisonnement `<think>` avant la réponse) a le même plafond de 1 000 jetons : la réponse peut être coupée avant d'avoir commencé | `TASK_MAX_TOKENS.chat` |
| 14 | `finishReason` et `usage` émis par l'hôte mais **ignorés** par la page | `aiOnHostMessage` |

Non-problèmes vérifiés : le moteur n'est **jamais** rechargé entre deux questions (seul
`GENERATE` est envoyé) ; une seule génération à la fois est déjà garantie par l'hôte ;
aucun appel LLM n'est utilisé pour classer (la détection d'intention existante est locale).

## 3. Architecture APRÈS

```
question
  ↓  analyzeQuestion         intention · profondeur · langue · consignes de forme   (assistant-core.js, local)
  ↓  localAnswer             temps réel / référence inventée → réponse LOCALE, 0 appel au modèle
  ↓  localCalculation        calcul exact en JavaScript (jamais eval)
  ↓  selectHistory           historique PERTINENT, comprimé, dans le budget réel
  ↓  selectStrategy          consignes de réponse + température / top_p / max_tokens
  ↓  buildGeneralPrompt      [system] + historique + question (+ consigne collée à la question)
  ↓  aiHostGenerate          GENERATE { messages, temperature, topP, maxTokens }   (ai-host.js)
  ↓  WebLLM, en flux         rAF : au plus une mise à jour du DOM par image
  ↓  cleanAnswer             pas de flatterie, pas de « Sources » ni d'URL inventées
  ↓  mémoire de conversation (thread : contenu BRUT + meta {intent, topic, followType, aborted…})
```

* **Un seul assistant** : `aiGeneralAsk()` (index.html, section 13bis) est LE point
  d'entrée ; `aiRunPersonalQuery` et `aiFollowUp` y mènent. Les actions à panneau
  (Expliquer, Résumer, Quiz…) et les intentions **personnelles** (aujourd'hui, planning,
  erreurs, réviser) gardent leur flux — elles parlent de l'étudiant et ont besoin de son profil.
* **Aucun appel LLM** pour classer, résumer l'historique ou préparer : le modèle écrit LA
  réponse, rien d'autre.
* **Le routeur n'est pas rigide** : l'intention est un *indice* interne (jamais affichée) ;
  le prompt ne contient pas de gabarit imposé, seulement des priorités.

## 4. Question Analyzer (`analyzeQuestion`)

Heuristiques déterministes, **5 langues** (FR, EN, ES, DE, IT) : structure de la question,
mots-clés, contexte précédent. Aucun appel au modèle.

| Intention | Déclencheur (exemples) |
|---|---|
| `CURRENT_INFORMATION` | « cours du Bitcoin **aujourd'hui** », météo, scores, « inflation actuelle » (jamais « valeur actuelle nette » ni « taux d'actualisation ») |
| `CALCULATION` | nombres + « combien / calcule / intérêts / moyenne… » ou expression arithmétique |
| `DEFINITION` | « qu'est-ce que », « c'est quoi », « définis », *what is*, *¿qué es?*, *was ist*, *cos'è* |
| `EXPLANATION` | « explique », « pourquoi », « comment fonctionne » |
| `COMPARISON` | « compare », « différence entre », *vs* |
| `PROCEDURE` · `SUMMARY` · `BRAINSTORMING` · `EXERCISE` | « comment faire / étapes » · « résume » · « idées » · « exercice / fais-moi une question » |
| `REFORMULATION` | message court **sans sujet propre** après une réponse : « plus simplement », « donne-moi un exemple », « plus court », « approfondis » |
| `FOLLOW_UP` | « et si le taux augmente ? », « donc ? », pronoms/renvois (« compare-**le** à la VAN », « explique le **résultat** ») |
| `GENERAL_KNOWLEDGE` | tout le reste (repli) |

Le **sujet** (`extractTopic`) est mémorisé : « Qu'est-ce que la VAN ? » → *VAN* ; il est
rappelé explicitement au modèle pour les suites (les petits modèles perdent vite le fil).
Les suggestions cliquées portent leur intention (`forced`) : rien n'est deviné.

## 5. Profondeur adaptative

`SHORT` / `NORMAL` / `DEEP`, déduite de la question (« EBITDA définition » → SHORT ;
« Explique-moi l'EBITDA » → NORMAL ; « Quelles sont les limites de l'EBITDA dans l'analyse
financière… » → DEEP) **et** des demandes explicites (« en une phrase », « plus court »,
« juste la réponse » → SHORT ; « plus détaillé », « explique le raisonnement » → DEEP ;
« débutant », « niveau avancé » ajoutent une consigne de niveau). Jamais une règle rigide :
l'utilisateur peut toujours demander autre chose au tour suivant.

## 6. Stratégies de réponse (`selectStrategy`)

Consignes courtes, construites dynamiquement (le prompt système reste petit) :

* Définition : réponse directe → intuition → exemple *seulement s'il apporte quelque chose*.
* Explication : idée → intuition → mécanisme → exemple. Calcul : données → formule →
  substitution → résultat → sens. Exercice, comparaison, procédure, résumé, idées : voir
  `STRATEGY_LINES`.
* Reformulation : *réécrire la réponse PRÉCÉDENTE* plus simplement, **sans repartir de zéro**
  (+ la réponse précédente est dans le contexte). Autres suites : exemple, plus court,
  approfondir, vérification (« pose UNE question, ne donne pas la réponse »), continuer.
* Domaines : **finance** (intuition → mécanisme → formule si utile → exemple → sens),
  **économie** (concept → mécanisme → agents → effets ; corrélation ≠ causalité, court ≠ long
  terme), **mathématiques / statistiques** (jamais une formule seule, sauf réponse très courte demandée).

## 7. Context Builder (`selectHistory`, `buildGeneralPrompt`)

Priorité : question actuelle → sujet → **dernier échange complet** (la réponse à simplifier /
prolonger) → échanges plus anciens **comprimés** (question + première phrase de la réponse,
3 au plus) → le reste abandonné. Retirés : salutations, messages en erreur, réponses
locales (temps réel / source), marqueur « interrompue ». Une question **indépendante**
n'envoie **aucun** historique.

**Budget RÉEL** : les trois paliers ont `context_window_size: 4096` (vérifié dans le
`prebuiltAppConfig` de `@mlc-ai/web-llm` 0.2.85 installé). Budget d'historique = 4096 −
marge (120) − réponse autorisée − consignes − question ; s'il est trop petit, c'est d'abord la
*réponse autorisée* qui est rognée (jamais sous un plancher), puis les lignes de style
optionnelles, puis l'historique — **jamais la question**. Estimation : 1 jeton ≈ 3,2 car.
(même règle que `ai-engine.js`). Si l'hôte répond « contexte dépassé », **un** second essai a
lieu avec un contexte réduit de 35 %.

## 8. Prompt système

~190 jetons (≈ 600 car.), en anglais (les petits modèles suivent mieux ; la langue de réponse
est donnée explicitement) : tuteur de gestion, réponse directe d'abord, pas de flatterie ni de
conclusion artificielle, **honnêteté** (connaissances internes seulement, ni internet ni données
en direct ; ne jamais inventer chiffres / études / auteurs / citations / dates / URL / sources),
formules en texte simple, et « un bloc VERIFIED CALCULATION est exact : réutilise ses nombres ».
Le comportement détaillé vient des consignes dynamiques ci-dessus. Les consignes sont dans un
vrai message **`system`**, sauf pour le palier **Expert** (DeepSeek-R1) : l'éditeur recommande
de les mettre dans le premier message utilisateur — c'est ce qui est fait.

## 9. Rapide / Avancé / Expert

Réutilise `state.aiTier` et le ModelManager existants : **aucun** second sélecteur, **aucun**
second moteur, **aucun** chargement déclenché par une question. Réponse maximale par palier et
profondeur (`MAX_TOKENS`) : Rapide 200 / 420 / 700 ; Avancé 260 / 600 / 1 000 ; Expert
900 / 1 300 / 1 700 (le raisonnement `<think>` consomme des jetons avant la réponse, masqué par
`stripReasoning`). Question complexe en Rapide → **suggestion discrète** « pourrait bénéficier
du mode Avancé » (jamais de changement automatique) ; Avancé + question très difficile en
maths/stats/finance → suggestion « Expert ».

## 10. Paramètres de génération

Vérifiés dans les types de WebLLM 0.2.85 (`chat_completion.d.ts`) : `temperature`, `top_p`,
`max_tokens`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `stop`, `seed`.
Utilisés ici : **température**, **top_p**, **max_tokens** seulement. Quatre profils, pas vingt :
calcul 0,2 / 0,8 · factuel 0,3 / 0,9 · explication 0,5 / 0,9 · brainstorming 0,8 / 0,95 ;
palier Expert : température 0,5–0,7 (plage recommandée pour R1). Une **régénération** monte la
température de 0,12 pour pouvoir répondre autrement. `top_p` n'est envoyé que s'il est fourni
et valide : les appels existants (cours, quiz…) sont inchangés. **Non modifiés** : pénalités,
`stop`, `seed` (non nécessaires ; à évaluer sur de vraies réponses).

## 11. Streaming, TTFT, arrêt, régénération

* Flux : l'hôte envoie chaque jeton ; la page peint **au plus une fois par image** (rAF) au
  lieu d'une fois par jeton, et n'efface pas le spinner tant que rien d'affichable n'est arrivé.
* **TTFT** : mesuré à deux endroits — côté moteur (`ttftMs`, déjà émis par l'hôte) et côté page
  (`ttftPageMs`, dispatch → premier jeton) ; plus `timePreparing` (soumission → dispatch) et
  `generationTime`. **Uniquement dans le panneau de diagnostic** (jamais dans la conversation).
  Le banc ne mesure que la préparation JavaScript (quelques ms) : le **vrai TTFT** dépend du GPU
  → `NOT TESTED REAL WEBLLM`.
* **Arrêter** : « Envoyer » devient « Arrêter » ; bouton aussi dans la conversation ; **Échap**.
  Envoie `ABORT` (`interruptGenerate`), garde la réponse partielle (marquée dans les *données*,
  pas dans le texte), ne recharge rien. La question suivante repart avec cette réponse partielle.
* **Régénérer** : même question, même contexte pertinent, modèle courant ; la réponse est
  **remplacée** (pas de doublon dans l'historique).

## 12. Mémoire conversationnelle

Le fil garde le contenu **brut** + des métadonnées ; le prompt est reconstruit à chaque tour
(donc régénérer / réessayer sont triviaux). Exemple testé : « Qu'est-ce que la VAN ? » → « plus
simplement » → « donne-moi un exemple » → « et si le taux d'actualisation augmente ? » : chaque
suite reçoit la réponse précédente, le sujet *VAN* et la consigne adaptée, sans renvoyer tout
l'historique.

## 13. Incertitude, temps réel, fausses sources

* **Temps réel** (cours, actualité, météo, scores, chiffres du jour) : réponse **locale**
  immédiate « je n'ai pas accès aux informations en temps réel dans ce mode… », **sans appel au
  modèle** — un petit modèle inventerait. Elle propose d'expliquer ce qui fait varier ce type de
  chiffre. Les réponses locales ne sont jamais renvoyées au modèle comme contexte.
* **Demande de référence précise** (« l'étude exacte qui prouve… ») : réponse locale qui refuse
  d'inventer et explique comment retrouver une vraie source (Google Scholar, bases de l'école).
  « étude de marché », « sources de financement » ne déclenchent pas ce garde-fou.
* **Filet après génération** (`cleanAnswer`) : retire les ouvertures creuses (« Bien sûr ! »), les
  rubriques « Sources / Références » finales, les URL et les liens Markdown. Le mode Général =
  connaissances internes ; aucune source n'a été consultée.
* Incertitude générale : consigne système « si tu n'es pas sûr, dis-le brièvement » (sans
  avertissement systématique). *Son effet réel sur un vrai modèle n'est pas mesuré ici.*
* **Futur module Web** : non implémenté. `analysis.realtime` est le point d'accroche naturel
  (aujourd'hui : réponse locale ; plus tard : appel au module).

## 14. Calculs

`localCalculation` (pur, **jamais** `eval`/`Function` — un analyseur par pile sur liste blanche de
symboles ; testé contre des entrées hostiles) : intérêts composés (annuels, mensuels, trimestriels,
semestriels) et simples, valeur actuelle, **VAN** avec flux explicites, pourcentage d'un nombre,
variation en %, moyenne / médiane / somme / variance / écart-type, arithmétique (+ − × ÷ ^ et
parenthèses). Le résultat exact + formule + substitution sont injectés dans le prompt (bloc
`VERIFIED CALCULATION`) ; le modèle **explique et interprète**, il ne recalcule pas. Nombres lus
selon la langue (« 1 000 », « 1.000 », « 1,5 »). Ce qui n'est pas reconnu retourne `null` : le
modèle répond seul (aucune valeur inventée par le moteur). **Limites** : pas d'équations,
d'IRR/TRI, de probabilités ni de calcul symbolique ; la formulation libre (« j'ai mis 1k à 5% »)
n'est pas comprise.

## 15. États et erreurs

Machine unique `IDLE → PREPARING → GENERATING → COMPLETE | ABORTED | ERROR` (`nextPhase`) :
« occupé » = PREPARING ou GENERATING ; un second envoi est **refusé** (jamais de seconde
génération silencieuse) ; `state.aiBusy` en découle. Codes : `MODEL_NOT_READY`,
`ENGINE_INIT_FAILED`, `DEVICE_LOST`, `GENERATION_FAILED`, `GENERATION_ABORTED`,
`CONTEXT_TOO_LARGE`, `OUT_OF_MEMORY`, `WORKER_FAILED`, `EMPTY_RESPONSE`, `BUSY`,
`UNKNOWN_ERROR` — réutilise les codes de l'hôte et les messages `ai.err.*` existants ; messages
simples (traduits ×5), détails dans le diagnostic. « Réessayer » relance la même question.

## 16. Interface

Barre unique + une ligne discrète « **Général** · Avancé » (mode et palier actifs). Puis la
conversation. Actions sous la dernière réponse : **Copier**, **Régénérer** ; puis 2 à 3
suggestions **contextuelles** (après une définition : exemple / approfondir / une question ;
après un calcul : expliquer le résultat / changer une hypothèse), jamais celle qu'on vient de
demander. Aucun nom de catégorie, d'intention ou de stratégie n'est affiché. Textes dans
`translations.js` (clés `assistant.*`, 5 langues).

## 17. Mesures AVANT / APRÈS (`tests/assistant-bench.mjs`)

Ce que le banc mesure (réel) : ce que la **vraie page** envoie au moteur (messages, caractères,
jetons estimés), le nombre d'appels, la préparation JavaScript. Le « moteur » est un faux qui
répond un texte fixe. Version AVANT = commit `fc9e401` servi tel quel ; APRÈS = ce commit.

| Message | Jetons estimés AVANT | APRÈS | Appels LLM |
|---|---:|---:|:-:|
| « Qu'est-ce que l'EBITDA ? » (seul) | 352 | **268** | 1 → 1 |
| Conversation TRI, msg 1 | 351 | 309 | 1 → 1 |
| msg 2 « Plus simplement » (réponses de 600 car.) | 555 | 556 | 1 → 1 |
| msg 3 « Donne-moi un exemple… » | 764 | **577** | 1 → 1 |
| msg 4 « compare-le à la VAN » | 972 | **708** | 1 → 1 |
| msg 5 « Fais-moi une question… » | 1 187 | **786** | 1 → 1 |
| Mêmes msg 3 / 4 / 5 avec des réponses de 2 400 car. (≈ réelles) | 1 956 / 2 761 / 2 777 | **1 173 / 1 305 / 1 382** | 1 → 1 |
| Calcul 1 000 € à 5 % sur 4 ans | 365 (aucun calcul fiable) | 416 (**calcul exact fourni**) | 1 → 1 |
| « Cours du Bitcoin aujourd'hui ? » | 397 (routé comme « mon planning ») | **0** | 1 → **0** |

* AVANT, à 2 400 car. par réponse, le fil approche le plafond de 2 946 jetons dès le message 4
  et **perd un échange** au message 5 ; APRÈS, il reste à ~1 400 jetons.
* Le premier message est plus court (268 vs 352), pas dramatiquement : le gain principal est la
  **pertinence** (plus de tableau de maîtrise) et la **croissance** de l'historique.
* Réponse maximale : AVANT 1 000 pour tout ; APRÈS 260 (définition) à 1 000 (question profonde).
* TTFT : **non mesurable ici** (pas de GPU). `prepMs` JavaScript : 4–27 ms avant comme après.

## 18. Compatibilité

* **Chrome / Chromium** : testé (PASS MOCK, vrai Chromium).
* **Safari / WKWebView** : le code ajouté n'utilise aucune API Chromium-only (vérifié par
  analyse statique), ni lookbehind regex (test `compat-syntax`), et la copie a un repli
  `execCommand`. **Non exécuté sous WebKit** (absent de cet environnement) :
  `NOT TESTED WKWEBVIEW`. **Aucune modification Swift/Xcode n'est requise** (pas de nouvelle API
  WebView, pas de réseau, pas de nouveau fichier hors du dossier web). Si ton app macOS embarque
  une **copie** des fichiers web : `assistant-core.js` est un nouveau fichier à inclure.
* Le service worker précache `assistant-core.js` (`rev-em-v8`).

## 19. « Mes cours » (préparé, NON développé)

`buildGeneralPrompt` prend déjà `history`, `analysis`, `calc` ; un mode « Mes cours » ajoutera
un bloc de contexte récupéré (RAG) *avant* la question et une consigne « réponds d'après ces
extraits ». Rien de ce qui est écrit ici ne l'empêche. Non développé : embeddings, index,
découpage de PDF, recherche vectorielle.

## 20. Limites restantes

* La **qualité** des réponses (pédagogie, justesse en finance, respect des consignes de forme)
  dépend du modèle : Llama 3.2 1B (Rapide) reste limité. Non mesurée ici.
* Un petit modèle peut ignorer « une seule phrase » ou « pas de flatterie » ; le filet
  `cleanAnswer` retire la flatterie mais ne tronque pas les phrases en trop.
* Le temps réel n'est reconnu que par motifs (marché, météo, actualité, scores, statistiques
  « actuelles ») : une formulation inhabituelle passera au modèle (qui a la consigne de ne pas inventer).
* La détection d'intention est heuristique : une formulation très atypique tombe en
  `GENERAL_KNOWLEDGE` (réponse correcte, mais sans stratégie dédiée).
* Pas de LaTeX : les formules sont demandées en texte simple.

## 21. Protocole de test pour toi (Mac, WebLLM réel) — 10 tests, ~15 minutes

Prépare : onglet Assistant, palier **Avancé** chargé. Ouvre « Diagnostic » pour lire le TTFT.
Chaque test : **QUESTION À POSER** → **COMPORTEMENT ATTENDU**.

1. **Définition** — « Qu'est-ce que l'EBITDA ? » → 2 à 4 phrases, directe, sans « Bien sûr ! »,
   sans dissertation ; réponse démarrée vite.
2. **Explication** — « Explique-moi la loi normale comme si je débutais. » → langage simple,
   définit les termes, idée → intuition → exemple ; pas de formule seule.
3. **Finance** — « Pourquoi une hausse des taux fait-elle baisser le prix d'une obligation ? » →
   commence par l'intuition (anciennes obligations moins attractives), puis le mécanisme ; exemple
   numérique ou formule seulement si utile ; pas de définition académique récitée.
4. **Calcul** — « 1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ? » → formule,
   substitution, **1 215,51 €** (le chiffre vient du moteur local), puis une phrase d'interprétation ;
   aucun autre montant.
5. **Question complexe en Rapide** — passe en **Rapide**, puis « Quelles sont les limites de
   l'EBITDA dans l'analyse financière d'une entreprise ? » → réponse structurée ; **aucun modèle ne
   se télécharge** ; message discret « pourrait bénéficier du mode Avancé ».
6. **« Plus simplement »** — après « Qu'est-ce que la VAN ? » écris « plus simplement » → la **même**
   notion réécrite plus simplement (pas une nouvelle définition générique).
7. **« Donne-moi un exemple »** — ensuite « donne-moi un exemple » → un exemple **sur la VAN**.
8. **Continuité** — puis « et si le taux d'actualisation augmente ? » → raisonnement cohérent
   (la VAN diminue), sans redéfinir la VAN ; enchaîne avec « maintenant compare-la au TRI » →
   comparaison VAN/TRI.
9. **Temps réel** — « Quel est le cours du Bitcoin aujourd'hui ? » → réponse **immédiate** : pas
   d'accès aux données en temps réel, **aucune valeur**, aucun chargement (Diagnostic : `llmCalls : 0`).
   Variante : « Donne-moi l'étude exacte qui prouve cette affirmation. » → refuse d'inventer une référence.
10. **Arrêt / régénération** — pose une question longue (« Explique en détail le CAPM »), clique
    **Arrêter** (ou Échap) en cours de route → le texte reçu reste, « Réponse interrompue », la
    page ne se fige pas, **le modèle n'est pas rechargé** ; pose ensuite une autre question (réponse
    normale) puis **Régénérer** → la réponse est remplacée (pas dupliquée).

Dans « Diagnostic → Dernière réponse », note aussi : `TTFT(engine)` (cible subjective : le texte
commence en moins de 1–2 s sur Avancé une fois le modèle chaud), `historyMessagesUsed`, `finishReason`
(`length` = réponse coupée → un bouton « Continue » apparaît). Pour vérifier automatiquement les
propriétés objectives d'une réponse réelle (pas d'URL, bon résultat de calcul, une phrase…), colle-la
dans la console : `RevemAssistant.checkAnswer("E", "<réponse>")` (cas A à L : `RevemAssistant.CASES`).
