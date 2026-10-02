/* ============================================================================
   REV-EM — pipeline d'import de cours : contexte, correspondance, doublons,
   persistance immédiate et reprise, dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, dans un vrai Chromium : courseImportProcessFile,
       courseImportResolveTarget, courseImportRunAllSteps, libGenerateChapterAI
       — le pipeline entier, pas une réimplémentation pour le test ;
     • l'extraction de texte collé, la persistance localStorage, le rendu.

   CE QUI EST REMPLACÉ, ET POURQUOI
     `webllmChat`/`webllmJsonChat` sont remplacées par un double déterministe :
     WebLLM a besoin d'un vrai GPU (WebGPU), absent de cet environnement. Le
     double répond selon le CONTENU du prompt (voir keyOfPrompt ci-dessous),
     donc chaque étape du pipeline (détection, fiche, résumé, quiz,
     flashcards, questions) reçoit une réponse cohérente avec ce qu'elle a
     demandé — jamais une réponse générique qui masquerait un mauvais
     câblage. `state.aiStatus = "ready"` évite le téléchargement réel du
     modèle, qui n'a pas sa place dans un test.

     Ce qu'AUCUNE suite ne prouve : qu'un vrai modèle, sur un vrai GPU,
     produit un contenu de qualité. Voir le rapport de l'étape —
     NOT TESTED contre un vrai WebGPU.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/course-import.test.mjs
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

/* Double déterministe de WebLLM : une réponse par NATURE de prompt, jamais
   par ordre d'appel — un appelant qui change l'ordre des étapes ne casse pas
   le test. `window.__AI` garde tout ce qu'il faut inspecter depuis le test :
   les appels reçus, les échecs à simuler, les délais à imposer. */
const FAKE_AI = `
(function(){
  const AI = window.__AI = { calls: [], fail: new Set(), delay: {}, detect: {} };
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
  async function maybeFailOrDelay(key){
    AI.calls.push(key);
    if (AI.delay[key]) await new Promise(r => setTimeout(r, AI.delay[key]));
    if (AI.fail.has(key)) throw new Error("échec simulé : " + key);
  }
  window.webllmChat = async function(turns){
    const key = keyOfChat(turns[0].content);
    await maybeFailOrDelay(key);
    if (key === "detect"){
      const obj = {
        title: AI.detect.title || "Cours de test",
        chapter: AI.detect.chapter || "Chapitre de test",
        level: "", notions: ["notion a", "notion b"],
      };
      if (AI.detect.subject !== undefined) obj.subject = AI.detect.subject;
      return { text: JSON.stringify(obj) };
    }
    if (key === "fiche") return { text: JSON.stringify({
      introduction: "Introduction de test.",
      sections: [{ type: "notions", title: "Notions", items: [{ title: "Terme", content: "Définition." }] }],
      keyPoints: ["Point essentiel."],
    }) };
    if (key === "summary") return { text: "Résumé court\\nphrase.\\nIdées essentielles\\n- une idée" };
    return { text: "" };
  };
  window.webllmJsonChat = async function(turns){
    const key = keyOfJson(turns[0].content);
    await maybeFailOrDelay(key);
    if (key === "quiz") return [{ q: "Quelle est la question de test posée ici ?", opts: ["Réponse un", "Réponse deux", "Réponse trois", "Réponse quatre"], correct: 0, exp: "", sourceQuote: "texte" }];
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
  if (process.env.DEBUG_CONSOLE) page.on("console", m => console.log("  [page]", m.text().slice(0, 300)));
  await page.goto(APP);
  await page.waitForTimeout(900);
  await page.addScriptTag({ content: FAKE_AI });
  await page.evaluate(() => { state.aiStatus = "ready"; });
  return { page, errors };
}

/* Une matière avec, éventuellement, un chapitre déjà là — construites par les
   fonctions réelles du produit (saveUserSubjects/saveUserChapters), jamais
   une seconde structure de données inventée pour le test. */
async function seedSubject(page, { id, name, chapter } = {}) {
  return page.evaluate(({ id, name, chapter }) => {
    const subjectId = id || ("subj_" + Math.random().toString(36).slice(2));
    state.userSubjects.push({ id: subjectId, name: name || "Marketing", semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D", icon: "", description: "" });
    saveUserSubjects();
    let chapterId = null;
    if (chapter) {
      chapterId = chapter.id || ("ch_" + Math.random().toString(36).slice(2));
      state.userChapters.push(Object.assign({
        id: chapterId, subjectId, num: "01", desc: "", level: "",
        content: "", summary: "", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [],
        keyNotions: [], sourceFileName: "", pageCount: null, hasOriginalFile: false,
        createdAt: Date.now(), updatedAt: Date.now(), markedReviewed: false, heuristicMode: false,
        generationPending: false,
      }, chapter));
      saveUserChapters();
    }
    return { subjectId, chapterId };
  }, { id, name, chapter });
}

const pasteAndGoReview = (page, text, fileName) => page.evaluate(({ text, fileName }) => {
  // Reproduit l'état réel d'un utilisateur qui vient de coller son texte sur
  // l'écran d'import — sans quoi le futur clic réel sur les boutons de
  // l'écran de révision ne trouverait rien à l'écran (state.tab resterait
  // sur un autre onglet).
  switchTab("library"); libGoto("import");
  state.courseImport.pasteText = text;
  courseImportAddPasteAsFile();
  if (fileName) state.courseImport.files[state.courseImport.files.length - 1].name = fileName;
  state.courseImport.step = "detect"; // comme le ferait courseImportStart()
  return courseImportProcessFile(state.courseImport.files.length - 1);
}, { text, fileName });

const chapterOf = (page, chapterId) => page.evaluate((id) => findAnyChapter(id), chapterId);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. CONTEXTE PRIORITAIRE — la matière ouverte n'est jamais changée
     ====================================================================== */
  await scenario("1. importer depuis une matière ouverte la verrouille, même si l'IA en suggère une autre", async () => {
    const { page, errors } = await open(browser);
    const { subjectId } = await seedSubject(page, { name: "Marketing" });
    await seedSubject(page, { name: "Finance" }); // une autre matière existe, l'IA pourrait la préférer
    await page.evaluate(() => { window.__AI.detect.subject = "Finance"; }); // réponse "hostile" de l'IA
    await page.evaluate((id) => {
      libGoto("subjectDetail", { subjectId: id }); switchTab("library");
    }, subjectId);
    await page.click("#lib-import-into-subject-btn");
    await page.waitForTimeout(200);
    const locked = await page.evaluate(() => state.courseImport.lockedSubjectId);
    eq("le contexte est retenu dès l'ouverture de l'assistant", locked, subjectId);
    await pasteAndGoReview(page, "Un cours de test sur le marketing, assez long pour être accepté par le pipeline d'import.", "cours.txt");
    const detected = await page.evaluate(() => state.courseImport.files[0].detected);
    eq("la matière reste celle qui était ouverte, jamais « Finance »", detected.subjectId, subjectId);
    eq("aucune nouvelle matière n'est proposée", detected.newSubjectName, "");
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("2. sans contexte, la détection reste libre", async () => {
    const { page, errors } = await open(browser);
    await page.evaluate(() => goToCourseImport());
    await pasteAndGoReview(page, "Un cours de test, importé sans être dans une matière précise.", "libre.txt");
    const locked = await page.evaluate(() => state.courseImport.lockedSubjectId);
    eq("aucun verrouillage sans point d'entrée contextuel", locked, null);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     3. CORRESPONDANCE DE CHAPITRE EXISTANT
     ====================================================================== */
  await scenario("3. un chapitre au titre très proche est proposé, pas recréé", async () => {
    const { page, errors } = await open(browser);
    const { subjectId, chapterId } = await seedSubject(page, { name: "Marketing", chapter: { title: "Étude de marché" } });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; window.__AI.detect.chapter = "Étude de marché"; });
    await pasteAndGoReview(page, "Cours sur les méthodes d'étude de marché, quantitatives et qualitatives.", "etude.txt");
    const detected = await page.evaluate(() => state.courseImport.files[0].detected);
    eq("la matière est retrouvée par correspondance de nom", detected.subjectId, subjectId);
    eq("le chapitre existant est proposé", detected.chapterId, chapterId);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("4. sans chapitre proche, « + Nouveau chapitre » est proposé", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Marketing", chapter: { title: "Étude de marché" } });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; window.__AI.detect.chapter = "Comportement du consommateur"; });
    await pasteAndGoReview(page, "Cours sur le comportement du consommateur, motivations et freins.", "compo.txt");
    const detected = await page.evaluate(() => state.courseImport.files[0].detected);
    eq("aucun chapitre existant n'est proposé à tort", detected.chapterId, null);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     5/6/7. DÉDUPLICATION — jamais silencieuse
     ====================================================================== */
  await scenario("5. réimporter le même fichier propose remplacer / nouvelle entrée / annuler", async () => {
    const { page, errors } = await open(browser);
    const { chapterId } = await seedSubject(page, {
      name: "Marketing",
      chapter: { title: "Cours existant", content: "ancien contenu", sourceFileName: "annales.pdf", originalText: "vieux texte" },
    });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; });
    await pasteAndGoReview(page, "Nouveau contenu qui remplace complètement l'ancien cours enregistré.", "annales.pdf");
    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(400);
    const modal = await page.evaluate(() => !!document.querySelector(".modal--confirm"));
    check("une confirmation explicite est affichée (jamais silencieux)", modal);
    const titre = await page.evaluate(() => document.querySelector(".modal-title").textContent);
    check("elle dit que le cours existe déjà", /existe/i.test(titre), titre);

    await page.click('[data-ds-confirm="no"]'); // annuler
    await page.waitForTimeout(600);
    const apresAnnulation = await page.evaluate((id) => ({
      status: state.courseImport.files[0].status,
      chapitre: findAnyChapter(id).content,
    }), chapterId);
    eq("annuler : retour à l'écran de révision", apresAnnulation.status, "review");
    eq("annuler : rien n'a été modifié", apresAnnulation.chapitre, "ancien contenu");

    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(400);
    await page.click('[data-ds-confirm="yes"]'); // remplacer
    await page.waitForTimeout(1500);
    const chAfter = await chapterOf(page, chapterId);
    check("remplacer : le MÊME chapitre a été mis à jour", chAfter.content && chAfter.content !== "ancien contenu", chAfter.content);
    const count = await page.evaluate(() => state.userChapters.length);
    eq("remplacer : aucun chapitre en plus", count, 1);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("6. « créer une nouvelle entrée » ajoute un second chapitre, sans toucher au premier", async () => {
    const { page, errors } = await open(browser);
    const { chapterId } = await seedSubject(page, {
      name: "Marketing",
      chapter: { title: "Cours existant", content: "ancien contenu", sourceFileName: "annales.pdf" },
    });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; });
    await pasteAndGoReview(page, "Un second cours, même nom de fichier par coïncidence.", "annales.pdf");
    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(400);
    await page.click('[data-ds-confirm="alt"]'); // nouvelle entrée
    await page.waitForTimeout(1500);
    const count = await page.evaluate(() => state.userChapters.length);
    eq("un second chapitre a bien été créé", count, 2);
    const original = await chapterOf(page, chapterId);
    eq("le premier chapitre est intact", original.content, "ancien contenu");
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("7. un chapitre VIDE ne déclenche aucune confirmation (le remplir est le but)", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Marketing", chapter: { title: "Étude de marché" } }); // vide : pas de content/aiQuiz
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; window.__AI.detect.chapter = "Étude de marché"; });
    await pasteAndGoReview(page, "Cours complet sur l'étude de marché, méthodes et outils associés.", "etude.txt");
    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(500);
    const modal = await page.evaluate(() => !!document.querySelector(".modal--confirm"));
    check("aucune confirmation pour un simple emplacement vide", !modal, modal);
    await page.waitForTimeout(1500);
    eq("toujours un seul chapitre", await page.evaluate(() => state.userChapters.length), 1);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     8/9/10. PERSISTANCE IMMÉDIATE ET REPRISE
     ====================================================================== */
  await scenario("8. le cours est enregistré AVANT la fin de la génération", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Marketing" });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; window.__AI.delay.quiz = 300; });
    await pasteAndGoReview(page, "Cours de test pour vérifier la persistance immédiate.", "test.txt");
    page.click("#import-confirm-generate-btn"); // sans attendre : on inspecte PENDANT la génération
    await page.waitForTimeout(250); // la fiche/le résumé ont eu le temps de passer, le quiz est encore en cours (delay 300ms)
    const pendant = await page.evaluate(() => ({
      chapitres: state.userChapters.length,
      contenu: state.userChapters[0] ? !!state.userChapters[0].content : false,
    }));
    check("le chapitre existe déjà avant la fin de la génération", pendant.chapitres === 1, pendant);
    check("la fiche est déjà écrite (étape déjà terminée)", pendant.contenu, pendant);
    await page.waitForTimeout(2500);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("9. reprise après interruption : seules les étapes manquantes sont regénérées", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Marketing" });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; window.__AI.fail.add("quiz"); window.__AI.fail.add("flashcards"); });
    await pasteAndGoReview(page, "Cours de test pour vérifier la reprise après interruption.", "reprise.txt");
    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(2500);
    const chapterId = await page.evaluate(() => state.userChapters[0].id);
    const echec = await chapterOf(page, chapterId);
    check("la fiche a réussi", !!(echec.content && echec.content.trim()), echec.content);
    check("le résumé a réussi", !!(echec.summary && echec.summary.trim()), echec.summary);
    check("le quiz a échoué : resté vide, pas d'invention", echec.aiQuiz.length === 0, echec.aiQuiz);
    check("les flashcards ont échoué : restées vides", echec.aiFlashcards.length === 0, echec.aiFlashcards);
    check("les questions de révision ont réussi", echec.aiReviewQuestions.length > 0, echec.aiReviewQuestions);
    check("le chapitre se signale « en attente » de génération", echec.generationPending === true, echec);

    /* L'onglet est fermé et rouvert (F5) : la reprise doit lire l'état
       réellement écrit, pas un état en mémoire de l'assistant d'import. */
    await page.reload();
    await page.waitForTimeout(900);
    await page.addScriptTag({ content: FAKE_AI });
    await page.evaluate(() => { state.aiStatus = "ready"; }); // le quiz/les flashcards ne sont plus en échec cette fois

    await page.evaluate((id) => { libGoto("chapterDetail", { chapterId: id }); switchTab("library"); }, chapterId);
    const avant = await page.evaluate(() => document.getElementById("lib-generate-ai-btn"));
    check("le bouton de reprise est proposé après rechargement", !!avant);
    await page.click("#lib-generate-ai-btn");
    await page.waitForTimeout(1500);

    const appels = await page.evaluate(() => window.__AI.calls);
    check("SEULES les étapes manquantes ont été redemandées (quiz, flashcards)",
      appels.filter(k => k === "quiz" || k === "flashcards").length === 2
      && appels.filter(k => k === "fiche" || k === "summary" || k === "reviewQuestions").length === 0,
      appels);
    const final = await chapterOf(page, chapterId);
    check("le quiz est désormais présent", final.aiQuiz.length > 0, final.aiQuiz);
    check("les flashcards sont désormais présentes", final.aiFlashcards.length > 0, final.aiFlashcards);
    check("la fiche obtenue avant l'interruption n'a pas été regénérée pour rien", final.content === echec.content, { avant: echec.content, apres: final.content });
    eq("plus rien en attente", final.generationPending, false);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("10. mode simplifié : « Générer avec l'IA » régénère TOUT (mise à niveau complète)", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Marketing" });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; });
    await pasteAndGoReview(page, "Cours de test pour le mode simplifié : Définition : une explication ici.", "simple.txt");
    await page.click("#import-save-noai-btn");
    await page.waitForTimeout(600);
    const chapterId = await page.evaluate(() => state.userChapters[0].id);
    const avant = await chapterOf(page, chapterId);
    check("mode simplifié : une fiche existe déjà (heuristique)", !!avant.content, avant.content);
    eq("marqué comme mode simplifié", avant.heuristicMode, true);

    await page.evaluate((id) => { libGoto("chapterDetail", { chapterId: id }); switchTab("library"); }, chapterId);
    await page.click("#lib-generate-ai-btn");
    await page.waitForTimeout(1500);
    const appels = await page.evaluate(() => window.__AI.calls);
    eq("les 5 étapes sont TOUTES redemandées à l'IA (mise à niveau, pas un complément)",
      ["fiche", "summary", "quiz", "flashcards", "reviewQuestions"].every(k => appels.includes(k)), true);
    const apres = await chapterOf(page, chapterId);
    eq("le mode simplifié est levé une fois l'IA passée", apres.heuristicMode, false);
    eq("plus rien en attente", apres.generationPending, false);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     11. NE JAMAIS BLOQUER L'UTILISATEUR
     ====================================================================== */
  await scenario("11. la génération continue même si l'utilisateur change d'onglet", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Marketing" });
    await page.evaluate(() => { window.__AI.detect.subject = "Marketing"; });
    await pasteAndGoReview(page, "Cours de test pour vérifier la navigation pendant la génération.", "nav.txt");
    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(200);
    await page.evaluate(() => switchTab("dashboard")); // l'utilisateur s'en va pendant la génération
    await page.waitForTimeout(1800);
    const ch = await page.evaluate(() => state.userChapters[0]);
    check("le cours a bien fini de se générer malgré la navigation", ch && ch.aiQuiz.length > 0, ch);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     12. MATCHSUBJECTBYNAME RESSERRÉ
     ====================================================================== */
  await scenario("12. un nom exact ne se laisse plus piéger par une variante plus longue", async () => {
    const { page, errors } = await open(browser);
    await seedSubject(page, { name: "Management" });
    await seedSubject(page, { name: "Management commercial" });
    await page.evaluate(() => { window.__AI.detect.subject = "Management"; });
    await pasteAndGoReview(page, "Cours sur le management, exactement ce sujet précis.", "mgmt.txt");
    const detected = await page.evaluate(() => state.courseImport.files[0].detected);
    const matched = await page.evaluate((id) => findSubject(id).name, detected.subjectId);
    eq("« Management » exact retrouve « Management », pas « Management commercial »", matched, "Management");
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     13. MESSAGE HONNÊTE POUR UN FICHIER ABSENT DE CET APPAREIL
     ====================================================================== */
  await scenario("13. un PDF importé ailleurs affiche un message qui n'affirme pas une suppression", async () => {
    const { page, errors } = await open(browser);
    const { chapterId } = await seedSubject(page, {
      name: "Marketing",
      chapter: { title: "Cours avec PDF", content: "contenu", hasOriginalFile: true, sourceFileName: "cours.pdf" },
    });
    await page.evaluate((id) => { libGoto("chapterDetail", { chapterId: id }); switchTab("library"); }, chapterId);
    const alerts = [];
    page.on("dialog", async (d) => { alerts.push(d.message()); await d.dismiss(); });
    await page.click("#lib-open-pdf-btn");
    await page.waitForTimeout(300);
    check("un message apparaît", alerts.length === 1, alerts);
    check("il ne prétend pas qu'un fichier a été supprimé (jamais présent ici)", !/n'est plus disponible/i.test(alerts[0] || ""), alerts[0]);
    check("il reste honnête et compréhensible", /appareil/i.test(alerts[0] || ""), alerts[0]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* ======================================================================
     14. PARCOURS COMPLET, BOUT EN BOUT (le §37 du cahier des charges)
     ====================================================================== */
  await scenario("14. le parcours décrit dans le cahier des charges fonctionne de bout en bout", async () => {
    const { page, errors } = await open(browser);
    const { subjectId } = await seedSubject(page, { name: "Marketing" });
    await page.evaluate(() => { window.__AI.detect.chapter = "Étude de marché"; });
    await page.evaluate((id) => { libGoto("subjectDetail", { subjectId: id }); switchTab("library"); }, subjectId);
    await page.click("#lib-import-into-subject-btn");
    await page.waitForTimeout(200);
    /* Le bouton ouvre l'Import Center (fenêtre) et pose le contexte de la matière ; ce
       scénario simule ensuite le texte collé directement dans le pipeline : on referme la fenêtre. */
    await page.evaluate(() => closeImportCenter());
    await pasteAndGoReview(page, "Les méthodes quantitatives et qualitatives d'étude de marché, avec leurs avantages respectifs.", "etude-marche.pdf");
    await page.click("#import-confirm-generate-btn");
    await page.waitForTimeout(2200);

    const r = await page.evaluate((sid) => {
      const ch = state.userChapters[0];
      return {
        subjectCount: state.userSubjects.filter(s => s.id === sid).length,
        chapterSubject: ch.subjectId,
        hasFiche: !!(ch.content && ch.content.trim()),
        quiz: ch.aiQuiz.length, cards: ch.aiFlashcards.length, reviewQ: ch.aiReviewQuestions.length,
        pending: ch.generationPending,
      };
    }, subjectId);
    eq("toujours une seule matière (aucun doublon créé)", r.subjectCount, 1);
    eq("le cours est dans la bonne matière", r.chapterSubject, subjectId);
    check("une fiche existe", r.hasFiche, r);
    check("un quiz existe", r.quiz > 0, r);
    check("des flashcards existent", r.cards > 0, r);
    check("des questions de révision existent", r.reviewQ > 0, r);
    eq("plus rien en attente : le cours est complet", r.pending, false);

    /* "Je ferme REV-EM, je me reconnecte plus tard" — simulé par un
       rechargement complet de la page, qui relit tout depuis localStorage. */
    await page.reload();
    await page.waitForTimeout(900);
    const apresReload = await page.evaluate(() => ({
      subjects: state.userSubjects.map(s => s.name),
      quiz: state.userChapters[0] ? state.userChapters[0].aiQuiz.length : 0,
    }));
    eq("tout est toujours là après réouverture", apresReload.subjects.includes("Marketing") && apresReload.quiz > 0, true);
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
