/* ============================================================================
   REV-EM — logique pure de « Réglages › Applications connectées » (connected-apps.js)
   Exécution :  node tests/connected-apps.test.js   (aucun navigateur, aucun réseau)
   ============================================================================ */
"use strict";
require("../connected-apps.js");
const L = globalThis.RevemLinks;
let pass = 0, fail = 0;
const check = (label, ok, detail) => { if(ok){ pass++; console.log("PASS — " + label); } else { fail++; console.log("FAIL — " + label + "  " + (detail !== undefined ? JSON.stringify(detail) : "")); } };
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const scenario = (n) => console.log("\n── " + n + " ──");
const conn = (o) => Object.assign({ integrationVersion: "lexnote-revem/v1", kind: "connection-state", partner: "lexnote", state: "CONNECTED", localStatus: "CONNECTED", peerStatus: "CONNECTED", verified: true, linkedAt: "2026-10-08T10:00:00Z", checkedAt: "x" }, o || {});

scenario("« Connecté » exige les DEUX côtés vérifiés");
eq("connecté + vérifié", L.describe(conn()), { kind: "connected", since: "2026-10-08T10:00:00Z" });
eq("CONNECTED non vérifié → pas connecté", L.describe(conn({ verified: false })).kind, "pending");
eq("CONNECTED mais le partenaire ne confirme pas → pas connecté", L.describe(conn({ peerStatus: "UNKNOWN" })).kind, "pending");
eq("chargement", L.describe(null, null), { kind: "loading" });
eq("non connecté", L.describe(conn({ state: "NOT_CONNECTED", localStatus: null, verified: false, peerStatus: "UNKNOWN" })).kind, "not_connected");
eq("révoqué par le partenaire", L.describe(conn({ state: "REVOKED", verified: false, revokedBy: "partner", revokedAt: "2026-10-09T08:00:00Z" })), { kind: "revoked", by: "partner", at: "2026-10-09T08:00:00Z" });
eq("erreur : partenaire injoignable", L.describe(conn({ state: "ERROR", errorCode: "PEER_UNREACHABLE", verified: false })), { kind: "error", reason: "unreachable" });
eq("erreur : liaison absente chez le partenaire", L.describe(conn({ state: "ERROR", errorCode: "PEER_MISSING", verified: false })).reason, "missing");
eq("état inconnu → erreur, jamais « connecté »", L.describe(conn({ state: "WHATEVER" })).kind, "error");
eq("échec réseau de l'appel", L.describe(null, { code: "UNAVAILABLE" }), { kind: "error", reason: "unreachable" });
eq("serveur non configuré", L.describe(null, { code: "INTERNAL" }).reason, "unconfigured");

scenario("Actions proposées selon l'état");
eq("non connecté : connecter", L.actions({ kind: "not_connected" }), { connect: true, disconnect: false, verify: true });
eq("connecté : déconnecter (pas reconnecter)", L.actions({ kind: "connected" }), { connect: false, disconnect: true, verify: true });
eq("révoqué : reconnecter", L.actions({ kind: "revoked" }).connect, true);
eq("injoignable : déconnecter possible, pas de nouvelle liaison", L.actions({ kind: "error", reason: "unreachable" }), { connect: false, disconnect: true, verify: true });
eq("chargement : rien", L.actions({ kind: "loading" }), { connect: false, disconnect: false, verify: false });

scenario("URL d'autorisation : jamais de redirection non vérifiée");
eq("https accepté", L.safeConfirmUrl("https://lexnote.example.app/integrations/revem/connect?intent=x#n=abc") !== null, true);
eq("http://localhost accepté (développement)", L.safeConfirmUrl("http://localhost:5173/x") !== null, true);
for (const bad of ["javascript:alert(1)", "http://evil.example/x", "data:text/html,x", "https://user:pw@lexnote.example.app/", "ftp://x.y", "", null, undefined, "pas une url"])
  eq("refusée : " + String(bad), L.safeConfirmUrl(bad), null);

scenario("Retour de LexNote (?lexnote_link=connected)");
eq("paramètre lu et retiré", L.parseReturn("?lexnote_link=connected&x=1"), { status: "connected", cleanSearch: "?x=1" });
eq("seul paramètre : query vide", L.parseReturn("?lexnote_link=connected"), { status: "connected", cleanSearch: "" });
eq("valeur inconnue : jamais interprétée comme un succès", L.parseReturn("?lexnote_link=yes").status, "unknown");
eq("absent", L.parseReturn("?brightspace=connected"), { status: null, cleanSearch: "?brightspace=connected" });

console.log("\n" + pass + " vérifications réussies, " + fail + " échec(s).");
process.exit(fail === 0 ? 0 : 1);
