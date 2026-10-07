// Edge Function « integration-gateway » — passerelle SERVEUR → SERVEUR (appelée uniquement par l'autre projet).
// Authentification : signature HMAC (horodatage + nonce + empreinte du corps + expéditeur + clé), PAS un JWT Supabase.
// Déploiement : supabase functions deploy integration-gateway --no-verify-jwt     (seule fonction concernée)
// @ts-nocheck
import { handleGatewayRequest, integrationError } from '../_shared/integration/lexnote-revem-v1.mjs';
import { runtime } from '../_shared/integration/runtime.ts';

Deno.serve(async (req: Request) => {
  try { return await handleGatewayRequest(req, runtime().gw); }
  catch (e) {
    console.error('[integration-gateway] configuration', e?.message);
    return new Response(JSON.stringify(integrationError('INTERNAL', 'Intégration non configurée.')), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
