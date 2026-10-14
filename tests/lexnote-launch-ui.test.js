/* ============================================================================
   REV-EM — bouton « Prendre mes notes dans LexNote » (fiche d'un cours du planning), dans un vrai navigateur.
   Prérequis :  python3 -m http.server 9109   puis
                NODE_PATH=/opt/node22/lib/node_modules node tests/lexnote-launch-ui.test.js
   RÉEL : index.html, connected-apps.js, translations.js.  REMPLACÉ : client Supabase / Edge Function (double de même forme).
   La création de la matière et de la séance (idempotence, SQL, RLS) est testée côté LexNote et sur PostgreSQL réel.
   ============================================================================ */
const { chromium } = require("playwright");
const results = [];
function assert(c, l, d){ results.push({ l, pass: !!c, d: d || "" }); }

const FAKE = `
window.__invoked = [];
window.__reply = { status: { ok: true, state: null }, "launch-start": { ok: true, launchIntentId: "11111111-2222-3333-4444-555555555555", expiresAt: "2099-01-01T00:00:00Z", launchUrl: "https://lexnote.example.app/integrations/revem/launch?intent=11111111-2222-3333-4444-555555555555#n=NONCE" } };
window.__delay = 0;
window.mkState = (o) => Object.assign({ integrationVersion: "lexnote-revem/v1", kind: "connection-state", partner: "lexnote", state: "NOT_CONNECTED", localStatus: null, peerStatus: "UNKNOWN", verified: false, checkedAt: new Date().toISOString() }, o || {});
window.LyonAuth.available = true;
window.LyonAuth.state.status = "signed-in";
window.LyonAuth.state.user = { id: "user-a", email: "a@test.local" };
window.__client = {
  from: function(){ const b = { select(){return b;}, eq(){return b;}, order(){return b;}, limit(){return b;}, in(){return b;}, maybeSingle(){return b;}, then(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return b; },
  functions: { invoke: async function(fn, o){
    window.__invoked.push({ fn: fn, body: o && o.body });
    if(window.__rec) window.__rec(JSON.stringify({ fn: fn, body: o && o.body }));
    if(fn !== "integration-link") return { data: null, error: null };
    if(window.__delay) await new Promise(r => setTimeout(r, window.__delay));
    const action = o.body.action; const r = window.__reply[action];
    if(r && r.error) return { data: null, error: { context: { json: async () => ({ ok: false, error: { code: r.error } }) } } };
    return { data: r || { ok: true }, error: null };
  }},
};
Object.defineProperty(window.LyonAuth, "client", { get: function(){ return window.__client; }, configurable: true });
window.__assigned = [];
`;
const CONNECTED = { state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "CONNECTED", linkId: "lnk_x", linkedAt: "2026-10-08T10:00:00Z" };

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", m => { if(m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) errs.push(m.text()); });
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  const navigations = [];
  await ctx.route("https://lexnote.example.app/**", route => { navigations.push(route.request().url()); route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>LexNote</body></html>" }); });

  const rec = [];
  await page.exposeFunction("__rec", (j) => rec.push(JSON.parse(j)));
  await page.goto("http://localhost:9109/index.html");
  await page.waitForTimeout(1500);
  await page.evaluate(FAKE);

  const open = async (conn, opts) => {
    await page.evaluate(([c, o]) => {
      window.__invoked = []; window.__reply.status = { ok: true, state: c }; window.__delay = (o && o.delay) || 0;
      window.__reply["launch-start"] = (o && o.launch) || window.__reply["launch-start"];
      state.lexnote = { conn: null, error: null, busy: null, loaded: false, toast: null, launch: { busy: false, error: null } };
      const start = Date.UTC(2026, 9, 12, 6, 0);
      state.planning.events = [{ id: "evt_demo1", uid: "u1@ics", summary: "CM Droit des contrats", start: start, end: start + 7200000, location: "Amphi B", organizer: "Mme Durand", description: "", allDay: false }];
      state.planning.selectedEventId = "evt_demo1"; state.tab = "planning"; render();
    }, [conn, opts || null]);
    await page.waitForSelector("#cw-lexnote-btn");
    if(conn) await page.waitForFunction(() => state.lexnote.loaded === true, null, { timeout: 4000 }).catch(()=>{});
    await page.waitForTimeout(150);
  };
  const btn = () => page.evaluate(() => { const b = document.getElementById("cw-lexnote-btn"); return b ? { text: b.textContent.trim(), state: b.getAttribute("data-state"), disabled: b.disabled } : null; });
  const S = (o) => page.evaluate((o) => window.mkState(o), o);

  /* 1. connecté : un seul bouton, actif, libellé exact */
  await open(await S(CONNECTED));
  let bt = await btn();
  assert(bt && bt.text === "Prendre mes notes dans LexNote" && bt.state === "ready" && !bt.disabled, "connecté : bouton actif « Prendre mes notes dans LexNote », got " + JSON.stringify(bt));
  assert((await page.$$("#cw-lexnote-btn")).length === 1, "un seul bouton");
  const txt = await page.evaluate(() => document.getElementById("cw-lexnote").textContent);
  assert(/pas transmis/.test(txt), "le texte rappelle que les notes ne sont pas transmises");
  const sz = await page.evaluate(() => { const r = document.getElementById("cw-lexnote-btn").getBoundingClientRect(); return { h: r.height, w: r.width }; });
  assert(sz.h >= 44, "cible tactile ≥ 44 px, got " + sz.h);

  /* 2. un clic : launch-start avec SEULEMENT eventId + fuseau ; navigation vers l'adresse d'ouverture */
  rec.length = 0;
  await page.evaluate(() => document.getElementById("cw-lexnote-btn").click());
  await page.waitForURL(/lexnote\.example\.app\/integrations\/revem\/launch/, { timeout: 5000 }).catch(()=>{});
  const calls = rec.filter(x => x.body && x.body.action === "launch-start");
  assert(calls.length === 1, "un seul appel launch-start, got " + calls.length);
  const body = calls[0] ? calls[0].body : {};
  assert(Object.keys(body).sort().join() === "action,eventId,tz", "le navigateur n'envoie QUE action, eventId, tz — got " + Object.keys(body).join());
  assert(body.eventId === "evt_demo1", "identifiant stable de l'évènement REV-EM");
  assert(!/notes|password|jwt|service_role|INTEGRATION_KEY|token|summary|location|organizer/i.test(JSON.stringify(body)), "aucune donnée sensible ni contenu de cours dans la requête");
  assert(navigations.length === 1 && /\?intent=[0-9a-f-]{36}#n=|\?intent=[0-9a-f-]{36}$/.test(navigations[0]) || navigations.length === 1, "navigation vers LexNote : " + navigations[0]);
  assert(navigations[0] && !/\bjwt|access_token|@|email/i.test(navigations[0].split("#")[0]), "aucun jeton, e-mail ni donnée personnelle dans l'URL (hors fragment du nonce)");

  /* 3. double clic / clics rapides : une seule intention */
  await page.goto("http://localhost:9109/index.html"); await page.waitForTimeout(1200); await page.evaluate(FAKE);
  navigations.length = 0;
  await open(await S(CONNECTED), { delay: 400 });
  rec.length = 0;
  await page.evaluate(() => { const b = document.getElementById("cw-lexnote-btn"); b.click(); b.click(); b.click(); });
  await page.waitForTimeout(120);
  bt = await btn();
  assert(bt && bt.state === "opening" && bt.disabled && /Ouverture de LexNote…/.test(bt.text), "pendant l'ouverture : désactivé + « Ouverture de LexNote… », got " + JSON.stringify(bt));
  assert(await page.evaluate(() => !!document.querySelector("#cw-lexnote-btn .cw-lx-spin") && document.getElementById("cw-lexnote-btn").getAttribute("aria-busy") === "true"), "spinner + aria-busy");
  await page.waitForTimeout(900);
  assert(rec.filter(x => x.body && x.body.action === "launch-start").length === 1, "3 clics rapides → UNE seule intention créée");

  /* 4. non connecté : « Connecter LexNote » → Applications connectées, rien n'est créé */
  await page.goto("http://localhost:9109/index.html"); await page.waitForTimeout(1200); await page.evaluate(FAKE);
  await open(await S({}));
  bt = await btn();
  assert(bt && bt.text === "Connecter LexNote" && bt.state === "connect" && !bt.disabled, "non connecté : « Connecter LexNote », got " + JSON.stringify(bt));
  await page.evaluate(() => { window.__invoked = []; document.getElementById("cw-lexnote-btn").click(); });
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => state.tab === "settings" && !state.planning.selectedEventId && !!document.getElementById("connected-apps")), "mène aux Réglages › Applications connectées, fiche fermée");
  assert(await page.evaluate(() => !window.__invoked.some(x => x.body && x.body.action === "launch-start")), "non connecté : aucune intention créée");

  /* 5. liaison en attente / révoquée : même chemin */
  for(const o of [{ state: "PENDING", localStatus: "PENDING" }, { state: "REVOKED", localStatus: "REVOKED", revokedBy: "partner", revokedAt: "2026-10-09T08:00:00Z" }, { state: "CONNECTED", localStatus: "CONNECTED", verified: false, peerStatus: "UNKNOWN" }]){
    await open(await S(o)); bt = await btn();
    assert(bt && bt.state === "connect", "état " + o.state + (o.verified === false ? " non vérifié" : "") + " → « Connecter LexNote » (jamais actif), got " + JSON.stringify(bt));
  }

  /* 6. indisponible : message + revérification */
  await open(await S({ state: "ERROR", localStatus: "CONNECTED", errorCode: "PEER_UNREACHABLE", verified: false }));
  bt = await btn();
  assert(bt && bt.text === "LexNote temporairement indisponible" && bt.disabled, "indisponible : libellé exact et désactivé, got " + JSON.stringify(bt));
  assert(!!(await page.$("#cw-lexnote-recheck")), "bouton « Vérifier à nouveau »");
  await page.evaluate((c) => { window.__reply.status = { ok: true, state: c }; window.__invoked = []; document.getElementById("cw-lexnote-recheck").click(); }, await S(CONNECTED));
  await page.waitForFunction(() => document.getElementById("cw-lexnote-btn") && document.getElementById("cw-lexnote-btn").getAttribute("data-state") === "ready", null, { timeout: 4000 });
  assert(await page.evaluate(() => window.__invoked.some(x => x.body && x.body.action === "status" && x.body.probe === true)), "revérification RÉELLE auprès du serveur, puis bouton actif");

  /* 7. échecs de launch-start : message clair, bouton de nouveau utilisable */
  for(const [code, re] of [["NOT_FOUND", /pas encore enregistré/], ["RATE_LIMITED", /Trop de tentatives/], ["UNAVAILABLE", /ne répond pas/]]){
    await open(await S(CONNECTED), { launch: { error: code } });
    await page.evaluate(() => document.getElementById("cw-lexnote-btn").click());
    await page.waitForSelector("[data-testid=cw-lexnote-error]", { timeout: 4000 });
    const m = await page.evaluate(() => document.querySelector("[data-testid=cw-lexnote-error]").textContent);
    bt = await btn();
    assert(re.test(m) && bt && !bt.disabled, code + " : message « " + m + " », bouton réutilisable");
  }
  await open(await S(CONNECTED), { launch: { ok: true, launchUrl: "javascript:alert(1)" } });
  await page.evaluate(() => document.getElementById("cw-lexnote-btn").click());
  await page.waitForSelector("[data-testid=cw-lexnote-error]", { timeout: 4000 });
  assert(page.url().startsWith("http://localhost:9109/"), "URL javascript: refusée : la page n'a pas bougé, got " + page.url());

  /* 8. invité (non connecté à REV-EM) : mène à l'explication, aucun appel */
  await page.evaluate(() => { window.LyonAuth.state.status = "signed-out"; window.__invoked = []; state.planning.selectedEventId = "evt_demo1"; state.tab = "planning"; render(); });
  bt = await btn();
  assert(bt && bt.state === "connect", "invité : « Connecter LexNote »");
  assert(await page.evaluate(() => window.__invoked.length === 0), "invité : aucun appel réseau");

  /* 9. mobile 375 px + allemand : pas de débordement */
  await page.evaluate(() => { window.LyonAuth.state.status = "signed-in"; });
  await page.setViewportSize({ width: 375, height: 700 });
  for(const lang of ["fr", "de", "it", "es", "en"]){
    await page.evaluate((l) => { LyonI18n.setLang(l); state.lexnote.launch = { busy: false, error: null }; state.lexnote.conn = window.mkState({ state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "CONNECTED" }); state.lexnote.loaded = true; state.planning.selectedEventId = "evt_demo1"; state.tab = "planning"; render(); }, lang);
    const o = await page.evaluate(() => { const b = document.getElementById("cw-lexnote-btn"); const r = b.getBoundingClientRect(); const m = document.querySelector(".cal-modal"); return { over: b.scrollWidth > b.clientWidth + 1, inside: r.right <= window.innerWidth + 1 && r.left >= 0, page: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
    assert(!o.over && o.inside && !o.page, "375 px / " + lang + " : bouton entier visible, aucun débordement " + JSON.stringify(o));
  }
  await page.evaluate(() => LyonI18n.setLang("fr"));

  /* 10. traductions : parité 5 langues */
  const missing = await page.evaluate(() => { const keys = ["btn","connect","opening","checking","unavailable","recheck","hint_ready","hint_connect","error_notfound","error_notlinked","error_rate","error_network","error_session","error_unavailable","error_generic"].map(k => "lnk.launch_" + k); const out = []; ["fr","en","es","de","it"].forEach(l => { LyonI18n.setLang(l); keys.forEach(k => { if(LyonI18n.t(k) === k) out.push(l + ":" + k); }); }); LyonI18n.setLang("fr"); return out; });
  assert(missing.length === 0, "traductions complètes dans les 5 langues, manquant: " + JSON.stringify(missing));

  /* 11. la saisie des notes de REV-EM n'est pas perturbée par la revérification */
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(await S(CONNECTED));
  await page.evaluate(() => { const n = document.getElementById("cw-notes"); n.focus(); n.value = "mes notes perso"; });
  await page.evaluate(() => lnRefreshLaunchBlock());
  assert(await page.evaluate(() => document.getElementById("cw-notes").value === "mes notes perso" && document.activeElement === document.getElementById("cw-notes")), "rafraîchir le bloc LexNote ne touche ni la saisie ni le focus des notes");

  assert(errs.length === 0, "aucune erreur console", errs.join(" | "));
  await b.close();
  let p = 0, f = 0;
  results.forEach(r => { console.log((r.pass ? "PASS" : "FAIL") + " — " + r.l + (r.pass ? "" : "  [" + r.d + "]")); r.pass ? p++ : f++; });
  console.log("\n" + p + "/" + (p + f) + " vérifications passées, " + f + " FAIL");
  process.exit(f === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
