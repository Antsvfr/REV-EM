// Câblage des Edge Functions d'intégration (Deno). TOUTE la logique est dans le paquet généré `lexnote-revem-v1.mjs`.
// Ici : lecture des secrets du projet, client service role (serveur uniquement), authentification de l'utilisateur par SON jeton.
// @ts-nocheck — le paquet généré n'a pas de déclarations de types.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createLaunchService, createLinkService, createPeerClient, createRpcLaunchStore, createRpcStore, fail, readIntegrationConfig } from './lexnote-revem-v1.mjs';
import { courseEventFromPlanning } from './revem-courses.mjs';

export const SELF = 'revem';

let cached;
export function runtime() {
  if (cached) return cached;
  const env = (k) => Deno.env.get(k);
  const cfg = readIntegrationConfig(SELF, env);
  // La clé service role est fournie automatiquement par Supabase aux Edge Functions : elle ne quitte jamais ce processus.
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createRpcStore(admin);
  const peer = createPeerClient(cfg);
  const service = createLinkService({ cfg, store, peer });
  // Lancement d'un cours : le cours est relu ICI, dans les tables de l'étudiant (jamais fourni par le navigateur, qui n'envoie que l'identifiant).
  const source = {
    async resolveEvent(userId, { eventId, tz }) {
      const [ev, subj] = await Promise.all([
        admin.from('planning_events').select('local_id,data').eq('user_id', userId).eq('local_id', eventId).maybeSingle(),
        admin.from('subjects').select('local_id,name').eq('user_id', userId),
      ]);
      if (ev.error) throw new Error('planning_events: ' + ev.error.message);
      if (!ev.data) return null;
      return courseEventFromPlanning(ev.data, { subjects: subj.data ?? [], tz, now: Date.now() });
    },
  };
  const launchStore = createRpcLaunchStore(admin);
  const launch = createLaunchService({ cfg, links: service, linkStore: store, launchStore, peer, source });
  // L'identité vient du jeton de l'appelant, vérifié par Supabase Auth — jamais d'un champ du corps de la requête.
  const authenticate = async (req) => {
    const auth = req.headers.get('Authorization') ?? '';
    if (!/^Bearer\s+\S+/.test(auth)) return fail('UNAUTHENTICATED', 'Jeton absent.');
    const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data, error } = await asUser.auth.getUser();
    if (error || !data?.user) return fail('UNAUTHENTICATED', 'Jeton invalide.');
    return data.user.id;
  };
  cached = { cfg, store, service, launch, gw: { cfg, store, service, launch }, user: { cfg, service, launch, authenticate } };
  return cached;
}
