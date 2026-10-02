# Pipeline de SORTIE de l'assistant : du texte brut du modèle à la réponse propre

Suite de `AI_CHAT.md` (entrée : analyse, contexte, prompt) et `AI_KNOWLEDGE.md` (connaissances).
Ce document traite **la sortie** : ce qui se passe entre le premier jeton de WebLLM et l'écran.

> **Ce que ce document prouve et ne prouve pas.** Les tests rejouent des flux **simulés** (`PASS` pour la
> logique pure, `PASS MOCK` dans une vraie page avec un **faux** moteur). Ils prouvent que, *pour ces flux*,
> l'affichage et la mémoire sont corrects. **Rien ne prouve qu'un vrai DeepSeek-R1 produira de meilleures
> réponses** : `NOT TESTED REAL WEBLLM`, `NOT TESTED GPU`, `NOT TESTED MAC`, `NOT TESTED WKWEBVIEW`.

## 1. Le défaut observé, et sa cause

Réponse réelle : `</think>` visible, mots chinois dans du français, la même réponse plusieurs fois, « mesyre »,
langue demandée mal respectée, impression de « plusieurs tentatives internes » concaténées.

### Ce que j'ai vérifié dans le code réel (WebLLM 0.2.85 installé dans `node_modules`, et le code du projet)

| Question | Constat | Preuve |
|---|---|---|
| Le moteur renvoie-t-il le raisonnement à part (`reasoning_content`) ? | **Non.** Aucun champ de ce nom dans WebLLM 0.2.85 : le raisonnement arrive **en clair dans `delta.content`** | `grep reasoning` dans `lib/index.js` → aucun résultat |
| Delta ou texte complet ? | **Delta** : `choices[0].delta.content`, un jeton à la fois ; la page fait `+=` | `ai-host.js` l. 328-332 ; `aiOnHostMessage` |
| Un chemin peut-il livrer deux fois le même événement ? | **Non constaté** : un seul `w.onmessage` par transport, un seul transport actif | `index.html`, `aiStartWorkerTransport` |
| Un retry concatène-t-il l'ancienne tentative ? | **Non** : chaque appel a son propre `aiGen` ; mais l'**affichage** gardait le partiel de la tentative précédente jusqu'au premier jeton suivant | `aiGeneralAsk`, boucle de tentatives |
| Que fait l'ancien filtre ? | `stripReasoning` ne retirait **que les paires complètes** `<think>…</think>` (et un bloc ouvert en cours de flux) | `ai-engine.js` (supprimé) |
| `enable_thinking` ? | Existe (`extra_body`), mais la doc de WebLLM le dit **réservé à Qwen3** ; il préfixe `<think>\n\n</think>\n\n` | `lib/openai_api_protocols/chat_completion.d.ts` |
| Le gabarit de chat du modèle (`mlc-chat-config.json`) ? | **Non lisible depuis cet environnement** (Hugging Face injoignable) | — |
| Modèle de reasoning dans REV-EM ? | **Oui : le palier Expert**, `DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC` (ou `q4f32_1` sans `shader-f16`), `reasoning: true` ; Rapide = Llama 3.2 1B, Avancé = Phi-4 mini (aucun ne raisonne) | `ai-engine.js` `TIERS` |

### Cause exacte des `</think>`

Un modèle de la famille DeepSeek-R1 écrit son raisonnement **avant** la réponse, fermé par `</think>`. Selon son gabarit de
chat, la balise **ouvrante** `<think>` peut être placée **dans le prompt** par le gabarit : le modèle n'a alors jamais à
l'émettre. La sortie est : *raisonnement, puis `</think>`, puis réponse*. L'ancien filtre cherchait une **paire** :
sans `<think>`, il ne trouvait rien — et **tout** (le raisonnement, ses brouillons de réponse, la balise) était affiché,
puis stocké dans la conversation, puis **renvoyé au modèle** au tour suivant.

*Limite honnête :* je n'ai pas pu lire le gabarit réel du modèle ; j'ai donc traité **les deux formes** (balise ouvrante
présente ou absente). La forme « orpheline » est celle qui explique exactement ce qui a été observé.

### Cause des « duplications » et des « plusieurs tentatives concaténées »

Probable à 100 % de la même origine : le raisonnement d'un R1 *est* une suite de brouillons (« Let me draft : … Hmm, wait,
better : … »). Affiché à cause du `</think>` orphelin, il se lit comme plusieurs versions de la réponse collées bout à bout,
suivies de la réponse finale. Aucune génération n'était accumulée deux fois (vérifié : delta, un seul listener, un seul
`aiGen`). Deux aggravants réels, corrigés : (a) l'historique renvoyé au modèle contenait ces brouillons, donc le tour
suivant les répétait ; (b) « en français » n'était pas compris (voir plus bas) : le modèle recevait un message vide de sens
au-dessus d'un historique pollué. Les boucles de répétition d'un R1 trop « froid » existent aussi : détectées maintenant.

### Cause des caractères chinois, de « mesyre » et du français approximatif

**Cause identifiable : le modèle.** DeepSeek-R1-Distill-**Qwen**-7B est un Qwen entraîné majoritairement en chinois et en anglais,
qui mélange les langues, surtout dans son raisonnement et à température élevée ; la qualité de son français est
limitée. Aucun post-traitement ne la transforme : **je ne l'ai pas tenté** (aucun remplacement de mots, aucune « correction »).
Ce qui est fait : instruction de langue plus ferme pour ce palier, température ramenée à 0,6, **détection** de l'alphabet
étranger et note discrète proposant de régénérer. *Si la contamination persiste sur le Mac, c'est la limite du modèle :
Avancé (Phi-4 mini) est le palier à utiliser pour du français soigné.*

**Modèle exact de la réponse observée :** non déterminable depuis ici (je n'ai pas la capture du diagnostic). Les symptômes
(`</think>` + chinois) désignent **Expert**. Le Diagnostic affiche `activeModel` : à confirmer dans le test 1 du protocole.

## 2. Architecture AVANT

```
WebLLM ─▶ ai-host.js (delta.content) ─▶ GENERATION_TOKEN{delta}
       ─▶ page : aiGen.text += delta ─▶ stripReasoning(texte)   « paires complètes seulement »
       ─▶ aiGeneralPaint (rAF) ─▶ cleanAnswer (filler, URL, « Sources ») ─▶ affichage
       ─▶ à la fin : stripReasoning ─▶ cleanAnswer ─▶ état.aiThread ─▶ renvoyé au modèle au tour suivant
```

## 3. Architecture APRÈS

```
WebLLM ─▶ ai-host.js (delta) ─▶ GENERATION_TOKEN{delta}
  ─▶ ASSEMBLEUR (output-processor.js, un par génération)
       push(delta)      un delta est AJOUTÉ ; un « delta » qui recolle tout le texte déjà reçu est un cumul : remplacé
       extract()        filtre du raisonnement par ÉTAT sur le texte accumulé (balises coupées, orphelines, absentes)
       visible()        ce qui s'affiche PENDANT le flux : rien du raisonnement, aucune balise même partielle
       détecteur de boucle ─▶ si boucle : ABORT une fois
  ─▶ aiGeneralPaint ─▶ cleanAnswer ─▶ affichage
  ─▶ finish(): jetons spéciaux · boucle réduite · doublons évidents · typographie  ─▶ validate()
  ─▶ aiGeneralAsk : erreur claire (vide, raisonnement tronqué, boucle) | réponse NETTOYÉE ─▶ aiThread ─▶ historique ─▶ modèle
  brut : en MÉMOIRE seulement (revemLastRawOutput), jamais stocké, jamais synchronisé, jamais affiché
```

Un seul module (`output-processor.js`, `RevemOutput`), pur, testable sous Node. L'ancien `stripReasoning` d'`ai-engine.js` est
**supprimé** (pas de second filtre). Tous les consommateurs de `aiHostGenerate` en profitent : le chat (pipeline complet) et
les tâches de cours / JSON (**filtre du raisonnement et des balises seulement**, contenu jamais retouché).

## 4. Traitement du raisonnement

`extract(raw, { reasoning, final, finishReason })` :

* `</think>` **avant** toute balise ouvrante ⇒ ce qui le précède est du raisonnement ;
* palier à raisonnement, flux en cours, **aucune balise encore reçue** ⇒ on **retient** (on suppose qu'il réfléchit) jusqu'à `</think>` ;
* fin de flux sans aucune balise ⇒ réponse directe ; **sauf** coupure par la limite de longueur ⇒ raisonnement inachevé, **jamais affiché comme une réponse** ;
* `<think>` jamais refermé ⇒ réponse vide + `REASONING_TRUNCATED` ;
* `<THINK>`, plusieurs blocs, sauts de ligne après la balise : gérés.

Conséquence assumée : sur un palier à raisonnement qui répondrait **directement sans aucune balise**, le texte n'apparaît qu'à la
fin (on ne peut pas savoir plus tôt que ce n'est pas du raisonnement). Le spinner « Réflexion… » reste affiché.

## 5. Traitement du streaming

Le texte est **recalculé depuis le texte accumulé** : une balise coupée entre deux chunks (`</thi` + `nk>`) est reconnue dès qu'elle
est complète, et en attendant, le fragment (`<thi`, `<|im_`…) n'est **pas affiché** (`trimPartial`). Testé : balise découpée à
**toutes** les positions possibles (plusieurs centaines de découpages) et caractère par caractère : jamais une fuite. Dans la
page, un `MutationObserver` enregistre **chaque état du DOM** pendant le flux : aucun mot du raisonnement n'y figure.
**Delta :** WebLLM envoie des deltas ; un garde-fou traite comme cumulé un « delta » qui recolle tout le texte déjà reçu
(≥ 4 caractères, +3 au moins) — jamais le cas d'un vrai jeton — pour empêcher « A », « AB », « ABC » de donner « AABABC ».

## 6. Traitement des retries

Un retry (contexte trop grand → nouvel essai à 65 % de fenêtre) : nouvel `aiGen`, **nouvel assembleur** ; le tampon d'affichage de la
tentative précédente est **réinitialisé** (`aiPaintReset`) ; la conversation ne reçoit **que** la réponse finale. Le diagnostic compte
honnêtement 2 appels. Il n'y a pas de retry « de qualité » (pas de second appel pour corriger).

## 7. Verrou de langue

Priorité : **instruction explicite** (« en français », « in English », « auf Deutsch », « en español », « in italiano ») >
**langue de la question** > **langue verrouillée de la conversation** (la dernière détectée) > langue de l'interface.

* « en français » **après une réponse** = *réécrire la réponse précédente en français* (avant : message flou « continue l'échange » → c'est
  ce qui, avec un historique pollué, produisait la réponse triplée) ;
* « Explique l'inflation en anglais » → réponse en anglais ; « Explain inflation in English. » → anglais ;
* « Comment dit-on *obligation* en anglais ? » est une **traduction d'un terme**, pas un changement de langue : la réponse reste française ;
* un changement logique (question clairement française après des échanges anglais) change la langue.

**Instruction compacte** (≈ 34 jetons, ajoutée au prompt système) : *« Answer in French: natural, idiomatic, grammatical, complete
sentences; no stray foreign words or literal translations; never repeat yourself. »* ; palier à raisonnement : + *« Your final
answer, after any thinking, must be entirely in French. »*

## 8. Output Processor

| Étape | Fait | Ne fait JAMAIS |
|---|---|---|
| Raisonnement | filtre par état, flux compatible | afficher le raisonnement, même une fraction de seconde |
| Jetons spéciaux | retire `<\|eot_id\|>`, `<\|im_end\|>`, `<\|end\|>`, `<｜end▁of▁sentence｜>` (réellement émis par Llama / Phi / Qwen / DeepSeek) | maintenir une longue liste de balises inventées |
| Typographie | espaces multiples, lignes vides répétées, espace avant `,` `.`, fins de ligne | toucher `: ; ! ?` (typographie française), les blocs de code, les tableaux, les formules, le Markdown |
| Boucle | un bloc ≥ 12 car. répété 3 fois (6 pour un bloc court) à la suite → **arrête** la génération, garde un exemplaire | confondre une ligne de points avec une boucle |
| Doublons | paragraphe ≥ 120 car. quasi identique (**mêmes nombres**, similarité ≥ 0,92, longueur voisine) à un précédent ; phrase répétée deux fois de suite | fusionner deux calculs qui ne diffèrent que par leurs chiffres ; toucher code / tableau / liste |
| Alphabet étranger | **détecte** (Han, kana, hangul, cyrillique, arabe, hébreu, thaï, devanagari, ponctuation pleine largeur ; **pas** le grec mathématique) | **supprimer** : « Que signifie 衡量 ? » reste intact ; permis si la question/la conversation contient du non-latin, un nom de langue étrangère, ou « traduis » |
| Sens | — | remplacer un mot, « corriger » le français, réécrire une connaissance |

## 9. Validation (`validate`, déterministe, jamais un jugement de vérité)

`EMPTY`, `REASONING_TRUNCATED` (erreurs) · `LOOP`, `LENGTH_CUT`, `TAGS_REMAINING`, `FOREIGN_SCRIPT`, `LANG_MISMATCH` (détecteur injecté,
≥ 200 caractères, seulement si sûr), `ANOMALOUS_LENGTH` (avertissements) · `DUPLICATE_REMOVED`, `REASONING_STRIPPED` (infos). Une erreur
→ message simple traduit + « Réessayer » ; un avertissement de langue/alphabet → **note discrète** sous la réponse (« Régénère… ») ; le
reste → diagnostic. Aucun deuxième appel au modèle.

## 10. Paramètres de génération modifiés (et pourquoi)

| Paramètre | Avant | Après | Raison |
|---|---|---|---|
| Expert : température | 0,5 à 0,7 | **0,5 à 0,6** (explication : 0,6) | 0,6 est la valeur recommandée par DeepSeek pour R1 : plus haut → mélanges de langues ; plus bas → boucles |
| Expert : `max_tokens` (court / normal / profond) | 900 / 1 300 / 1 700 | **1 000 / 1 600 / 2 200** | le raisonnement consomme des jetons **avant** la réponse : trop juste → réponse jamais écrite (désormais détecté) ; reste dans la fenêtre de 4 096 (le constructeur réduit si besoin) |
| Rapide / Avancé : température, `top_p`, `max_tokens` | 0,2–0,8 / 0,8–0,95 / 200–1 000 | **inchangés** | rien ne justifiait de les toucher ; définition 0,3, explication 0,5, calcul 0,2 sont déjà prudents |
| Pénalités de répétition | absentes | **absentes** | non mesurables sans le vrai modèle ; la boucle est détectée et arrêtée à la place |

Coût : l'instruction de langue ajoute ≈ 34 jetons ; un prompt de question seule passe d'environ 268 à ≈ 310 jetons.

## 11. Performance

Mesuré (Node, 27 090 caractères en 6 773 chunks, `push` + `visible()` à **chaque** chunk) : **153 ms cumulées sur tout le flux**
(≈ 0,02 ms par chunk) ; **traitement final** (filtre + boucle + doublons + typographie) : **1,7 ms** (`outputProcessingMs`, dans le
diagnostic). Négligeable devant la génération. Aucun appel au modèle supplémentaire. Ces chiffres sont ceux de Node : sur le Mac ils
dépendent du navigateur, mais l'ordre de grandeur (millisecondes) laisse une marge très large.

## 12. Limites

* Le gabarit réel du modèle n'a pas été lu : les deux formes sont traitées, mais seul un vrai test sur le Mac confirme laquelle se produit.
* Contamination de langue et français approximatif de R1/Qwen : **limites du modèle**, détectées et signalées, pas guéries.
* Le filtre de doublons est volontairement conservateur : une **variante** (un mot différent) d'un paragraphe n'est pas retirée.
* Palier à raisonnement répondant sans balise : texte affiché seulement à la fin.
* Boucle **dans** le raisonnement : la génération est arrêtée mais il n'y a pas de réponse (erreur claire + Réessayer ; une régénération
  augmente la température).

## 13. Protocole de test pour toi (Mac, WebLLM réel) — 10 tests

Prépare : ouvre **Diagnostic** (la ligne *activeModel* et la ligne **output** t'intéressent). Commence en **Expert**.

| # | À FAIRE | COMPORTEMENT ATTENDU | À OBSERVER |
|---|---|---|---|
| 1 | Expert : « Explique-moi simplement à quoi sert l'écart-type en finance. » | Réponse française, **aucun** `<think>`, aucun brouillon, aucune répétition | `activeModel` (confirme le modèle), `orphanThink` true/false (confirme la cause), `reasoningHidden` > 0, `outputProcessingTime` |
| 2 | Puis « en français » | Réécriture française de la réponse, **pas** une nouvelle réponse triplée | `preferredLanguage fr (explicit)` ; la réponse précédente n'est pas répétée |
| 3 | « Qu'est-ce que l'inflation ? » | Concise, française | aucun problème dans `issues` |
| 4 | « Explain inflation in English. » | Anglais | `preferredLanguage en (explicit)` ; la question suivante en français revient au français |
| 5 | « Que signifie le mot chinois 衡量 ? » | Le caractère chinois est **conservé** | aucune note, `allowForeign true` |
| 6 | Pendant une réponse Expert, regarde l'écran | Spinner « Réflexion… » puis le texte final ; **jamais** de texte en anglais type « Okay, the user… » | rien du raisonnement n'apparaît, même brièvement |
| 7 | « Explique la VAN. » → « Plus simplement. » → « Donne-moi un exemple. » | Contexte cohérent, aucune trace d'artefact | console : `revemLastRawOutput()` donne le brut ET le propre : compare |
| 8 | Question volontairement longue en Expert : « Explique en détail le CAPM, avec ses limites. » | Réponse complète, **ou** message clair « limite de réflexion épuisée » (jamais du raisonnement affiché) | `finishReason`, `LENGTH_CUT` / `REASONING_TRUNCATED` ; si fréquent : passe en Avancé |
| 9 | Refais le test 1 en **Avancé** puis en **Rapide** | Français naturel ; compare avec Expert | la contamination chinoise ne devrait pas apparaître (modèles non-Qwen) |
| 10 | Si un caractère étranger apparaît : regarde la note sous la réponse, puis **Régénérer** | Note discrète proposant de régénérer ; la régénération la fait disparaître ou non | `issues : FOREIGN_SCRIPT` ; si elle réapparaît toujours en Expert, c'est la limite du modèle |
