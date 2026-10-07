// Edge Function « integration-link » — actions de l'ÉTUDIANT (démarrer / inspecter / autoriser / vérifier / révoquer une liaison).
// Appelée par le navigateur AVEC le jeton Supabase de l'utilisateur (JWT vérifié). Aucun secret inter-applications n'est jamais renvoyé.
// Déploiement : supabase functions deploy integration-link
// @ts-nocheck
import { handleUserRequest, integrationError } from '../_shared/integration/lexnote-revem-v1.mjs';
import { runtime } from '../_shared/integration/runtime.ts';

Deno.serve(async (req: Request) => {
  try { return await handleUserRequest(req, runtime().user); }
  catch (e) {
    console.error('[integration-link] configuration', e?.message);
    return new Response(JSON.stringify({ ok: false, error: integrationError('INTERNAL', 'Intégration non configurée sur ce serveur.') }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
