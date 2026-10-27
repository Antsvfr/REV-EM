/* ============================================================================
   REV-EM — « Importer un cours » → sélecteur de fichiers → import, dans un vrai Chromium
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel ; les VRAIS boutons « Importer un cours » (tableau de bord, Mes matières, page d'une
       matière, Ressources, navigation) ; le VRAI sélecteur de fichiers de Chromium (événement `filechooser`) ;
     • un vrai PDF, l'extraction pdf.js réelle, le pipeline d'import, l'enregistrement (localStorage + IndexedDB),
       le rechargement de la page.
   CE QUI EST SIMULÉ, ET POURQUOI
     • « le sélecteur ne s'ouvre pas » : c'est le comportement de WKWebView sur macOS quand l'application n'implémente pas
       webView(_:runOpenPanelWith:…). On le reproduit en neutralisant input.click() et en prenant l'User-Agent de WKWebView.
       Cela vérifie la RÉACTION de la page ; cela ne prouve rien sur REV-EM.app : NOT TESTED WKWEBVIEW.
     • « l'utilisateur annule » : événements blur + cancel envoyés comme le ferait le navigateur.
     • WebLLM indisponible (state.aiStatus = "nogpu") : l'import doit réussir sans IA.
   NOT TESTED : Safari, REV-EM.app (WKWebView), un vrai Mac.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/import-picker.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";
const PDFJS = path.join(ROOT, "node_modules/pdfjs-dist/build");
const WKWEBVIEW_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log(`PASS — ${name}`); } else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
let PDF;
{
  const pg = await browser.newPage();
  const p = (t) => `<p>${t}</p>`;
  await pg.setContent(`<html><body style="font-family:sans-serif;font-size:15px">${[
    "Chapitre 3 — Le marché. Un marché est le lieu de rencontre entre l'offre et la demande d'un bien ou d'un service.",
    "Le prix d'équilibre est celui pour lequel la quantité offerte égale la quantité demandée. Au-dessus, il y a excès d'offre ; en dessous, excès de demande.",
    "La concurrence pure et parfaite suppose l'atomicité des agents, l'homogénéité des produits, la libre entrée, la transparence de l'information et la mobilité des facteurs.",
    "L'élasticité-prix de la demande mesure la sensibilité de la quantité demandée à une variation du prix.",
  ].map(p).join("")}</body></html>`);
  PDF = await pg.pdf({ format: "A4" });
  await pg.close();
}
const PDF_FILE = { name: "Le-marche.pdf", mimeType: "application/pdf", buffer: PDF };

async function open({ ua, viewport } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", userAgent: ua, viewport: viewport || { width: 1280, height: 900 } });
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.min.mjs")) }));
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.worker\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.worker.min.mjs")) }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(APP);
  await page.waitForFunction(() => typeof state !== "undefined" && typeof openImportCenter === "function" && !!window.RevemImport);
  await page.evaluate(() => { state.aiStatus = "nogpu"; state.aiGpuDiag = { message: "WebGPU indisponible." }; });   // WebLLM indisponible : l'import doit réussir quand même
  return { ctx, page };
}
/* Un VRAI clic → le sélecteur doit s'ouvrir dans le même geste. */
async function clickExpectChooser(page, selector) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), page.click(selector)]);
  return chooser;
}
const icState = (p) => p.evaluate(() => ic ? ic.machine.state : null);
const waitIc = (p, st, ms = 10000) => p.waitForFunction((s) => ic && ic.machine.state === s, st, { timeout: ms });
const notice = (p) => p.evaluate(() => { const n = document.querySelector("[data-ic-picker-issue]"); return n ? n.innerText.replace(/\s+/g, " ").trim() : ""; });
/* Import complet après le choix du fichier : « Importer le cours » → écran de confirmation → « Générer » → page du cours. */
async function finishImport(page) {
  await page.click('#import-center [data-ic="primary"]');
  await page.waitForSelector("#import-confirm-generate-btn", { timeout: 30000 });
  await page.click("#import-confirm-generate-btn");
  await page.waitForFunction(() => state.library.view === "chapterDetail" && !!state.library.chapterId, null, { timeout: 30000 });
  return page.evaluate(() => state.library.chapterId);
}

/* ═════════════════════════════════════════════════════════════════════ */
await scenario("1. Chaque bouton « Importer un cours » ouvre DIRECTEMENT le sélecteur de fichiers", async () => {
  const { ctx, page } = await open();
  const entries = [
    ["Tableau de bord (« Que veux-tu faire ? »)", async () => { await page.evaluate(() => switchTab("dashboard")); return '[data-qa="import_course"]'; }],
    ["Mes matières", async () => { await page.evaluate(() => { libGoto("subjects"); switchTab("library"); }); return "#lib-import-course-btn"; }],
    ["Page d'une matière", async () => { await page.evaluate(() => { const s = allSubjects()[0] || null; if (!s) { state.userSubjects.push({ id: "subj_x", name: "Économie", semesterId: SEMESTERS[0].id, builtin: false }); } libGoto("subjectDetail", { subjectId: (s || { id: "subj_x" }).id }); switchTab("library"); }); return "#lib-import-into-subject-btn"; }],
    ["Ressources", async () => { await page.evaluate(() => switchTab("fiches")); return "#resources-import-btn"; }],
  ];
  for (const [label, prep] of entries) {
    const sel = await prep();
    let chooser = null;
    try { chooser = await clickExpectChooser(page, sel); } catch (e) { chooser = null; }
    check(`${label} : un clic ouvre le sélecteur de fichiers`, !!chooser);
    check(`${label} : l'Import Center est là pour recevoir le fichier`, await page.evaluate(() => !!document.getElementById("import-center")));
    check(`${label} : le sélecteur accepte PDF, Word et texte`, chooser && /\.pdf/.test(await page.evaluate(() => document.getElementById("ic-file-input").accept)));
    if (chooser) await chooser.setFiles([]);
    await page.evaluate(() => closeImportCenter());
  }
  /* Menu de navigation (bouton du menu déroulant, même logique centralisée) */
  const navChooser = await (async () => { try { const [c] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), page.evaluate(() => document.querySelector('[data-goto="import-course"]').click())]); return c; } catch (e) { return null; } })();
  check("Navigation « Importer un cours » : ouvre le sélecteur", !!navChooser);
  if (navChooser) await navChooser.setFiles([]);
  await page.evaluate(() => closeImportCenter());
  /* Un appel SANS geste (programmé) n'essaie pas d'ouvrir le sélecteur — le navigateur l'ignorerait en silence. */
  await page.evaluate(() => openImportCenter({ origin: "test", pick: true }));
  check("appel programmé, sans clic : l'Import Center s'ouvre, le bouton « Choisir un fichier » est prêt", await page.evaluate(() => !!document.querySelector('#import-center [data-ic="pick"]') && document.activeElement.getAttribute("data-ic") === "pick"));
  const again = await clickExpectChooser(page, '#import-center [data-ic="pick"]');
  check("« Choisir un fichier » ouvre le sélecteur", !!again);
  await again.setFiles([]);
  eq("un seul champ fichier, identifiant unique", await page.evaluate(() => [document.querySelectorAll("input[type=file]#ic-file-input").length, document.querySelectorAll("#ic-file-input").length]), [1, 1]);
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("2. Tableau de bord → sélecteur → PDF → cours importé et ENREGISTRÉ, sans IA, et toujours là après rechargement", async () => {
  const { ctx, page } = await open();
  const chooser = await clickExpectChooser(page, '[data-qa="import_course"]');
  await chooser.setFiles(PDF_FILE);
  await waitIc(page, "READY");
  check("le fichier choisi est reçu, son nom est affiché", (await page.innerText("#import-center .ic-file-name")) === "Le-marche.pdf");
  check("taille et format affichés", /PDF/.test(await page.innerText("#import-center .ic-file-meta")));
  check("« Remplacer » et « Retirer » sont proposés", !!(await page.$('#import-center [data-ic="replace"]')) && !!(await page.$('#import-center [data-ic="remove"]')));
  const id = await finishImport(page);
  const ch = await page.evaluate((cid) => { const c = findAnyChapter(cid); return { title: c.title, text: (c.originalText || "").length, file: c.sourceFileName, hasPdf: !!c.hasOriginalFile, subject: !!findSubject(c.subjectId) }; }, id);
  check("texte extrait du PDF et conservé", ch.text > 200, ch);
  check("PDF original conservé (IndexedDB)", ch.hasPdf && ch.file === "Le-marche.pdf", ch);
  check("cours rattaché à une matière", ch.subject, ch);
  check("on arrive sur la page du cours importé", await page.evaluate(() => !!document.getElementById("course-hub")));
  await page.reload();
  await page.waitForFunction(() => typeof state !== "undefined" && Array.isArray(state.userChapters));
  check("après rechargement : le cours est toujours enregistré", await page.evaluate((cid) => !!state.userChapters.find(c => c.id === cid && (c.originalText || "").length > 200), id));
  check("après rechargement : le PDF original est toujours là", await page.evaluate(async (cid) => !!(await getCourseFileBlob(cid)), id));
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("3. Depuis une matière : le cours est rattaché à CETTE matière", async () => {
  const { ctx, page } = await open();
  const sid = await page.evaluate(() => { state.userSubjects.push({ id: "subj_eco", name: "Microéconomie", semesterId: SEMESTERS[0].id, builtin: false }); saveUserSubjects(); libGoto("subjectDetail", { subjectId: "subj_eco" }); switchTab("library"); return "subj_eco"; });
  const chooser = await clickExpectChooser(page, "#lib-import-into-subject-btn");
  await chooser.setFiles(PDF_FILE);
  await waitIc(page, "READY");
  const id = await finishImport(page);
  eq("cours enregistré dans la matière d'origine", await page.evaluate((cid) => findAnyChapter(cid).subjectId, id), sid);
  await ctx.close();
});

await scenario("4. Annuler le sélecteur n'est PAS une panne ; le même fichier peut être choisi deux fois", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  /* Annulation réelle : la fenêtre native s'ouvre (la page perd le focus), puis l'utilisateur annule. */
  await page.evaluate(() => { HTMLInputElement.prototype.__click = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function(){ if(this.type !== "file") return this.__click(); window.dispatchEvent(new Event("blur")); setTimeout(() => this.dispatchEvent(new Event("cancel")), 900); }; });
  await page.click('#import-center [data-ic="pick"]');
  await page.waitForTimeout(2200);
  eq("annulation : aucune alerte, la fenêtre reste prête", [await notice(page), await icState(page)], ["", "IDLE"]);
  await page.evaluate(() => { HTMLInputElement.prototype.click = HTMLInputElement.prototype.__click; });
  /* Le même fichier, deux fois de suite */
  let c = await clickExpectChooser(page, '#import-center [data-ic="pick"]');
  await c.setFiles(PDF_FILE); await waitIc(page, "READY");
  await page.click('#import-center [data-ic="remove"]');
  c = await clickExpectChooser(page, '#import-center [data-ic="pick"]');
  await c.setFiles(PDF_FILE); await waitIc(page, "READY");
  check("même fichier choisi une 2e fois : reçu à nouveau", (await page.innerText("#import-center .ic-file-name")) === "Le-marche.pdf");
  c = await clickExpectChooser(page, '#import-center [data-ic="replace"]');
  await c.setFiles(PDF_FILE); await waitIc(page, "READY");
  check("« Remplacer » par le même fichier : reçu", (await page.innerText("#import-center .ic-file-name")) === "Le-marche.pdf");
  /* Fermer / rouvrir : le sélecteur s'ouvre toujours, aucun écouteur ni champ en double */
  await page.evaluate(() => closeImportCenter());
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => switchTab("dashboard"));
    const k = await clickExpectChooser(page, '[data-qa="import_course"]');
    await k.setFiles([]);
    await page.evaluate(() => closeImportCenter());
  }
  check("après 3 ouvertures/fermetures : plus aucun Import Center ni champ fichier orphelin", await page.evaluate(() => !document.getElementById("import-center") && document.querySelectorAll("input[type=file]").length === document.querySelectorAll("input[type=file]:not(#ic-file-input)").length));
  await ctx.close();
});

await scenario("5. Sélecteur qui NE S'OUVRE PAS (comportement de WKWebView sans gestion native) : message clair, solutions qui marchent", async () => {
  const { ctx, page } = await open({ ua: WKWEBVIEW_UA });
  /* WKWebView sans webView(_:runOpenPanelWith:…) : input.click() ne fait rien (variante a), ou annule aussitôt (variante b). */
  await page.evaluate(() => { HTMLInputElement.prototype.__click = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function(){ if(this.type !== "file") return this.__click(); }; });
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await page.click('#import-center [data-ic="pick"]');
  check("tout de suite : pas encore d'alerte (on laisse le temps à la fenêtre de s'ouvrir)", (await notice(page)) === "");
  await page.waitForTimeout(1800);
  const n = await notice(page);
  check("a) rien ne s'ouvre : « Aucune fenêtre de sélection ne s'est ouverte » + solutions", /Aucune fenêtre de sélection/.test(n) && /Glisse ton fichier/.test(n), n);
  check("dans l'app Mac, le message dit qu'une mise à jour de l'application est nécessaire", /application REV-EM pour Mac/.test(n), n);
  check("l'alerte est annoncée (role=alert)", await page.evaluate(() => document.querySelector("[data-ic-picker-issue]").getAttribute("role") === "alert"));
  /* variante b : annulation instantanée */
  await page.evaluate(() => { HTMLInputElement.prototype.click = function(){ if(this.type !== "file") return this.__click(); setTimeout(() => this.dispatchEvent(new Event("cancel")), 5); }; });
  await page.click('#import-center [data-ic="pick"]');
  await page.waitForTimeout(300);
  check("b) annulation instantanée sans fenêtre : même message", /Aucune fenêtre de sélection/.test(await notice(page)));
  /* le glisser-déposer marche, et efface l'alerte */
  await page.evaluate(({ data, name }) => {
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(data)], name, { type: "application/pdf" }));
    const el = document.querySelector("#ic-dialog");
    ["dragenter", "dragover", "drop"].forEach(ph => el.dispatchEvent(new DragEvent(ph, { dataTransfer: dt, bubbles: true, cancelable: true })));
  }, { data: [...PDF], name: "Le-marche.pdf" });
  await waitIc(page, "READY");
  check("glisser-déposer : fichier reçu, alerte effacée", (await notice(page)) === "" && (await page.innerText("#import-center .ic-file-name")) === "Le-marche.pdf");
  const id = await finishImport(page);
  check("… et l'import se termine : cours enregistré", await page.evaluate((cid) => (findAnyChapter(cid).originalText || "").length > 200, id));
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("6. Un navigateur ordinaire n'affiche jamais ce message à tort", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  const c = await clickExpectChooser(page, '#import-center [data-ic="pick"]');
  await page.waitForTimeout(400);
  await c.setFiles(PDF_FILE);
  await waitIc(page, "READY");
  await page.waitForTimeout(1800);
  eq("fichier choisi : aucune alerte", await notice(page), "");
  check("message « app Mac » jamais montré dans Chrome", !(await page.evaluate(() => RevemImport.isEmbeddedWebKit(navigator.userAgent, !!(window.webkit && window.webkit.messageHandlers)))));
  await ctx.close();
});

await scenario("7. Traductions (5 langues) et mobile 375 px", async () => {
  const { ctx, page } = await open({ ua: WKWEBVIEW_UA, viewport: { width: 375, height: 740 } });
  const missing = await page.evaluate(() => { const out = []; ["fr", "en", "es", "de", "it"].forEach(l => { LyonI18n.setLang(l); ["imp.picker.title", "imp.picker.body", "imp.picker.app"].forEach(k => { if (LyonI18n.t(k) === k) out.push(l + ":" + k); }); }); LyonI18n.setLang("fr"); return out; });
  eq("aucune clé manquante", missing, []);
  await page.evaluate(() => { HTMLInputElement.prototype.__click = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function(){ if(this.type !== "file") return this.__click(); }; });
  for (const l of ["fr", "de"]) {
    await page.evaluate((x) => { LyonI18n.setLang(x); if (ic) closeImportCenter(); openImportCenter({ origin: "test" }); }, l);
    await page.click('#import-center [data-ic="pick"]');
    await page.waitForTimeout(1800);
    const o = await page.evaluate(() => { const d = document.getElementById("ic-dialog"), a = document.querySelector("[data-ic-picker-issue]"); return { alert: !!a, over: d.scrollWidth > d.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth + 1, pick: !!document.querySelector('[data-ic="pick"]') }; });
    check(`375 px / ${l} : alerte lisible, sans débordement, « Choisir un fichier » toujours là`, o.alert && !o.over && !o.page && o.pick, o);
  }
  await ctx.close();
});

await browser.close();
console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
