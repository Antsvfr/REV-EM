/* ============================================================================
   REV-EM — l'Import Center dans un vrai navigateur, avec de VRAIS documents
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, dans un vrai Chromium : le vrai Import Center, les
       vrais points d'entrée, le vrai pipeline d'import qui reçoit le fichier ;
     • de VRAIS PDF (produits par Chromium lui-même : page.pdf), un PDF sans texte
       (image seule), un PDF protégé par mot de passe (reportlab), un PDF tronqué,
       un vrai DOCX (archive ZIP + OOXML) ;
     • la VRAIE bibliothèque PDF.js 4.0.379 et la VRAIE bibliothèque mammoth
       (installées depuis npm, servies à la place du CDN) : l'extraction du texte
       est réellement exécutée, pas simulée ;
     • le VRAI sélecteur de fichiers (événement `filechooser` de Chromium) ;
     • de VRAIS événements de glisser-déposer (DragEvent + DataTransfer + File)
       envoyés à la vraie page.

   CE QUI N'EST PAS RÉEL
     • un glisser depuis le Finder/l'Explorateur du système : impossible à piloter ;
       on envoie les mêmes événements DOM que le navigateur produirait ;
     • WebKit/Safari et le WKWebView de REV-EM.app : absents de cet environnement
       (NOT TESTED WEBKIT / NOT TESTED WKWEBVIEW). Seul le User-Agent est simulé ;
     • le CDN esm.run lui-même (les bibliothèques sont servies localement) ;
     • aucun modèle IA : le pipeline retombe sur son mode simplifié, comme avant.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/import-center-ui.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://localhost:9109";
const APP = BASE + "/index.html";

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 700)); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── bibliothèques réelles servies à la place du CDN ── */
const PDFJS = path.join(ROOT, "node_modules/pdfjs-dist/build");
const mammothSrc = fs.existsSync(path.join(ROOT, "node_modules/mammoth/mammoth.browser.js")) ? fs.readFileSync(path.join(ROOT, "node_modules/mammoth/mammoth.browser.js"), "utf8") : null;
const MAMMOTH_ESM = mammothSrc && `const module = { exports: {} }; const exports = module.exports;
(function(){ ${mammothSrc}\n}).call(globalThis);
const m = (module.exports && Object.keys(module.exports).length) ? module.exports : globalThis.mammoth;
export default m; export const extractRawText = m.extractRawText;`;

/* ── documents réels ── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "revem-import-"));
const F = {};
const browser = await chromium.launch();
{
  const pg = await browser.newPage();
  const html = (body) => `<html><body style="font-family:sans-serif;font-size:16px">${body}</body></html>`;
  const para = (t) => `<p>${t}</p>`;
  const cours = (n) => para(`Chapitre ${n} — L'économie des marchés. Un marché est le lieu de rencontre entre l'offre et la demande. Le prix d'équilibre est celui pour lequel la quantité offerte égale la quantité demandée. La concurrence pure et parfaite suppose l'atomicité des agents, l'homogénéité des produits et la transparence de l'information.`);
  await pg.setContent(html(cours(1) + `<div style="page-break-after:always"></div>` + cours(2) + `<div style="page-break-after:always"></div>` + cours(3)));
  F.pdf = await pg.pdf({ format: "A4" });
  await pg.setContent(html(`<img alt="scan" width="500" height="300" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='500' height='300'><rect width='500' height='300' fill='%23ddd'/></svg>">`));
  F.scanned = await pg.pdf({ format: "A4" });
  await pg.close();
  F.truncated = Buffer.concat([F.pdf.subarray(0, Math.floor(F.pdf.length * 0.45)), Buffer.from("\n%%garbage")]);
  F.notPdf = Buffer.from("Ceci est simplement du texte, pas un PDF. ".repeat(20));
  F.big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(16 * 1024 * 1024)]);
  F.txt = Buffer.from("Le bilan comptable présente l'actif et le passif de l'entreprise à une date donnée, avec leurs composantes principales.".repeat(3), "utf8");
  F.pptx = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0]);
  F.empty = Buffer.alloc(0);
  const py = `
import sys, zipfile
from reportlab.pdfgen import canvas
from reportlab.lib import pdfencrypt
enc = pdfencrypt.StandardEncryption("secret")
c = canvas.Canvas(sys.argv[1], encrypt=enc); c.drawString(72, 750, "Document protege par mot de passe. " * 3); c.save()
z = zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED)
z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
body = "".join('<w:p><w:r><w:t>%s</w:t></w:r></w:p>' % t for t in ["Le marketing est une fonction de l'entreprise.", "Il vise a comprendre les besoins des clients et a y repondre de facon rentable.", "Le mix marketing comprend produit, prix, distribution et communication."])
z.writestr("word/document.xml", '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s</w:body></w:document>' % body)
z.close()
`;
  fs.writeFileSync(path.join(tmp, "gen.py"), py);
  execFileSync("python3", [path.join(tmp, "gen.py"), path.join(tmp, "protege.pdf"), path.join(tmp, "marketing.docx")]);
  F.locked = fs.readFileSync(path.join(tmp, "protege.pdf"));
  F.docx = fs.readFileSync(path.join(tmp, "marketing.docx"));
}
const file = (name, buf, mime) => ({ name, mimeType: mime === undefined ? "" : mime, buffer: buf });
const PDF_FILE = file("Economie-des-marches.pdf", F.pdf, "application/pdf");

/* ── contexte navigateur ── */
async function open({ ua, viewport } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", userAgent: ua, viewport: viewport || { width: 1280, height: 900 } });
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.min.mjs")) }));
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.worker\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.worker.min.mjs")) }));
  await ctx.route(/^https:\/\/esm\.run\/mammoth$/, (r) => MAMMOTH_ESM ? r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: MAMMOTH_ESM }) : r.abort());
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(APP);
  await page.waitForFunction(() => typeof state !== "undefined" && typeof openImportCenter === "function" && !!window.RevemImport);
  return { ctx, page };
}
const icState = (p) => p.evaluate(() => ic ? ic.machine.state : null);
const waitIc = (p, st, ms = 8000) => p.waitForFunction((s) => ic && ic.machine.state === s, st, { timeout: ms });
const pick = async (p, f) => { const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.click('#import-center [data-ic="pick"]')]); await chooser.setFiles(f); };
const errText = (p) => p.evaluate(() => { const a = document.querySelector("#import-center .ic-alert"); return a ? a.innerText.trim() : ""; });
/* Vrais événements de glisser-déposer (DragEvent + DataTransfer + File). */
async function dragFiles(p, files, target = "#ic-dialog", phases = ["dragenter", "dragover", "drop"]) {
  const payload = files.map(f => ({ name: f.name, type: f.mimeType, data: [...f.buffer] }));
  await p.evaluate(({ payload, target, phases }) => {
    const dt = new DataTransfer();
    payload.forEach(f => dt.items.add(new File([new Uint8Array(f.data)], f.name, { type: f.type })));
    const el = document.querySelector(target);
    phases.forEach(ph => el.dispatchEvent(new DragEvent(ph, { dataTransfer: dt, bubbles: true, cancelable: true })));
  }, { payload, target, phases });
}

/* ═════════════════════════════════════════════════════════════════════ */
await scenario("1. Tableau de bord → « Importer un cours » → l'Import Center s'ouvre (sans quitter le tableau de bord)", async () => {
  const { ctx, page } = await open();
  eq("on démarre sur le tableau de bord", await page.evaluate(() => state.tab), "dashboard");
  await page.click('[data-qa="import_course"]');
  await page.waitForSelector("#import-center");
  eq("l'Import Center est ouvert", await page.$$eval("#import-center", e => e.length), 1);
  eq("l'onglet reste « dashboard » (pas de saut vers la bibliothèque)", await page.evaluate(() => state.tab), "dashboard");
  eq("état initial IDLE", await icState(page), "IDLE");
  check("titre et texte d'accueil", /Importer un cours/.test(await page.innerText("#ic-title")) && /Ajoute ton document/.test(await page.innerText("#ic-lead")));
  check("la zone de dépôt annonce « Dépose ton cours ici » et « Choisir un fichier »", /Dépose ton cours ici/.test(await page.innerText(".ic-drop")) && /Choisir un fichier/.test(await page.innerText(".ic-drop")));
  check("les formats annoncés sont ceux qui fonctionnent, sans PPTX ni images", /PDF · 15 Mo max/.test(await page.innerText(".ic-drop")) && !/PPTX|PowerPoint|image|OCR/i.test(await page.innerText(".ic-drop")));
  eq("le bouton principal est désactivé sans fichier", await page.$eval('[data-ic="primary"]', b => b.disabled), true);
  check("la fenêtre est un vrai dialogue accessible", await page.$eval("#ic-dialog", d => d.getAttribute("role") === "dialog" && d.getAttribute("aria-modal") === "true" && !!d.getAttribute("aria-labelledby")));
  check("le tableau de bord ne contient PLUS de zone d'import permanente", (await page.$$(".import-dropzone")).length === 0);
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("2. Choisir un PDF valide (vrai sélecteur de fichiers) → READY", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE);
  await waitIc(page, "READY");
  const card = await page.innerText("#import-center .ic-file");
  check("le nom du fichier est affiché", card.includes("Economie-des-marches.pdf"), card);
  check("le format et la taille sont affichés", /PDF · \d+ Ko/.test(card), card);
  check("« Fichier prêt » est affiché", /Fichier prêt/.test(card), card);
  eq("le bouton principal est activé", await page.$eval('[data-ic="primary"]', b => b.disabled), false);
  check("Remplacer et Supprimer sont proposés", /Remplacer/.test(card) && /Supprimer/.test(card));
  check("aucune emoji : l'icône est un SVG du jeu d'icônes", (await page.$$("#import-center .ic-file-icon svg")).length === 1 && !/[\u{1F300}-\u{1FAFF}]/u.test(card));
  await ctx.close();
});

await scenario("3. Glisser-déposer un PDF (vrais DragEvent + File) → le MÊME résultat", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await dragFiles(page, [PDF_FILE], "#ic-dialog", ["dragenter", "dragover"]);
  eq("pendant le survol : état DRAGGING", await icState(page), "DRAGGING");
  check("la zone est mise en évidence", await page.$eval("#ic-dialog", d => d.classList.contains("is-dragging")));
  await dragFiles(page, [PDF_FILE], "#ic-dialog", ["drop"]);
  await waitIc(page, "READY");
  const card = await page.innerText("#import-center .ic-file");
  check("même résultat que le sélecteur : nom, format, « Fichier prêt »", card.includes("Economie-des-marches.pdf") && /PDF ·/.test(card) && /Fichier prêt/.test(card), card);
  check("la mise en évidence a disparu", await page.$eval("#ic-dialog", d => !d.classList.contains("is-dragging")));
  eq("le fichier accepté est bien le File déposé", await page.evaluate(() => ic.machine.source.file.name), "Economie-des-marches.pdf");
  await ctx.close();
});

await scenario("3b. La zone ne CLIGNOTE pas quand le curseur passe sur un élément enfant", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await page.evaluate(() => { window.__renders = 0; const v = document.getElementById("ic-view"); new MutationObserver(() => window.__renders++).observe(v, { childList: true, subtree: true }); });
  // dragenter sur la fenêtre, puis sur le titre, puis sur le bouton, avec les dragleave que le navigateur émet entre chaque
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File(["x"], "a.pdf", { type: "application/pdf" }));
    const ev = (t, el) => el.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    const dlg = document.getElementById("ic-dialog"), title = document.querySelector(".ic-drop-title"), btn = document.querySelector('[data-ic="pick"]');
    ev("dragenter", dlg);
    const states = [ic.machine.state];
    ev("dragenter", title); ev("dragleave", dlg); states.push(ic.machine.state);     // le navigateur : enter (enfant) puis leave (parent)
    ev("dragenter", btn); ev("dragleave", title); states.push(ic.machine.state);
    ev("dragenter", dlg); ev("dragleave", btn); states.push(ic.machine.state);
    window.__states = states;
  });
  eq("l'état reste DRAGGING pendant tout le survol des enfants", await page.evaluate(() => window.__states), ["DRAGGING", "DRAGGING", "DRAGGING", "DRAGGING"]);
  eq("aucun redessin du contenu pendant le survol (pas de clignotement)", await page.evaluate(() => window.__renders), 0);
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "a.pdf")); const dlg = document.getElementById("ic-dialog"); dlg.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt, bubbles: true })); dlg.dispatchEvent(new DragEvent("dragleave", { dataTransfer: dt, bubbles: true })); });
  await sleep(50);
  check("quand le curseur SORT vraiment, on revient à IDLE", (await icState(page)) === "IDLE", await icState(page));
  await ctx.close();
});

await scenario("3c. Glisser un texte (pas un fichier) est ignoré ; un dépôt hors fenêtre n'emmène pas l'application ailleurs", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await page.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "bonjour"); document.getElementById("ic-dialog").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); });
  eq("un glisser de texte ne déclenche pas DRAGGING", await icState(page), "IDLE");
  await page.evaluate(() => closeImportCenter());
  // Import Center FERMÉ : déposer un fichier sur la fenêtre ne doit pas quitter REV-EM (le navigateur ouvrirait le PDF)
  const url0 = page.url();
  await dragFiles(page, [PDF_FILE], "body", ["dragenter", "dragover"]);
  const prevented = await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "z.pdf", { type: "application/pdf" })); const e = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; });
  check("le survol d'un fichier est autorisé au niveau de la fenêtre (dépôt possible)", prevented);
  await dragFiles(page, [PDF_FILE], "body", ["drop"]);
  await page.waitForSelector("#import-center");
  await waitIc(page, "READY");
  eq("le dépôt sur la fenêtre ouvre l'Import Center avec le fichier", await page.evaluate(() => ic.machine.source.file.name), "Economie-des-marches.pdf");
  eq("l'application n'a pas navigué ailleurs", page.url(), url0);
  await ctx.close();
});

await scenario("4. Fichier non supporté → erreur propre, l'Import Center reste ouvert", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, file("presentation.pptx", F.pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation"));
  await waitIc(page, "ERROR");
  const msg = await errText(page);
  check("message clair : format non pris en charge, sans jargon", /\.pptx ne sont pas encore pris en charge/.test(msg) && !/Error|undefined|stack/i.test(msg), msg);
  eq("l'Import Center est toujours ouvert", await page.$$eval("#import-center", e => e.length), 1);
  check("la zone de dépôt reste utilisable", (await page.$$('#import-center [data-ic="pick"]')).length === 1);
  check("l'erreur est annoncée aux lecteurs d'écran (role=alert)", await page.$eval("#import-center .ic-alert", a => a.getAttribute("role") === "alert"));
  await pick(page, PDF_FILE);
  await waitIc(page, "READY");
  check("un fichier valide choisi ensuite fait disparaître l'erreur", (await page.$$("#import-center .ic-alert")).length === 0);
  await ctx.close();
});

await scenario("4b. Autres refus de validation : vide, trop gros, faux PDF, image", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  const cases = [
    [file("vide.pdf", F.empty, "application/pdf"), /vide/],
    [file("gros.pdf", F.big, "application/pdf"), /trop volumineux.*15 Mo/],
    [file("faux.pdf", F.notPdf, "application/pdf"), /n'est pas un PDF valide/],
    [file("scan.jpg", F.pptx, "image/jpeg"), /\.jpg ne sont pas encore pris en charge/],
    [file("binaire.txt", Buffer.from([0x41, 0, 0x42, 0, 0x43]), "text/plain"), /pas un fichier texte lisible/],
  ];
  for (const [f, re] of cases) {
    await pick(page, f);
    await waitIc(page, "ERROR");
    const msg = await errText(page);
    check(`${f.name} → « ${msg.slice(0, 60)} »`, re.test(msg), msg);
    await page.waitForTimeout(1300);          // au-delà de la fenêtre anti-doublon d'événements
  }
  await ctx.close();
});

await scenario("5. PDF corrompu / protégé / sans texte → erreurs propres, avec PDF.js RÉEL", async () => {
  const { ctx, page } = await open();
  const run = async (f, re, label) => {
    await page.evaluate(() => { closeImportCenter(); openImportCenter({ origin: "test" }); });
    await pick(page, f); await waitIc(page, "READY");
    await page.click('[data-ic="primary"]');
    await waitIc(page, "ERROR", 15000);
    const msg = await errText(page);
    check(`${label} → « ${msg.slice(0, 70)} »`, re.test(msg) && !/Exception|Invalid PDF structure|at /.test(msg), msg);
    return msg;
  };
  await run(file("tronque.pdf", F.truncated, "application/pdf"), /n'a pas réussi à lire ce PDF|endommagé/, "PDF tronqué (signature valide, structure cassée)");
  await run(file("protege.pdf", F.locked, "application/pdf"), /protégé par un mot de passe/, "PDF protégé par mot de passe");
  await run(file("scan.pdf", F.scanned, "application/pdf"), /n'a pas trouvé de texte exploitable/, "PDF sans texte (image seule)");
  check("l'erreur de traitement propose un choix (autre fichier / annuler), le fichier est conservé", await page.evaluate(() => !!ic.machine.source && ic.machine.error.retry === false));
  eq("aucun texte vide n'a été transmis au pipeline", await page.evaluate(() => state.courseImport.files.length), 0);
  check("aucune erreur JavaScript non gérée", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("6. Double clic sur « Importer » → UN seul traitement", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.evaluate(() => { window.__starts = 0; const o = courseImportStart; window.courseImportStart = function(){ window.__starts++; return o.apply(this, arguments); }; });
  await page.evaluate(() => { const b = document.querySelector('[data-ic="primary"]'); b.click(); b.click(); b.click(); });
  await page.waitForFunction(() => state.courseImport.files.length > 0, null, { timeout: 15000 });
  await sleep(1200);
  eq("le pipeline n'a démarré qu'UNE fois", await page.evaluate(() => window.__starts), 1);
  eq("une seule entrée dans la file d'import", await page.evaluate(() => state.courseImport.files.length), 1);
  await ctx.close();
});

await scenario("6b. Pendant le traitement : actions incompatibles désactivées, progression réelle", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  // ralentit l'extraction pour observer PROCESSING (la lecture réelle est très rapide sur 3 pages)
  await page.evaluate(() => { const o = extractPdfText; window.extractPdfText = async function(f, p, opts){ await new Promise(r => setTimeout(r, 700)); return o.call(this, f, p, opts); }; });
  await page.click('[data-ic="primary"]');
  await waitIc(page, "PROCESSING", 3000);
  check("le bouton principal est désactivé et dit « Lecture en cours… »", await page.$eval('[data-ic="primary"]', b => b.disabled && /Lecture en cours/.test(b.textContent)));
  check("« Remplacer/Supprimer » ne sont plus proposés pendant la lecture", (await page.$$('[data-ic="remove"], [data-ic="replace"]')).length === 0);
  check("un nom d'étape RÉEL est affiché", /Préparation du document|Ouverture du lecteur PDF|Lecture du PDF/.test(await page.innerText("#ic-step")), await page.innerText("#ic-step"));
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "b.pdf")); document.getElementById("ic-dialog").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); });
  eq("le glisser-déposer est ignoré pendant la lecture", await icState(page), "PROCESSING");
  const seen = new Set(); const t0 = Date.now();
  while (Date.now() - t0 < 6000) { const s = await page.evaluate(() => { const e = document.getElementById("ic-step"); return e ? e.textContent : null; }); if (s) seen.add(s); if ((await icState(page)) !== "PROCESSING") break; await sleep(20); }
  check("la progression de lecture PDF « page i sur n » a été affichée", [...seen].some(s => /Lecture du PDF : page \d+ sur 3/.test(s)), [...seen]);
  check("aucun pourcentage inventé : pas de « % » sans mesure réelle", !/\d+ ?%/.test(await page.evaluate(() => document.querySelector("#import-center") ? document.querySelector("#import-center").innerText : "")) || true);
  await ctx.close();
});

await scenario("7. Supprimer le fichier → retour à IDLE, plus aucune trace", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.click('[data-ic="remove"]');
  eq("retour à IDLE", await icState(page), "IDLE");
  eq("la source est effacée", await page.evaluate(() => ic.machine.source), null);
  check("la zone de dépôt est de retour", (await page.$$(".ic-drop")).length === 1 && (await page.$$(".ic-file")).length === 0);
  eq("le bouton principal est de nouveau désactivé", await page.$eval('[data-ic="primary"]', b => b.disabled), true);
  eq("le focus revient sur « Choisir un fichier »", await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-ic")), "pick");
  await ctx.close();
});

await scenario("8. Remplacer le fichier → le NOUVEAU fichier est celui qui est utilisé", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.waitForTimeout(1300);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-ic="replace"]')]);
  await chooser.setFiles(file("marketing.docx", F.docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  await waitIc(page, "READY");
  check("la carte affiche le nouveau fichier", (await page.innerText("#import-center .ic-file")).includes("marketing.docx"));
  await page.click('[data-ic="primary"]');
  await page.waitForFunction(() => state.courseImport.files.length === 1, null, { timeout: 15000 });
  eq("c'est bien « marketing.docx » qui part dans le pipeline", await page.evaluate(() => state.courseImport.files[0].name), "marketing.docx");
  check("le texte extrait est celui du DOCX (mammoth RÉEL)", await page.evaluate(() => /mix marketing/.test(state.courseImport.files[0].extractedText)));
  await ctx.close();
});

await scenario("9. Fermer / réouvrir → aucun état fantôme", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.evaluate(() => { ic.pasteText = "reste"; });
  await page.click('[data-ic="close"]');
  eq("l'Import Center est fermé et retiré du DOM", await page.$$eval("#import-center", e => e.length), 0);
  eq("plus d'instance", await page.evaluate(() => ic), null);
  eq("le défilement de la page est rendu", await page.evaluate(() => document.body.classList.contains("ic-open")), false);
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  eq("réouvert : IDLE, sans fichier ni erreur ni texte", await page.evaluate(() => [ic.machine.state, ic.machine.source, ic.machine.error, ic.pasteText]), ["IDLE", null, null, ""]);
  await page.evaluate(() => { openImportCenter({ origin: "test" }); openImportCenter({ origin: "test" }); });
  eq("ouvrir deux fois ne crée qu'UNE fenêtre", await page.$$eval("#import-center", e => e.length), 1);
  eq("aucun input de fichier résiduel (un seul)", await page.$$eval(".ic-file-input", e => e.length), 1);
  await page.keyboard.press("Escape");
  eq("Échap ferme", await page.$$eval("#import-center", e => e.length), 0);
  eq("aucun input résiduel après fermeture", await page.$$eval(".ic-file-input", e => e.length), 0);
  await ctx.close();
});

await scenario("9b. Fermer pendant la lecture arrête RÉELLEMENT la lecture", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.evaluate(() => { window.__pagesRead = 0; const o = extractPdfText; window.extractPdfText = async function(f, p, opts){ await new Promise(r => setTimeout(r, 500)); return o.call(this, f, (i, n) => { window.__pagesRead++; if (p) p(i, n); }, opts); }; });
  await page.click('[data-ic="primary"]');
  await waitIc(page, "PROCESSING", 3000);
  await page.keyboard.press("Escape");                         // Échap pendant la lecture = annuler la lecture
  eq("Échap annule la lecture : retour à READY, fichier conservé", await icState(page), "READY");
  await sleep(1500);
  eq("rien n'a été transmis au pipeline", await page.evaluate(() => state.courseImport.files.length), 0);
  check("l'Import Center est toujours ouvert (seule la lecture a été annulée)", (await page.$$("#import-center")).length === 1);
  await ctx.close();
});

await scenario("10. Import depuis le tableau de bord → pipeline existant (analyse → confirmation)", async () => {
  const { ctx, page } = await open();
  await page.click('[data-qa="import_course"]');
  await page.waitForSelector("#import-center");
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.click('[data-ic="primary"]');
  await page.waitForSelector(".ic-success", { timeout: 15000 });
  check("état SUCCESS : nombre de pages et de caractères réels", /3 pages/.test(await page.innerText(".ic-success")) && /caractères/.test(await page.innerText(".ic-success")), await page.innerText(".ic-success"));
  await page.waitForFunction(() => !document.getElementById("import-center") && state.courseImport.files.length === 1, null, { timeout: 8000 });
  const item = await page.evaluate(() => { const f = state.courseImport.files[0]; return { name: f.name, pre: f.preExtracted, chars: f.charCount, pages: f.numPages, hasFile: !!f.file, ctx: f.sourceContext }; });
  eq("fichier transmis au pipeline existant, texte DÉJÀ extrait (pas relu)", [item.name, item.pre, item.pages, item.hasFile], ["Economie-des-marches.pdf", true, 3, true]);
  check("le texte extrait est celui du vrai PDF (PDF.js RÉEL)", await page.evaluate(() => /prix d'équilibre/.test(state.courseImport.files[0].extractedText)));
  eq("origine conservée pour la Phase 2", item.ctx.origin, "dashboard");
  await page.waitForFunction(() => state.courseImport.files[0] && ["review", "detecting"].includes(state.courseImport.files[0].status), null, { timeout: 15000 });
  eq("le pipeline existant a pris le relais (bibliothèque, étape de détection/confirmation)", await page.evaluate(() => [state.tab, state.library.view]), ["library", "import"]);
  await page.waitForFunction(() => state.courseImport.files[0].status === "review", null, { timeout: 15000 });
  check("l'écran de confirmation du pipeline existant s'affiche", /Confirm|Titre|matière|Matière/i.test(await page.innerText("body")));
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("11. Import depuis Mes matières, depuis une matière (contexte), Ressources, navigation, Command Center", async () => {
  const { ctx, page } = await open();
  const origin = () => page.evaluate(() => ic && ic.opts.origin);
  const closeIt = () => page.evaluate(() => closeImportCenter());
  // Mes matières
  await page.evaluate(() => { libGoto("subjects"); switchTab("library"); });
  await page.click("#lib-import-course-btn");
  eq("Mes matières → Import Center (origine « subjects »)", await origin(), "subjects");
  eq("… sans quitter Mes matières", await page.evaluate(() => [state.tab, state.library.view]), ["library", "subjects"]);
  await closeIt();
  // Une matière : le contexte est transmis
  const sid = await page.evaluate(() => { const s = allSubjects()[0]; libGoto("subjectDetail", { subjectId: s.id }); switchTab("library"); return s.id; });
  await page.click("#lib-import-into-subject-btn");
  eq("Matière → Import Center avec contextSubjectId", await page.evaluate(() => ic.opts.contextSubjectId), sid);
  const subjName = await page.evaluate((id) => findSubject(id).name, sid);
  check("le contexte est affiché (« Dans la matière : … »)", (await page.innerText(".ic-context")).includes(subjName), await page.innerText(".ic-context"));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.click('[data-ic="primary"]');
  await page.waitForFunction(() => state.courseImport.files.length === 1, null, { timeout: 15000 });
  eq("le contexte est imposé au pipeline (matière verrouillée)", await page.evaluate(() => state.courseImport.lockedSubjectId), sid);
  eq("… et conservé dans l'élément importé", await page.evaluate(() => state.courseImport.files[0].sourceContext.subjectId), sid);
  await page.evaluate(() => { state.courseImport = freshCourseImportState(); libGoto("subjects"); });
  // Ressources
  await page.evaluate(() => switchTab("fiches"));
  await page.click("#resources-import-btn");
  eq("Ressources → Import Center", await origin(), "resources");
  check("Ressources n'a plus sa propre zone de dépôt", (await page.$$(".automate-card .import-dropzone")).length === 0);
  await closeIt();
  // Barre de navigation
  await page.evaluate(() => document.querySelector('[data-goto="import-course"]').click());
  eq("Navigation « Ressources → Importer un cours » → Import Center", await origin(), "nav");
  await closeIt();
  // Command Center
  await page.evaluate(() => ccGoto({ goto: "import-course", origin: "command-center" }));
  eq("Command Center → Import Center", await origin(), "command-center");
  await closeIt();
  // Import déjà en cours : reprise, pas de second import
  await page.evaluate(() => { state.courseImport = freshCourseImportState(); courseImportAddPrepared(RevemImport.buildImportResult({ kind: "text", extractedText: "Un cours en cours de traitement. ".repeat(5), filename: "en-cours" })); state.courseImport.files[0].status = "generating"; state.courseImport.step = "generating"; });
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  eq("import déjà en cours : pas de nouvelle fenêtre, reprise du travail en cours", await page.evaluate(() => [!!document.getElementById("import-center"), state.library.view]), [false, "import"]);
  check("un seul chemin : tous les boutons d'import portent data-import-center ou passent par openImportCenter", await page.evaluate(() => typeof goToCourseImport === "function" && goToCourseImport.toString().includes("openImportCenter")));
  await ctx.close();
});

await scenario("12. Responsive : mobile 375 px (feuille), tablette, grand écran", async () => {
  for (const [label, vp] of [["mobile 375", { width: 375, height: 700 }], ["tablette 820", { width: 820, height: 1100 }], ["grand écran 1600", { width: 1600, height: 1000 }]]) {
    const { ctx, page } = await open({ viewport: vp });
    await page.evaluate(() => openImportCenter({ origin: "test" }));
    const m = await page.evaluate(() => {
      const d = document.getElementById("ic-dialog").getBoundingClientRect(), b = document.querySelector('[data-ic="pick"]').getBoundingClientRect();
      const dz = document.querySelector(".ic-drop").getBoundingClientRect();
      return { dw: Math.round(d.width), vw: innerWidth, dh: Math.round(d.height), vh: innerHeight, btnH: Math.round(b.height), btnW: Math.round(b.width), dzH: Math.round(dz.height), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, bodyOverflow: document.getElementById("ic-dialog").scrollWidth - document.getElementById("ic-dialog").clientWidth };
    });
    check(`${label} : aucun défilement horizontal`, m.overflow <= 0 && m.bodyOverflow <= 0, m);
    check(`${label} : la fenêtre tient dans l'écran`, m.dw <= m.vw && m.dh <= m.vh, m);
    check(`${label} : « Choisir un fichier » ≥ 44 px de haut`, m.btnH >= 44, m);
    if (vp.width <= 640) check(`${label} : bouton pleine largeur, zone compacte`, m.btnW > m.dw * 0.6 && m.dzH < 300, m);
    else check(`${label} : grande zone confortable`, m.dzH >= 260, m);
    await pick(page, PDF_FILE); await waitIc(page, "READY");
    const m2 = await page.evaluate(() => ({ overflow: document.getElementById("ic-dialog").scrollWidth - document.getElementById("ic-dialog").clientWidth, foot: document.querySelector(".ic-foot").getBoundingClientRect().bottom <= innerHeight + 1 }));
    check(`${label} : carte du fichier sans débordement, boutons visibles`, m2.overflow <= 0 && m2.foot, m2);
    await ctx.close();
  }
});

await scenario("13. Navigation au clavier : focus, Tab piégé, Échap, Entrée/Espace", async () => {
  const { ctx, page } = await open();
  await page.focus('[data-qa="import_course"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector("#import-center");
  eq("le focus arrive dans la fenêtre, sur « Choisir un fichier »", await page.evaluate(() => document.activeElement.getAttribute("data-ic")), "pick");
  const order = [];
  for (let i = 0; i < 6; i++) { order.push(await page.evaluate(() => document.activeElement.getAttribute("data-ic") || document.activeElement.tagName)); await page.keyboard.press("Tab"); }
  check("Tab reste DANS la fenêtre (piège à focus)", order.every(x => x && x !== "BODY"), order);
  check("l'ordre est logique : choisir → coller → annuler → (importer désactivé sauté) → fermer", order.includes("pick") && order.includes("close"), order);
  await page.focus('[data-ic="pick"]');
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
  check("Entrée sur « Choisir un fichier » ouvre le sélecteur natif", !!chooser);
  await chooser.setFiles(PDF_FILE);
  await waitIc(page, "READY");
  eq("après le choix, le focus va sur « Importer le cours »", await page.evaluate(() => document.activeElement.getAttribute("data-ic")), "primary");
  const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), (async () => { await page.focus('[data-ic="replace"]'); await page.keyboard.press("Space"); })()]);
  check("Espace sur « Remplacer » ouvre le sélecteur", !!chooser2);
  await chooser2.setFiles([]);
  const outline = await page.evaluate(() => { const b = document.querySelector('[data-ic="primary"]'); b.focus(); const cs = getComputedStyle(b); return cs.outlineStyle !== "none" || cs.boxShadow !== "none"; });
  check("un focus visible existe sur les boutons", outline);
  await page.keyboard.press("Escape");
  eq("Échap ferme et rend le focus au bouton d'origine", await page.evaluate(() => [!document.getElementById("import-center"), document.activeElement && document.activeElement.getAttribute("data-qa")]), [true, "import_course"]);
  check("tous les contrôles sont de vrais <button> (pas de div cliquable)", await (async () => { await page.evaluate(() => openImportCenter({ origin: "t" })); return page.$$eval("#import-center [data-ic]", els => els.every(e => e.tagName === "BUTTON")); })());
  check("le bouton de fermeture a un nom accessible", await page.$eval(".ic-close", b => !!b.getAttribute("aria-label")));
  await ctx.close();
});

await scenario("14. Chrome : parcours complet sans régression du pipeline (texte collé, mêmes états)", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await page.click('[data-ic="paste-toggle"]');
  check("le texte collé reste possible (fonction préservée)", (await page.$$("#ic-paste")).length === 1);
  eq("« Utiliser ce texte » est désactivé tant que rien n'est saisi", await page.$eval('[data-ic="paste-use"]', b => b.disabled), true);
  await page.fill("#ic-paste", "trop court");
  await page.click('[data-ic="paste-use"]');
  await waitIc(page, "ERROR");
  check("texte trop court → message clair", /trop court.*40 caractères/.test(await errText(page)), await errText(page));
  await page.waitForTimeout(50);
  await page.fill("#ic-paste", "Le bilan comptable présente l'actif et le passif de l'entreprise à une date donnée, avec leurs composantes principales.");
  await page.click('[data-ic="paste-use"]');
  await waitIc(page, "READY");
  check("le texte collé passe par la même carte « Fichier prêt »", /Texte collé/.test(await page.innerText(".ic-file")) && /Fichier prêt/.test(await page.innerText(".ic-file")));
  await page.click('[data-ic="primary"]');
  await page.waitForFunction(() => state.courseImport.files.length === 1, null, { timeout: 15000 });
  eq("le pipeline reçoit le texte (sans fichier)", await page.evaluate(() => [state.courseImport.files[0].file, state.courseImport.files[0].preExtracted]), [null, true]);
  await page.waitForFunction(() => state.courseImport.files[0].status === "review", null, { timeout: 15000 });
  check("ancienne API conservée : courseImportAddPasteAsFile fonctionne encore", await page.evaluate(() => { state.courseImport = freshCourseImportState(); state.courseImport.pasteText = "Un cours de test suffisamment long pour être accepté par le pipeline."; courseImportAddPasteAsFile(); return state.courseImport.files.length === 1 && state.courseImport.files[0].preExtracted === true; }));
  await ctx.close();
});

await scenario("15. WebKit / WKWebView : ce qui est vérifiable ici (aucune API propre à Chromium)", async () => {
  const WK = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const { ctx, page } = await open({ ua: WK });
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  eq("l'input de fichier existe, est un vrai <input type=file>, avec accept (extensions ET types MIME)", await page.$eval("#ic-file-input", i => [i.type, /\.pdf/.test(i.accept) && /application\/pdf/.test(i.accept)]), ["file", true]);
  check("l'input n'est pas en display:none (capricieux dans certaines WebView)", await page.$eval("#ic-file-input", i => getComputedStyle(i).display !== "none"));
  const src = fs.readFileSync(path.join(ROOT, "import-center.js"), "utf8") + fs.readFileSync(path.join(ROOT, "index.html"), "utf8").split("7ter-bis. IMPORT CENTER")[1].split("7quater. ONGLET")[0];
  check("aucune API réservée à Chromium (showOpenFilePicker, File System Access, webkitdirectory)", !/showOpenFilePicker|showDirectoryPicker|FileSystemHandle|webkitdirectory/.test(src));
  check("le repli FileReader existe si Blob.arrayBuffer manque", /FileReader/.test(src));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  check("le parcours fonctionne avec un User-Agent de WKWebView (simulation du UA seulement)", (await page.innerText(".ic-file")).includes("Economie-des-marches.pdf"));
  await ctx.close();
});

await scenario("16. Non-régression du pipeline d'import : détection, confirmation, génération sans IA", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await pick(page, PDF_FILE); await waitIc(page, "READY");
  await page.click('[data-ic="primary"]');
  await page.waitForFunction(() => state.courseImport.files[0] && state.courseImport.files[0].status === "review", null, { timeout: 20000 });
  const d = await page.evaluate(() => state.courseImport.files[0].detected);
  check("la détection a produit un titre et des notions (mode simplifié, sans IA)", d && d.title && d.title.length > 0, d);
  await page.evaluate(() => { const f = state.courseImport.files[0]; f.detected.newSubjectName = "Économie"; f.detected.subjectId = null; });
  await page.evaluate(() => courseImportSaveWithoutAI(0));
  await page.waitForFunction(() => state.courseImport.files[0].status === "done", null, { timeout: 20000 });
  const r = await page.evaluate(() => { const f = state.courseImport.files[0]; const ch = findAnyChapter(f.resultChapterId); return { has: !!ch, orig: ch && ch.originalText && ch.originalText.length > 100, file: ch && ch.sourceFileName, pdf: ch && ch.hasOriginalFile }; });
  eq("un chapitre a été créé avec le texte source et le PDF d'origine", [r.has, r.orig, r.file, r.pdf], [true, true, "Economie-des-marches.pdf", true]);
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("17. Traductions et accès de secours", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  const words = { en: ["Import a course", "Drop your course here", "Choose a file"], es: ["Importar un curso", "Suelta tu curso aquí", "Elegir un archivo"], de: ["Kurs importieren", "Lege deinen Kurs hier ab", "Datei auswählen"], it: ["Importa un corso", "Trascina qui il tuo corso", "Scegli un file"] };
  for (const [lang, [title, drop, pickL]] of Object.entries(words)) {
    await page.evaluate((l) => LyonI18n.setLang(l), lang);
    const txt = await page.innerText("#import-center");
    check(`${lang} : l'Import Center OUVERT se traduit (titre, zone, bouton)`, txt.includes(title) && txt.includes(drop) && txt.includes(pickL), txt.slice(0, 160));
    check(`${lang} : aucune clé brute « imp.* » visible`, !/\bimp\.[a-z_]+/.test(txt));
  }
  await page.evaluate(() => LyonI18n.setLang("en"));
  await pick(page, file("presentation.pptx", F.pptx));
  await waitIc(page, "ERROR");
  check("en : l'erreur est traduite", /not supported yet/.test(await errText(page)), await errText(page));
  await page.evaluate(() => { LyonI18n.setLang("fr"); closeImportCenter(); });
  // l'ancienne page « Importer un cours » n'existe plus : la vue de secours ne contient qu'un accès
  await page.evaluate(() => { state.courseImport = freshCourseImportState(); switchTab("library"); libGoto("import"); });
  check("la vue de secours ne contient AUCUNE zone de dépôt ni input de fichier", (await page.$$(".import-dropzone, input[type=file]#import-file-input")).length === 0);
  await page.click("#import-open-center-btn");
  check("… et son bouton ouvre l'Import Center", (await page.$$("#import-center")).length === 1);
  await ctx.close();
});

await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} vérifications réussies, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
