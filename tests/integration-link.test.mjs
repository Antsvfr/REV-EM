/* ============================================================================
   REV-EM — paquet d'intégration `lexnote-revem/v1` (supabase/functions/_shared/integration/lexnote-revem-v1.mjs)
   ----------------------------------------------------------------------------
   Exécution :  node tests/integration-link.test.mjs     (aucun navigateur, aucun réseau, aucune dépendance)

   Ce paquet est GÉNÉRÉ depuis le dépôt LexNote (src/integration) et copié à l'identique ici : on vérifie qu'il est intact, autonome,
   et qu'il fait respecter — côté REV-EM — signature, anti-rejeu, usage unique des intentions, révocation immédiate.
   Le magasin est un double en mémoire ; la vraie persistance (SQL atomique + RLS) est testée par
   supabase/tests/integration_links_tests.sql et, côté LexNote, sur PostgreSQL réel.
   ============================================================================ */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, "..", "supabase", "functions", "_shared", "integration", "lexnote-revem-v1.mjs");
const I = await import("file://" + BUNDLE);

let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { pass++; console.log("PASS — " + l); } else { fail++; console.log("FAIL — " + l + "  " + (d !== undefined ? JSON.stringify(d) : "")); } };
const eq = (l, g, w) => check(l, JSON.stringify(g) === JSON.stringify(w), { attendu: w, obtenu: g });
const scenario = (n) => console.log("\n── " + n + " ──");
const rejects = async (l, p, code) => { try { await p; check(l, false, "aucune exception"); } catch (e) { check(l, (e.error && e.error.code) === code, e.error ? e.error.code : String(e)); } };

scenario("Intégrité du paquet");
{
  const src = fs.readFileSync(BUNDLE, "utf8");
  const [l1, l2, ...rest] = src.split("\n");
  const code = rest.join("\n");
  check("l'empreinte annoncée correspond au code", l2.includes(crypto.createHash("sha256").update(code).digest("hex")));
  check("autonome : aucun import", !/^\s*import\s/m.test(code));
  check("aucune clé ni secret littéral", !/sk-ant-[A-Za-z0-9_-]{16,}|sb_secret_[A-Za-z0-9_-]{16,}|eyJhbGciOi[A-Za-z0-9_-]{20,}\./.test(code));
  eq("version du contrat", I.INTEGRATION_VERSION, "lexnote-revem/v1");
  check("en-tête de génération", l1.includes("GÉNÉRÉ"));
}

scenario("Fichiers des Edge Functions REV-EM");
{
  const rd = (f) => fs.readFileSync(path.join(here, "..", "supabase", "functions", f), "utf8");
  const rt = rd("_shared/integration/runtime.ts");
  check("REV-EM s'identifie 'revem'", /SELF = 'revem'/.test(rt));
  check("la clé service role n'est lue que côté serveur (Deno.env)", /Deno\.env\.get/.test(rt) && /env\('SUPABASE_SERVICE_ROLE_KEY'\)/.test(rt));
  check("jeton utilisateur vérifié par Supabase Auth (getUser), jamais lu dans le corps", /auth\.getUser\(\)/.test(rt) && !/body\.userId|body\.user_id/.test(rt));
  for (const f of ["integration-link/index.ts", "integration-gateway/index.ts", "_shared/integration/runtime.ts"]) {
    const s = rd(f).replace(/\/\/.*$/gm, "");
    check(f + " : aucun CORS joker", !/Allow-Origin['"]?\s*[:,]\s*['"]\*/.test(s) && !/['"]\*['"]/.test(s));
    check(f + " : aucune journalisation de secret", !/console\.(log|error)\([^)]*(KEY|secret|token|nonce)/i.test(s));
  }
  check("passerelle : documentée --no-verify-jwt, seule fonction concernée", /--no-verify-jwt/.test(rd("integration-gateway/index.ts")) && !/--no-verify-jwt/.test(rd("integration-link/index.ts").replace(/\/\/ Déploiement.*\n/, "")));
}

/* ---- deux côtés, magasins en mémoire (même contrat que les fonctions SQL) ---- */
const KEY = "x".repeat(20) + "REV-EM-test-shared-key-0123456789";
const env = (self) => (k) => ({
  INTEGRATION_KEY_ID: "k1", INTEGRATION_KEY: KEY,
  INTEGRATION_SELF_APP_URL: self === "revem" ? "https://antsvfr.github.io/REV-EM/" : "https://lexnote.example.app/",
  INTEGRATION_PEER_APP_URL: self === "revem" ? "https://lexnote.example.app/" : "https://antsvfr.github.io/REV-EM/",
  INTEGRATION_PEER_GATEWAY_URL: self === "revem" ? "https://l.example/functions/v1/integration-gateway" : "https://r.example/functions/v1/integration-gateway",
})[k];

function memStore(selfProvider) {
  const intents = new Map(), links = new Map(), nonces = new Set();
  const live = (l) => l.status === "PENDING" || l.status === "CONNECTED";
  return {
    intents, links,
    async startIntent(user, hash) { if ([...links.values()].some((l) => l.userId === user && l.status === "CONNECTED")) return { reason: "ALREADY_LINKED" }; const id = crypto.randomUUID(); const exp = new Date(Date.now() + 300000); intents.set(id, { id, user, hash, status: "PENDING", exp }); return { reason: "OK", intentId: id, expiresAt: exp.toISOString() }; },
    async cancelIntents() {},
    async inspectIntent(id, hash) { const i = intents.get(id); if (!i) return { reason: "NOT_FOUND" }; if (i.hash !== hash) return { reason: "NONCE_MISMATCH" }; if (i.status !== "PENDING") return { reason: i.status }; if (i.exp < new Date()) { i.status = "EXPIRED"; return { reason: "EXPIRED" }; } return { reason: "OK", displayHint: "Alice", expiresAt: i.exp.toISOString() }; },
    async redeemIntent(a) { const r = await this.inspectIntent(a.intentId, a.nonceHash); if (r.reason !== "OK") return { reason: r.reason }; const i = intents.get(a.intentId); i.status = "CONFIRMED"; links.set(a.linkId, { linkId: a.linkId, userId: i.user, provider: a.provider, status: "PENDING", localReference: a.localRef, externalReference: a.partnerRef, linkedAt: null, revokedAt: null, revokedBy: null, errorCode: null }); return { reason: "OK" }; },
    async createPendingLink(a) { if ([...links.values()].some((l) => l.userId === a.userId && l.status === "CONNECTED")) return { reason: "ALREADY_LINKED" }; links.set(a.linkId, { linkId: a.linkId, userId: a.userId, provider: a.provider, status: "PENDING", localReference: a.localRef, externalReference: a.partnerRef, linkedAt: null, revokedAt: null, revokedBy: null, errorCode: null }); return { reason: "OK" }; },
    async activateLink(id, ref) { const l = links.get(id); if (!l || l.externalReference !== ref) return { reason: "NOT_FOUND" }; if (l.status === "REVOKED") return { reason: "REVOKED" }; l.status = "CONNECTED"; l.linkedAt = new Date().toISOString(); return { reason: "OK" }; },
    async revokeLink(id, ref, by) { const l = links.get(id); if (!l || (ref !== null && l.externalReference !== ref)) return { reason: "NOT_FOUND" }; if (l.status !== "REVOKED") { l.status = "REVOKED"; l.revokedAt = new Date().toISOString(); l.revokedBy = by; } return { reason: "OK", externalReference: l.externalReference }; },
    async markError(id, code) { const l = links.get(id); if (l && live(l)) { l.status = "ERROR"; l.errorCode = code; } },
    async getLink(id, ref) { const l = links.get(id); return l && (ref === null || l.externalReference === ref) ? { ...l } : null; },
    async getUserLink(user) { const m = [...links.values()].filter((l) => l.userId === user); return m.length ? { ...m[m.length - 1] } : null; },
    async registerNonce(sender, nonce) { const k = sender + "|" + nonce; if (nonces.has(k)) return false; nonces.add(k); return true; },
  };
}

function world() {
  const cfgR = I.readIntegrationConfig("revem", env("revem")), cfgL = I.readIntegrationConfig("lexnote", env("lexnote"));
  const sides = {};
  const net = (target) => async (url, init) => { const res = await I.handleGatewayRequest(new Request(url, { method: init.method, headers: init.headers, body: init.body }), sides[target].gw); const text = await res.text(); return { status: res.status, text: async () => text, headers: res.headers }; };
  const mk = (cfg, target) => { const store = memStore(); const service = I.createLinkService({ cfg, store, peer: I.createPeerClient(cfg, { fetch: net(target) }) }); return { cfg, store, service, gw: { cfg, store, service } }; };
  sides.R = mk(cfgR, "L"); sides.L = mk(cfgL, "R");
  return sides;
}

scenario("Liaison complète A ↔ A, puis révocation (REV-EM initiateur)");
{
  const w = world();
  const s = await w.R.service.startLink("revem-user-A");
  const u = new URL(s.confirmUrl);
  check("URL de LexNote, nonce dans le fragment", u.origin === "https://lexnote.example.app" && u.pathname === "/integrations/revem/connect" && u.hash.startsWith("#n=") && !u.search.includes("n="));
  const nonce = u.hash.slice(3), intent = u.searchParams.get("intent");
  eq("inspection sans consommer", (await w.L.service.inspect(intent, nonce)).displayHint, "Alice");
  const st = await w.L.service.confirm("lex-user-A", intent, nonce);
  check("côté LexNote : connecté et vérifié", st.state === "CONNECTED" && st.verified === true);
  const rs = await w.R.service.getState("revem-user-A");
  check("côté REV-EM : connecté et vérifié", rs.state === "CONNECTED" && rs.verified === true && rs.peerStatus === "CONNECTED");
  eq("même integrationLinkId des deux côtés", rs.linkId, st.linkId);
  const Rl = await w.R.store.getUserLink("revem-user-A"), Ll = await w.L.store.getUserLink("lex-user-A");
  check("références croisées, jamais d'identifiant de compte", Rl.localReference === Ll.externalReference && Ll.localReference === Rl.externalReference && ![Rl.localReference, Rl.externalReference, Rl.linkId].join(" ").includes("user-"));
  await rejects("intention déjà utilisée", w.L.service.confirm("lex-user-B", intent, nonce), "GONE");
  const rv = await w.R.service.revoke("revem-user-A");
  check("révocation REV-EM : LexNote prévenu", rv.peerNotified === true && rv.state.state === "REVOKED");
  const ls = await w.L.service.getState("lex-user-A");
  check("LexNote constate la révocation (révoqué par le partenaire)", ls.state === "REVOKED" && ls.revokedBy === "partner");
  await rejects("plus aucun échange sur une liaison révoquée", w.R.service.assertLinkUsable(Rl.linkId, Rl.externalReference), "LINK_REVOKED");
}

scenario("Utilisateur B ne peut ni lier ni lire ni révoquer le lien de A");
{
  const w = world();
  const a = new URL((await w.R.service.startLink("A")).confirmUrl), b = new URL((await w.R.service.startLink("B")).confirmUrl);
  await rejects("intention de B + nonce de A", w.L.service.confirm("lex-A", b.searchParams.get("intent"), a.hash.slice(3)), "FORBIDDEN");
  await w.L.service.confirm("lex-A", a.searchParams.get("intent"), a.hash.slice(3));
  await w.L.service.confirm("lex-B", b.searchParams.get("intent"), b.hash.slice(3));
  const A = await w.R.store.getUserLink("A"), B = await w.R.store.getUserLink("B");
  await rejects("révoquer le lien de B avec la référence de A", w.R.service.handlePeerRequest({ kind: "link-request", operation: "REVOKE", linkId: B.linkId, senderReference: A.externalReference }), "NOT_FOUND");
  check("le lien de B est intact", (await w.R.service.getState("B")).state === "CONNECTED");
  eq("B ne voit que son lien", (await w.R.service.getState("B")).linkId === B.linkId && B.linkId !== A.linkId, true);
}

scenario("Passerelle REV-EM : signature, rejeu, altération, expiration, expéditeur, origine");
{
  const w = world(); const cfgL = w.L.cfg;
  const payload = { integrationVersion: I.INTEGRATION_VERSION, kind: "link-request", operation: "STATUS", linkId: "lnk_" + "a".repeat(30), senderReference: "ref_" + "b".repeat(30) };
  const build = async (over = {}) => {
    const env = I.makeEnvelope({ from: "lexnote", to: "revem", linkId: "pairing", payload });
    const body = over.body ?? JSON.stringify(env);
    const h = await I.signRequest({ body, from: "lexnote", to: "revem", kid: "k1", secret: over.secret ?? KEY, now: over.now });
    if (over.mutate) over.mutate(h);
    return new Request("https://r.example/gw", { method: "POST", headers: { "content-type": "application/json", ...h, ...(over.origin ? { origin: over.origin } : {}) }, body });
  };
  const call = async (r) => { const res = await I.handleGatewayRequest(r, w.R.gw); return { status: res.status, json: JSON.parse(await res.text()) }; };
  eq("requête valide (liaison inconnue → 404 signé)", (await call(await build())).status, 404);
  const r1 = await build(); const r2 = r1.clone(); await call(r1);
  eq("rejeu", (await call(r2)).json.details.reason, "replay");
  eq("mauvaise clé", (await call(await build({ secret: "z".repeat(40) }))).json.details.reason, "bad-signature");
  const ok = await build(); const tampered = new Request(ok.url, { method: "POST", headers: ok.headers, body: (await ok.clone().text()).replace("STATUS", "REVOKE") });
  eq("payload modifié", (await call(tampered)).json.details.reason, "payload-hash");
  eq("message expiré", (await call(await build({ now: new Date(Date.now() - 3600000) }))).json.details.reason, "expired");
  eq("expéditeur inconnu", (await call(await build({ mutate: (h) => { h["x-lnrv-from"] = "mallory"; } }))).json.details.reason, "unknown-sender");
  eq("origine navigateur refusée", (await call(await build({ origin: "https://evil.example" }))).status, 403);
  eq("requête non signée", (await call(new Request("https://r.example/gw", { method: "POST", body: "{}" }))).status, 401);
  void cfgL;
}

scenario("Fonction utilisateur : jeton obligatoire, CORS strict");
{
  const w = world();
  const user = { cfg: w.R.cfg, service: w.R.service, authenticate: async (req) => { const m = /^Bearer test-(.+)$/.exec(req.headers.get("authorization") || ""); if (!m) throw new I.IntegrationFailure(I.integrationError("UNAUTHENTICATED", "x")); return m[1]; } };
  const call = async (headers, body) => { const r = await I.handleUserRequest(new Request("https://x/f", { method: "POST", headers, body: JSON.stringify(body) }), user); return { status: r.status, acao: r.headers.get("access-control-allow-origin"), json: await r.json().catch(() => null) }; };
  eq("sans jeton : 401", (await call({ origin: "https://antsvfr.github.io" }, { action: "start" })).status, 401);
  const ok = await call({ origin: "https://antsvfr.github.io", authorization: "Bearer test-A" }, { action: "start" });
  check("jeton valide, origine REV-EM : écho exact de l'origine", ok.status === 200 && ok.acao === "https://antsvfr.github.io");
  const bad = await call({ origin: "https://evil.example", authorization: "Bearer test-A" }, { action: "start" });
  check("origine inconnue : 403 sans CORS", bad.status === 403 && bad.acao === null);
  check("jamais de joker", ok.acao !== "*" && bad.acao !== "*");
  check("la réponse au navigateur ne contient aucun secret", !JSON.stringify(ok.json).includes(KEY) && I.findSecrets(ok.json).length === 0);
}

scenario("Configuration");
{
  const base = { INTEGRATION_KEY_ID: "k1", INTEGRATION_KEY: KEY, INTEGRATION_SELF_APP_URL: "https://antsvfr.github.io/REV-EM/", INTEGRATION_PEER_APP_URL: "https://lexnote.example.app/", INTEGRATION_PEER_GATEWAY_URL: "https://l.example/gw" };
  const throws = (over) => { try { I.readIntegrationConfig("revem", (k) => ({ ...base, ...over })[k]); return false; } catch { return true; } };
  check("refuse '*'", throws({ INTEGRATION_ALLOWED_ORIGINS: "*" }));
  check("refuse http en production", throws({ INTEGRATION_PEER_APP_URL: "http://lexnote.example.app/" }));
  check("refuse localhost en production", throws({ INTEGRATION_ALLOWED_ORIGINS: "http://localhost:8080" }));
  check("refuse une clé courte", throws({ INTEGRATION_KEY: "court" }));
  eq("origines de production de REV-EM", I.readIntegrationConfig("revem", (k) => base[k]).selfOrigins, ["https://antsvfr.github.io"]);
}

console.log("\n" + pass + "/" + (pass + fail) + " vérifications passées, " + fail + " FAIL");
process.exit(fail === 0 ? 0 : 1);
