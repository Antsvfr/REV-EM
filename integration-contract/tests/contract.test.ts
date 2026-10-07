import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATION_VERSION, isSupportedVersion, RevemCourseEvent, LexNoteSessionReference, StudyArtifactReference,
  IntegrationUserLink, CourseSessionIntent, parseLexNotePath, parseRevemHash, LEXNOTE_PATHS, REVEM_ROUTES,
  buildLexNoteLaunchUrl, buildLexNoteUrl, readTokenFromHash, assertOrigin, isAllowedReturn, verifyLaunchToken,
} from "../src/index.ts";
import { signLaunchToken } from "../src/server.ts";
import { b64urlEncode } from "../src/token.ts";

const V = INTEGRATION_VERSION;
const T0 = "2026-10-12T08:00:00.000Z";
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const event = () => ({
  integrationVersion: V,
  eventRef: { revemEventId: "evt_abc123", icsUid: "uid-1@univ.example", occurrenceStart: T0 },
  title: "Droit des contrats — CM 3", start: T0, end: "2026-10-12T10:00:00.000Z", allDay: false,
  location: "Amphi A", kind: "CM" as const, subject: { revemSubjectId: "subj_1", nameHint: "Droit des contrats" },
});

test("version : 1 acceptée, tout le reste refusé", () => {
  assert.equal(isSupportedVersion("1"), true);
  for (const v of ["2", "", 1, null, undefined, "1.0"]) assert.equal(isSupportedVersion(v), false);
  assert.equal(RevemCourseEvent.safeParse({ ...event(), integrationVersion: "2" }).success, false);
});

test("RevemCourseEvent : valide, puis rejette userId / e-mail / clés inconnues / dates incohérentes", () => {
  assert.equal(RevemCourseEvent.safeParse(event()).success, true);
  assert.equal(RevemCourseEvent.safeParse({ ...event(), userId: "u-1" }).success, false, "userId interdit");
  assert.equal(RevemCourseEvent.safeParse({ ...event(), email: "a@b.fr" }).success, false, "email interdit");
  assert.equal(RevemCourseEvent.safeParse({ ...event(), end: "2026-10-12T07:00:00.000Z" }).success, false, "fin avant début");
  const bad = event(); bad.eventRef.revemEventId = "etu@univ.fr";
  assert.equal(RevemCourseEvent.safeParse(bad).success, false, "un e-mail n'est pas un identifiant opaque");
  const ctl = event(); ctl.title = "ok\u0000mal";
  assert.equal(RevemCourseEvent.safeParse(ctl).success, false, "caractères de contrôle");
  const big = event(); big.title = "x".repeat(201);
  assert.equal(RevemCourseEvent.safeParse(big).success, false);
});

test("LexNoteSessionReference : référence seulement (pas de contenu)", () => {
  const ref = { integrationVersion: V, lexnoteSessionId: "session_9f", title: "CM 3", date: "2026-10-12", status: "completed" as const,
    number: 3, capture: { hasAudio: true, hasTranscript: true, transcriptWords: 5200, audioMs: 5400000 }, updatedAt: T0 };
  assert.equal(LexNoteSessionReference.safeParse(ref).success, true);
  assert.equal(LexNoteSessionReference.safeParse({ ...ref, notes: "contenu" }).success, false, "pas de contenu de notes");
  assert.equal(LexNoteSessionReference.safeParse({ ...ref, transcript: [] }).success, false, "pas de transcription");
  assert.equal(LexNoteSessionReference.safeParse({ ...ref, status: "draft" }).success, false);
  assert.equal(LexNoteSessionReference.safeParse({ ...ref, date: "12/10/2026" }).success, false);
});

test("StudyArtifactReference : provenance / vérification de LexNote ; openPath strictement /artifact/:id", () => {
  const a = { integrationVersion: V, artifactId: "art_1", lexnoteSessionId: "session_9f", type: "MIND_MAP" as const, title: "Carte mentale",
    generatedAt: T0, provenance: "AI" as const, verification: "UNVERIFIED" as const, generatedBy: { providerId: "x", model: "m" },
    contentSha256: "a".repeat(64), openPath: "/artifact/art_1" };
  assert.equal(StudyArtifactReference.safeParse(a).success, true);
  for (const p of ["https://evil.example/artifact/art_1", "/artifact/../x", "//evil.example/artifact/a", "/session/x", "/artifact/a b"])
    assert.equal(StudyArtifactReference.safeParse({ ...a, openPath: p }).success, false, p);
  assert.equal(StudyArtifactReference.safeParse({ ...a, provenance: "TRUSTED" }).success, false);
  assert.equal(StudyArtifactReference.safeParse({ ...a, type: "EXAM" }).success, false);
});

test("IntegrationUserLink : pseudonyme ; ni e-mail ni identifiant d'authentification", () => {
  const l = { integrationVersion: V, linkId: UUID(1), status: "active" as const, scopes: ["session:open" as const], createdAt: T0,
    peer: { app: "lexnote" as const, externalReference: "install_7f3a" } };
  assert.equal(IntegrationUserLink.safeParse(l).success, true);
  assert.equal(IntegrationUserLink.safeParse({ ...l, userId: UUID(2) }).success, false);
  assert.equal(IntegrationUserLink.safeParse({ ...l, peer: { app: "lexnote", externalReference: "a@b.fr" } }).success, false);
  assert.equal(IntegrationUserLink.safeParse({ ...l, scopes: [] }).success, false);
  assert.equal(IntegrationUserLink.safeParse({ ...l, scopes: ["admin"] }).success, false);
});

test("CourseSessionIntent : expiration après la demande", () => {
  const i = { integrationVersion: V, intentId: UUID(3), action: "open_or_create_session" as const, event: event(), requestedAt: T0, expiresAt: "2026-10-12T08:02:00.000Z" };
  assert.equal(CourseSessionIntent.safeParse(i).success, true);
  assert.equal(CourseSessionIntent.safeParse({ ...i, expiresAt: T0 }).success, false);
  assert.equal(CourseSessionIntent.safeParse({ ...i, action: "delete_everything" }).success, false);
});

test("liens profonds : routes exactes, rien d'autre", () => {
  assert.deepEqual(parseLexNotePath(LEXNOTE_PATHS.course("session_9f")), { kind: "course", sessionId: "session_9f" });
  assert.deepEqual(parseLexNotePath(LEXNOTE_PATHS.artifact("art_1")), { kind: "artifact", artifactId: "art_1" });
  assert.deepEqual(parseLexNotePath("/integrations/revem/session"), { kind: "launch" });
  for (const p of ["/course/", "/course/a/b", "/course/a?x=1", "/course/<script>", "/integrations/revem/session/x", "/session/abc", "/course/" + "a".repeat(129)])
    assert.equal(parseLexNotePath(p), null, p);
  assert.deepEqual(parseRevemHash(REVEM_ROUTES.course("evt_abc123")), { kind: "course", eventId: "evt_abc123" });
  assert.deepEqual(parseRevemHash(REVEM_ROUTES.revision("subj_1")), { kind: "revision", subjectId: "subj_1" });
  for (const h of ["#/course/", "#/course/a@b.fr", "#/admin", "/course/x", "#/course/x/y"]) assert.equal(parseRevemHash(h), null, h);
  assert.throws(() => LEXNOTE_PATHS.course("a@b.fr"));
  assert.throws(() => REVEM_ROUTES.course("x y"));
});

test("liens profonds : origine sûre, retour en liste blanche, jeton dans le fragment", () => {
  assert.equal(assertOrigin("https://lexnote.example"), "https://lexnote.example");
  assert.equal(assertOrigin("http://localhost:5173"), "http://localhost:5173");
  for (const o of ["http://lexnote.example", "https://u:p@lexnote.example", "https://lexnote.example/x", "javascript:alert(1)", "lexnote.example", "https://lexnote.example?x=1"])
    assert.throws(() => assertOrigin(o), o);
  assert.equal(buildLexNoteUrl("https://lexnote.example", "/artifact/art_1"), "https://lexnote.example/artifact/art_1");
  assert.throws(() => buildLexNoteUrl("https://lexnote.example", "/settings"));
  const url = buildLexNoteLaunchUrl("https://lexnote.example", "aaa.bbb.ccc");
  assert.equal(url, "https://lexnote.example/integrations/revem/session#t=aaa.bbb.ccc");
  assert.equal(new URL(url).search, "", "aucun paramètre de requête");
  assert.equal(readTokenFromHash(new URL(url).hash), "aaa.bbb.ccc");
  assert.equal(readTokenFromHash("?t=aaa.bbb.ccc"), null);
  assert.throws(() => buildLexNoteLaunchUrl("https://lexnote.example", "pas un jeton"));
  const allowed = ["https://revem.example"];
  assert.equal(isAllowedReturn("https://revem.example/#/course/x", allowed), true);
  for (const r of ["https://evil.example/", "https://revem.example.evil.example/", "https://u:p@revem.example/", "javascript:alert(1)", "//evil.example"])
    assert.equal(isAllowedReturn(r, allowed), false, r);
});

/* ── jeton de lancement ─────────────────────────────────────────────────── */
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}
const claimsIn = { jti: UUID(10), sub: UUID(11), intent: UUID(12), scope: "session:open" as const };
const NOW = 1_800_000_000;

test("jeton : signé côté serveur, vérifié avec la clé PUBLIQUE seule", async () => {
  const { priv, pub } = await keypair();
  const tok = await signLaunchToken(claimsIn, priv, "k1", NOW);
  assert.equal(tok.split(".").length, 3);
  const r = await verifyLaunchToken(tok, { k1: pub }, NOW + 5);
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.claims.sub, UUID(11)); assert.equal(r.claims.exp - r.claims.iat, 120); assert.equal(r.header.alg, "EdDSA"); }
  assert.equal(Object.keys(pub).includes("d"), false, "la clé publique ne contient aucun secret");
  const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
  assert.deepEqual(Object.keys(payload).sort(), ["aud", "exp", "iat", "intent", "iss", "jti", "scope", "sub", "v"], "aucune donnée métier ni identité dans le jeton");
});

test("jeton : expiré, futur, durée excessive, mauvaise clé, clé inconnue", async () => {
  const a = await keypair(), b = await keypair();
  const tok = await signLaunchToken(claimsIn, a.priv, "k1", NOW);
  assert.deepEqual(await verifyLaunchToken(tok, { k1: a.pub }, NOW + 120 + 61), { ok: false, reason: "expired" });
  assert.equal((await verifyLaunchToken(tok, { k1: a.pub }, NOW + 120 + 30)).ok, true, "tolérance d'horloge");
  assert.deepEqual(await verifyLaunchToken(tok, { k1: a.pub }, NOW - 61 - 1), { ok: false, reason: "not_yet_valid" });
  assert.deepEqual(await verifyLaunchToken(tok, { k1: b.pub }, NOW), { ok: false, reason: "bad_signature" });
  assert.deepEqual(await verifyLaunchToken(tok, { autre: a.pub }, NOW), { ok: false, reason: "unknown_key" });
  assert.deepEqual(await verifyLaunchToken(tok, {}, NOW), { ok: false, reason: "unknown_key" });
  const long = await signLaunchToken({ ...claimsIn, ttlSec: 99999 }, a.priv, "k1", NOW);
  assert.equal(JSON.parse(Buffer.from(long.split(".")[1], "base64url").toString()).exp - NOW, 300, "plafonné à 300 s côté signature");
});

test("jeton : falsification de la charge, en-tête alg=none, jeton mal formé, clé « __proto__ »", async () => {
  const { priv, pub } = await keypair();
  const tok = await signLaunchToken(claimsIn, priv, "k1", NOW);
  const [h, p, s] = tok.split(".");
  const evil = { ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: UUID(99) };
  const forged = h + "." + b64urlEncode(new TextEncoder().encode(JSON.stringify(evil))) + "." + s;
  assert.deepEqual(await verifyLaunchToken(forged, { k1: pub }, NOW), { ok: false, reason: "bad_signature" });
  const noneH = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "revem-launch+1", kid: "k1" })));
  assert.deepEqual(await verifyLaunchToken(noneH + "." + p + ".", { k1: pub }, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyLaunchToken(noneH + "." + p + "." + s, { k1: pub }, NOW), { ok: false, reason: "bad_header" });
  const hs = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "revem-launch+1", kid: "k1" })));
  assert.deepEqual(await verifyLaunchToken(hs + "." + p + "." + s, { k1: pub }, NOW), { ok: false, reason: "bad_header" });
  for (const bad of ["", "a.b", "a.b.c.d", "!!!.???.***", h + "." + p]) assert.equal((await verifyLaunchToken(bad, { k1: pub }, NOW)).ok, false, bad);
  const protoH = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "revem-launch+1", kid: "__proto__" })));
  assert.deepEqual(await verifyLaunchToken(protoH + "." + p + "." + s, { k1: pub }, NOW), { ok: false, reason: "unknown_key" });
});

test("jeton : les claims sont strictes (userId, email, aud inattendus refusés à la signature)", async () => {
  const { priv } = await keypair();
  await assert.rejects(() => signLaunchToken({ ...claimsIn, scope: "root" as never }, priv, "k1", NOW));
  await assert.rejects(() => signLaunchToken({ ...claimsIn, sub: "user@example.com" as never }, priv, "k1", NOW), "sub doit être un uuid de lien, pas un e-mail");
});
