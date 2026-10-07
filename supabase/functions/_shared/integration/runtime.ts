// Câblage des Edge Functions d'intégration (Deno). TOUTE la logique est dans le paquet généré `lexnote-revem-v1.mjs`.
// Ici : lecture des secrets du projet, client service role (serveur uniquement), authentification de l'utilisateur par SON jeton.
// @ts-nocheck — le paquet généré n'a pas de déclarations de types.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createLinkService, createPeerClient, createRpcStore, fail, readIntegrationConfig } from './lexnote-revem-v1.mjs';

export const SELF = 'revem';

let cached;
export function runtime() {
  if (cached) return cached;
  const env = (k) => Deno.env.get(k);
  const cfg = readIntegrationConfig(SELF, env);
  // La clé service role est fournie automatiquement par Supabase aux Edge Functions : elle ne quitte jamais ce processus.
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createRpcStore(admin);
  const service = createLinkService({ cfg, store, peer: createPeerClient(cfg) });
  // L'identité vient du jeton de l'appelant, vérifié par Supabase Auth — jamais d'un champ du corps de la requête.
  const authenticate = async (req) => {
    const auth = req.headers.get('Authorization') ?? '';
    if (!/^Bearer\s+\S+/.test(auth)) return fail('UNAUTHENTICATED', 'Jeton absent.');
    const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data, error } = await asUser.auth.getUser();
    if (error || !data?.user) return fail('UNAUTHENTICATED', 'Jeton invalide.');
    return data.user.id;
  };
  cached = { cfg, store, service, gw: { cfg, store, service }, user: { cfg, service, authenticate } };
  return cached;
}
