/* ============================================================================
   REV-EM — génération des supports d'un cours, À TRAVERS LE VRAI MOTEUR DE LA PAGE
   ----------------------------------------------------------------------------
   POURQUOI CE TEST EXISTE
     Panne constatée : après l'import d'un PDF, Fiche, Résumé, Quiz, Quiz Flash et Flashcards affichaient tous
     « Erreur — à relancer ». Cause : une étape dépassait son délai FIXE (90 s pour la fiche, alors qu'un modèle « Avancé »
     sur un Mac modeste écrit 10–20 jetons/s), demandait l'arrêt au moteur, puis rendait la main AVANT que le moteur soit
     réellement arrêté ; l'étape suivante trouvait le moteur occupé et échouait aussitôt, puis la suivante… sans
     qu'aucune n'atteigne le moteur. Les suites existantes remplacent webllmChat / webllmJsonChat par un double : elles ne
     pouvaient pas voir ce défaut, qui vit ENTRE ces fonctions et le moteur.

   CE QUI EST RÉEL ICI
     • index.html tel quel dans un vrai Chromium ; l'Import Center ; l'extraction pdf.js d'un VRAI PDF ; la détection,
       courseImportGenerate → courseHubGenerate → courseHubPump → courseImportRunAllSteps → generateCourse* →
       webllmChat / webllmJsonChat → aiHostGenerate → assembleur de sortie (output-processor.js) → délais (withGenTimeout) ;
     • les cartes du hub, les vues de ressource, « Réessayer ».
   CE QUI EST SIMULÉ
     • le MOTEUR (aiTransport) : il reproduit le protocole de ai-host.js — flux de jetons GENERATION_TOKEN, ABORT effectif
       au jeton suivant, GENERATION_COMPLETE / GENERATION_ERROR, refus si occupé — avec un débit réglable ;
     • le temps (horloge Playwright accélérée) : 2 minutes de génération durent quelques secondes.
   NON TESTÉ : un vrai WebLLM sur un vrai GPU (le Mac de l'utilisateur). PASS MOCK pour tout ce qui suit.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/course-generation-engine.test.mjs
   (pdf.js est lu dans node_modules/pdfjs-dist@4.0.379, comme tests/import-center-ui.test.mjs.)
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

/* Un cours réaliste (droit des contrats), assez long pour un vrai travail de génération. */
const PARAS = [
  "Le contrat est un accord de volontés entre deux ou plusieurs personnes destiné à créer, modifier, transmettre ou éteindre des obligations (article 1101 du Code civil).",
  "L'offre comprend les éléments essentiels du contrat envisagé et exprime la volonté de son auteur d'être lié en cas d'acceptation. À défaut, il y a seulement invitation à entrer en négociation.",
  "L'acceptation est la manifestation de volonté de son auteur d'être lié dans les termes de l'offre. Le silence ne vaut pas acceptation, sauf exceptions prévues par la loi ou les usages.",
  "Le contrat est conclu dès que l'acceptation parvient à l'offrant : c'est la théorie de la réception (article 1121).",
  "L'erreur, le dol et la violence vicient le consentement lorsqu'ils sont de telle nature que, sans eux, l'une des parties n'aurait pas contracté. Ils entraînent la nullité relative.",
  "Le dol est le fait d'obtenir le consentement de l'autre par des manœuvres ou des mensonges ; la réticence dolosive en est une forme.",
  "Le pacte de préférence oblige une partie à proposer prioritairement à son bénéficiaire de traiter avec lui si elle décide de contracter.",
  "La nullité est absolue lorsque la règle violée protège l'intérêt général, relative lorsqu'elle protège un intérêt privé. L'action se prescrit par cinq ans.",
];

/* ── moteur simulé, fidèle au protocole de ai-host.js ── */
const ENGINE = `
(function(){
  const E = window.__ENG = { tokMs: 80, prefillMs: 3000, mode: {}, log: [], active: 0, maxActive: 0, sent: 0, busyRefusals: 0 };
  const big = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const NOTIONS = ["l'offre", "l'acceptation", "la réception", "l'erreur", "le dol", "la violence", "le pacte de préférence", "la nullité relative", "la nullité absolue", "la caducité", "la promesse unilatérale", "le devoir d'information", "la capacité", "le contenu licite", "la prescription", "la réticence dolosive", "le contrat d'adhésion", "la clause abusive", "les négociations", "la rétractation"];
  function kindOf(p){
    if(/déduis un titre court/.test(p)) return "detect";
    if(/condense cet extrait/.test(p)) return "condense";
    if(/fiche de révision structurée/.test(p)) return "fiche";
    if(/résumé très court/.test(p)) return "summary";
    if(/flashcards de révision/.test(p)) return "flashcards";
    if(/questions pour réviser CETTE partie|questions à choix multiples/.test(p)) return "quiz";
    if(/questions de révision variées/.test(p)) return "reviewQuestions";
    return "chat";
  }
  function answer(kind){
    if(kind === "detect") return JSON.stringify({ title: "La formation du contrat", subject: "Droit des contrats", chapter: "La formation du contrat", level: "L2", notions: ["offre", "acceptation", "dol"] });
    if(kind === "fiche") return JSON.stringify({ introduction: "Le contrat est un accord de volontés destiné à créer des obligations.", sections: big(6, s => ({ type: "notions", title: "Partie " + (s + 1), items: big(7, i => ({ title: NOTIONS[(s * 7 + i) % NOTIONS.length] + " (" + s + "." + i + ")", content: "Définition reformulée de " + NOTIONS[(s * 7 + i) % NOTIONS.length] + " selon le cours, avec ses conditions et sa sanction.", example: "Exemple concret " + s + "." + i })) })), keyPoints: big(7, i => "À retenir : " + NOTIONS[i] + " obéit à une règle précise du Code civil.") });
    if(kind === "summary") return "Résumé court\\nLe contrat se forme par la rencontre d'une offre et d'une acceptation. Sa validité suppose un consentement libre et éclairé, la capacité et un contenu licite et certain.\\nIdées essentielles\\n" + NOTIONS.slice(0, 8).map(n => "- " + n + " : règle essentielle du chapitre.").join("\\n");
    if(kind === "flashcards") return JSON.stringify(NOTIONS.slice(0, 10).map(n => ({ front: "Qu'est-ce que " + n + " ?", back: "Dans le cours, " + n + " désigne une règle précise de formation ou de validité du contrat.", concept: n, sourceQuote: "contrat", exampleQuote: "" })));
    if(kind === "quiz") return JSON.stringify(NOTIONS.slice(0, 8).map(n => ({ q: "Que dit le cours sur " + n + " ?", opts: ["La règle exacte sur " + n, "Une règle propre à un autre sujet", "Une confusion fréquente en examen", "Une règle aujourd'hui abrogée"], correct: 0, concept: n, type: "definition", difficulty: "medium", exp: "Voir le cours sur " + n + ".", sourceQuote: "contrat", exampleQuote: "" })));
    if(kind === "reviewQuestions") return JSON.stringify(NOTIONS.slice(0, 6).map(n => ({ q: "Explique " + n + ".", a: "Réponse courte tirée du cours sur " + n + "." })));
    if(kind === "condense") return NOTIONS.map(n => "- " + n).join("\\n");
    return "Réponse.";
  }
  let cur = null;
  aiTransport = { mode: "worker", terminate(){}, send(m){
    if(m.type === "ABORT"){ if(cur && cur.id === m.id){ cur.abort = true; E.log.push("ABORT " + cur.kind); } return; }
    if(m.type !== "GENERATE") return;
    E.sent++;
    if(cur){ E.busyRefusals++; setTimeout(() => aiOnHostMessage({ type: "GENERATION_ERROR", id: m.id, code: "BUSY", message: "Une génération est déjà en cours." }), 1); return; }
    const kind = kindOf(m.messages[0].content);
    const mode = E.mode[kind] || E.mode["*"] || "normal";
    let text = answer(kind);
    if(mode === "fence") text = "Voici le résultat :\\n\`\`\`json\\n" + text + "\\n\`\`\`\\nBonne révision !";
    const toks = text.match(/[\\s\\S]{1,4}/g);
    const limit = mode === "truncate" ? Math.floor(toks.length * 0.6) : m.maxTokens;
    const g = cur = { id: m.id, kind, abort: false, n: 0 };
    E.active++; E.maxActive = Math.max(E.maxActive, E.active);
    E.log.push("GEN " + kind + (mode !== "normal" ? " [" + mode + "]" : ""));
    const end = (reason) => { cur = null; E.active--; aiOnHostMessage({ type: "GENERATION_COMPLETE", id: g.id, aborted: g.abort, chars: g.n, totalMs: 0, finishReason: reason }); };
    const tick = () => {
      if(mode === "stuck" && g.abort){ return; }                          // le moteur ne rend jamais la main
      if(g.abort) return end(null);
      if(mode === "silent" || mode === "stuck") return setTimeout(tick, 500);   // aucun jeton : pré-remplissage figé
      if(g.n >= toks.length) return end("stop");
      if(g.n >= limit) return end("length");
      aiOnHostMessage({ type: "GENERATION_TOKEN", id: g.id, delta: toks[g.n++] });
      setTimeout(tick, E.tokMs);
    };
    setTimeout(tick, E.prefillMs);
  }};
  E.release = () => { if(cur){ const g = cur; cur = null; E.active--; aiOnHostMessage({ type: "GENERATION_COMPLETE", id: g.id, aborted: true, chars: g.n, totalMs: 0, finishReason: null }); } };
})();`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium" });
let PDF;
{
  const pg = await browser.newPage();
  await pg.setContent(`<html><body style="font-family:sans-serif;font-size:15px">${PARAS.map(p => `<p>${p}</p>`).join("")}<div style="page-break-after:always"></div>${PARAS.slice().reverse().map(p => `<p>${p}</p>`).join("")}</body></html>`);
  PDF = await pg.pdf({ format: "A4" });
  await pg.close();
}

async function open({ viewport } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: viewport || { width: 1280, height: 900 } });
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.min.mjs")) }));
  await ctx.route(/^https:\/\/esm\.run\/pdfjs-dist@4\.0\.379\/build\/pdf\.worker\.min\.mjs$/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: fs.readFileSync(path.join(PDFJS, "pdf.worker.min.mjs")) }));
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.goto(APP);
  await page.waitForFunction(() => typeof state !== "undefined" && typeof openImportCenter === "function" && !!window.RevemOutput);
  await page.evaluate(ENGINE);
  await page.evaluate(() => { state.aiStatus = "ready"; state.aiTier = "avance"; });
  return { ctx, page };
}

/* Import RÉEL d'un PDF jusqu'à l'écran de confirmation, puis « Générer » : renvoie l'id du cours créé. */
async function importPdf(page) {
  await page.evaluate(() => openImportCenter({ origin: "test" }));
  await page.waitForSelector('#import-center [data-ic="pick"]');
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('#import-center [data-ic="pick"]')]);
  await chooser.setFiles({ name: "Formation-du-contrat.pdf", mimeType: "application/pdf", buffer: PDF });
  await page.waitForFunction(() => ic && ic.machine.state === "READY", null, { timeout: 15000 });
  await page.evaluate(() => { window.__ENG.prefillMs = 50; window.__ENG.tokMs = 2; });     // détection rapide (l'objet du test est la génération)
  await page.click('#import-center [data-ic="primary"]');
  await page.waitForSelector("#import-confirm-generate-btn", { timeout: 30000 });
}
async function confirmAndRun(page, { tokMs = 80, prefillMs = 3000, mode = {} } = {}, maxSimMs = 30 * 60 * 1000) {
  await page.evaluate(([tokMs, prefillMs, mode]) => { Object.assign(window.__ENG, { tokMs, prefillMs, mode, log: [] }); }, [tokMs, prefillMs, mode]);
  await page.clock.install();
  await page.click("#import-confirm-generate-btn");
  return runQueue(page, maxSimMs);
}
async function runQueue(page, maxSimMs = 30 * 60 * 1000) {
  let sim = 0;
  /* La file démarre après l'enregistrement du cours (IndexedDB : vraiment asynchrone) : on attend qu'elle ait COMMENCÉ. */
  for (let i = 0; i < 200 && !(await page.evaluate(() => !!(state.courseGen && (state.courseGen.running || state.courseGen.queue.length)))); i++) { await page.clock.runFor(50); sim += 50; await page.waitForTimeout(10); }
  while (sim < maxSimMs) {
    await page.clock.runFor(5000); sim += 5000;
    if (await page.evaluate(() => state.courseGen && !state.courseGen.running && !state.courseGen.queue.length)) break;
  }
  return sim;
}
const cards = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#course-hub [data-hub-open]")].map(b => [b.dataset.hubOpen, b.dataset.hubState])));
const cardText = (page, key) => page.evaluate((k) => { const b = document.querySelector(`#course-hub [data-hub-open="${k}"]`); return b ? b.innerText.replace(/\s+/g, " ").trim() : ""; }, key);
const errorsOf = (page) => page.evaluate(() => { const id = state.library.chapterId; const e = (state.courseGen.errors || {})[id] || {}; return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v.code])); });
const course = (page) => page.evaluate(() => { const ch = findAnyChapter(state.library.chapterId); return { fiche: !!ch.content, summary: !!ch.summary, quiz: ch.aiQuiz.length, flashcards: ch.aiFlashcards.length, reviewQuestions: (ch.aiReviewQuestions || []).length, originalText: (ch.originalText || "").length, hasPdf: !!ch.hasOriginalFile }; });
const READY5 = { fiche: "READY", summary: "READY", quiz: "READY", quizflash: "READY", flashcards: "READY", questions: "READY" };

/* ═════════════════════════════════════════════════════════════════════ */
await scenario("1. PDF réel importé, modèle LENT (12 jetons/s, réponses > 90 s) : les cinq supports sont produits", async () => {
  const { ctx, page } = await open();
  await importPdf(page);
  const sim = await confirmAndRun(page, { tokMs: 80 });
  const c = await course(page);
  check("le texte du PDF a été extrait et conservé avec le cours", c.originalText > 1000 && c.hasPdf, c);
  eq("on arrive sur la page du cours, les six accès prêts (aucune « Erreur — à relancer »)", await cards(page), READY5);
  eq("aucune erreur enregistrée", await errorsOf(page), {});
  check("fiche, résumé, banque de quiz, banque de flashcards, questions de révision : tous remplis", c.fiche && c.summary && c.quiz >= 4 && c.flashcards >= 4 && c.reviewQuestions >= 3, c);
  const E = await page.evaluate(() => window.__ENG);
  check("un seul travail sur le moteur à la fois", E.maxActive === 1, E.maxActive);
  check("le moteur n'a jamais été sollicité alors qu'il était occupé", E.busyRefusals === 0, E.busyRefusals);
  check("aucune génération n'a été arrêtée alors qu'elle progressait", !E.log.some(l => /^ABORT/.test(l)), E.log);
  check("la fiche (la plus longue, > 90 s à ce débit) est allée jusqu'au bout", E.log.includes("GEN fiche") && c.fiche, E.log);
  console.log("   temps simulé : " + Math.round(sim / 1000) + " s ; appels : " + E.log.join(" · "));
  /* ouverture des supports */
  await page.click('#course-hub [data-hub-open="fiche"]');
  check("la fiche s'ouvre et s'affiche", await page.evaluate(() => state.library.view === "chapterResource" && /Partie 1/.test(document.body.innerText)));
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await scenario("2. Le moteur se fige sur la fiche (aucun jeton) : SEULE la fiche échoue, les autres supports sont produits", async () => {
  const { ctx, page } = await open();
  await importPdf(page);
  await confirmAndRun(page, { tokMs: 20, mode: { fiche: "silent" } });
  const st = await cards(page);
  eq("fiche en erreur, tout le reste prêt (plus de cascade)", st, Object.assign({}, READY5, { fiche: "ERROR" }));
  eq("cause enregistrée : délai dépassé", await errorsOf(page), { fiche: "TIMEOUT" });
  const E = await page.evaluate(() => window.__ENG);
  check("les étapes suivantes ont attendu l'arrêt RÉEL du moteur (aucun refus « occupé »)", E.busyRefusals === 0, E);
  check("la carte dit POURQUOI : « Délai dépassé »", /Délai dépassé/.test(await cardText(page, "fiche")), await cardText(page, "fiche"));
  /* Réessayer depuis la vue de la ressource */
  await page.evaluate(() => { window.__ENG.mode = {}; });
  await page.click('#course-hub [data-hub-open="fiche"]');
  check("la vue explique l'erreur et propose « Réessayer »", /trop de temps/.test(await page.innerText("#content")) && !!(await page.$("[data-hub-generate=fiche]")));
  await page.click("[data-hub-generate=fiche]");
  await runQueue(page);
  check("« Réessayer » produit la fiche", (await course(page)).fiche);
  await ctx.close();
});

await scenario("3. Le moteur ne rend JAMAIS la main après l'arrêt : échec borné, cause claire, puis reprise", async () => {
  const { ctx, page } = await open();
  await importPdf(page);
  const sim = await confirmAndRun(page, { tokMs: 20, mode: { fiche: "stuck" } }, 20 * 60 * 1000);
  const errs = await errorsOf(page);
  eq("fiche : délai dépassé ; les suivantes : « assistant occupé » (jamais un échec muet)", errs, { fiche: "TIMEOUT", summary: "ENGINE_BUSY", quiz: "ENGINE_BUSY", flashcards: "ENGINE_BUSY", reviewQuestions: "ENGINE_BUSY" });
  check("l'attente est bornée (une seule attente de 30 s, pas une par étape)", sim <= 3 * 60 * 1000, Math.round(sim / 1000) + " s");
  check("la carte Résumé dit « Assistant IA occupé »", /Assistant IA occupé/.test(await cardText(page, "summary")), await cardText(page, "summary"));
  /* le moteur finit par rendre la main : « Tout générer » relance ce qui manque */
  await page.evaluate(() => { window.__ENG.release(); window.__ENG.mode = {}; });
  await page.clock.runFor(100);
  await page.click("#lib-generate-ai-btn");
  await runQueue(page);
  eq("après reprise, tout est prêt", await cards(page), READY5);
  await ctx.close();
});

await scenario("4. Réponses COUPÉES (limite de jetons) et JSON entouré de texte / ```json : les éléments complets sont gardés", async () => {
  const { ctx, page } = await open();
  await importPdf(page);
  await confirmAndRun(page, { tokMs: 5, mode: { fiche: "truncate", quiz: "truncate", flashcards: "fence", reviewQuestions: "fence" } });
  eq("tous les supports sont prêts", await cards(page), READY5);
  const c = await course(page);
  check("fiche coupée : ses sections complètes sont gardées", c.fiche && await page.evaluate(() => { const f = JSON.parse(findAnyChapter(state.library.chapterId).content); return f.sections.length >= 1 && f.sections.every(s => s.items.length > 0); }), c);
  check("quiz coupé : les questions complètes sont gardées, aucune à moitié", c.quiz >= 3 && await page.evaluate(() => findAnyChapter(state.library.chapterId).aiQuiz.every(q => q.opts && q.opts.length === 4 && q.q)), c.quiz);
  check("flashcards et questions de révision en bloc ```json : lues", c.flashcards >= 4 && c.reviewQuestions >= 3, c);
  await ctx.close();
});

await scenario("5. IA indisponible au moment de l'import : chaque carte dit pourquoi, rien n'est perdu", async () => {
  const { ctx, page } = await open();
  await importPdf(page);
  await page.evaluate(() => { state.aiStatus = "nogpu"; state.aiGpuDiag = { message: "WebGPU indisponible." }; });
  await page.click("#import-confirm-generate-btn");
  await page.waitForFunction(() => state.library.view === "chapterDetail" && !state.courseGen.running, null, { timeout: 10000 });
  const st = await cards(page);
  check("les cinq ressources générables sont en erreur", ["fiche", "summary", "quiz", "quizflash", "flashcards"].every(k => st[k] === "ERROR"), st);
  check("la carte dit « Assistant IA indisponible » (pas une erreur générique)", /Assistant IA indisponible/.test(await cardText(page, "quiz")), await cardText(page, "quiz"));
  check("le texte du cours est conservé", (await course(page)).originalText > 1000);
  /* l'IA redevient prête : la préparation reprend TOUTE SEULE */
  await page.evaluate(() => { window.__ENG.tokMs = 2; window.__ENG.prefillMs = 50; state.aiStatus = "ready"; render(); });
  await page.waitForFunction(() => { const c = findAnyChapter(state.library.chapterId); return c.content && c.summary && c.aiQuiz.length && c.aiFlashcards.length; }, null, { timeout: 30000 });
  check("reprise automatique : les supports sont produits", true);
  await ctx.close();
});

await scenario("6. L'assistant (questions libres) n'est pas affecté : une 2e demande PENDANT une génération est refusée tout de suite", async () => {
  const { ctx, page } = await open();
  const r = await page.evaluate(async () => {
    window.__ENG.tokMs = 30; window.__ENG.prefillMs = 10;
    const first = webllmChat([{ role: "user", content: "Bonjour" }], { task: "chat" });
    const t0 = performance.now();
    let msg = "";
    try { await webllmChat([{ role: "user", content: "Deuxième" }], { task: "chat" }); } catch (e) { msg = e.message + "|" + e.code; }
    const dt = performance.now() - t0;
    await first;
    return { msg, dt };
  });
  check("refus immédiat « Une génération est déjà en cours. » (aucune attente)", /déjà en cours/.test(r.msg) && /ENGINE_BUSY/.test(r.msg) && r.dt < 200, r);
  await ctx.close();
});

await scenario("7. Raisons traduites (5 langues) et carte lisible sur mobile", async () => {
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 } });
  const missing = await page.evaluate(() => {
    const codes = ["NO_SOURCE", "AI_UNAVAILABLE", "AI_LOADING", "OUT_OF_MEMORY", "TIMEOUT", "DEVICE_LOST", "GENERATION_FAILED", "ENGINE_BUSY", "BAD_FORMAT"];
    const keys = codes.map(c => "hub.reason." + c).concat(codes.map(c => "hub.err." + c));
    const out = [];
    ["fr", "en", "es", "de", "it"].forEach(l => { LyonI18n.setLang(l); keys.forEach(k => { if (LyonI18n.t(k) === k) out.push(l + ":" + k); }); });
    LyonI18n.setLang("fr");
    return out;
  });
  eq("aucune clé manquante", missing, []);
  await importPdf(page);
  await page.evaluate(() => { state.aiStatus = "nogpu"; });
  await page.click("#import-confirm-generate-btn");
  await page.waitForFunction(() => state.library.view === "chapterDetail" && !state.courseGen.running, null, { timeout: 10000 });
  for (const l of ["fr", "de"]) {
    await page.evaluate((x) => { LyonI18n.setLang(x); render(); }, l);
    const o = await page.evaluate(() => { const b = document.querySelector('#course-hub [data-hub-open="flashcards"]'); return { over: b.scrollWidth > b.clientWidth + 1, page: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
    check(`390 px / ${l} : carte en erreur sans débordement`, !o.over && !o.page, o);
  }
  check("aucune erreur JavaScript", page.errors.length === 0, page.errors);
  await ctx.close();
});

await browser.close();
console.log(`\n${pass}/${pass + fail} vérifications passées (PASS MOCK : moteur simulé), ${fail} FAIL`);
process.exit(fail ? 1 : 0);
