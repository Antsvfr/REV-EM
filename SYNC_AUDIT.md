# Audit de la synchronisation par compte — REV-EM

> Étape « Recherche premium + synchronisation complète des données par
> compte ». Ce document est **l'audit** demandé en partie 1, tel qu'il a été
> mené *avant* de modifier le code, puis ce qui a été corrigé et ce qui reste
> ouvert. Le détail du fonctionnement nominal est dans
> [`SYNC_UTILISATEUR.md`](SYNC_UTILISATEUR.md) ; la recherche est dans
> [`SUBJECT_SEARCH.md`](SUBJECT_SEARCH.md).

## 1. Verdict de l'audit

La synchronisation **existait et fonctionnait** : `user-data.js` +
`cloudStart()` / `cloudStop()` dans `index.html`, branchés sur `lsSet()`, 18
tables Supabase sous RLS. Elle n'a **pas** été réécrite (consigne : « ne
réécris pas le système de synchronisation s'il fonctionne déjà »).

L'audit a en revanche trouvé **des défauts réels**, dont certains faisaient
perdre du travail sans le dire. Ils ont été prouvés (script de reproduction,
puis test qui échoue avant le correctif) avant d'être corrigés :

| # | Défaut trouvé | Gravité | Corrigé |
|---|---|---|---|
| D1 | Une modification faite **hors ligne** (ou dans les 900 ms avant de fermer l'onglet) n'existait que dans le cache local ; à la réouverture, la **lecture écrasait** le cache et la modification disparaissait, sans message | perte de données silencieuse | oui |
| D2 | Si la **première lecture échouait** (réseau, base pas prête), aucun moteur n'était actif : aucune nouvelle tentative, et les écritures suivantes n'étaient pas suivies | perte silencieuse + panne muette | oui |
| D3 | À la **connexion avec choix « fusionner »** (et à *chaque* connexion suivante, car le choix est mémorisé), l'envoi supprimait chez le compte les éléments qu'un autre appareil avait ajoutés : le moteur déduisait « présent chez le compte, absent ici ⇒ supprimé » alors que l'appareil n'avait pas encore absorbé le compte | suppression de données d'un autre appareil | oui |
| D4 | À la **déconnexion**, l'envoi final partait *après* la fin de session : Supabase le refuse (RLS), le travail restait dans le cache de l'appareil seulement | perte différée | oui |
| D5 | Au **changement de compte**, l'état en mémoire du compte A restait affiché pendant que le compte B se chargeait (fenêtre de plusieurs centaines de ms : envoi final de A) | fuite d'affichage A → B | oui |
| D6 | `exportAllData()` exportait **tout** le `localStorage` de l'appareil, dont le cache des autres comptes (appareil partagé) | fuite entre comptes | oui |
| D7 | `resetAllData()` supprimait le cache de **tous** les comptes de l'appareil (dont du travail non envoyé) et la langue | perte + effet de bord entre comptes | oui |
| D8 | Le toast d'échec ajouté à l'étape précédente dans `cloudStart()` était du **code mort** : `pullAll()` ne lève jamais, il renvoie `{errors}` | échec toujours muet | oui |
| D9 | Au lancement d'un compte déjà connecté, l'espace **invité vide** s'affichait un instant avant de basculer | flash trompeur | oui |
| D10 | Une instance de synchronisation abandonnée pouvait, plus tard, pousser un état qui n'était plus le sien | fuite potentielle | oui |

## 2. Réponses aux dix questions de l'audit

**1. Qu'est-ce qui est stocké en local seulement ?** Le contenu binaire des
documents et les PDF importés (IndexedDB `rev-em-files`, clés = identifiant de
chapitre, non cloisonnées par compte — voir §9), le modèle WebLLM (cache
navigateur), la langue de l'interface (`lyon-lang`, préférence d'appareil,
voulue), le marqueur `storage-claimed-by`, le choix de migration et la file
`sync-pending` (état de synchronisation, propre à l'appareil).

**2. Qu'est-ce qui est dans Supabase ?** Les 18 tables de
[`SYNC_UTILISATEUR.md`](SYNC_UTILISATEUR.md) (données produit), `profiles`
(identité, prénom, nom, pseudo, téléphone), le bucket privé `avatars`.

**3. Qu'est-ce qui est synchronisé ?** Les 16 clés locales de la table du §4,
dans les deux sens.

**4. Qu'est-ce qui n'est pas synchronisé ?** Voir §4 (colonne « NON
SYNCHRONISÉ »).

**5. Que perd-on en changeant d'appareil ?** Seulement : le contenu binaire
des documents (les métadonnées voyagent ; l'interface dit que le contenu est
ailleurs), les PDF d'origine, la langue, le modèle IA téléchargé.

**6. Comment les données sont-elles associées au compte ?** Par
`auth.users.id` (UUID Supabase, stable). Jamais par nom, e-mail ou appareil.
Côté base : colonne `user_id` + RLS `auth.uid() = user_id`. Côté navigateur :
espace `localStorage` `u.<uuid>.`.

**7. Isolation ?** Trois couches : (a) RLS côté base, seule barrière de
sécurité ; (b) espaces `localStorage` par UUID ; (c) remise à zéro synchrone de
la mémoire au changement de compte + garde d'écriture `stateNamespace`.

**8. Reconnexion ?** Voir §5.

**9. Migration des anciennes données ?** `claimGuestDataForUser` : au premier
compte qui se connecte sur un navigateur, les données invité pré-existantes
sont copiées dans son espace, une seule fois (marqueur global) ; un second
compte démarre vide. Puis, si l'appareil a des données que le compte n'a pas :
**question explicite** (envoyer / utiliser mon compte / plus tard) — jamais de
fusion silencieuse.

**10. Comment fonctionne la synchronisation ?** Voir §5 et §6.

## 3. Identité et isolation (parties 2 et 3)

- **Source d'identité** : `LyonAuth.state.user.id` (Supabase). `currentAuthId()`
  est la seule fonction qui la lit pour le branchement de synchronisation.
- **Au changement de compte** (`handleAuthUserChange`), dans cet ordre, **avant
  le premier `await`** : (1) instantané de l'ancien compte figé, (2)
  `resetUserStateInMemory()` vide données **et** sessions en cours (quiz,
  flashcards, examen, révision intelligente, planning, assistant d'import…),
  (3) `state.accountLoading = true` et rendu neutre « Chargement de ton
  espace… ». Ensuite seulement : envoi final de l'ancien compte avec
  l'instantané figé, puis chargement du nouvel espace.
- **Garde d'écriture** : `lsSet()` refuse d'écrire (et le dit dans la
  console) si l'état en mémoire n'appartient pas à l'espace courant
  (`stateNamespace`). Une écriture tardive d'un minuteur du compte A ne peut
  pas atterrir dans l'espace de B.
- **Premier passage d'un compte sur un appareil** (cache vide) : l'écran de
  chargement reste jusqu'à la première lecture (8 s au plus) — un tableau de
  bord vide ferait croire à une perte.
- **Démarrage avec session mémorisée** : l'écran de lancement reste jusqu'au
  premier événement d'authentification (1,5 s au plus), pour ne jamais montrer
  l'espace invité entre-temps. Sans session mémorisée : aucune attente.
- **Callbacks asynchrones** : la file « à envoyer » est écrite dans l'espace de
  *son* compte (`lsSetForUser`), jamais dans l'espace courant ; chaque étape de
  `cloudStartRun` vérifie que le compte est toujours courant (`stale()`).
- **Sauvegarde / restauration / réinitialisation** (`exportAllData`,
  `importAllDataFromFile`, `resetAllData`) : limitées à l'espace du compte
  courant ; une clé d'un autre compte dans un ancien fichier est ignorée.

## 4. Classification de chaque catégorie (partie 5)

| Donnée | Classe | Où | Note |
|---|---|---|---|
| Profil, prénom, nom, pseudo, téléphone | **SUPABASE** | `profiles` (via `auth.js`) | pas de cache local durable |
| Photo de profil | **SUPABASE** | bucket privé `avatars`, `{uid}/…` | URL signée à la demande |
| Matières, chapitres | **LOCAL + SYNC** | `subjects`, `chapters` | ligne par ligne |
| Cours, fiches, notes de cours | **LOCAL + SYNC** | `chapters`, `course_notes` | |
| Flashcards, cartes IA | **LOCAL + SYNC** | `progress` (`kind='flashcard'`), `ai_cards` | |
| Progression, statistiques, séries | **LOCAL + SYNC** | `progress`, `user_stats`, `daily_stats` | compteurs : maximum |
| Erreurs de quiz, historique par question | **LOCAL + SYNC** | `question_stats` | `wrongQuestions` reconstruit |
| Examens blancs | **LOCAL + SYNC** | `exam_history` | union |
| Planning, activités, visites de chapitres | **LOCAL + SYNC** | `planning_events`, `activities`, `chapter_visits` | |
| Plans de révision | **LOCAL + SYNC** | `study_plans` | |
| Historique IA | **LOCAL + SYNC** | `ai_history` | |
| Préférences (bulle IA, modèle IA) | **LOCAL + SYNC** | `preferences` | |
| Documents — **métadonnées** | **LOCAL + SYNC** | `documents` | |
| Documents — **contenu binaire**, PDF d'origine | **LOCAL (volontaire)** | `localStorage` / IndexedDB | volume ; voir §7 |
| Langue de l'interface | **LOCAL (volontaire)** | `lyon-lang` | préférence d'appareil |
| Modèle WebLLM | **LOCAL** | cache navigateur | centaines de Mo |
| File « à envoyer », choix de migration | **LOCAL** | `sync-pending`, `cloud-choice` | état de synchro, par compte et appareil |

## 5. Cycle de vie (parties 4, 7, 8, 11, 12, 30, 31)

**Local d'abord.** Toute écriture va dans le cache local, immédiatement,
l'interface n'attend jamais le réseau. La synchronisation est en arrière-plan.

**Écriture** : `lsSet` → `cloudNoteLocalWrite` → `cloud.push(domaines)` →
regroupée et différée (900 ms) → un seul cycle par lot (pas une requête par
modification, encore moins par caractère). Idempotente (upsert sur clés
naturelles, migration 005). La liste des domaines en attente est **persistée**
(`sync-pending`) à chaque changement.

**Échec** : le domaine reste en attente ; nouvelle tentative à 2 s, 4 s, 8 s…
plafonnée à 60 s ; **aucune tentative hors ligne** (`navigator.onLine`) — c'est
l'événement `online` qui relance. Un seul toast au passage à l'erreur, jamais
hors ligne (l'indicateur le dit déjà).

**Fermeture de l'onglet** : `visibilitychange`(hidden) et `pagehide` déclenchent
un envoi au mieux. Si le navigateur le coupe : rien n'est perdu, la file est
déjà dans le stockage local et repart à la réouverture.

**Connexion / reconnexion** (`cloudStartRun`) :

1. identifier le compte (Supabase) ;
2. afficher le cache **de ce compte** (jamais celui d'un autre) ;
3. **lire** le compte (remplit les clés connues) ;
4. décider de la migration si besoin (question explicite) ;
5. **envoyer avant de lire** ce qui attendait (« le local d'abord ») — sans
   déduire de suppression à partir de clés que l'appareil n'a pas absorbées
   (D3) — puis relire ;
6. appliquer, domaine par domaine, uniquement ce qui est arrivé ;
7. ne marquer « synchronisé » qu'alors.

Lecture **totalement** ratée (matières incluses) : rien n'est appliqué, le
travail local reste tel quel, reprise automatique avec délai croissant.
Lecture **partiellement** ratée : ce qui est arrivé est appliqué, état
« à terminer », un toast.

**Première connexion sur un nouvel appareil avec des données locales
différentes** : question explicite, chiffres à l'appui (« Cet appareil
contient N éléments, ton compte en contient déjà M »), trois issues :
*Envoyer vers mon compte* (fusion : maximum / union / ajout, rien supprimé),
*Utiliser mon compte* (le compte fait foi ; les modifications locales non
envoyées sont écartées, à la demande de l'utilisateur), *Plus tard* (rien ne
part, rien n'arrive). Après une fusion réussie, le choix devient « compte » :
les connexions suivantes lisent, elles ne re-fusionnent pas.

**Déconnexion** : l'envoi part **avant** la fin de session (`cloudFlushNow`,
borné à 4 s) ; le cache local n'est purgé qu'après confirmation ; en cas
d'échec, cache **et** file sont conservés pour la prochaine connexion sur cet
appareil.

## 6. Conflits (partie 9)

| Nature de la donnée | Stratégie |
|---|---|
| Collections d'objets indépendants (matières, chapitres, notes, événements, documents, stats par question) | ligne par ligne, dernier écrivain gagnant (`updated_at`) |
| Compteurs qui ne font que monter (questions répondues, temps, meilleure série, meilleur score) | **maximum** ; jamais de recul |
| Série en cours | dernière écriture |
| Journaux (activités, examens, réussites) | **union** |
| Suppression | propagée **uniquement** parmi les clés que l'appareil a réellement vues ; jamais déduite au démarrage (D3) |
| Modification locale non envoyée vs lecture | **le local d'abord** : envoyé avant la lecture |

**Limite connue** : une suppression faite hors ligne, puis l'application
fermée avant toute reconnexion, peut **réapparaître** à la réouverture (le
démarrage n'envoie que des ajouts/modifications). C'est un choix : une
suppression qui réapparaît est un désagrément, une création qui disparaît est
une perte.

## 7. Fichiers binaires (partie 6)

Séparation **métadonnées / contenu** : les métadonnées (nom, type, matière,
date) voyagent ; le contenu (jusqu'à ~3 Mo, dans `localStorage`) et les PDF
d'origine (IndexedDB) restent sur l'appareil qui les a importés. Sur un autre
appareil, le document est listé avec son nom et l'interface indique que son
contenu n'est pas disponible ici.

**Non implémenté dans cette étape** (et donc pas testé) : l'envoi du contenu
vers Supabase Storage (bucket privé `documents`, chemin `{uid}/{doc_id}`,
policies sur le premier segment du chemin, envoi paresseux à l'import, plafond
de taille, migration 006). Ce serait le bon design ; il exige un projet
Supabase réel pour être validé, ce qui n'est pas possible depuis cet
environnement. Rien n'est stocké en gros dans `localStorage` de plus
qu'avant.

## 8. Indicateur (partie 10)

Un point de 7 px dans la barre du haut (`#cloud-indicator`, `role="status"`),
dont l'état est dit en toutes lettres dans l'infobulle et pour les lecteurs
d'écran. Invisible pour un invité. Jamais de bandeau.

> **Écart avec la demande** (« ● Synchronisé » en texte visible) : le texte
> n'est pas affiché dans la barre. Mesuré au navigateur, ses 100 à 150 px font
> déborder la navigation (la loupe chevauche « Progression ») à toutes les
> largeurs, la barre étant plafonnée. Le libellé existe, dans les cinq langues,
> en infobulle et en `aria-label` ; un affichage textuel visible demande de
> repenser la barre (par exemple dans le menu du profil) — non fait ici.

| État | Signe | Libellé (FR) | Quand |
|---|---|---|---|
| synchronisé | point plein vert | Synchronisé | tout est confirmé |
| en cours | cercle qui tourne | Synchronisation… | lecture ou écriture en cours, ou lot en attente de départ |
| hors ligne | cercle vide | Hors connexion | `navigator.onLine === false` |
| à terminer | point ambre | Synchronisation à terminer | échec, lecture partielle, reprise à venir |

Cinq langues (FR/EN/ES/DE/IT), parité vérifiée. Seul mouvement : la rotation
pendant une synchronisation réelle, désactivée avec `prefers-reduced-motion`.

## 9. Sécurité (partie 25)

- Toutes les tables de données portent `user_id` et une RLS : 21 instructions
  `enable row level security`, 32 policies dans les migrations 000/001/002.
  RLS **jamais désactivée**. `user_id` envoyé par le navigateur n'est **pas** la
  barrière : un `user_id` falsifié fait échouer l'écriture (test 5 de
  `tests/user-data.test.mjs`, contre un vrai PostgreSQL).
- Aucun secret côté frontend : la clé `anon`/publishable est publique par
  conception ; aucune `service_role`.
- Bucket `avatars` : policies sur `auth.uid()` = premier segment du chemin.
- `sw.js` n'intercepte jamais `*.supabase.co` et ne met en cache que la
  coquille de l'application, aucune donnée utilisateur.

**Risque résiduel** : les PDF d'origine (IndexedDB `rev-em-files`) sont
indexés par identifiant de chapitre, sans préfixe de compte. Les identifiants
de chapitre étant générés aléatoirement, une collision entre deux comptes d'un
même appareil est improbable, mais le cloisonnement n'est pas *garanti par
construction* comme pour `localStorage`. À traiter avec le stockage des
fichiers (§7).

**Autre limite** : « Réinitialiser toutes mes données » (Réglages) vide le
cache de l'appareil pour le compte courant ; pour un compte connecté, les
données du compte reviennent à la prochaine synchronisation. Une vraie remise à
zéro du compte demande une opération côté serveur qui n'existe pas encore.

## 10. Tests

| Suite | Contenu | Réel / remplacé |
|---|---|---|
| `tests/user-data.test.mjs` (129) | moteur contre **PostgreSQL réel** : RLS, contraintes, idempotence, deux identités, file persistable, reprise avec délai, absence d'écriture hors ligne, instance abandonnée, ne rien supprimer avant d'avoir absorbé | HTTP PostgREST et signature du JWT remplacés |
| `tests/account-sync.test.mjs` | **vrai Chromium**, `index.html` réel, deux contextes = deux appareils : hors ligne + réouverture (app tuée / fermeture normale), retour de connexion, panne serveur avec reprise, première lecture en échec + reprise + question de migration (deux réponses), A→B→A sans fuite (échantillonnage toutes les 2 ms), déconnexion qui envoie avant la fin de session, F5 sans flash d'espace invité, quatre états × cinq langues, sauvegarde/restauration/réinitialisation limitées au compte | le **SDK Supabase** est un double en mémoire |
| `tests/subject-search.test.js` (25), `tests/library-search.test.mjs` (73) | classement, champ jamais recréé, aucune requête réseau, responsive, cinq langues | — |

Le test central (hors ligne + app tuée + réouverture en ligne) a été vérifié
comme **détectant** le défaut : avec `initialPending` neutralisé, il échoue
(3 vérifications), avec le correctif il passe.

### Ce qui n'est PAS testé (et ne doit pas être présenté comme testé)

- **NOT TESTED — REAL DEVICES** : deux vrais appareils physiques ; les
  « deux appareils » des tests sont deux contextes de navigateur isolés.
- **NOT TESTED — against real Supabase** : le réseau réel, les e-mails de
  confirmation, la latence, l'expiration de session, la vraie
  implémentation Realtime/RLS de Supabase Cloud. L'environnement de test
  bloque `*.supabase.co`.
- **NOT TESTED** : Supabase Storage pour le contenu des documents (non
  implémenté, §7).
- **NOT TESTED — real reload with a real SDK session** : le double du SDK
  simule la session mémorisée (`sb-…-auth-token`), pas le vrai
  rafraîchissement de jeton.
