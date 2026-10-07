import { z } from "zod";
import { INTEGRATION_VERSION } from "./version.ts";
import { LINK_SCOPES } from "./schemas.ts";
import { strict, uuid } from "./common.ts";

/* ═══════════════════════════════════════════════════════════════════════════
   Jeton de lancement REV-EM → LexNote
   ───────────────────────────────────────────────────────────────────────────
   • Format compact « en-tête.charge.signature » (base64url), algorithme EdDSA (Ed25519).
   • SIGNÉ côté serveur REV-EM (Edge Function, clé privée dans les secrets Supabase) ; VÉRIFIÉ avec la
     clé PUBLIQUE (JWK) : LexNote n'a donc AUCUN secret à stocker, et le frontend de REV-EM non plus.
   • Court : 120 s par défaut, 300 s au maximum. Il ne contient AUCUNE donnée métier ni identité :
     `sub` est le linkId PSEUDONYME du lien, `intent` désigne une intention conservée côté serveur.
   • À USAGE UNIQUE : `jti` est consommé côté serveur REV-EM (table lexnote_link_intents). Un
     jeton valide mais déjà consommé est refusé — la vérification de signature seule ne suffit pas.
   • La vérification est ici ; la SIGNATURE est dans server.ts (jamais importée par un frontend).
   ═══════════════════════════════════════════════════════════════════════════ */

export const TOKEN_TYP = "revem-launch+1" as const;
export const DEFAULT_TTL_SEC = 120;
export const MAX_TTL_SEC = 300;
export const CLOCK_SKEW_SEC = 60;

export const LaunchTokenHeader = strict({ alg: z.literal("EdDSA"), typ: z.literal(TOKEN_TYP), kid: z.string().regex(/^[A-Za-z0-9_.\-]{1,64}$/) });

export const LaunchTokenClaims = strict({
  v: z.literal(INTEGRATION_VERSION),
  iss: z.literal("revem"),
  aud: z.literal("lexnote"),
  jti: uuid,
  /** linkId pseudonyme (IntegrationUserLink.linkId) — JAMAIS l'identifiant d'authentification. */
  sub: uuid,
  intent: uuid,
  scope: z.enum(LINK_SCOPES),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});
export type LaunchTokenClaims = z.infer<typeof LaunchTokenClaims>;
export type LaunchTokenHeader = z.infer<typeof LaunchTokenHeader>;


export type VerifyFailure =
  | "malformed" | "bad_header" | "bad_signature" | "bad_claims"
  | "expired" | "not_yet_valid" | "lifetime_too_long" | "unknown_key";
export type VerifyResult = { ok: true; claims: LaunchTokenClaims; header: LaunchTokenHeader } | { ok: false; reason: VerifyFailure };

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ""; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_\-]*$/.test(str)) return null;
  try {
    const b = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch { return null; }
}

/** Clés publiques connues, par `kid` (rotation : plusieurs clés valides en même temps). */
export type PublicKeySet = Record<string, JsonWebKey>;

export async function verifyLaunchToken(token: string, keys: PublicKeySet, nowSec: number = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;
  const hb = b64urlDecode(h), pb = b64urlDecode(p), sb = b64urlDecode(s);
  if (!hb || !pb || !sb || !hb.length || !pb.length || sb.length !== 64) return { ok: false, reason: "malformed" };   // une signature Ed25519 fait exactement 64 octets
  let header: LaunchTokenHeader, rawClaims: unknown;
  try {
    const dec = new TextDecoder("utf-8", { fatal: true });
    const hp = LaunchTokenHeader.safeParse(JSON.parse(dec.decode(hb)));   // alg « none » ou autre : refusé ici
    if (!hp.success) return { ok: false, reason: "bad_header" };
    header = hp.data;
    rawClaims = JSON.parse(dec.decode(pb));
  } catch { return { ok: false, reason: "malformed" }; }

  const jwk = Object.prototype.hasOwnProperty.call(keys, header.kid) ? keys[header.kid] : undefined;
  if (!jwk) return { ok: false, reason: "unknown_key" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, sb as BufferSource, new TextEncoder().encode(h + "." + p));
  } catch { return { ok: false, reason: "bad_signature" }; }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const cp = LaunchTokenClaims.safeParse(rawClaims);
  if (!cp.success) return { ok: false, reason: "bad_claims" };
  const c = cp.data;
  if (c.exp - c.iat > MAX_TTL_SEC) return { ok: false, reason: "lifetime_too_long" };
  if (c.iat > nowSec + CLOCK_SKEW_SEC) return { ok: false, reason: "not_yet_valid" };
  if (c.exp + CLOCK_SKEW_SEC < nowSec) return { ok: false, reason: "expired" };
  return { ok: true, claims: c, header };
}
