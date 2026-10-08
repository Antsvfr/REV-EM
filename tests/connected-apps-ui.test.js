/* ============================================================================
   REV-EM — « Réglages › Applications connectées » : le BRANCHEMENT, dans un vrai navigateur
   ----------------------------------------------------------------------------
   Prérequis :  python3 -m http.server 9109   puis
                NODE_PATH=/opt/node22/lib/node_modules node tests/connected-apps-ui.test.js

   RÉEL : index.html, auth.js, connected-apps.js, translations.js (le code du produit).
   REMPLACÉ : le client Supabase et l'appel à l'Edge Function `integration-link` (double de même forme). La sécurité de la
   liaison elle-même (signature, rejeu, intentions, RLS) est testée sur le vrai code des Edge Functions et sur PostgreSQL :
   voir tests/integration-link.test.mjs et supabase/tests/integration_links_tests.sql.
   ============================================================================ */
const { chromium } = require("playwright");
const results = [];
function assert(c, l, d){ results.push({ l, pass: !!c, d: d || "" }); }

const FAKE = `
window.__invoked = [];
window.__reply = { status: { ok: true, state: null } };
window.__user = "user-a";
function mkState(o){ return Object.assign({ integrationVersion: "lexnote-revem/v1", kind: "connection-state", partner: "lexnote", state: "NOT_CONNECTED", localStatus: null, peerStatus: "UNKNOWN", verified: false, checkedAt: new Date().toISOString() }, o || {}); }
window.mkState = mkState;
window.LyonAuth.available = true;
window.LyonAuth.state.status = "signed-in";
window.LyonAuth.state.user = { id: "user-a", email: "a@test.local" };
window.__client = {
  from: function(){ const b = { select(){return b;}, eq(){return b;}, order(){return b;}, limit(){return b;}, in(){return b;}, maybeSingle(){return b;}, then(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return b; },
  functions: { invoke: async function(fn, o){
    window.__invoked.push({ fn: fn, body: o && o.body });
    if(fn !== "integration-link") return { data: null, error: null };
    const action = o.body.action; const r = window.__reply[action];
    if(r && r.error) return { data: null, error: { context: { json: async () => ({ ok: false, error: { code: r.error } }) } } };
    return { data: r || { ok: true }, error: null };
  }},
};
Object.defineProperty(window.LyonAuth, "client", { get: function(){ return window.__client; }, configurable: true });
`;

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", m => { if(m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); });
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  const navigations = [];
  await ctx.route("https://lexnote.example.app/**", route => { navigations.push(route.request().url()); route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>LexNote</body></html>" }); });

  await page.goto("http://localhost:9109/index.html");
  await page.waitForTimeout(1500);
  await page.evaluate(FAKE);

  async function show(connState){
    await page.evaluate((cs) => {
      window.__reply.status = { ok: true, state: cs };
      window.__invoked = [];
      state.lexnote = { conn: null, error: null, busy: null, loaded: false, toast: null };
      state.tab = "settings"; render();
    }, connState);
    await page.waitForFunction(() => state.lexnote.loaded === true, null, { timeout: 4000 });
    await page.waitForTimeout(150);
    return await page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " ").trim());
  }
  const S = (o) => page.evaluate((o) => window.mkState(o), o);

  /* 1. non connecté */
  let txt = await show(await S({}));
  assert(/Applications connectées/.test(txt) && /LexNote/.test(txt), "la section existe dans les Réglages, got: " + txt.slice(0, 80));
  assert(/Non connecté/.test(txt) && !!(await page.$("#lnk-connect-btn")), "non connecté : bouton Connecter");
  assert(!(await page.$("#lnk-disconnect-btn")), "non connecté : pas de bouton Déconnecter");
  let st = await page.evaluate(() => window.__invoked);
  assert(st[0] && st[0].fn === "integration-link" && st[0].body.action === "status" && st[0].body.probe === true, "ouvre les Réglages → vérification RÉELLE auprès du serveur, got: " + JSON.stringify(st[0]));

  /* 2. LE cas critique : CONNECTED non vérifié ne s'affiche jamais « Connecté » */
  txt = await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: false, peerStatus: "UNKNOWN", linkId: "lnk_x" }));
  assert(!/✓ Connecté/.test(txt), "CONNECTED non vérifié : jamais « ✓ Connecté », got: " + txt.slice(0, 120));
  assert(/Vérification en cours/.test(txt), "il est présenté comme vérification en cours");
  txt = await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "PENDING" }));
  assert(!/✓ Connecté/.test(txt), "partenaire non confirmé : jamais « ✓ Connecté »");

  /* 3. connecté, vérifié des deux côtés */
  txt = await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "CONNECTED", linkId: "lnk_x", linkedAt: "2026-10-08T10:00:00Z" }));
  assert(/✓ Connecté/.test(txt), "vérifié des deux côtés : « ✓ Connecté », got: " + txt.slice(0, 120));
  assert(/2026/.test(txt) && /jamais le contenu/.test(txt), "date de connexion + rappel de confidentialité");
  assert(!!(await page.$("#lnk-disconnect-btn")) && !(await page.$("#lnk-connect-btn")), "connecté : Déconnecter, pas Connecter");
  assert(!/lnk_x|ref_|secret|token/i.test(txt), "aucun identifiant interne ni secret affiché");

  /* 4. déconnexion : confirmation + appel revoke ; rien n'est supprimé */
  await page.evaluate(() => { window.__invoked = []; window.__reply.revoke = { ok: true, state: window.mkState({ state: "REVOKED", localStatus: "REVOKED", revokedBy: "self", revokedAt: new Date().toISOString() }), peerNotified: true }; window.confirm = () => true; });
  await page.evaluate(() => document.getElementById("lnk-disconnect-btn").click());
  await page.waitForFunction(() => window.__invoked.some(x => x.body && x.body.action === "revoke"), null, { timeout: 4000 });
  await page.waitForTimeout(200);
  txt = await page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " "));
  assert(/Déconnecté/.test(txt) && /Aucune donnée n'a été supprimée/.test(txt), "après révocation : « Déconnecté » + aucune donnée supprimée, got: " + txt.slice(0, 160));
  assert(!!(await page.$("#lnk-connect-btn")), "révoqué : reconnexion possible");
  await page.evaluate(() => { window.__invoked = []; window.confirm = () => false; });
  await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "CONNECTED", linkedAt: "2026-10-08T10:00:00Z" }));
  await page.evaluate(() => { window.__invoked = []; document.getElementById("lnk-disconnect-btn").click(); });
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => !window.__invoked.some(x => x.body && x.body.action === "revoke")), "refus de la confirmation : aucun appel revoke");

  /* 5. révoqué par LexNote */
  txt = await show(await S({ state: "REVOKED", localStatus: "REVOKED", revokedBy: "partner", revokedAt: "2026-10-09T08:00:00Z" }));
  assert(/LexNote a mis fin/.test(txt), "révoqué par le partenaire : on le dit, got: " + txt.slice(0, 120));

  /* 6. partenaire injoignable / échec de l'appel */
  txt = await show(await S({ state: "ERROR", localStatus: "CONNECTED", errorCode: "PEER_UNREACHABLE", verified: false }));
  assert(/injoignable/.test(txt) && !/✓ Connecté/.test(txt), "injoignable : message clair, jamais « Connecté »");
  await page.evaluate(() => { window.__reply.status = { error: "UNAVAILABLE" }; state.lexnote = { conn: null, error: null, busy: null, loaded: false, toast: null }; render(); });
  await page.waitForFunction(() => state.lexnote.loaded === true, null, { timeout: 4000 });
  await page.waitForTimeout(100);
  txt = await page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " "));
  assert(/injoignable/.test(txt) && !/✓ Connecté/.test(txt), "échec de l'appel serveur : jamais « Connecté »");

  /* 7. Connecter : start puis redirection vers LexNote avec le nonce dans le FRAGMENT ; URL dangereuse refusée */
  await show(await S({}));
  await page.evaluate(() => { window.__invoked = []; window.__reply.start = { ok: true, linkIntentId: "9f1c0a52-4d1e-4b43-8a7f-0c6a4f8f7a11", confirmUrl: "https://lexnote.example.app/integrations/revem/connect?intent=9f1c0a52-4d1e-4b43-8a7f-0c6a4f8f7a11#n=" + "A".repeat(43) }; });
  await Promise.all([page.waitForURL(/lexnote\.example\.app/, { timeout: 5000 }), page.evaluate(() => document.getElementById("lnk-connect-btn").click())]);
  assert(/^https:\/\/lexnote\.example\.app\/integrations\/revem\/connect\?intent=[0-9a-f-]{36}$/.test(navigations[0] || ""), "redirige vers LexNote ; le nonce n'est PAS dans la requête envoyée au serveur, got: " + navigations[0]);
  assert(page.url().includes("#n="), "le nonce est dans le fragment (jamais transmis au serveur)");
  await page.goto("http://localhost:9109/index.html"); await page.waitForTimeout(1200); await page.evaluate(FAKE);
  await show(await S({}));
  await page.evaluate(() => { window.__reply.start = { ok: true, confirmUrl: "javascript:alert(document.domain)" }; document.getElementById("lnk-connect-btn").click(); });
  await page.waitForTimeout(400);
  assert(page.url().startsWith("http://localhost:9109"), "URL javascript: : aucune navigation");
  await page.evaluate(() => { window.__reply.start = { ok: true, confirmUrl: "http://evil.example/steal" }; document.getElementById("lnk-connect-btn").click(); });
  await page.waitForTimeout(400);
  assert(page.url().startsWith("http://localhost:9109") && navigations.length === 1, "URL non https : aucune navigation");
  await page.evaluate(() => { window.__reply.start = { error: "CONFLICT" }; document.getElementById("lnk-connect-btn").click(); });
  await page.waitForTimeout(300);
  txt = await page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " "));
  assert(/déjà connecté/.test(txt), "déjà lié : message explicite, got: " + txt.slice(0, 160));

  /* 8. Retour de LexNote : le paramètre est retiré, l'état est REVÉRIFIÉ côté serveur (l'URL ne prouve rien) */
  await page.goto("http://localhost:9109/index.html"); await page.waitForTimeout(1200); await page.evaluate(FAKE);
  await page.evaluate(() => { window.__reply.status = { ok: true, state: window.mkState({ state: "NOT_CONNECTED" }) }; window.__invoked = []; history.replaceState({}, "", "/index.html?lexnote_link=connected"); lnHandleReturn(); });
  await page.waitForFunction(() => state.lexnote.loaded === true, null, { timeout: 4000 });
  await page.waitForTimeout(200);
  assert(!/lexnote_link/.test(page.url()), "le paramètre de retour est retiré de l'URL, got: " + page.url());
  assert(await page.evaluate(() => state.tab === "settings"), "l'écran de retour est Réglages");
  assert(await page.evaluate(() => window.__invoked.some(x => x.body && x.body.action === "status" && x.body.probe === true)), "le retour déclenche une vérification serveur");
  txt = await page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " "));
  assert(!/✓ Connecté/.test(txt), "un paramètre d'URL forgé ne suffit pas à afficher « Connecté »");

  /* 9. cloisonnement : changer de compte efface la liaison affichée */
  await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "CONNECTED", linkedAt: "2026-10-08T10:00:00Z" }));
  await page.evaluate(() => resetUserStateInMemory());
  assert(await page.evaluate(() => state.lexnote.conn === null && state.lexnote.loaded === false), "changement de compte : la liaison du compte précédent n'est plus en mémoire");

  /* 10. invité : aucune action, explication */
  await page.evaluate(() => { window.LyonAuth.state.status = "signed-out"; state.tab = "settings"; render(); });
  txt = await page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " "));
  assert(/Connecte-toi à REV-EM/.test(txt) && !(await page.$("#lnk-connect-btn")), "invité : explication, aucun bouton");

  /* 11. les 5 langues ont toutes les clés */
  const missing = await page.evaluate(() => { const keys = ["title","intro","connect","disconnect","connected","not_connected","revoked","error","confirm_disconnect","error_unreachable","no_data_deleted","pitch","connected_since","revoked_by_partner","revoked_by_self","success_toast","disconnected_toast"].map(k => "lnk." + k); const out = []; ["fr","en","es","de","it"].forEach(l => { LyonI18n.setLang(l); keys.forEach(k => { if(LyonI18n.t(k) === k) out.push(l + ":" + k); }); }); LyonI18n.setLang("fr"); return out; });
  assert(missing.length === 0, "traductions complètes dans les 5 langues, manquant: " + JSON.stringify(missing));

  assert(errs.length === 0, "aucune erreur console", errs.join(" | "));
  await b.close();
  let p = 0, f = 0;
  results.forEach(r => { console.log((r.pass ? "PASS" : "FAIL") + " — " + r.l + (r.pass ? "" : "  [" + r.d + "]")); r.pass ? p++ : f++; });
  console.log("\n" + p + "/" + (p + f) + " vérifications passées, " + f + " FAIL");
  process.exit(f === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
