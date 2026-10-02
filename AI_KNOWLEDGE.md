# REV-EM Knowledge Engine (V1) et assistant V2

Deuxième volet de l'assistant « Questions libres » (le premier : `AI_CHAT.md`). Cette
intervention construit **le moteur** qui donne au modèle local des connaissances
pédagogiques structurées **avant** la génération — pas la base elle-même.

> **Ce que ce document prouve et ne prouve pas.** Tests : `PASS` (logique pure, fichiers de
> données), `PASS MOCK` (vraie page, **faux** moteur WebLLM : on lit les messages exacts
> envoyés, aucun modèle ne répond). **Rien ici ne dit que les réponses sont meilleures** :
> `NOT TESTED REAL WEBLLM`, `NOT TESTED GPU`, `NOT TESTED MAC`, `NOT TESTED WKWEBVIEW`. Le
> protocole de la section 17 sert à le vérifier sur le Mac, et l'outil de comparaison
> ON/OFF (section 12) permet de **lire** la différence plutôt que de la supposer.

## 1. Audit — ce qui existait (et qu'on a donc réutilisé)

Une seule chaîne de question libre, `aiGeneralAsk()` → `assistant-core.js` → `webllmChat` →
`ai-host.js`/worker. Vérifié dans le code avant d'écrire quoi que ce soit :

| Question | Constat |
|---|---|
| Appels LLM par question | **1** (classement, mémoire, préparation : tous locaux et déterministes) |
| Moteur réinitialisé entre deux questions | **Non** — seul `GENERATE` est envoyé |
| Tout l'historique envoyé | **Non** — `selectHistory` : dernier échange entier + 3 plus anciens comprimés, dans le budget |
| Prompt système volumineux | **Non** — une question seule part avec ≈ 270 jetons (système + consignes + question) |
| Plusieurs pipelines IA | Un par fonction (chapitre, planning, quiz…), **un seul** pour les questions libres |
| Analyseur / stratégie / constructeur de contexte / prompt | **Existaient** (`analyzeQuestion`, `selectStrategy`, `selectHistory`, `buildGeneralPrompt`) |
| Retrieval, données pédagogiques | **Absents** → c'est ce qui est ajouté |
| Une seule génération GPU à la fois | Garantie par l'hôte **et** par `aiGeneralAsk` (refus propre) |
| Calculs, temps réel, fausses sources | Déjà locaux (`localCalculation`, `localAnswer`) |

Conséquence : **pas de second assistant**, pas de nouveau pipeline. Le moteur de connaissances
est une **étape de plus** dans la chaîne existante, et le budget de contexte reste central.

## 2. Architecture APRÈS

```
question
  ↓ analyzeQuestion              intention · profondeur · domaine · langue · consignes   (assistant-core.js, local)
  ↓ localAnswer                  temps réel / fausse source → réponse LOCALE (0 appel, 0 connaissance)
  ↓ localCalculation             calcul exact JS → connaissances NON ajoutées (inutiles, plus lent)
  ↓ wantsKnowledge               pas pour « plus simplement » / « plus court » / « continue » (on réécrit la réponse précédente)
  ↓ RevemKnowledge.retrieve      sujets repérés · candidats · scores · top-k selon le palier     (knowledge-engine.js, local, < 1 ms)
  ↓ attachTopics                 complète l'analyse : topics[] et domaine (si inconnu)
  ↓ toBlocks                     chaque élément : version COMPLÈTE et version COMPACTE
  ↓ buildGeneralPrompt           UN budget central : question > connaissances > conversation > consignes
  ↓ WebLLM (un seul appel, en flux)
  ↓ cleanAnswer → mémoire de la conversation
```

Rien de ce schéma n'est visible dans l'interface. Aucun appel LLM n'a été ajouté.

## 3. Fichiers

| Fichier | Rôle |
|---|---|
| `knowledge-engine.js` | **Moteur PUR** (`RevemKnowledge`) : schéma, validation, index, retrieval, mise en forme. Ni DOM, ni réseau, ni `state`. |
| `ai-knowledge/index.json` | Manifeste : la liste des fichiers chargés |
| `ai-knowledge/topics.json` | Lexique des **sujets** (identifiant + mots de toutes langues) |
| `ai-knowledge/<domaine>/*.json` | Un fichier = un élément de connaissance (5 éléments **DÉMO** aujourd'hui) |
| `ai-knowledge/README.md` | **Comment ajouter une connaissance** (guide, exemple complet) |
| `assistant-core.js` | + `fitKnowledge`, `wantsKnowledge`, `attachTopics`, bloc de connaissances dans `buildGeneralPrompt`, domaines comptabilité / marketing / management, codes d'erreur |
| `index.html` | Chargement paresseux, réglage Auto/Désactivées/Démo, diagnostics, `revemKnowledgeCompare` |
| `tests/knowledge-engine.test.js` | 157 vérifications pures |
| `tests/knowledge-ui.test.mjs` | 101 vérifications `PASS MOCK` (vrai Chromium + vrais fichiers) |
| `tests/knowledge-bench.mjs` | Banc OFF/ON A–L + hors-sujet |

Les **données sont des fichiers statiques versionnés dans Git** : rapides, auditables, relisibles
en diff, compatibles GitHub Pages, utilisables hors ligne (précache du service worker), aucune
requête Supabase. Supabase reste réservé aux données utilisateur ; la connaissance REV-EM n'y est
pas stockée.

## 4. Question Analyzer — ajouts

L'analyseur existant (12 intentions, 3 profondeurs) est conservé. Ajouts :

* **`topics`** : les sujets repérés par le lexique `topics.json` (ex. « Pourquoi une hausse des taux
  fait-elle baisser les obligations ? » → `["bonds", "interest_rates"]`). Aucun LLM.
* **Domaines** : ajout de **management** ; **marketing** reconnaît « marketing », « campagne »,
  « publicité », « réseaux sociaux »… ; un domaine `general` est complété par celui du sujet repéré.
* **Intention** : « Comment créer / lancer / organiser… » → `PROCEDURE`.
* **Une suite reste dans le domaine de la conversation** (« donne-moi un exemple » après une question
  de finance garde le style finance et retrouve les mêmes connaissances).
* **Consignes de domaine** pour comptabilité, marketing, management (en plus de finance, économie,
  maths, stats).

## 5. Schéma d'un Knowledge Item

Détail champ par champ : `ai-knowledge/README.md`. Le schéma sépare **contenu** (`summary`, `facts`,
`mechanisms`, `formulas`, `examples`, `commonMistakes`), **concepts** (`title`, `topic`, `topics`,
`relatedConcepts`), **alias** (multilingues), **mots-clés**, **formules** (chaîne ou `{name, expression, note}`),
**provenance** (`sources[]`), **validation** (`verified`, `status`, `lastReviewed`), **version**,
**sensibilité au temps** (`timeSensitive`) et un champ `avoid` (expressions qui annulent l'élément).

**Le validateur refuse** : id mal formé ou ne commençant pas par son domaine ; champs obligatoires
absents ; `verified` absent ; `verified: true` **sans source** ou **sans `lastReviewed`** ; un élément
`demo` déclaré vérifié ; sujet absent du lexique ; référence cassée ; id en double ; même titre sur deux
éléments. **Il avertit** : provenance manquante, alias partagé (ambiguïté), `timeSensitive` sans date,
élément trop long. **Un élément invalide n'entre jamais dans l'index** (jamais de demi-connaissance servie).

## 6. Retrieval et scoring

Déterministe, sans LLM, sans embeddings. L'index (phrases normalisées → éléments) est **construit une
fois** au premier usage et réutilisé. Normalisation unique (minuscules, accents, ponctuation, pluriels) des
deux côtés. Mesuré : **0,04 ms** par question sur la base de démo, **< 15 ms** sur 2 000 éléments.

| Signal | Points | Remarque |
|---|---:|---|
| Concept (`title`) dans la question | **100** | |
| Alias (toutes langues) | **80** | |
| Sujet principal (`topic`) | **40** | via `topics.json` |
| Autre sujet (`topics`) | **30** | |
| Mot-clé fort | **15** chacun, plafond **45** | |
| Concept lié (`relatedConcepts`) à un élément déjà ≥ 80 | **+10** | jamais suffisant seul |
| Même domaine que la question | **+10** | seulement si déjà touché |
| Terme de 1–3 lettres (« van », « tri ») **non corroboré** | 35 / 15 | « tri des lignes d'un tableau » ≠ TRI |
| Terme issu de la **conversation** (suite) | × 0,8 | le sujet courant retrouve l'élément |

Sélection : **score ≥ 40**, **≥ 45 %** du meilleur, **top-k selon le palier** (Rapide 2, Avancé 3, Expert 3, plafond
5). Rien ne passe le seuil → **`NO KNOWLEDGE`** → réponse WebLLM normale. `avoid` annule un élément
(« obligation légale » ne ramène pas les obligations financières).

## 7. Confiance : ce qui a le droit d'être envoyé

| Mode (réglage) | Envoyé au modèle |
|---|---|
| **Auto** (défaut) | éléments **vérifiés** uniquement — *aujourd'hui, aucun* : la base ne contient que de la démo |
| **Démo** | + éléments `status:"demo"`, **non vérifiés**, étiquetés `UNVERIFIED` dans le contexte |
| **Désactivées** | rien |

Un `draft` n'est **jamais** envoyé. Si des éléments sont retrouvés mais retenus (mode Auto), le
diagnostic le dit (`withheld`). Un élément non vérifié change la consigne donnée au modèle (« indice, pas
autorité »). Une source n'apparaît dans le contexte que si elle existe dans les métadonnées.

## 8. Budget de contexte (central, dans `buildGeneralPrompt`)

Fenêtre **réelle** des trois paliers : **4096 jetons** (vérifiée dans le `model_list` de WebLLM 0.2.85,
jamais supposée). Ordre de priorité : **question > connaissances > conversation > consignes optionnelles**.

* Plafond de connaissances par palier : Rapide **520**, Avancé **640**, Expert **640** jetons ; jamais plus de
  **70 %** du budget restant (**45 %** s'il faut aussi de la conversation).
* `fitKnowledge` : tous les éléments classés tiennent d'abord en version **compacte** (idée + 1 mécanisme + 1 formule) ;
  le reste du budget passe les mieux classés en version **complète**. Réponse **courte** (définition, « en une phrase ») :
  compacte uniquement. Budget < 80 : **aucun bloc** plutôt qu'un bloc tronqué.
* Dernier recours si ça déborde : lignes de style optionnelles → conversation → connaissances → réponse autorisée
  (plancher 120). **La question n'est jamais coupée.**

## 9. Rapide / Avancé / Expert

Préservés : le palier choisi reste le palier (testé : aucun changement, aucun chargement). Rapide reçoit **2** éléments
au plus et un plafond plus bas ; Expert (DeepSeek-R1, sans rôle `system`) reçoit les connaissances dans le premier
message utilisateur. L'hypothèse « petit modèle + bon contexte = meilleure réponse » **n'est pas vérifiée ici**.

## 10. Calculs, temps réel, sources

* **Calculs** : inchangés — moteur local exact, jamais `eval`. Quand un calcul local est fourni, les connaissances ne sont
  pas ajoutées (statut `skipped:calculation`).
* **Temps réel** : réponse locale (« je n'ai pas accès aux informations en temps réel »), 0 appel, 0 connaissance. Aucune valeur.
  Point d'accroche futur : `analysis.realtime`. **Pas d'accès Web.**
* **Sources** : aucune n'est inventée. Seules celles des métadonnées d'un élément peuvent apparaître ; `cleanAnswer`
  retire URL et rubriques « Sources » produites par le modèle.
* **`timeSensitive`** : le contexte envoie « may be outdated (last reviewed …) — never present it as current ».

## 11. Mesures (diagnostic uniquement — jamais dans la conversation)

Panneau « Diagnostic » → *Dernière réponse* : `questionIntent`, `domain`, `topicsDetected`, `responseDepth`,
`knowledgeMode`, `knowledgeStatus`, `knowledgeCandidates`, `knowledgeSelected`, `knowledgeScores`, `knowledgeContext`
(jetons, éléments utilisés / compactés / abandonnés / retenus), `retrievalTime`, `historyMessagesUsed`, `llmCalls`,
`timePreparing`, `TTFT(engine)`, `TTFT(page)`, `generationTime`, `activeModel`, `finishReason`, `errorCode`.
« Copier le diagnostic » ajoute l'état de Knowledge et ces mesures — **sans** texte de question ni de réponse.

## 12. Comparer OFF / ON (outil de développement)

* Réglage **Connaissances REV-EM : Auto / Désactivées / Démo** dans le panneau de diagnostic (mémorisé via
  `lsGet/lsSet`, jamais synchronisé).
* Console : `revemKnowledgeCompare("Qu'est-ce que la VAN ?")` → compare les **prompts** avec/sans.
  `revemKnowledgeCompare("…", { generate: true, temperature: 0.2 })` → génère **les deux réponses**, l'une après l'autre
  (jamais en parallèle sur le GPU), sans rien écrire dans la conversation. **Aucun score automatique ne dit laquelle est
  meilleure : on les lit.**

## 13. Mesures du banc (`tests/knowledge-bench.mjs`, faux moteur)

Prompt envoyé au moteur, OFF → ON (Avancé). **Ce que ça mesure :** ce qui part au modèle. **Ce que ça ne mesure pas :** la qualité.

| Cas | Jetons OFF → ON | Connaissances (jetons) | Éléments |
|---|---:|---:|---|
| A EBITDA | 268 → 268 | 0 | aucun (hors base de démo) |
| B obligations / taux | 326 → 912 | 532 | `finance.bond-interest-rates` |
| C loi normale | 336 → 863 | 472 | `statistics.normal-distribution` |
| D VAN vs TRI | 313 → 805 | 436 | `finance.irr` + `finance.npv` |
| E calcul 1 000 € à 5 % | 414 → 414 | 0 | calcul local exact, connaissances non ajoutées |
| F « plus simplement » | — | 0 | réécriture : pas de connaissances |
| G « donne-moi un exemple » | 340 → 913 | 518 | `finance.npv` (par la conversation) |
| H « et si le taux d'actualisation augmente ? » | 384 → 957 | 518 | `finance.npv` |
| I Bitcoin / J fausse source | 0 → 0 | 0 | réponse locale, **0 appel** |
| K « en une phrase » | 295 → 558 | 208 | `economics.inflation`, version compacte |
| M1–M3 hors-sujet (marketing Instagram, crêpes, taux de change) | inchangé | 0 | rien ne remonte |

Partout : **1 appel au modèle**, récupération **< 1 ms**. **Coût réel d'un élément :** +200 à +530 jetons de prompt, donc un
temps de lecture du prompt (préremplissage) plus long avant le premier jeton. **Ce coût n'est PAS mesuré ici** (pas de GPU) :
c'est la première chose à regarder sur le Mac (`TTFT(engine)` OFF vs ON).

## 14. « Mes cours » et le futur Web — préparés, NON implémentés

```
                    QUESTION
                       │
                 Query Analyzer   ← analyzeQuestion (existe)
          ┌────────────┼────────────┐
     REV-EM Knowledge   Mes cours    Web
     (cette livraison)  (PDF RAG)   (données actuelles)
          └────────────┼────────────┘
                 buildGeneralPrompt  ← budget central (existe)
                       │
               Rapide / Avancé / Expert
```

Knowledge reste **séparé** de Mes cours (autre stockage, autre retrieval). Les questions personnelles (« que dois-je réviser ? »)
ne reçoivent **aucune** connaissance REV-EM (testé). Chaque source future produira des blocs `{id, score, full, compact, …}`
que `fitKnowledge` sait déjà ranger sous un seul budget.

## 15. Compatibilité

* Chrome / Chromium : testé (PASS MOCK).
* Safari / WKWebView : aucun lookbehind regex (test `compat-syntax`), aucune API récente, `fetch` de fichiers statiques de même
  origine seulement. **Non exécuté sous WebKit** : `NOT TESTED WKWEBVIEW`. **Aucune modification Xcode n'est requise** par
  ce code. **Si ton app macOS embarque une COPIE des fichiers web**, il faut y ajouter `knowledge-engine.js` et le dossier
  `ai-knowledge/` (sinon l'assistant fonctionne, sans connaissances : statut `unavailable`).
* Hors ligne : le service worker (`rev-em-v9`) précache moteur, manifeste, lexique et éléments.
* **À vérifier sur le Mac (WKWebView)** : les éléments sont lus par `fetch()` de fichiers statiques **de même origine**. Si l'app macOS
  charge le site depuis `https://` (GitHub Pages), c'est le cas normal. Si elle charge des fichiers locaux `file://`, une WebView peut
  refuser ce `fetch` : l'assistant répond alors **normalement, sans connaissances** (diagnostic : `status unavailable`) — jamais une
  erreur affichée. Test 2 du protocole : si `selected` reste vide en mode Démo et que le statut est `unavailable`, c'est ce cas.
  **ACTION MANUELLE XCODE POSSIBLE** (non inventée, à confirmer seulement si ce symptôme apparaît) : servir `ai-knowledge/` par le même
  schéma d'URL que `index.html`.

## 16. Limites

* **Aucune connaissance vérifiée n'existe encore** : en mode Auto, rien n'est envoyé. La base de 5 éléments est de la démo, écrite
  de mémoire, **non relue**, sans source.
* Retrieval **lexical** : une reformulation sans aucun mot connu (ni alias, ni mot-clé, ni sujet) ne retrouve rien — d'où des alias
  multilingues riches. Pas de sémantique, par choix (simple, testable).
* Termes ambigus : « van », « tri » ne comptent qu'avec un contexte de domaine ; d'autres ambiguïtés se règlent par `avoid`.
* Les éléments en français sont envoyés tels quels à un modèle qui répond dans la langue de l'élève : la traduction implicite par
  le modèle n'est **pas évaluée**.
* Le gain de qualité, le coût en TTFT et le comportement de WebGPU ne sont **pas mesurés ici**.

## 17. Protocole de test pour toi (Mac, WebLLM réel) — 10 tests, ~20 minutes

Prépare : palier **Avancé** chargé. Ouvre **Diagnostic** → *Connaissances REV-EM* → **Démo** (sinon, en mode Auto, rien
n'est envoyé — c'est voulu).

| # | QUESTION À POSER | COMPORTEMENT ATTENDU | CE QUE TU DOIS OBSERVER |
|---|---|---|---|
| 1 | « Qu'est-ce que l'EBITDA ? » | 2–4 phrases, directe, sans « Bien sûr ! » | Diagnostic : `knowledge … selected none` (l'EBITDA n'est pas dans la base) ; réponse normale, rapide |
| 2 | « Pourquoi une hausse des taux fait-elle baisser le prix d'une obligation ? » | Intuition (anciennes obligations moins attractives) puis mécanisme ; exemple chiffré cohérent (≈ 981 €) | `selected finance.bond-interest-rates`, `knowledgeContext ≈ 500 tokens` ; compare avec le mode **Désactivées** |
| 3 | « 1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ? » | Formule, substitution, **1 215,51 €**, interprétation | `localCalc` renseigné ; `knowledgeStatus skipped:calculation` |
| 4 | « Compare VAN et TRI. » | Points communs, différences, conflit possible (VAN fait référence) | `selected finance.irr, finance.npv` ; les deux erreurs courantes du TRI apparaissent-elles ? |
| 5 | « Explique-moi la loi normale comme si je débutais. » | Langage simple, cloche, μ/σ, règle 68-95-99,7 | `selected statistics.normal-distribution` ; pas de formule seule |
| 6 | « Qu'est-ce que la VAN ? » → « plus simplement » → « donne-moi un exemple » → « et si le taux d'actualisation augmente ? » | Même notion réécrite ; exemple sur la VAN ; la VAN **diminue** | « plus simplement » : `knowledgeStatus not-needed` ; les 3 autres : `finance.npv` ; `historyMessagesUsed` > 0 |
| 7 | « Quel est le cours du Bitcoin aujourd'hui ? » | Pas d'accès temps réel, **aucune valeur** | Réponse immédiate, `llmCalls 0`, aucun chargement |
| 8 | « Comment créer une campagne marketing Instagram ? » | Étapes concrètes ; **aucune** mention VAN / obligations | `selected none` — le moteur n'a rien injecté |
| 9 | « Explique en détail le CAPM » puis **Arrêter** en route, puis une autre question, puis **Régénérer** | Texte reçu conservé, « interrompue », **modèle non rechargé** ; régénération = réponse remplacée | pas de redémarrage du modèle ; la conversation n'est pas dupliquée |
| 10 | **Comparaison OFF/ON** — console : `revemKnowledgeCompare("Pourquoi une hausse des taux fait-elle baisser le prix d'une obligation ?", { generate: true, temperature: 0.2 })` ; refais-le en palier **Rapide** | Deux réponses imprimées, **lis-les** : la version ON est-elle plus juste / plus pédagogique ? | `TTFT` et `totalMs` OFF vs ON (le coût du contexte supplémentaire) ; **ne conclus pas** sans avoir lu les deux textes |

Pour juger objectivement une réponse réelle : `RevemAssistant.checkAnswer("B", "<réponse>")` (cas A–L : `RevemAssistant.CASES`).
