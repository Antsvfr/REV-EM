# Intégration REV-EM × LexNote — étape 1 : architecture et contrat

> ## ⚠️ STATUT ACTUEL — décisions du propriétaire (révisées après l'audit)
>
> **Conservé comme fondation documentée :** ce document, `integration-contract/`, les schémas Zod versionnés,
> le principe de jetons courts signés **Ed25519**, la séparation des responsabilités REV-EM / LexNote.
>
> **Révisé :** le **lien par installation n'est PAS l'architecture définitive**. La cible est
> **utilisateur REV-EM ↔ liaison explicite ↔ utilisateur LexNote**, jamais *installation ↔ installation locale*.
> Les comptes LexNote, la synchronisation multi-appareils et la séparation stricte des données par utilisateur sont
> des fonctionnalités **prioritaires** (plus de « V6 hypothétique »).
>
> **Suspendu :** l'étape 2 (appairage, Edge Functions de lancement, routes de connexion). **Rien** de ce qui reste à
> construire ne doit dépendre de l'absence actuelle de comptes LexNote.
>
> **Facultatif :** la migration `007_lexnote_links.sql` reste dans le dépôt mais **rien n'en dépend** et elle n'est
> **pas à appliquer** pour l'instant (voir §7). Elle sera revue — voire remplacée — quand LexNote aura ses comptes.
>
> **Priorité :** rendre LexNote fonctionnel comme produit indépendant multi-utilisateur (feuille de route §11), puis
> seulement reprendre l'intégration (phase 10). Les sections ci-dessous décrivent l'état *à l'issue de l'audit* ; les
> passages devenus provisoires sont marqués **[PROVISOIRE]** ou **[SUPPRIMÉ DE LA CIBLE]**.

> **Deux applications indépendantes, une intégration propre.** Pas de fusion de dépôts, pas de base commune,
> pas de compte commun. REV-EM est le *hub* de l'étudiant ; LexNote est le moteur spécialisé (notes, transcription,
> supports). Cette étape pose le **socle** : propriété des données, contrat versionné, liens profonds, sécurité,
> tables d'intégration. **Aucun comportement utilisateur n'est modifié.**

## 0. Ce que l'audit a changé par rapport au brief

L'audit de LexNote (dépôt `Antsvfr/LexNote`, commit `cc56ee7`) contredit plusieurs hypothèses du brief. Elles
conditionnent toute l'architecture :

| Hypothèse du brief | Réalité constatée dans LexNote | Conséquence |
|---|---|---|
| LexNote a une authentification et un modèle d'utilisateur | **Aucune.** Un « profil » local (`localStorage`, prénom + citation), « jamais envoyé ». La carte REV-EM de la barre latérale dit « Connexion bientôt disponible ». | **[RÉVISÉ]** Un lien par installation avait été envisagé ; il est **abandonné comme architecture définitive**. On construit d'abord les comptes LexNote (§11). |
| LexNote a sa propre base Supabase | **Aucune base distante.** IndexedDB (`lexnote` + `lexnote-capture`), `SyncEngine` *no-op*. « Aucune donnée ne quitte l'appareil. » | **[RÉVISÉ]** LexNote aura **sa propre base Supabase** (phase 3) ; `revem_links` y sera une vraie table (voir §7). |
| `StudyArtifacts`, « cours intelligent », cartes mentales, schémas existent | **Pas encore.** `CourseSession` réserve `aiOutputs` (restructured/summary/studySheet), `flashcards`, `questions` ; IA = `NullProvider`. Roadmap V4–V5. | Le contrat décrit les supports **à venir** ; aucun n'est simulé. |
| Routes `/course/:sessionId`, `/artifact/:artifactId`, `/integrations/revem/session` | Routes actuelles : `/`, `subjects`, `modules/:id`, `sessions`, `search`, `settings`, `session/:id`, `session/:id/recap`. | Les trois routes sont **à créer** (alias/redirections) — spécifiées §5, **non créées** (voir §8). |
| REV-EM a des routes `/course/:eventId`, `/revision/:subjectId` | REV-EM n'a **pas de routeur** : navigation par `state.tab` (`switchTab`), URL inutilisée (seul `?brightspace=` est lu). Hébergé en statique (GitHub Pages) : pas de réécriture serveur. | Routes REV-EM en **fragment** (`#/course/<id>`), non branchées pour l'instant. |

## 1. Audit — REV-EM

| Sujet | Constat (fichier) |
|---|---|
| Auth | Supabase Auth via `auth.js` ; `profiles` (id = `auth.users.id`, prénom, nom, avatar). Invité = `localStorage` seul. |
| Modèle utilisateur | `auth.users.id` (uuid) ; **toutes** les données sont filtrées par `user_id` + RLS (`auth.uid() = user_id`). |
| Planning / événements | `planning.js` (moteur pur) + `parseICS()` dans `index.html`. Événement : `{ id: "evt_…" (local à l'appareil), uid (UID ICS), summary, start, end (ms), location, description, organizer, allDay, rrule }`. Les séries récurrentes sont **développées en occurrences qui partagent l'UID** → la référence stable d'une séance est **`(id, occurrenceStart)`**, pas l'UID seul. Synchronisé : table `planning_events (user_id, local_id, data jsonb)`. |
| Matières / ressources | `subjects`, `chapters`, `documents` (binaire local IndexedDB). Brightspace en lecture (Edge Functions). |
| Dashboard / progression | `smart-revision.js`, `statistics.js` — **ne seront pas touchés** ; ils ne connaissent que des chapitres/questions. |
| Supabase | Projet unique REV-EM ; migrations `000`–`006` (+ `007` ici) ; Edge Functions Brightspace (`requireUser` = identité tirée du JWT vérifié, jamais d'un `user_id` du corps). |
| Routes | Aucune URL ; onglets (`switchTab`) et `handleNavGoto`. |

## 2. Audit — LexNote

| Sujet | Constat |
|---|---|
| Stack | React 19, TypeScript strict, Vite, TipTap, Zustand, `idb`, React Router (BrowserRouter), PWA. |
| Auth / utilisateur | **Aucun.** Profil local seul. |
| Données | `Subject`, `Module`, `CourseSession` (séance = CM : titre, date, durée, statut, `captureSummary`, réservés IA), `NoteDocument` (notes TipTap, store séparé). Capture dans une base à part (`AudioSession`, `AudioChunk`, `TranscriptSegment`, `TimelineMarker`, `NoteAnchor`). |
| « Subjects » / « modules » | Une matière contient des modules ; une séance appartient à un module. Pas de lien avec un planning. |
| Cours intelligent / supports | **Non implémentés** (IA = `NullProvider`). Types déjà prêts : `GeneratedOutput`, `Flashcard`, `StudyQuestion`, et la provenance (`PROFESSOR`/`USER_NOTE`/`DOCUMENT`/`TRANSCRIPTION`/`AI`/`VERIFIED_SOURCE`/`UNKNOWN`) + vérification (`VERIFIED`/`UNVERIFIED`/`POTENTIAL_CONFLICT`/`NEEDS_REVIEW`). Règle codée : une info `AI`/`UNKNOWN` n'est jamais « vérifiée ». |
| `CourseContext` | `buildCourseContext(sessionId)` : entrée prévue du futur moteur IA ; notes / transcription / support restent séparés par provenance. |
| Réseau | Aucun appel sortant, sauf moteurs de transcription **explicitement** configurés (Web Speech, API Whisper). |

## 3. Propriété des données (source de vérité)

**Règle : une donnée a un seul propriétaire. L'autre application en détient au plus une RÉFÉRENCE (identifiant
opaque + titre + statut), jamais une copie du contenu.**

| Donnée | Propriétaire | L'autre application garde |
|---|---|---|
| Planning, événements ICS | **REV-EM** | `RevemCourseEvent` transmis **à la demande** (lancement), jamais stocké comme planning |
| Matières de révision, chapitres, examens, tâches de révision, progression, quiz, flashcards de REV-EM | **REV-EM** | rien |
| Organisation générale de la révision | **REV-EM** | rien |
| Notes brutes, transcription, audio, marqueurs, ancrages | **LexNote** | rien (REV-EM n'en reçoit même pas le comptage détaillé — seulement `capture.hasAudio/hasTranscript/…`) |
| Documents de séance | **LexNote** | rien |
| Cours intelligent, fiches, cartes mentales, schémas, supports générés | **LexNote** | `StudyArtifactReference` (ouvre par lien profond) |
| Lien REV-EM ↔ installation LexNote | **REV-EM** (`lexnote_links`) | LexNote : (cible) sa propre table `revem_links` dans **sa** base, quand elle aura des comptes |
| Identité de l'étudiant | **REV-EM** (Supabase Auth) | LexNote : **aucune** — il ne connaît ni e-mail, ni `user_id` |

Conflit, doublon ou divergence : **le propriétaire gagne**. Les références ne sont jamais « réparées » en copiant du
contenu ; une référence périmée est détectée (`updatedAt`, `contentSha256`) puis rafraîchie auprès du propriétaire.

## 4. Le contrat — dossier `integration-contract/`

Paquet TypeScript indépendant (`zod`), **sans donnée métier et sans secret**. Il est la **seule** chose que les deux
dépôts partagent *conceptuellement*. Distribution : copie vendorée ou dépendance Git dans chaque dépôt (aucun
accès réseau entre les deux au build). Tests : `cd integration-contract && npm install && npm test` (12 tests).

```
integration-contract/src/
  version.ts    INTEGRATION_VERSION = "1", SUPPORTED_VERSIONS, isSupportedVersion()
  common.ts     opaqueId, safeText, isoDateTime… — objets STRICTS (clé inconnue = erreur)
  schemas.ts    RevemCourseEvent · LexNoteSessionReference · StudyArtifactReference
                IntegrationUserLink · CourseSessionIntent
  deeplinks.ts  routes, parseurs, builders, assertOrigin, isAllowedReturn
  token.ts      LaunchTokenClaims, verifyLaunchToken()     ← frontend/LexNote : vérification SEULE
  server.ts     signLaunchToken()                          ← Edge Function uniquement (clé privée)
```

| Schéma | Rôle | Ce qu'il **interdit** |
|---|---|---|
| `RevemCourseEvent` | une séance du planning (référence stable `revemEventId + occurrenceStart`, titre, début/fin, type CM/TD/TP, `subject.nameHint`) | `userId`, `email`, fin < début, caractères de contrôle |
| `LexNoteSessionReference` | une séance LexNote (id, titre, date, statut, présence audio/transcription) | tout contenu : notes, transcription |
| `StudyArtifactReference` | un support généré (type, titre, provenance, vérification, `contentSha256`, `openPath` = `/artifact/:id`) | URL absolue, chemin hors `/artifact/:id` |
| `IntegrationUserLink` | le lien pseudonyme (`linkId`, statut, scopes, dates, `peer`) | e-mail, `userId`, scope inconnu |
| `CourseSessionIntent` | « ouvrir/créer la séance pour cet événement » ; conservée **côté serveur** | action inconnue, expiration ≤ demande |

**Provenance et vérification** reprennent *exactement* les valeurs de LexNote : REV-EM ne les « améliore » pas. Un
support `AI` / `UNVERIFIED` est présenté comme tel (jamais comme un corrigé).

### Versionnage
`integrationVersion: "1"` dans **chaque** objet. Ajouter un champ **optionnel** ne change pas la version ; retirer,
renommer, changer un sens ou durcir une contrainte → `"2"`. Une application accepte les versions de
`SUPPORTED_VERSIONS` et **refuse** les autres (jamais « on essaie quand même »). Pendant une migration, elle en
liste deux. Le jeton, les tables SQL (`integration_version`) et les objets portent tous la version.

## 5. Liens profonds

| Application | Route | Rôle |
|---|---|---|
| LexNote | `/integrations/revem/session` | point d'entrée d'un lancement ; jeton dans le **fragment** `#t=…` |
| LexNote | `/course/:sessionId` | alias → route existante `session/:id` (reprise de la séance) |
| LexNote | `/artifact/:artifactId` | ouvre un support généré |
| REV-EM | `#/course/:eventId` | ouvre la séance du planning |
| REV-EM | `#/revision/:subjectId` | ouvre la révision d'une matière |

Règles (appliquées par `deeplinks.ts`, testées) :

* une URL ne porte **jamais** d'identifiant d'utilisateur, d'e-mail, de nom de matière ni de donnée de cours — au plus
  un identifiant **opaque** d'objet (`[A-Za-z0-9_.:-]{1,128}` : le `@` est exclu, un e-mail est donc rejeté) ;
* le jeton est dans le **fragment** (jamais envoyé au serveur, absent des journaux d'accès et du `Referer`) ;
* un lien est une **intention de navigation**, jamais une autorisation ;
* origines : `https` obligatoire (`http` seulement pour `localhost`), pas d'identifiants dans l'URL, **liste blanche**
  pour tout `returnTo` ;
* REV-EM est statique : ses routes sont dans le fragment (pas de réécriture serveur) ; son futur routeur lira
  `parseRevemHash()`.

## 6. Sécurité

**Principes** : aucun secret partagé dans un frontend ; ne jamais faire confiance à un `userId`, un e-mail ou un
nom de matière venu d'un client ; l'autorisation vient d'un **jeton signé vérifié** + d'un **lien actif**, pas d'une URL.

### Jeton de lancement (REV-EM → LexNote) — `token.ts` / `server.ts`
* **Ed25519 (EdDSA)**, format compact `en-tête.charge.signature`. **Asymétrique volontairement** : LexNote (qui
  n'a pas de serveur) vérifie avec la clé **publique** ; il n'y a **aucun secret partagé**. La clé privée vit dans
  les secrets Supabase (Edge Function), jamais dans un dépôt ni un navigateur.
* **Court** : 120 s par défaut, **300 s maximum** (plafonné à la signature **et** refusé à la vérification), tolérance
  d'horloge 60 s.
* **Aucune donnée métier ni identité** : charge = `v, iss, aud, jti, sub (linkId pseudonyme), intent, scope, iat, exp`.
  Ni `user_id`, ni e-mail, ni événement : l'**intention** reste côté serveur, désignée par `intent`.
* **Usage unique** : `jti` consommé côté serveur (`lexnote_link_intents.consumed_at`, `UPDATE … WHERE consumed_at IS NULL`).
  Une signature valide ne suffit pas : un jeton rejoué est refusé.
* **Rotation** : l'en-tête porte `kid` ; le vérificateur reçoit un *jeu* de clés publiques (`kid → JWK`).

### Procédure de génération de la clé Ed25519 (documentée, **non appliquée**)
À exécuter **une seule fois, le moment venu** (phase 10), pas maintenant :
```bash
node -e '(async()=>{const kp=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);
 console.log("PRIVE", JSON.stringify(await crypto.subtle.exportKey("jwk",kp.privateKey)));
 console.log("PUBLIC", JSON.stringify(await crypto.subtle.exportKey("jwk",kp.publicKey)));})()'
```
1. Choisir un `kid` (ex. `revem-2026-01`).
2. La clé **PRIVÉE** (JSON contenant `d`) va **uniquement** dans un secret Supabase d'Edge Function
   (`supabase secrets set LEXNOTE_SIGNING_KEY='…' LEXNOTE_SIGNING_KID='…'`). Jamais dans le dépôt, un `.env` versionné,
   un navigateur, un journal ou une conversation.
3. La clé **PUBLIQUE** (sans `d`) est **publique par nature** : elle peut être versionnée dans LexNote (jeu `kid → JWK`).
4. **Rotation** : générer une nouvelle paire, publier la nouvelle clé publique dans LexNote **avant** de signer avec la
   nouvelle clé privée, garder l'ancienne publique le temps de la durée de vie maximale d'un jeton (5 min), puis la
   retirer.
5. **Compromission** de la clé privée : retirer immédiatement sa clé publique du jeu de LexNote et en publier une neuve.
Test de cohérence : `cd integration-contract && npm test` (signature + vérification de bout en bout avec une paire
éphémère). **Aucun système de production n'est construit autour d'une identité locale temporaire.**
* Refusés par les tests : `alg: none` / `HS256`, signature absente ou de mauvaise taille, charge falsifiée, mauvaise
  clé, `kid` inconnu (y compris `__proto__`), jeton expiré / du futur / trop long, claims en trop (`.strict()`).

### Flux cible (étape suivante — **non construit**)
```
REV-EM (clic sur une séance)
  1. Edge Function `lexnote-launch`  ── JWT Supabase vérifié (requireUser) → identité
  2. vérifie qu'un lien ACTIF existe pour (user, installation) ; construit l'intention depuis SES données de
     planning (le client ne transmet qu'un identifiant d'événement, jamais le titre ni la matière)
  3. insère l'intention (lexnote_link_intents) ; signe le jeton (clé privée) ; renvoie l'URL
        https://<lexnote>/integrations/revem/session#t=<jeton>
LexNote (/integrations/revem/session)
  4. lit #t=, vérifie signature + expiration avec la clé PUBLIQUE ; efface le fragment de l'URL
  5. appelle l'Edge Function `lexnote-intent` avec le jeton → le serveur consomme `jti` (usage unique) et
     renvoie l'intention (RevemCourseEvent validé par Zod)
  6. rapproche l'événement de SES modules (nameHint = indication, jamais créée aveuglément) ; ouvre/crée la séance
```
Le nom de matière reçu est **une indication** : LexNote le rapproche de ses propres matières ; la confirmation (et la
création éventuelle) restent une décision de l'étudiant dans LexNote.

### Établissement du lien — **[SUPPRIMÉ DE LA CIBLE]** (appairage par installation)
~~LexNote n'a pas de compte : REV-EM crée un lien `pending`, affiche un code d'appairage, LexNote renvoie sa référence
d'installation.~~ **Abandonné comme architecture définitive** (décision du propriétaire) : il ferait dépendre
l'intégration de l'absence de comptes LexNote et lierait deux *appareils* au lieu de deux *personnes*.

**Cible (orientation, à concevoir en phase 10 — rien n'est construit) :** une **liaison explicite entre un utilisateur
REV-EM et un utilisateur LexNote**, consentie **des deux côtés** (l'étudiant est authentifié dans les deux applications
au moment de lier), révocable depuis chacune, et exprimée **uniquement par des identifiants pseudonymes de lien** —
jamais par l'`user_id` ni l'e-mail de l'autre application. Plusieurs appareils d'un même utilisateur partagent la même
liaison (la liaison est portée par le compte, pas par l'appareil). Les principes de ce §6 (jeton court, signé, usage
unique, rien d'identifiant dans l'URL, l'autorisation vient du jeton **et** de la liaison active) restent valables tels
quels.

## 7. Bases de données — jamais mélangées

### REV-EM (Supabase REV-EM) — migration `007_lexnote_links.sql` — **[PROVISOIRE · FACULTATIVE]**
> **Statut :** présente dans le dépôt, **non obligatoire, non à appliquer pour l'instant, et rien n'en dépend**
> (aucun code d'application, aucun test applicatif, aucune Edge Function ne la lit). Sa colonne
> `lexnote_external_reference` désigne aujourd'hui une *installation* ; dans la cible elle désignera un **lien vers un
> utilisateur LexNote**. Elle sera **revue ou remplacée** (nouvelle migration `008…`) quand LexNote aura ses comptes ;
> tant qu'elle n'est appliquée sur aucune base, elle peut être modifiée sans migration de données.
| Table | Contenu | Accès |
|---|---|---|
| `lexnote_links` | `id` (**linkId pseudonyme**), `user_id` (= `revem_user_id`), `lexnote_external_reference` (opaque, jamais un e-mail), `status` (`pending/active/revoked/expired`), `scopes`, `integration_version`, dates | navigateur : **SELECT de ses propres lignes** (RLS `auth.uid() = user_id`). Aucune policy d'écriture : **seules les Edge Functions** (service_role) créent/activent/révoquent — un client ne peut pas se déclarer « lié ». |
| `lexnote_link_intents` | `jti`, `intent_id`, `link_id`, `scope`, `intent` (jsonb, côté serveur), `expires_at` (≤ 5 min, contrainte), `consumed_at` | **aucun accès navigateur** (RLS activée sans policy, droits retirés) |

* Ces tables **ne sont pas** dans `user-data.js` : pas de synchronisation. Leur absence ne casse donc **rien** dans
  l'application (contrairement à un domaine synchronisé : voir l'incident `math_practice`/migration 006).
* `supabase/tests/00_diagnostic.sql` signale la 007 comme « facultative ».
* Test sur PostgreSQL réel : `node tests/lexnote-links.test.mjs` (30 vérifications : RLS, privilèges, contraintes,
  usage unique, cascade, idempotence).

### LexNote — base propre, **à venir** (phase 3)
~~Store IndexedDB local `revem_links`.~~ **Abandonné** : LexNote aura sa **propre base Supabase** (distincte de celle de
REV-EM, jamais partagée) avec ses comptes ; `revem_links` y sera une **vraie table** du brief
(`id`, `lexnote_user_id`, `revem_external_reference`, `status`, `created_at`), sous RLS stricte (`auth.uid() = user_id`).
Rien n'est créé tant que LexNote n'a pas ses comptes.

## 8. Ce qui est fait / pas fait dans cette étape (état à l'issue de l'audit)

| | |
|---|---|
| ✅ Audit des deux dépôts | §1–2 |
| ✅ Propriété des données | §3 |
| ✅ Contrat versionné validé par Zod (`integration-contract/`) | 12 tests, `tsc --noEmit` propre |
| ✅ Liens profonds spécifiés + parseurs/builders sûrs | §5 |
| ✅ Sécurité : jeton Ed25519 court, usage unique, sans secret partagé | §6 (signature/vérification implémentées et testées) |
| ✅ Structures REV-EM : `lexnote_links`, `lexnote_link_intents` (migration 007 — **facultative, provisoire**) | §7, 30 tests PostgreSQL |
| ⏸ **Routes LexNote** (`/integrations/revem/session`, `/course/:id`, `/artifact/:id`) | **suspendues** jusqu'à la phase 10 (le dépôt LexNote est désormais accessible en écriture, mais la priorité est ailleurs) |
| ❌ Store `revem_links` local de LexNote | **abandonné** (voir §7) |
| ⏸ Routes REV-EM `#/course/:eventId`, `#/revision/:subjectId` | contrat prêt (`parseRevemHash`) ; **non branchées** (aucun comportement modifié) |
| ⏸ Edge Functions (`lexnote-link`, `lexnote-launch`, `lexnote-intent`) | **non écrites** : étape suivante |
| ❌ Lancement automatique, synchronisation des supports, assistant commun | **hors périmètre** de cette étape |

## 9. Décisions (réponses du propriétaire)

| # | Question | Décision |
|---|---|---|
| 1 | Lien par installation | **NON comme architecture définitive.** On attend les comptes LexNote ; cible = utilisateur ↔ liaison explicite ↔ utilisateur. |
| 2 | Écriture sur le dépôt LexNote | **OUI.** Les prochaines modifications se font réellement dans LexNote (accès attaché à la session). |
| 3 | Ed25519 | **OUI sur le principe.** Architecture conservée, procédure documentée (§6), **aucun système de production** construit maintenant. |
| 4 | Domaines de production | **Fournis/configurés plus tard**, quand LexNote aura son URL définitive (liste blanche `returnTo` / CORS). |
| 5 | Migration 007 | **Facultative**, conservée, rien n'en dépend avant la nouvelle architecture utilisateurs. |

## 10. Règle de non-dérive

Toute évolution de l'intégration passe par le contrat (`integration-contract`) **d'abord** : nouveau champ → schéma +
test + doc ; nouvelle route → `deeplinks.ts` + test ; nouveau cas d'échange → nouvelle intention + `scope`. Pas de
champ « en plus » dans une URL, un jeton ou un objet (`strict()` le refuse), pas de lecture de la base de l'autre
application, pas de copie de contenu. C'est ce qui évite que l'intégration devienne un ensemble de hacks.

## 11. Feuille de route — LexNote d'abord, intégration ensuite

L'intégration ne reprend **qu'après** la phase 9. Chaque phase se fait **dans le dépôt LexNote**, avec ses tests.

| Phase | Contenu | Dépendances / remarques |
|---|---|---|
| 1 | **Authentification LexNote réelle** | Supabase Auth propre à LexNote ; mode « invité local » conservé (local-first) |
| 2 | **Profils utilisateurs** | table `profiles` ; remplace le profil `localStorage` |
| 3 | **Supabase propre à LexNote** | projet et migrations dédiés — **jamais** la base de REV-EM |
| 4 | **Chaque donnée appartient à un `userId`** | matières, modules, CM/TD/TP, notes, transcriptions, ressources |
| 5 | **RLS stricte** | `auth.uid() = user_id` partout ; tests sur une vraie base (comme REV-EM) |
| 6 | **IndexedDB local-first + synchronisation Supabase** | l'autosave local reste prioritaire ; `SyncEngine` (aujourd'hui *no-op*) devient réel ; barrière d'hydratation |
| 7 | **Multi-appareils** | cache **scopé par compte**, aucune fuite d'un compte à l'autre, conflits explicites |
| 8 | **Cours intelligent** | `CourseContext` → IA ; provenance/vérification jamais « embellies » |
| 9 | **Fiches, cartes mentales, schémas, StudyArtifacts** | les supports que le contrat référence |
| 10 | **Reprise de l'intégration REV-EM ↔ LexNote** | liaison utilisateur ↔ utilisateur, Edge Functions, routes, jeton Ed25519 en production |

### Ce que le contrat devra faire évoluer (anticipé, non fait)
* `IntegrationUserLink.peer` : aujourd'hui `{ app, externalReference }` où `externalReference` peut désigner une
  installation. Dans la cible il désignera un **pseudonyme de liaison utilisateur** (jamais l'`user_id` de l'autre
  application). Le schéma sera resserré (ex. `peer.kind = "user_link"`) et le champ « installation » retiré.
* `LexNoteSessionReference` / `StudyArtifactReference` : s'enrichiront (identifiants de comptes **non** inclus ; l'accès
  restera décidé par le serveur, pas par l'URL).
* **Versionnement :** `integrationVersion "1"` n'est émise par **aucune** application en production. Tant que c'est le
  cas, il peut être **corrigé sans changement de version** ; dès la première utilisation réelle, toute rupture exige `"2"`.
