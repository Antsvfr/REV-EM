/* ============================================================================
   REV-EM — branchement RÉEL de « Applications connectées » dans l'interface principale (desktop + mobile)
   Prérequis : python3 -m http.server 9109 ; NODE_PATH=/opt/node22/lib/node_modules node tests/connected-apps-nav.test.js
   Parcours testé, par clics : pastille profil → Mon espace → Paramètres → section « Applications connectées ».
   Remplacé : le client Supabase (double de même forme). Réel : index.html, connected-apps.js, translations.js, auth.js.
   ============================================================================ */
const fs = require("fs");
const { chromium } = require("playwright");
let fail = 0;
function assert(c, l, d){ console.log((c ? "PASS" : "FAIL") + " — " + l + (c ? "" : "  " + (d || ""))); if(!c) fail++; }

/* Statique : ce que GitHub Pages sert. */
const html = fs.readFileSync("index.html", "utf8"), sw = fs.readFileSync("sw.js", "utf8");
assert(/<script src="connected-apps\.js"><\/script>/.test(html), "index.html charge connected-apps.js");
assert(html.indexOf('src="connected-apps.js"') < html.indexOf("function renderConnectedApps"), "le script est chargé avant son utilisation");
assert(/\.\/connected-apps\.js/.test(sw), "sw.js précache connected-apps.js");
assert(/\$\{renderConnectedApps\(\)\}/.test(html), "renderSettings() appelle renderConnectedApps()");

const FAKE = `
window.__invoked = []; window.__reply = { status: { ok: true, state: null } };
window.mkState = (o) => Object.assign({ integrationVersion: "lexnote-revem/v1", kind: "connection-state", partner: "lexnote", state: "NOT_CONNECTED", localStatus: null, peerStatus: "UNKNOWN", verified: false, checkedAt: new Date().toISOString() }, o || {});
window.LyonAuth.available = true; window.LyonAuth.state.status = "signed-in"; window.LyonAuth.state.user = { id: "user-a", email: "a@test.local" };
window.__client = {
  from: function(){ const b = { select(){return b;}, eq(){return b;}, order(){return b;}, limit(){return b;}, in(){return b;}, maybeSingle(){return b;}, then(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return b; },
  functions: { invoke: async function(fn, o){
    window.__invoked.push({ fn: fn, body: o && o.body }); try{ sessionStorage.setItem('__inv', JSON.stringify(window.__invoked)); }catch(e){}
    const r = window.__reply[o.body.action];
    if(r && r.httpStatus) return { data: null, error: { context: { status: r.httpStatus, json: async () => { throw new Error("html"); } } } };
    if(r && r.error) return { data: null, error: { context: { status: 400, json: async () => ({ ok: false, error: { code: r.error } }) } } };
    return { data: r || { ok: true }, error: null };
  }},
};
Object.defineProperty(window.LyonAuth, "client", { get: function(){ return window.__client; }, configurable: true });
`;
const txt = (page) => page.evaluate(() => document.querySelector("#connected-apps").textContent.replace(/\s+/g, " ").trim());

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  for (const [name, vp] of [["desktop", { width: 1280, height: 800 }], ["mobile", { width: 390, height: 780 }]]) {
    const ctx = await b.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    const nav = [];
    await ctx.route("https://lexnote.example.app/**", r => { nav.push(r.request().url()); r.fulfill({ status: 200, contentType: "text/html", body: "<html>LexNote</html>" }); });
    await page.goto("http://localhost:9109/index.html");
    await page.waitForTimeout(1500);
    assert(await page.evaluate(() => typeof window.RevemLinks === "object" && typeof RevemLinks.describe === "function"), `[${name}] RevemLinks chargé par index.html`);
    await page.evaluate(FAKE);
    await page.evaluate(() => { window.__reply.status = { ok: true, state: window.mkState({}) }; render(); });

    /* Parcours par clics réels */
    await page.click("#profile-chip-btn");
    await page.waitForSelector("#myspace-settings-btn", { timeout: 4000 });
    await page.click("#myspace-settings-btn");
    await page.waitForSelector("#connected-apps", { timeout: 4000 });
    await page.waitForFunction(() => state.lexnote && state.lexnote.loaded === true, null, { timeout: 4000 });
    await page.waitForTimeout(150);
    let t = await txt(page);
    assert(/Applications connectées/.test(t) && /LexNote/.test(t), `[${name}] section « Applications connectées » + carte LexNote dans Paramètres`);
    assert(t.includes("Connectez LexNote pour ouvrir vos cours et vos notes directement depuis REV-EM."), `[${name}] description de la carte`);
    assert(/Non connecté/.test(t) && !!(await page.$("#lnk-connect-btn")) && !!(await page.$("#lnk-verify-btn")), `[${name}] Non connecté + Connecter + Vérifier`);
    assert(await page.evaluate(() => { const e = document.querySelector("#connected-apps"); const r = e.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; }), `[${name}] pas de débordement horizontal`);
    assert(await page.evaluate(() => window.__invoked.some(x => x.fn === "integration-link" && x.body.action === "status" && x.body.probe === true)), `[${name}] vérification serveur réelle à l'ouverture`);

    /* Connecter : start → URL validée → navigation vers LexNote, aucun secret dans la requête */
    await page.evaluate(() => { window.__invoked = []; window.__reply.start = { ok: true, confirmUrl: "https://lexnote.example.app/integrations/revem/connect?intent=abc#n=nonce123" }; });
    await page.click("#lnk-connect-btn");
    await page.waitForFunction(() => 1, null, { timeout: 4000 });
    for (let i = 0; i < 40 && !nav.length; i++) await page.waitForTimeout(100);
    assert(nav.some(u => u.startsWith("https://lexnote.example.app/integrations/revem/connect?intent=abc")), `[${name}] Connecter ouvre LexNote avec l'intention`, JSON.stringify(nav));
    await page.goto("http://localhost:9109/index.html"); await page.waitForTimeout(1200);
    const inv = await page.evaluate(() => sessionStorage.getItem("__inv") || "");
    assert(inv.includes('"start"') && !inv.includes("nonce123"), `[${name}] start appelé ; aucun nonce envoyé au serveur`, inv);
    await page.evaluate(FAKE);
    await page.evaluate(() => { state.tab = "settings"; render(); });

    /* États */
    const show = async (reply, check) => {
      await page.evaluate((r) => { window.__reply.status = r; state.lexnote = { conn: null, error: null, busy: null, loaded: false, toast: null }; state.tab = "settings"; render(); }, reply);
      await page.waitForFunction(() => state.lexnote.loaded === true, null, { timeout: 4000 });
      await page.waitForTimeout(120);
      return txt(page);
    };
    const S = (o) => page.evaluate((o) => ({ ok: true, state: window.mkState(o) }), o);
    t = await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: true, peerStatus: "CONNECTED", linkedAt: "2026-10-08T10:00:00Z" }));
    assert(/✓ Connecté/.test(t) && !!(await page.$("#lnk-disconnect-btn")), `[${name}] Connecté (vérifié des deux côtés) + Déconnecter`);
    t = await show(await S({ state: "CONNECTED", localStatus: "CONNECTED", verified: false }));
    assert(!/✓ Connecté/.test(t) && /Connexion en cours/.test(t), `[${name}] CONNECTED non vérifié → Connexion en cours`);
    t = await show(await S({ state: "REVOKED", revokedBy: "partner", revokedAt: "2026-10-09T08:00:00Z" }));
    assert(/Connexion révoquée/.test(t), `[${name}] Connexion révoquée`);
    t = await show(await S({ state: "ERROR", errorCode: "PEER_UNREACHABLE" }));
    assert(/LexNote indisponible/.test(t) && !/PEER_|Error:/.test(t), `[${name}] LexNote indisponible`, t);
    t = await show({ error: "INTERNAL" });
    assert(/Erreur de configuration/.test(t) && !/INTERNAL/.test(t), `[${name}] Erreur de configuration`, t);
    t = await show({ httpStatus: 404 });
    assert(/Erreur de configuration/.test(t), `[${name}] fonction non déployée (404) → Erreur de configuration`, t);
    t = await show({ error: "INTENT_EXPIRED" });
    assert(/expiré/.test(t) && !/INTENT_/.test(t), `[${name}] intention expirée : message propre`, t);
    t = await show({ error: "INTENT_USED" });
    assert(/déjà été utilisée/.test(t), `[${name}] intention déjà utilisée : message propre`, t);
    t = await show({ error: "CONFLICT" });
    assert(/déjà connecté/.test(t), `[${name}] lien déjà existant : message propre`, t);
    assert(errs.length === 0, `[${name}] aucune erreur JS`, errs.join("|"));

    /* Retour ?lexnote_link=connected : URL seule ≠ Connecté */
    await page.goto("http://localhost:9109/index.html?lexnote_link=connected&x=1"); await page.waitForTimeout(300);
    await page.evaluate(FAKE);
    await page.evaluate(() => { window.__reply.status = { ok: true, state: window.mkState({}) }; });
    await page.evaluate(() => { lnHandleReturn(); });
    await page.waitForFunction(() => state.lexnote && state.lexnote.loaded === true, null, { timeout: 4000 });
    await page.waitForTimeout(200);
    t = await txt(page);
    assert(!/✓ Connecté/.test(t) && /Non connecté/.test(t), `[${name}] paramètre d'URL seul : jamais Connecté`, t);
    assert(await page.evaluate(() => location.search === "?x=1"), `[${name}] paramètre retiré de l'URL`);
    await ctx.close();
  }
  await b.close();
  console.log(fail ? `\n${fail} ÉCHEC(S)` : "\nTout est passé.");
  process.exit(fail ? 1 : 0);
})();
