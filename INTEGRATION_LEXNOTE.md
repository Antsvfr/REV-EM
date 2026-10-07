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
     INTEGRATION_PEER_APP_URL=<URL officielle de LexNote, ex. https://lexnote.vercel.app/> \
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
