/* ⚠️ CODE SERVEUR UNIQUEMENT (Edge Function). Ne JAMAIS importer ce fichier depuis un frontend :
   il manipule la clé PRIVÉE de signature. Le frontend n'importe que « . » (index.ts). */
import { DEFAULT_TTL_SEC, LaunchTokenClaims, MAX_TTL_SEC, TOKEN_TYP, b64urlEncode } from "./token.ts";
import type { LaunchTokenClaims as Claims } from "./token.ts";

export type SignInput = Omit<Claims, "iat" | "exp" | "v" | "iss" | "aud"> & { ttlSec?: number };

export async function signLaunchToken(input: SignInput, privateJwk: JsonWebKey, kid: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const ttl = Math.min(Math.max(1, input.ttlSec ?? DEFAULT_TTL_SEC), MAX_TTL_SEC);
  const claims = LaunchTokenClaims.parse({ v: "1", iss: "revem", aud: "lexnote", jti: input.jti, sub: input.sub, intent: input.intent, scope: input.scope, iat: nowSec, exp: nowSec + ttl });
  const enc = new TextEncoder();
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: "EdDSA", typ: TOKEN_TYP, kid })));
  const p = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(h + "." + p)));
  return h + "." + p + "." + b64urlEncode(sig);
}
