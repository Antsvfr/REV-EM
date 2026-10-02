/* ============================================================================
   REV-EM — Hub de révision d'un cours, dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, dans un vrai Chromium : la page du chapitre, les
       cinq cartes (Fiche, Résumé, Quiz, Flashcards, Questions), les vues de
       ressource, le fil d'Ariane, la file de générations et le pipeline
       d'import (courseImportRunAllSteps) qu'elle réutilise ;
     • le rendu, le clavier, le responsive (viewport 390 px), le stockage local ;
     • la fonction réelle de changement de compte (resetUserStateInMemory).

   CE QUI EST REMPLACÉ, ET POURQUOI
     `webllmChat`/`webllmJsonChat` sont remplacées par un double déterministe
     (WebLLM exige un vrai GPU WebGPU, absent ici) — comme dans
     tests/course-import.test.mjs. Il compte aussi les générations SIMULTANÉES
     (maxActive) pour prouver « un seul travail WebLLM à la fois ».
     `state.aiStatus` est forcé (« ready » / « nogpu ») : aucun modèle réel.

   CE QU'AUCUNE SUITE NE PROUVE : qu'un vrai modèle, sur un vrai GPU (le Mac de
   l'utilisateur), produit ces contenus. NOT TESTED contre un vrai WebLLM.
   Le changement de compte est exercé au niveau de la fonction de remise à zéro
   réelle, pas avec un second compte Supabase réel (voir account-sync.test.mjs).

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/course-hub-ui.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

let pass = 0, fail = 0, current = "";
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  current = name; console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

const FAKE_AI = `
(function(){
  const AI = window.__AI = { calls: [], fail: new Set(), delay: {}, detect: {}, active: 0, maxActive: 0 };
  function keyOfChat(p){
    if (/déduis un titre court/.test(p)) return "detect";
    if (/fiche de révision structurée/.test(p)) return "fiche";
    if (/résumé très court/.test(p)) return "summary";
    return "unknown-chat";
  }
  function keyOfJson(p){
    if (/questions à choix multiples|questions pour réviser CETTE partie/.test(p)) return "quiz";
    if (/flashcards de révision/.test(p)) return "flashcards";
    if (/questions de révision variées/.test(p)) return "reviewQuestions";
    return "unknown-json";
  }
  async function step(key){
    AI.calls.push(key);
    AI.active++; AI.maxActive = Math.max(AI.maxActive, AI.active);
    try{
      if (AI.delay[key]) await new Promise(r => setTimeout(r, AI.delay[key]));
      if (AI.fail.has(key)) throw new Error("échec simulé : " + key);
    } finally { AI.active--; }
  }
  window.webllmChat = async function(turns){
    const key = keyOfChat(turns[0].content);
    await step(key);
    if (key === "detect") return { text: JSON.stringify({ title: AI.detect.title || "Cours de test", chapter: AI.detect.chapter || "Chapitre de test", level: "", notions: ["notion a", "notion b"] }) };
    if (key === "fiche") return { text: JSON.stringify({ introduction: "Introduction de test.", sections: [{ type: "notions", title: "Notions", items: [{ title: "Terme", content: "Définition." }] }], keyPoints: ["Point essentiel."] }) };
    if (key === "summary") return { text: "Résumé court\\nphrase.\\nIdées essentielles\\n- une idée" };
    return { text: "Bonjour, pose-moi ta question." };
  };
  window.webllmJsonChat = async function(turns){
    const key = keyOfJson(turns[0].content);
    await step(key);
    if (key === "quiz") return [{ q: "Question générée ?", opts: ["a", "b", "c", "d"], correct: 0, exp: "", sourceQuote: "texte" }, { q: "Seconde question ?", opts: ["a", "b", "c", "d"], correct: 1, exp: "", sourceQuote: "texte" }];
    if (key === "flashcards") return [{ front: "Recto", back: "Verso", sourceQuote: "texte" }];
    if (key === "reviewQuestions") return [{ q: "Question de révision ?", a: "Réponse." }];
    return [];
  };
})();
`;

async function open(browser, vp) {
  const page = await browser.newPage({ viewport: vp || { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(900);
  await page.addScriptTag({ content: FAKE_AI });
  await page.evaluate(() => { state.aiStatus = "ready"; });
  return { page, errors };
}

/* Une matière + des chapitres, construits par les fonctions RÉELLES du produit. */
async function seed(page, chapters) {
  return page.evaluate((chapters) => {
    const subjectId = "subj_hub";
    state.userSubjects.push({ id: subjectId, name: "Marketing", semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D", icon: "", description: "" });
    saveUserSubjects();
    const ids = [];
    chapters.forEach((c, i) => {
      const id = c.id || ("ch_hub_" + i);
      state.userChapters.push(Object.assign({
        id, subjectId, num: "0" + (i + 1), desc: "", level: "", title: "Chapitre " + (i + 1),
        content: "", summary: "", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [],
        keyNotions: [], sourceFileName: "", pageCount: null, hasOriginalFile: false, originalText: "",
        createdAt: Date.now(), updatedAt: Date.now(), markedReviewed: false, heuristicMode: false, generationPending: false,
      }, c));
      ids.push(id);
    });
    saveUserChapters();
    return { subjectId, ids };
  }, chapters);
}

const SRC = "Le marketing est l'ensemble des méthodes qui permettent de comprendre un marché. Une étude de marché collecte et analyse des informations pour soutenir la décision commerciale.";
const quiz = (tag, n = 2) => Array.from({ length: n }, (_, i) => ({ uid: "u-" + tag + i, ai: true, theme: "ai", q: "Question " + tag + " n°" + (i + 1) + " ?", opts: ["a", "b", "c", "d"], correct: 0, exp: "", chapterId: tag }));
const cards = (tag, n = 3) => Array.from({ length: n }, (_, i) => ({ front: "Recto " + tag + i, back: "Verso " + tag + i, ai: true, chapterId: tag }));
const FULL = (tag) => ({ id: tag, title: "Cours " + tag, originalText: SRC + " (" + tag + ")", content: "Fiche du cours " + tag + ".\n\n- point A\n- point B", summary: "Résumé du cours " + tag, aiQuiz: quiz(tag), aiFlashcards: cards(tag) });
const PDFONLY = (tag) => ({ id: tag, title: "Cours " + tag, originalText: SRC, hasOriginalFile: true, sourceFileName: "cours.pdf", pageCount: 4, generationPending: true });

const goChapter = (page, id) => page.evaluate((id) => { libGoto("chapterDetail", { chapterId: id }); switchTab("library"); }, id);
const cardStates = (page) => page.$$eval("[data-hub-open]", els => Object.fromEntries(els.map(e => [e.dataset.hubOpen, e.dataset.hubState])));
const bodyText = (page) => page.evaluate(() => document.getElementById("content").innerText);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ====================================================================
     1. Import d'un PDF → la page du cours s'ouvre, les cinq outils sont là
     ==================================================================== */
  await scenario("1. après l'import, on arrive SUR le cours : les cinq outils sont visibles", async () => {
    const { page, errors } = await open(browser);
    await page.evaluate(() => { window.__AI.detect.chapter = "Étude de marché"; });
    await page.evaluate(() => {
      switchTab("library"); libGoto("import");
      state.courseImport.pasteText = "Les méthodes quantitatives et qualitatives d'étude de marché, avec leurs avantages respectifs.";
      courseImportAddPasteAsFile();
      state.courseImport.files[0].name = "etude-marche.pdf";
      state.courseImport.step = "detect";
      return courseImportProcessFile(0);
    });
    await page.click("#import-confirm-generate-btn");
    await page.waitForSelector("#course-hub", { timeout: 15000 });
    const r = await page.evaluate(() => ({ view: state.library.view, tab: state.tab, chapterId: state.library.chapterId, real: state.userChapters[0].id }));
    eq("on est sur la page du chapitre importé (pas sur un écran passif)", [r.tab, r.view], ["library", "chapterDetail"]);
    eq("c'est bien le chapitre créé par l'import (identifiant stable)", r.chapterId, r.real);
    eq("les cinq accès sont là, dans l'ordre", await page.$$eval("[data-hub-open]", e => e.map(x => x.dataset.hubOpen)), ["fiche", "summary", "quiz", "quizflash", "flashcards", "questions"]);
    const txt = await bodyText(page);
    check("le titre et le sous-titre de la section", txt.includes("Outils de révision") && txt.includes("Tout ce qu'il te faut pour maîtriser ce chapitre"), txt.slice(0, 300));
    check("les libellés demandés", ["Réviser l'essentiel", "Comprendre rapidement", "Tester mes connaissances", "Mémoriser les notions", "Interroger REV-EM"].every(s => txt.includes(s)));
    eq("le gros bandeau « Ce cours est enregistré… » n'existe plus", (await page.$$(".ai-notice")).length, 0);
    check("le hub est AVANT le contenu complémentaire", await page.evaluate(() => { const h = document.getElementById("course-hub"), f = document.querySelector(".fiche-content"); return !f || (h.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; }));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     2-5. Ressources READY → le bon contenu du bon cours
     ==================================================================== */
  await scenario("2. fiche READY : la carte ouvre la fiche de CE cours", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [FULL("A")]);
    await goChapter(page, ids[0]);
    eq("les ressources générables sont READY", await cardStates(page), { fiche: "READY", summary: "READY", quiz: "READY", quizflash: "READY", flashcards: "READY", questions: "READY" });
    await page.click('[data-hub-open="fiche"]');
    await page.waitForSelector(".fiche-content");
    const txt = await bodyText(page);
    check("la fiche du cours A est affichée", txt.includes("Fiche du cours A"), txt.slice(0, 200));
    check("fil d'Ariane : Mes matières › Matière › Chapitre › Fiche", ["Mes matières", "Marketing", "Cours A", "Fiche"].every(s => txt.includes(s)));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("3. résumé READY : la carte ouvre le résumé de CE cours", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [FULL("A")]);
    await goChapter(page, ids[0]);
    await page.click('[data-hub-open="summary"]');
    await page.waitForSelector(".ai-result-body");
    check("le résumé du cours A est affiché", (await bodyText(page)).includes("Résumé du cours A"));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("4. quiz READY : la carte lance le quiz EXISTANT (aucune régénération)", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [FULL("A")]);
    await goChapter(page, ids[0]);
    check("la carte affiche le nombre RÉEL de questions", (await page.innerText('[data-hub-open="quiz"]')).includes("2 questions"));
    await page.click('[data-hub-open="quiz"]');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ tab: state.tab, screen: state.screen, scope: state.playing.scope, pool: state.pool.map(q => q.q).sort() }));
    eq("on est dans le quiz de ce chapitre", [r.tab, r.screen, r.scope], ["quiz", "quiz", "chapter:A"]);
    eq("ce sont exactement les questions stockées", r.pool, ["Question A n°1 ?", "Question A n°2 ?"]);
    eq("aucun appel IA : le contenu existant n'est jamais régénéré", await page.evaluate(() => window.__AI.calls), []);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("5. flashcards READY : la carte lance les flashcards EXISTANTES", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [FULL("A")]);
    await goChapter(page, ids[0]);
    check("la carte affiche le nombre RÉEL de cartes", (await page.innerText('[data-hub-open="flashcards"]')).includes("3 cartes"));
    await page.click('[data-hub-open="flashcards"]');
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ tab: state.tab, screen: state.flashScreen, scope: state.flashDeck.scope, n: state.flashDeck.cards.length, first: state.flashDeck.cards[0].front }));
    eq("on est dans le paquet de ce chapitre", [r.tab, r.screen, r.scope, r.n], ["flash", "play", "A", 3]);
    check("ce sont les cartes du cours A", /Recto A\d/.test(r.first), r);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     6. NOT_GENERATED : cliquable, vue explicite
     ==================================================================== */
  await scenario("6. quiz NOT_GENERATED : la carte reste cliquable et la vue le dit", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [PDFONLY("P")]);
    await goChapter(page, ids[0]);
    const st = await cardStates(page);
    eq("quiz et flashcards : à générer", [st.quiz, st.flashcards], ["NOT_GENERATED", "NOT_GENERATED"]);
    check("aucune carte n'est désactivée", await page.$$eval("[data-hub-open]", e => e.every(x => !x.disabled && x.getAttribute("aria-disabled") !== "true")));
    await page.click('[data-hub-open="quiz"]');
    await page.waitForSelector("[data-hub-generate]");
    const txt = await bodyText(page);
    check("« Ton quiz n'a pas encore été généré. »", txt.includes("Ton quiz n'a pas encore été généré."), txt);
    eq("le bouton propose « Générer le quiz »", (await page.innerText("[data-hub-generate]")).trim(), "Générer le quiz");
    check("fil d'Ariane jusqu'à « Quiz »", ["Mes matières", "Marketing", "Cours P", "Quiz"].every(s => txt.includes(s)));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     7. GENERATING → READY en direct, la carte reste cliquable
     ==================================================================== */
  await scenario("7. génération : la carte passe GENERATING puis READY toute seule", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [PDFONLY("P")]);
    await page.evaluate(() => { window.__AI.delay.quiz = 1200; });
    await goChapter(page, ids[0]);
    await page.click('[data-hub-open="quiz"]');
    await page.click("[data-hub-generate]");
    await page.waitForTimeout(350);
    check("la vue indique la génération en cours (rôle status)", await page.$eval('.hub-view-state[role="status"]', e => /Génération en cours/.test(e.innerText)));
    await page.click("[data-hub-back]");
    await page.waitForSelector("#course-hub");
    eq("retour au cours : la carte quiz est GENERATING", (await cardStates(page)).quiz, "GENERATING");
    check("… et reste cliquable", await page.$eval('[data-hub-open="quiz"]', e => !e.disabled));
    await page.click('[data-hub-open="quiz"]');
    check("cliquer dessus montre l'état de génération", (await bodyText(page)).includes("Génération en cours"));
    await page.waitForFunction(() => !!(findAnyChapter("P").aiQuiz || []).length, null, { timeout: 8000 });
    await page.waitForTimeout(200);
    check("sans rien faire, la vue passe à READY (bouton « Commencer le quiz »)", await page.$eval("[data-hub-start]", e => /Commencer le quiz/.test(e.innerText)));
    await page.click("[data-hub-back]");
    eq("retour au cours : le quiz est READY avec le vrai nombre", [(await cardStates(page)).quiz, (await page.innerText('[data-hub-open="quiz"]')).includes("2 questions")], ["READY", true]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     8. ERROR → Réessayer
     ==================================================================== */
  await scenario("8. échec de génération : état ERROR, message, puis « Réessayer »", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [PDFONLY("P")]);
    await page.evaluate(() => { window.__AI.fail.add("quiz"); });
    await goChapter(page, ids[0]);
    await page.click('[data-hub-open="quiz"]');
    await page.click("[data-hub-generate]");
    await page.waitForSelector(".hub-view-alert", { timeout: 8000 });
    check("message d'erreur affiché (role=alert)", await page.$eval(".hub-view-alert", e => e.getAttribute("role") === "alert" && e.innerText.length > 10));
    eq("le bouton devient « Réessayer »", (await page.innerText("[data-hub-generate]")).trim(), "Réessayer");
    await page.click("[data-hub-back]");
    eq("la carte est en ERROR (et cliquable)", [(await cardStates(page)).quiz, await page.$eval('[data-hub-open="quiz"]', e => !e.disabled)], ["ERROR", true]);
    await page.evaluate(() => { window.__AI.fail.clear(); });
    await page.click('[data-hub-open="quiz"]');
    await page.click("[data-hub-generate]");
    await page.waitForFunction(() => !!(findAnyChapter("P").aiQuiz || []).length, null, { timeout: 8000 });
    await page.waitForTimeout(200);
    eq("après « Réessayer » : READY", await page.evaluate(() => RevemHub.resourceState(findAnyChapter("P"), state.courseGen, "quiz").state), "READY");
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     9. IA indisponible : la page reste utilisable
     ==================================================================== */
  await scenario("9. IA indisponible : outils visibles, message clair au clic, « Réessayer »", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [PDFONLY("P")]);
    await page.evaluate(() => { state.aiStatus = "nogpu"; state.aiGpuDiag = { message: "WebGPU indisponible." }; });
    await goChapter(page, ids[0]);
    eq("les cinq outils restent affichés", (await page.$$("[data-hub-open]")).length, 6);
    check("le PDF reste lisible / téléchargeable", (await page.$$("#lib-open-pdf-btn, #lib-download-pdf-btn")).length === 2);
    await page.click('[data-hub-open="quiz"]');
    await page.click("[data-hub-generate]");
    await page.waitForSelector(".hub-view-alert", { timeout: 8000 });
    check("« L'assistant IA doit être disponible pour générer cette ressource. »", (await bodyText(page)).includes("L'assistant IA doit être disponible pour générer cette ressource."));
    eq("un bouton « Réessayer » est proposé", (await page.innerText("[data-hub-generate]")).trim(), "Réessayer");
    eq("rien ne reste bloqué « en préparation »", (await page.evaluate(() => [state.courseGen.queue.length, state.courseGen.current, state.libGenerateBusy])), [0, null, null]);
    eq("aucun appel IA n'a été tenté", await page.evaluate(() => window.__AI.calls), []);
    await page.click("[data-hub-back]");
    eq("la carte Questions reste un accès valide (l'assistant s'ouvre)", await page.$eval('[data-hub-open="questions"]', e => !e.disabled), true);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     10. Deux cours ne se mélangent jamais
     ==================================================================== */
  await scenario("10. deux cours : chaque carte ouvre SON contenu (jamais par le titre)", async () => {
    const { page, errors } = await open(browser);
    // MÊME titre pour les deux : seuls les identifiants peuvent les distinguer.
    const { ids } = await seed(page, [Object.assign(FULL("A"), { title: "Étude de marché" }), Object.assign(FULL("B"), { title: "Étude de marché" })]);
    await goChapter(page, "B");
    await page.click('[data-hub-open="quiz"]');
    await page.waitForTimeout(250);
    eq("le quiz ouvert est celui de B", await page.evaluate(() => [state.playing.scope, state.pool.every(q => /Question B/.test(q.q))]), ["chapter:B", true]);
    await goChapter(page, "A");
    await page.click('[data-hub-open="flashcards"]');
    await page.waitForTimeout(250);
    eq("les flashcards ouvertes sont celles de A", await page.evaluate(() => [state.flashDeck.scope, state.flashDeck.cards.every(c => /Recto A/.test(c.front))]), ["A", true]);
    await goChapter(page, "B");
    await page.click('[data-hub-open="fiche"]');
    await page.waitForSelector(".fiche-content");
    const txt = await bodyText(page);
    check("la fiche affichée est celle de B, pas celle de A", txt.includes("Fiche du cours B") && !txt.includes("Fiche du cours A"));
    // Une génération pour A ne touche jamais B.
    await page.evaluate(() => { findAnyChapter("A").aiQuiz = []; saveUserChapters(); });
    await goChapter(page, "A");
    await page.evaluate(() => courseHubGenerate("A", ["quiz"]));
    await page.waitForTimeout(400);
    eq("le quiz de B est intact", await page.evaluate(() => findAnyChapter("B").aiQuiz.map(q => q.q)), ["Question B n°1 ?", "Question B n°2 ?"]);
    eq("le quiz de A a bien été généré", await page.evaluate(() => findAnyChapter("A").aiQuiz.length), 2);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     11. Compte A / compte B : aucune contamination
     ==================================================================== */
  await scenario("11. changement de compte en pleine génération : rien n'est écrit chez l'autre compte", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [PDFONLY("A")]);
    await page.evaluate(() => { window.__AI.delay.quiz = 900; });
    await goChapter(page, "A");
    await page.evaluate(() => { window.__genPromise = courseHubGenerate("A", ["quiz"]); });
    await page.waitForTimeout(250);
    eq("la génération de A est en cours", await page.evaluate(() => state.courseGen.current && state.courseGen.current.chapterId), "A");
    // Bascule vers le « compte B » : la VRAIE remise à zéro en mémoire, puis les chapitres de B.
    await page.evaluate(() => {
      resetUserStateInMemory();
      state.userChapters = [{ id: "B", subjectId: "sB", title: "Cours de B", num: "01", content: "", summary: "", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [], originalText: "Texte de B", hasOriginalFile: false }];
    });
    const afterReset = await page.evaluate(() => ({ queue: state.courseGen.queue.length, current: state.courseGen.current, busy: state.libGenerateBusy, ctx: state.aiCourseContext, view: state.library.view }));
    eq("la file du compte A est abandonnée (file neuve, verrou libéré)", afterReset, { queue: 0, current: null, busy: null, ctx: null, view: "subjects" });
    await page.waitForTimeout(1200);
    const b = await page.evaluate(() => ({ chapters: state.userChapters.map(c => c.id), quiz: state.userChapters[0].aiQuiz.length, gen: state.courseGen.running }));
    eq("le compte B ne contient QUE ses chapitres, sans quiz venu de A", [b.chapters, b.quiz], [["B"], 0]);
    eq("la boucle de génération de A s'est arrêtée", b.gen, false);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     12. Retour au cours
     ==================================================================== */
  await scenario("12. retour au cours depuis la vue, le fil d'Ariane, le quiz et les flashcards", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [Object.assign(FULL("A"), { summary: "" })]);
    await goChapter(page, ids[0]);
    await page.click('[data-hub-open="summary"]');
    await page.waitForSelector("[data-hub-back]");
    await page.click("[data-hub-back]");
    eq("« Retour au cours » ramène à la page du chapitre", await page.evaluate(() => [state.library.view, !!document.getElementById("course-hub")]), ["chapterDetail", true]);
    await page.click('[data-hub-open="summary"]');
    await page.click('button[data-crumb="2"]');
    eq("le fil d'Ariane ramène au chapitre", await page.evaluate(() => state.library.view), "chapterDetail");
    await page.click('[data-hub-open="summary"]');
    await page.click('button[data-crumb="1"]');
    eq("… à la matière", await page.evaluate(() => state.library.view), "subjectDetail");
    await goChapter(page, "A");
    await page.click('[data-hub-open="quiz"]');
    await page.waitForSelector(".hub-crumb");
    const crumb = await page.innerText(".hub-crumb");
    check("le quiz a son fil d'Ariane (Mes matières › Marketing › Cours A › Quiz)", ["Mes matières", "Marketing", "Cours A", "Quiz"].every(s => crumb.includes(s)), crumb);
    await page.click('.hub-crumb [data-hub-goto="chapter"]');
    eq("depuis le quiz : retour au cours, hub visible", await page.evaluate(() => [state.tab, state.library.view, !!document.getElementById("course-hub")]), ["library", "chapterDetail", true]);
    await page.click('[data-hub-open="flashcards"]');
    await page.waitForSelector(".hub-crumb");
    await page.click('.hub-crumb [data-hub-goto="chapter"]');
    eq("depuis les flashcards : retour au cours", await page.evaluate(() => [state.tab, state.library.view]), ["library", "chapterDetail"]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     13. Mobile
     ==================================================================== */
  await scenario("13. mobile 390 px : une colonne, aucun défilement horizontal, cibles ≥ 44 px", async () => {
    const { page, errors } = await open(browser, { width: 390, height: 800 });
    const { ids } = await seed(page, [Object.assign(FULL("A"), { title: "Un titre de chapitre très très long pour vérifier qu'il ne fait pas déborder la page mobile" })]);
    await goChapter(page, ids[0]);
    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".hub-card")];
      const xs = new Set(cards.map(c => Math.round(c.getBoundingClientRect().left)));
      return { cols: xs.size, minH: Math.min(...cards.map(c => c.getBoundingClientRect().height)), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    eq("une seule colonne", m.cols, 1);
    check("chaque carte fait au moins 44 px de haut", m.minH >= 44, m);
    check("aucun défilement horizontal", m.overflow <= 0, m);
    await page.setViewportSize({ width: 768, height: 900 });
    eq("tablette : deux colonnes", await page.evaluate(() => new Set([...document.querySelectorAll(".hub-card")].map(c => Math.round(c.getBoundingClientRect().left))).size), 2);
    await page.setViewportSize({ width: 1280, height: 900 });
    const d = await page.evaluate(() => { const c = [...document.querySelectorAll(".hub-card")]; const row = c.filter(x => Math.round(x.getBoundingClientRect().top) === Math.round(c[0].getBoundingClientRect().top)).length; return { cards: c.length, row }; });
    eq("bureau : six cartes, trois par ligne", d, { cards: 6, row: 3 });
    // vue de ressource en mobile
    await page.setViewportSize({ width: 390, height: 800 });
    await page.click('[data-hub-open="fiche"]');
    await page.waitForSelector(".fiche-content");
    check("la vue de ressource ne déborde pas non plus", await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     14. Clavier + accessibilité
     ==================================================================== */
  await scenario("14. clavier : Tab atteint chaque carte, Entrée l'active, focus visible, aria", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [FULL("A")]);
    await goChapter(page, ids[0]);
    check("les cartes sont de vrais <button>", await page.$$eval(".hub-card", e => e.length === 6 && e.every(x => x.tagName === "BUTTON" && x.type === "button")));
    check("chaque carte a un nom accessible complet", await page.$$eval(".hub-card", e => e.every(x => (x.getAttribute("aria-label") || "").length > 10)));
    check("la section est un repère nommé", await page.$eval("#course-hub", e => e.tagName === "SECTION" && !!document.getElementById(e.getAttribute("aria-labelledby"))));
    await page.focus('[data-hub-open="fiche"]');
    await page.keyboard.press("Tab");
    eq("Tab passe à la carte suivante", await page.evaluate(() => document.activeElement.dataset.hubOpen), "summary");
    check("le focus est visible (contour)", await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return parseFloat(s.outlineWidth) > 0 && s.outlineStyle !== "none"; }));
    await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
    eq("Entrée sur la carte Quiz lance le quiz", await page.evaluate(() => [state.tab, state.playing && state.playing.scope]), ["quiz", "chapter:A"]);
    await goChapter(page, "A");
    await page.focus('[data-hub-open="flashcards"]');
    await page.keyboard.press("Space");
    await page.waitForTimeout(250);
    eq("Espace sur la carte Flashcards les lance", await page.evaluate(() => state.tab), "flash");
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     15. Jamais deux lancements ; un seul travail WebLLM à la fois
     ==================================================================== */
  await scenario("15. double clic / « Tout générer » : aucune génération en double, une seule à la fois", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [PDFONLY("P")]);
    await page.evaluate(() => { window.__AI.delay.quiz = 500; window.__AI.delay.flashcards = 300; });
    await goChapter(page, ids[0]);
    await page.click('[data-hub-open="quiz"]');
    await page.evaluate(() => { const b = document.querySelector("[data-hub-generate]"); b.click(); b.click(); b.click(); });
    await page.evaluate(() => { courseHubGenerate("P", ["quiz"]); courseHubGenerate("P", ["quiz"]); });
    await page.waitForFunction(() => !state.courseGen.running, null, { timeout: 8000 });
    eq("le quiz n'a été demandé à l'IA qu'UNE fois", await page.evaluate(() => window.__AI.calls.filter(c => c === "quiz").length), 1);
    // « Tout générer » : file séquentielle.
    await page.evaluate(() => { window.__AI.calls.length = 0; window.__AI.maxActive = 0; findAnyChapter("P").aiQuiz = []; saveUserChapters(); });
    await goChapter(page, "P");
    check("le bouton « Tout générer » est présent (il reste des choses à générer)", (await page.$$("#lib-generate-ai-btn")).length === 1);
    await page.click("#lib-generate-ai-btn");
    await page.waitForTimeout(150);
    const mid = await cardStates(page);
    const jobs = Object.entries(mid).filter(([k]) => k !== "quizflash");   // Quiz Flash reflète le travail du quiz : même travail, pas un second
    check("pendant la génération : un travail GENERATING, les autres QUEUED (jamais deux travaux à la fois)", jobs.filter(([, s]) => s === "GENERATING").length <= 1 && jobs.some(([, s]) => s === "GENERATING" || s === "QUEUED"), mid);
    check("le bouton « Tout générer » est neutralisé pendant le travail", await page.$eval("#lib-generate-ai-btn", e => e.disabled));
    await page.waitForFunction(() => !state.courseGen.running, null, { timeout: 15000 });
    const end = await page.evaluate(() => ({ calls: window.__AI.calls.slice(), max: window.__AI.maxActive }));
    eq("jamais deux travaux WebLLM en même temps", end.max, 1);
    eq("chaque ressource manquante a été demandée UNE fois, dans l'ordre du pipeline", end.calls, ["fiche", "summary", "quiz", "flashcards", "reviewQuestions"]);
    eq("tout est READY à la fin", await cardStates(page), { fiche: "READY", summary: "READY", quiz: "READY", quizflash: "READY", flashcards: "READY", questions: "READY" });
    check("« Tout générer » disparaît quand il n'y a plus rien à générer", (await page.$$("#lib-generate-ai-btn")).length === 0);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ====================================================================
     16. « Chapitre sans contenu » vs PDF importé ; Questions → assistant
     ==================================================================== */
  await scenario("16. « pas de contenu » n'est plus affiché quand un PDF existe", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [PDFONLY("P"), { id: "V", title: "Vide" }, { id: "T", title: "Texte", originalText: SRC }]);
    await goChapter(page, "P");
    let txt = await bodyText(page);
    check("PDF importé : « Ton cours est disponible depuis le PDF importé. »", txt.includes("Ton cours est disponible depuis le PDF importé."), txt.slice(0, 500));
    check("… et l'ancien message n'apparaît pas", !txt.includes("n'a pas encore de contenu"));
    await goChapter(page, "T");
    txt = await bodyText(page);
    check("texte enregistré sans fiche : message adapté", txt.includes("Ton cours est enregistré.") && !txt.includes("n'a pas encore de contenu"));
    await goChapter(page, "V");
    txt = await bodyText(page);
    check("chapitre réellement vide : l'ancien message est conservé", txt.includes("Ce chapitre n'a pas encore de contenu."));
    eq("chapitre vide : les cinq cartes restent affichées et cliquables", await page.$$eval("[data-hub-open]", e => e.length === 6 && e.every(x => !x.disabled)), true);
    await page.click('[data-hub-open="quiz"]');
    await page.waitForSelector("[data-hub-edit]");
    check("chapitre vide : la vue propose de modifier le chapitre (pas de génération impossible)", (await bodyText(page)).includes("Ce cours n'a pas de texte à analyser."));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("17. carte Questions : l'assistant s'ouvre avec CE cours pour contexte", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [FULL("A"), FULL("B")]);
    await goChapter(page, "B");
    await page.click('[data-hub-open="questions"]');
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({ tab: state.tab, ctx: state.aiCourseContext, label: state.aiContextLabel, prompt: state.aiThread[0] && state.aiThread[0].content }));
    eq("l'onglet Assistant s'ouvre", r.tab, "ai");
    eq("le contexte porte les trois identifiants stables", r.ctx, { courseId: "B", chapterId: "B", subjectId: "subj_hub" });
    check("le texte du cours B (et pas celui de A) est fourni à l'assistant", /\(B\)/.test(r.prompt) && !/\(A\)/.test(r.prompt), r.label);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("18. compatibilité : « Marquer comme révisé », PDF, édition et suppression restent là", async () => {
    const { page, errors } = await open(browser);
    const { ids } = await seed(page, [Object.assign(FULL("A"), { hasOriginalFile: true, sourceFileName: "cours.pdf" })]);
    await goChapter(page, "A");
    eq("les actions existantes sont présentes", await page.evaluate(() => ["lib-edit-chapter-btn", "lib-delete-chapter-btn", "lib-mark-reviewed-btn", "lib-open-pdf-btn", "lib-download-pdf-btn"].map(id => !!document.getElementById(id))), [true, true, true, true, true]);
    await page.click("#lib-mark-reviewed-btn");
    eq("« Marquer comme révisé » fonctionne", await page.evaluate(() => findAnyChapter("A").markedReviewed), true);
    check("les outils IA et les éditeurs de quiz / flashcards sont conservés", (await page.$$(".lib-tools")).length === 1 && (await bodyText(page)).includes("Modifier les flashcards"));
    eq("un chapitre intégré (non importé) n'a PAS de hub", await page.evaluate(() => { libGoto("chapterDetail", { chapterId: CHAPTERS[0].id }); switchTab("library"); return !!document.getElementById("course-hub"); }), false);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${(e && e.stack) || e}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
