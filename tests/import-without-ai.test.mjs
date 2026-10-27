/* ============================================================================
   REV-EM — importer un cours dans la bibliothèque PUIS le réviser, quand l'assistant IA n'est pas chargé
   ----------------------------------------------------------------------------
   POURQUOI CE TEST EXISTE
     Panne constatée : « l'importation dans la bibliothèque ne fonctionne toujours pas ». Deux causes, reproduites :
       1. l'étape « Analyse du contenu » LANÇAIT le chargement du modèle (tryEnsureImportAIReady → aiLoadModel :
          0,9 à 5 Go à télécharger) : l'import restait figé tant que le téléchargement n'était pas fini (des minutes, ou
          jamais dans l'app Mac), sans aucun cours enregistré ;
       2. même enregistré « sans IA », un cours rédigé en phrases (le cas d'un PDF) n'avait NI quiz NI flashcards : le
          mode simplifié ne reconnaissait que les définitions « Terme : … » en début de ligne.
   CE QUI EST RÉEL : index.html, le bouton « Importer un cours » de la bibliothèque, le vrai sélecteur de fichiers de
     Chromium, un vrai PDF, l'extraction pdf.js, le pipeline d'import, l'enregistrement (localStorage + IndexedDB), le hub
     du cours, une vraie session de quiz (réponse cliquée) et de flashcards.
   CE QUI EST SIMULÉ : un Mac avec WebGPU dont le modèle n'est pas chargé (state.aiStatus = "idle") et dont le chargement
     ne finit jamais (aiInitTier remplacé) — pour PROUVER que l'import ne l'attend plus. NOT TESTED : Safari, REV-EM.app.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/import-without-ai.test.mjs
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

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log(`PASS — ${name}`); } else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
/* Un cours rédigé EN PHRASES, sans aucune ligne « Terme : définition » (le cas courant d'un PDF). */
const PARAS = [
  "Un marché est le lieu de rencontre entre l’offre et la demande d’un bien ou d’un service.",
  "Le prix d’équilibre est celui pour lequel la quantité offerte égale la quantité demandée.",
  "Au-dessus du prix d’équilibre, il y a excès d’offre ; en dessous, il y a excès de demande.",
  "La concurrence pure et parfaite suppose l’atomicité des agents, l’homogénéité des produits et la transparence de l’information.",
  "L’élasticité-prix de la demande mesure la sensibilité de la quantité demandée à une variation du prix.",
  "Une hausse de la demande déplace la courbe de demande vers la droite et augmente le prix d’équilibre.",
  "Sur un marché en concurrence pure et parfaite, aucun agent ne peut influencer le prix.",
  "Le surplus du consommateur mesure l’écart entre le prix qu’il était prêt à payer et le prix d’équilibre.",
  "Une taxe sur un marché réduit la quantité échangée et crée une perte sèche pour la collectivité.",
];
let PDF;
{
  const pg = await browser.newPage();
  await pg.setContent(`<html><body style="font-family:sans-serif;font-size:15px"><h2>Chapitre 3 — Le marché</h2>${PARAS.map(p => `<p>${p}</p>`).join("")}</body></html>`);
  PDF = await pg.pdf({ format: "A4" });
  await pg.close();
}
const PDF_FILE = { name: "Microeconomie-le-marche.pdf", mimeType: "application/pdf", buffer: PDF };

async function open({ ai = "idle" } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.min.mjs")) }));
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.worker\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.worker.min.mjs")) }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(APP);
  await page.waitForFunction(() => typeof state !== "undefined" && typeof openImportCenter === "function" && !!window.RevemBank);
  await page.evaluate((mode) => {
    window.__modelLoads = 0;
    /* Le chargement du modèle (téléchargement de plusieurs Go) ne finit JAMAIS : s'il était attendu, l'import resterait figé. */
    aiInitTier = () => { window.__modelLoads++; return new Promise(() => {}); };
    state.aiStatus = mode;
  }, ai);
  return { ctx, page };
}
async function importFromLibrary(page) {
  await page.evaluate(() => { libGoto("subjects"); switchTab("library"); });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), page.click("#lib-import-course-btn")]);
  await chooser.setFiles(PDF_FILE);
  await page.waitForFunction(() => ic && ic.machine.state === "READY", null, { timeout: 15000 });
  await page.click('#import-center [data-ic="primary"]');
}
const hub = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#course-hub [data-hub-open]")].map(b => [b.dataset.hubOpen, b.dataset.hubState])));
const goChapter = (page, id) => page.evaluate((cid) => { libGoto("chapterDetail", { chapterId: cid }); switchTab("library"); }, id);

/* ═════════════════════════════════════════════════════════════════════ */
await scenario("1. Bibliothèque → PDF → cours importé en quelques secondes, SANS attendre le modèle", async () => {
  const { ctx, page } = await open({ ai: "idle" });
  const t0 = Date.now();
  await importFromLibrary(page);
  await page.waitForSelector("#import-confirm-generate-btn", { timeout: 10000 });
  const ms = Date.now() - t0;
  check("l'écran de confirmation arrive vite (aucune attente du modèle)", ms < 10000, ms + " ms");
  eq("aucun chargement de modèle n'a été lancé par l'import", await page.evaluate(() => window.__modelLoads), 0);
  eq("le bouton dit ce qui va se passer : « Importer le cours »", await page.innerText("#import-confirm-generate-btn"), "Importer le cours");
  check("une phrase explique les supports simplifiés et la suite avec l'IA", /supports? simplifiés|fiche, un quiz et des flashcards simplifiés/.test(await page.innerText("#import-noai-hint")));
  check("pas de second bouton qui ferait la même chose", !(await page.$("#import-save-noai-btn")));
  await page.click("#import-confirm-generate-btn");
  await page.waitForFunction(() => state.library.view === "chapterDetail" && !!document.getElementById("course-hub"), null, { timeout: 15000 });
  const id = await page.evaluate(() => state.library.chapterId);
  const ch = await page.evaluate((cid) => { const c = findAnyChapter(cid); return { text: (c.originalText || "").length, pdf: !!c.hasOriginalFile, quiz: c.aiQuiz.length, cards: c.aiFlashcards.length, fiche: !!c.content, summary: !!c.summary, simple: !!c.heuristicMode }; }, id);
  check("cours enregistré : texte du PDF et PDF original conservés", ch.text > 400 && ch.pdf, ch);
  check("un quiz (≥ 5 questions) et des flashcards (≥ 5) tirés du cours", ch.quiz >= 5 && ch.cards >= 5, ch);
  check("fiche et résumé simplifiés", ch.fiche && ch.summary, ch);
  eq("les outils de révision sont prêts (aucune « Erreur — à relancer »)", await hub(page), { fiche: "READY", summary: "READY", quiz: "READY", quizflash: "READY", flashcards: "READY", questions: "READY" });
  check("« Générer tout » reste proposé pour passer à la version IA plus tard", !!(await page.$("#lib-generate-ai-btn")));
  eq("toujours aucun chargement de modèle", await page.evaluate(() => window.__modelLoads), 0);
  /* Réviser pour de vrai */
  await page.click('[data-hub-open="quiz"]');
  await page.waitForSelector(".qz-opt", { timeout: 5000 });
  const good = await page.evaluate((cid) => { const q = state.pool[state.index]; const orig = findAnyChapter(cid).aiQuiz.find(x => x.uid === q.uid); return q.opts.indexOf(orig.opts[orig.correct]); }, id);
  await page.click(`.qz-opt[data-i="${good}"]`);
  check("Quiz : une question du cours se joue, la bonne réponse est reconnue", await page.evaluate(() => state.score === 1), await page.evaluate(() => state.score));
  check("Quiz : la question cite une phrase de TON cours", await page.evaluate(() => /complète cette phrase/.test(state.pool[state.index].q)));
  await goChapter(page, id);
  await page.click('[data-hub-open="quizflash"]');
  check("Quiz Flash : démarre", !!(await page.waitForSelector(".qz-opt", { timeout: 5000 }).catch(() => null)));
  await goChapter(page, id);
  await page.click('[data-hub-open="flashcards"]');
  check("Flashcards : le paquet s'ouvre", !!(await page.waitForSelector("#flashcard-el", { timeout: 5000 }).catch(() => null)));
  await goChapter(page, id);
  await page.click('[data-hub-open="fiche"]');
  check("Fiche : s'affiche avec les phrases clés du cours", /Phrases clés du cours/.test(await page.innerText("#content")));
  /* Rechargement */
  await page.reload();
  await page.waitForFunction(() => typeof state !== "undefined" && Array.isArray(state.userChapters));
  check("après rechargement : cours, quiz et flashcards toujours là", await page.evaluate((cid) => { const c = state.userChapters.find(x => x.id === cid); return !!c && c.aiQuiz.length >= 5 && c.aiFlashcards.length >= 5; }, id));
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("2. IA indisponible sur l'appareil (pas de WebGPU) : même parcours, rien ne bloque", async () => {
  const { ctx, page } = await open({ ai: "nogpu" });
  await importFromLibrary(page);
  await page.waitForSelector("#import-confirm-generate-btn", { timeout: 10000 });
  await page.click("#import-confirm-generate-btn");
  await page.waitForFunction(() => state.library.view === "chapterDetail" && !!document.getElementById("course-hub"), null, { timeout: 15000 });
  const st = await hub(page);
  check("quiz et flashcards prêts", st.quiz === "READY" && st.flashcards === "READY", st);
  await ctx.close();
});

await scenario("3. IA prête : le parcours avec l'IA est inchangé (« Générer avec l'IA » / « Enregistrer sans IA »)", async () => {
  const { ctx, page } = await open({ ai: "ready" });
  await page.evaluate(() => {
    window.webllmChat = async () => ({ text: JSON.stringify({ title: "Le marché", chapter: "Le marché", level: "", notions: ["offre", "demande"] }) });
    window.webllmJsonChat = async () => [];
  });
  await importFromLibrary(page);
  await page.waitForSelector("#import-confirm-generate-btn", { timeout: 10000 });
  eq("bouton IA", await page.innerText("#import-confirm-generate-btn"), "Générer avec l'IA");
  check("« Enregistrer sans IA » toujours proposé", !!(await page.$("#import-save-noai-btn")));
  check("pas d'explication « IA non chargée »", !(await page.$("#import-noai-hint")));
  await ctx.close();
});

await scenario("4. Traductions", async () => {
  const { ctx, page } = await open();
  const missing = await page.evaluate(() => { const out = []; ["fr", "en", "es", "de", "it"].forEach(l => { LyonI18n.setLang(l); ["imp.review.import", "imp.review.no_ai"].forEach(k => { if (LyonI18n.t(k) === k) out.push(l + ":" + k); }); }); LyonI18n.setLang("fr"); return out; });
  eq("aucune clé manquante (5 langues)", missing, []);
  await ctx.close();
});

await browser.close();
console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
