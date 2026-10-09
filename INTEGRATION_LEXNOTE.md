# Intégration LexNote — liaison de comptes (REV-EM)

REV-EM et LexNote restent **deux applications indépendantes** : deux projets Supabase, deux bases, deux comptes (UUID différents),
aucune session partagée. Cette étape ajoute uniquement une **liaison explicite** entre un compte REV-EM et un compte LexNote.
Contrat : `lexnote-revem/v1` (spécifié dans le dépôt LexNote, `docs/REVEM_LEXNOTE_INTEGRATION.md`). Rien d'autre n'est échangé
pour l'instant (pas de planning, pas de supports, pas de progression commune).

## Ce que voit l'étudiant

**Réglages › Applications connectées › LexNote** : *Connecter* → REV-EM crée une intention de liaison (5 min, usage unique) et ouvre
LexNote → connexion LexNote si besoin → « REV-EM souhaite être connecté à votre compte LexNote » *[Autoriser] [Annuler]* → retour dans
REV-EM (`?lexnote_link=connected`, retiré de l'URL, **revérifié côté serveur**) : *LexNote ✓ Connecté*. *Déconnecter* révoque
immédiatement des deux côtés, sans supprimer aucune donnée.

## Architecture réellement implémentée

```
navigateur REV-EM ──(JWT REV-EM)──▶ Edge Function integration-link ──▶ base REV-EM (RPC integration_*, service_role)
                                          │  signature HMAC (serveur → serveur)
                                          ▼
                              Edge Function integration-gateway (LexNote) ──▶ base LexNote
```
- `integration-link` : actions de l'étudiant (`start`, `cancel`, `inspect`, `confirm`, `status`, `revoke`), JWT Supabase vérifié (`auth.getUser`),
  CORS à liste blanche stricte (jamais `*`).
- `integration-gateway` : appelée **uniquement** par LexNote, `--no-verify-jwt`, authentifiée par signature `LNRV1-HMAC-SHA256`
  (horodatage ±5 min, nonce à usage unique, empreinte SHA-256 du corps, expéditeur, clé dérivée par direction, rotation par `kid`).
  Toute requête portant un en-tête `Origin` (navigateur) est refusée.
- Le **secret inter-applications n'existe que dans les secrets des Edge Functions** : jamais dans `index.html`, `supabase-config.js`, une
  réponse HTTP, une URL ou un journal.
- Le code partagé est un paquet **généré** depuis LexNote : `supabase/functions/_shared/integration/lexnote-revem-v1.mjs`
  (autonome, zod inclus, empreinte en en-tête) + `runtime.ts` (câblage Deno). Ne pas le modifier ici : régénérer depuis LexNote
  (`node scripts/build-integration-bundle.mjs --check`).
- Interface : `connected-apps.js` (logique pure, `RevemLinks`) + section dans `index.html` (`renderConnectedApps`, `lnConnect`, `lnDisconnect`,
  `lnHandleReturn`). « Connecté » n'est affiché que si **les deux côtés** le confirment (`verified` + `peerStatus`).

## Tables (migration `006_integration_links.sql`)

| Table | Rôle | Accès navigateur |
|---|---|---|
| `integration_links` | liaison : `provider` ('lexnote'), `link_id` (integrationLinkId public), `local_reference` / `external_reference` (pseudonymes opaques), `status` PENDING/CONNECTED/REVOKED/ERROR, dates | lecture de **ses** lignes, colonnes non sensibles uniquement |
| `integration_link_intents` | intention à usage unique (empreinte du nonce, `status` PENDING/CONFIRMED/EXPIRED/CANCELLED/USED, ≤ 15 min) | aucun |
| `integration_nonces` | anti-rejeu des messages serveur → serveur | aucun |

RLS activée **et forcée** ; aucune policy d'écriture ; fonctions `integration_*` en `SECURITY DEFINER` + `search_path` figé, réservées à `service_role`.
Jamais stockés : e-mail distant, mot de passe, access/refresh token, `service_role`.

## Mise en service (étapes manuelles)

1. Appliquer `supabase/migrations/006_integration_links.sql`.
2. Générer **une** clé partagée (≥ 32 caractères) et la poser **à l'identique** dans REV-EM et LexNote :
   `openssl rand -base64 48`
3. Secrets de ce projet :
   ```bash
   supabase secrets set INTEGRATION_ENV=production \
     INTEGRATION_KEY_ID=k1 INTEGRATION_KEY=<clé> \
     INTEGRATION_SELF_APP_URL=https://antsvfr.github.io/REV-EM/ \
     INTEGRATION_PEER_APP_URL=https://lex-note-svfr.vercel.app/ \
     INTEGRATION_PEER_GATEWAY_URL=https://<réf-projet-LexNote>.supabase.co/functions/v1/integration-gateway
   # facultatif : INTEGRATION_ALLOWED_ORIGINS (origines navigateur supplémentaires, https uniquement)
   ```
   En développement : `INTEGRATION_ENV=development` autorise `http://localhost`.
4. Déployer : `supabase functions deploy integration-link` et `supabase functions deploy integration-gateway --no-verify-jwt`
   (seule la passerelle est sans JWT ; elle est protégée par la signature).
5. **Rotation de clé** : poser la nouvelle (`INTEGRATION_KEY_ID=k2 INTEGRATION_KEY=…`) et garder l'ancienne en vérification
   (`INTEGRATION_KEY_PREVIOUS_ID=k1 INTEGRATION_KEY_PREVIOUS=…`) des deux côtés, puis retirer l'ancienne.

## Tests

- `node tests/connected-apps.test.js` — logique pure (états, URL sûre, retour).
- `NODE_PATH=/opt/node22/lib/node_modules node tests/connected-apps-ui.test.js` (avec `python3 -m http.server 9109`) — interface dans un vrai navigateur.
- `node tests/integration-link.test.mjs` — paquet d'intégration : intégrité, liaison A↔A, B ne peut rien sur A, signature, rejeu, altération, expiration, origine, CORS.
- `supabase/tests/integration_links_tests.sql` — RLS et fonctions sur PostgreSQL (voir en-tête du fichier).

## Limites connues

- Les deux projets ne communiquent pas entre eux dans l'environnement de test : le dialogue serveur ↔ serveur est testé par deux services branchés l'un à l'autre
  (et deux bases PostgreSQL réelles côté LexNote), **pas contre deux vrais projets Supabase déployés** (NOT TESTED en production).
- La suppression d'un compte supprime sa liaison locale (cascade) ; l'autre côté le constate au prochain contrôle (`PEER_MISSING`).
- La liaison est **initiée depuis REV-EM** ; l'initiation depuis LexNote n'est pas construite (les tables et fonctions la permettent).

## Production

Procédure complète (migrations, secrets, déploiement, audit `verify-db.sql`, test réel A/B et attaques, Advisors) : dépôt LexNote, `docs/PRODUCTION_RUNBOOK.md`. Domaines officiels : `https://antsvfr.github.io/REV-EM/` et `https://lex-note-svfr.vercel.app`.

## Lancement d'un cours : « Prendre mes notes dans LexNote » (extension de `lexnote-revem/v1`, rétro-compatible)

**But.** Depuis la fiche d'un cours du planning REV-EM, un clic ouvre la bonne séance LexNote (matière + séance créées ou retrouvées automatiquement) sur `/session/{id}?panel=transcript`. Le micro n'est **jamais** démarré : `ConsentDialog` / `captureManager.start()` restent le seul chemin.

### Flux

```
REV-EM (navigateur)  ──JWT──▶ integration-link  action « launch-start » { eventId, tz }          (aucun cours, aucune note)
   integration-link (serveur REV-EM) : relit le cours dans planning_events + subjects DU JETON, vérifie la liaison (CONNECTED, sondée),
                                       crée une intention (integration_launch_intents : nonce haché, ≤ 5 min, usage unique)
   ◀── { launchIntentId, expiresAt, launchUrl }   launchUrl = <LexNote>/integrations/revem/launch?intent=<uuid>#n=<nonce>
LexNote (navigateur) : si non connecté → intention conservée (sessionStorage, 10 min) → /login → reprise automatique ; jamais l'accueil
   ──JWT──▶ integration-link (LexNote) action « launch-open » { launchIntentId, nonce }
   serveur LexNote ──HMAC LNRV1──▶ integration-gateway REV-EM : course-launch-request{ operation:'REDEEM_LAUNCH', launchIntentId, nonce, linkId }
   ◀── course-launch-response{ ok, event: external-course-event }      (l'intention est consommée ATOMIQUEMENT, une seule fois)
   serveur LexNote : integration_course_open(...) → matière + séance (SQL, verrou consultatif, UNIQUE) → { sessionId, subjectId }
LexNote (navigateur) : attend que la séance soit présente localement (reload + syncNow, ≤ 15 s) → /session/{id}?panel=transcript
```

Aucun secret inter-applications dans le navigateur ; aucun identifiant d'utilisateur, e-mail, JWT ou contenu de cours dans une URL. Le nonce est dans le **fragment** (jamais envoyé à un serveur, retiré de l'URL dès la lecture) ; seul son hachage est stocké.

### Structure exacte transmise (REV-EM → LexNote, dans la réponse signée de la passerelle)

```json
{
  "integrationVersion": "lexnote-revem/v1", "kind": "external-course-event", "origin": "revem",
  "externalId": "evt_k3x9a2",                         // id STABLE de l'évènement REV-EM (planning_events.local_id)
  "title": "CM Droit des contrats",
  "startsAt": "2026-10-12T08:00:00+02:00", "endsAt": "2026-10-12T10:00:00+02:00", "allDay": false,
  "location": "Amphi B", "teacher": "Mme Durand",     // omis si absents
  "sessionTypeHint": "CM",                            // CM | TD | TP | SEMINAR | WORKSHOP | REVISION | OTHER (inconnu → OTHER)
  "subject": { "app": "revem", "ref": "subj_dc1", "name": "Droit des contrats" },
  "calendarSource": "ics", "cancelled": false, "updatedAt": "2026-10-09T09:00:00.000Z"
}
```

Jamais transmis : notes, résumé, questions, description du cours, mot de passe, JWT, `service_role`, `INTEGRATION_KEY`.

### Liaison évènement → séance, matière → matière, idempotence

* Table `integration_course_refs` (LexNote, migration `20261012000000_revem_course_refs.sql`) : `UNIQUE (user_id, provider, external_event_ref)` → **une** séance par évènement REV-EM et par utilisateur. Table `integration_subject_refs` : `UNIQUE (user_id, provider, external_subject_ref)` → **une** matière par matière REV-EM.
* Clé de matière : l'identifiant REV-EM de la matière si elle existe en base ; sinon `name:<nom normalisé>` (titre sans préfixe CM/TD/TP ni « groupe N »), de sorte que « CM/TD/TP Droit des contrats » partagent **une** matière. Une matière LexNote créée à la main sous le même nom est adoptée si elle n'est pas déjà liée à une autre matière REV-EM.
* La fonction SQL `integration_course_open` (SECURITY DEFINER, `service_role` seul) prend `pg_advisory_xact_lock` (matière puis évènement : ordre fixe, pas d'interblocage) : double clic, deux onglets, deux appareils, rejeu réseau → **une** matière, **une** séance, garanti par la base et non par le front. Une séance supprimée par l'étudiant est recréée à la réouverture ; une séance existante n'est jamais modifiée.
* Numérotation de la séance : `max(number)+1` par (matière, type).

### Qui possède quoi — mise à jour du planning

Création initiale à partir de REV-EM ; **ensuite LexNote possède la séance** (titre, date, horaires, notes, transcription). Une réouverture, ou une modification du planning REV-EM, **n'écrase jamais** une séance existante : seuls des métadonnées sûres pourraient un jour être rafraîchies (non implémenté, volontairement). Les notes restent dans LexNote ; REV-EM n'en reçoit jamais le contenu.

### Multi-appareils et synchronisation

La séance est créée **côté serveur LexNote** (pas dans l'IndexedDB du navigateur) puis tirée par le `SyncEngine` habituel (`pull` par `server_updated_at`) : elle est identique à une séance créée à la main (RLS, `version`, file « dirty » respectés). Sur un autre appareil, la même référence mène à la même séance.

### États du bouton (REV-EM)

| État de la liaison | Bouton |
|---|---|
| connectée et vérifiée des deux côtés | « Prendre mes notes dans LexNote » (actif) |
| non connectée / en attente / révoquée / non vérifiée / invité | « Connecter LexNote » → Réglages › Applications connectées (rien n'est créé) |
| LexNote injoignable ou non configurée | « LexNote temporairement indisponible » (désactivé) + « Vérifier à nouveau » |
| ouverture en cours | « Ouverture de LexNote… » + spinner, désactivé (aucun double clic) |

### Comportements d'erreur (LexNote)

Non connecté à LexNote → intention gardée (10 min) puis reprise après connexion · connecté mais comptes non liés → rien n'est créé, parcours « Connecter REV-EM » · intention expirée / déjà utilisée / falsifiée / d'un autre utilisateur → message dédié, rien n'est créé · réseau coupé → message + bouton réessayer. L'égalité d'e-mail n'est **jamais** une identité.

### Déploiement ultérieur (rien n'est déployé par cette étape)

1. REV-EM : appliquer `supabase/migrations/008_integration_launch.sql` ; LexNote : appliquer `20261012000000_revem_course_refs.sql` (après toutes les migrations antérieures).
2. Redéployer `integration-link` et `integration-gateway` (`--no-verify-jwt`) des **deux** projets (le paquet `lexnote-revem-v1.mjs` est régénéré : `node scripts/build-integration-bundle.mjs --revem <chemin REV-EM>`) ; secrets inchangés.
3. Publier les deux fronts, puis vérifier avec un compte réel de bout en bout (les tests automatisés sont en simulation : PGlite, double de Supabase, Chromium).
