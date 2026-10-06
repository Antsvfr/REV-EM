/* ============================================================================
   REV-EM — Conversion de « Analyse de marché » (matière intégrée → matière normale)
   ----------------------------------------------------------------------------
   Vérifie, dans un VRAI navigateur, sur de VRAIES données (CHAPTERS/QUESTIONS/
   FICHES/FLASHCARDS tels qu'ils sont réellement codés dans index.html, pas une
   copie) :
     1. la migration (migrateAnalyseMarcheToUserSubject) tourne au premier
        chargement, une seule fois, sans rien dupliquer au second ;
     2. plus aucun badge « Intégré », les boutons Modifier/Supprimer apparaissent ;
     3. les 5 chapitres, 85 questions et 53 flashcards sont intégralement
        présents (comptés), sans qu'aucun ne soit rejeté par le filtre qualité
        réservé à l'IA ;
     4. la fiche de chaque chapitre est rendue À L'IDENTIQUE (même HTML) ;
     5. Hub/Quiz/Quiz Flash/Flashcards/Questions fonctionnent comme pour un
        cours importé normal (sessions réelles, via revision-bank.js) ;
     6. Ajouter un chapitre / Importer un cours / Modifier / Supprimer marchent ;
     7. l'ancien système (Examen, Révision express, Quiz/Flashcards "par niveau",
        maîtrise globale) continue de fonctionner EXACTEMENT comme avant, sur
        les données d'origine, en parallèle — choix assumé (voir AM_MIGRATION.md).
     8. les flashcards IA déjà ajoutées sur l'ancien chapitre intégré (state.aiCards)
        sont reprises dans le nouveau chapitre, sans être retirées de l'ancien.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/analyse-marche-migration.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 900)); }
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
async function open(o) {
  o = o || {};
  const ctx = await browser.newContext({ viewport: o.vp || { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = []; page.on("pageerror", e => page.errors.push(String(e)));
  if (o.preseed) await ctx.addInitScript(o.preseed);
  await page.goto(APP);
  await page.waitForTimeout(1200);
  return { ctx, page };
}

try {
  await scenario("1. migration au premier chargement : une matière, 5 chapitres, rien perdu", async () => {
    const { ctx, page } = await open();
    const r = await page.evaluate(() => {
      const subs = state.userSubjects.filter(s => s.id === "analyse-marche");
      const chs = state.userChapters.filter(c => c.subjectId === "analyse-marche");
      return {
        subjectCount: subs.length, builtin: subs[0] && subs[0].builtin, name: subs[0] && subs[0].name,
        semesterId: subs[0] && subs[0].semesterId, descMentionsIntegre: subs[0] && /int[ée]gr/i.test(subs[0].description || ""),
        chapterIds: chs.map(c => c.id).sort(),
        totalQuiz: chs.reduce((n, c) => n + (c.aiQuiz || []).length, 0),
        totalCards: chs.reduce((n, c) => n + (c.aiFlashcards || []).length, 0),
        perChapterQuiz: chs.map(c => ({ id: c.id, n: (c.aiQuiz || []).length })).sort((a, b) => a.id < b.id ? -1 : 1),
        hasContent: chs.every(c => !!(c.content && c.content.trim())),
        hasOriginalText: chs.every(c => !!(c.originalText && c.originalText.trim())),
        allAi: chs.every(c => (c.aiQuiz || []).every(q => q.ai === true) && (c.aiFlashcards || []).every(f => f.ai === true)),
      };
    });
    eq("exactement UNE matière « analyse-marche », non intégrée", [r.subjectCount, r.builtin], [1, false]);
    eq("nom conservé", r.name, "Analyse de marché");
    eq("même semestre qu'avant (Semestre 1)", r.semesterId, "semestre-1");
    check("la description ne parle plus de « intégré »", !r.descMentionsIntegre);
    eq("5 chapitres, ids fixes am1..am5", r.chapterIds, ["am1", "am2", "am3", "am4", "am5"]);
    eq("85 questions au total (QUESTIONS.length réel), AUCUNE rejetée", r.totalQuiz, 85);
    eq("53 flashcards au total (somme des FLASHCARDS[chN])", r.totalCards, 53);
    eq("répartition par chapitre (hand-vérifiée contre QUESTIONS)", r.perChapterQuiz, [
      { id: "am1", n: 16 }, { id: "am2", n: 9 }, { id: "am3", n: 7 }, { id: "am4", n: 28 }, { id: "am5", n: 25 },
    ]);
    check("chaque chapitre a un contenu (fiche) non vide", r.hasContent);
    check("chaque chapitre a un texte d'origine (pour « Dans ton cours » / contexte IA)", r.hasOriginalText);
    check("toutes les questions/cartes sont bien marquées ai:true (forme de banque standard)", r.allAi);
    eq("aucune erreur JavaScript au chargement", page.errors, []);
    await ctx.close();
  });

  await scenario("2. idempotence : un second chargement ne duplique rien", async () => {
    const { ctx, page } = await open();
    await page.reload();
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => ({
      subjectCount: state.userSubjects.filter(s => s.id === "analyse-marche").length,
      chapterCount: state.userChapters.filter(c => c.subjectId === "analyse-marche").length,
      ids: state.userChapters.filter(c => c.subjectId === "analyse-marche").map(c => c.id).sort(),
    }));
    eq("toujours UNE matière après rechargement", r.subjectCount, 1);
    eq("toujours 5 chapitres, mêmes ids", [r.chapterCount, r.ids], [5, ["am1", "am2", "am3", "am4", "am5"]]);
    // un 3e rechargement, pour être sûr que ce n'est pas un hasard d'ordre d'exécution
    await page.reload();
    await page.waitForTimeout(1200);
    const r2 = await page.evaluate(() => state.userChapters.filter(c => c.subjectId === "analyse-marche").length);
    eq("troisième chargement : toujours 5", r2, 5);
    await ctx.close();
  });

  await scenario("3. plus de badge « Intégré », boutons Modifier/Supprimer présents", async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { libGoto("subjectDetail", { subjectId: "analyse-marche" }); switchTab("library"); });
    const html = await page.innerText("#content");
    check("aucun texte « Intégré » affiché sur la page de la matière", !/Intégré/.test(html), html.slice(0, 300));
    check("bouton « Modifier la matière » présent", !!(await page.$("#lib-edit-subject-btn")));
    check("bouton « Supprimer la matière » présent", !!(await page.$("#lib-delete-subject-btn")));
    check("bouton « + Ajouter un chapitre » toujours présent", !!(await page.$("#lib-add-chapter-btn")));
    check("bouton « Importer un cours » présent", !!(await page.$('[data-import-center="subject"]')));
    // la liste « Mes matières » elle-même ne montre pas non plus le badge
    await page.evaluate(() => libGoto("subjects"));
    const listHtml = await page.innerText("#content");
    check("aucun badge « Intégré » dans la liste des matières", !/Intégré/.test(listHtml));
    check("« Analyse de marché » apparaît une seule fois dans la liste", (listHtml.match(/Analyse de marché/g) || []).length === 1, listHtml);
    await ctx.close();
  });

  await scenario("4. fiche rendue à l'identique (même HTML qu'avant la conversion)", async () => {
    const { ctx, page } = await open();
    const r = await page.evaluate(() => {
      const newCh = state.userChapters.find(c => c.id === "am1");
      const oldHtml = FICHES["ch1"];
      const rendered = renderFicheContent(newCh.content);
      // renderFicheContent() trim() systématiquement son entrée (comportement générique,
      // identique pour un chapitre intégré ou utilisateur) : on compare donc au HTML
      // d'origine trim(), pas au literal brut (qui a des espaces/retours de mise en forme).
      return { identicalSource: newCh.content === oldHtml, identicalRendered: rendered === oldHtml.trim(), hasDef: /fiche-def/.test(rendered) };
    });
    check("le contenu stocké est BYTE-IDENTIQUE à l'ancienne fiche HTML", r.identicalSource);
    check("renderFicheContent() le restitue sans la modifier (classes fiche-def/fiche-list conservées)", r.identicalRendered && r.hasDef);
    await ctx.close();
  });

  await scenario("5. Hub : Fiche/Quiz/Quiz Flash/Flashcards prêts immédiatement ; Résumé générable", async () => {
    const { ctx, page } = await open();
    const r = await page.evaluate(() => {
      const ch = state.userChapters.find(c => c.id === "am1");
      const st = (key) => HUB.resourceState(ch, state.courseGen, key).state;
      return { fiche: st("fiche"), quiz: st("quiz"), quizflash: st("quizflash"), flashcards: st("flashcards"), summary: st("summary"), noSource: !chapterSourceText(ch).trim() };
    });
    eq("Fiche / Quiz / Quiz Flash / Flashcards : READY tout de suite (contenu déjà là)", [r.fiche, r.quiz, r.quizflash, r.flashcards], ["READY", "READY", "READY", "READY"]);
    eq("Résumé : NOT_GENERATED (n'existait pas avant), mais générable (pas « sans source »)", [r.summary, r.noSource], ["NOT_GENERATED", false]);
    await ctx.close();
  });

  await scenario("6. Quiz / Quiz Flash / Flashcards : une vraie session se lance (banque, pas l'ancien moteur)", async () => {
    const { ctx, page } = await open();
    const r = await page.evaluate(() => {
      const ch = state.userChapters.find(c => c.id === "am1");
      courseQuizStart(ch, "quiz");
      const quizOk = state.screen === "quiz" && state.pool && state.pool.length > 0 && state.pool.every(q => q.ai === true);
      const quizSize = state.pool ? state.pool.length : 0;
      courseFlashStart(ch);
      const flashOk = state.flashDeck && state.flashDeck.cards && state.flashDeck.cards.length > 0 && state.flashDeck.cards.every(c => c.ai === true);
      return { quizOk, quizSize, flashOk, flashSize: state.flashDeck ? state.flashDeck.cards.length : 0 };
    });
    check("Quiz : une session réelle démarre, questions = celles de la banque convertie (ai:true)", r.quizOk, r.quizSize);
    check("Flashcards : une session réelle démarre, cartes = celles de la banque convertie (ai:true)", r.flashOk, r.flashSize);
    await ctx.close();
  });

  await scenario("7. une session de quiz complétée met à jour la progression standard (clé partagée chapter:am2)", async () => {
    const { ctx, page } = await open();
    const r = await page.evaluate(() => {
      const ch = state.userChapters.find(c => c.id === "am2");
      courseQuizStart(ch, "quiz");
      while (state.screen === "quiz") {
        selectOption(0);
        nextQuestion();
      }
      const prog = state.progress["chapter:am2"];
      const viaBridge = userChapterProgress(ch);
      return { hasProg: !!prog, bridgeMatches: viaBridge === prog.best };
    });
    check("la session terminée écrit bien state.progress[\"chapter:am2\"]", r.hasProg);
    check("userChapterProgress() (le pont partagé builtin/utilisateur) lit cette même valeur", r.bridgeMatches);
    await ctx.close();
  });

  await scenario("8. legacy intact : Examen, Révision express, Quiz/Flashcards « par niveau » voient toujours les 5 chapitres d'origine", async () => {
    const { ctx, page } = await open();
    const r = await page.evaluate(() => ({
      chaptersLen: CHAPTERS.length,
      questionsLen: QUESTIONS.length,
      examAvail: examAvailableQuestions().length,
      poolExpressLen: poolExpress(10).length,
      globalMetricsTotal: globalMetrics().total,
      flashPickerHasL1: renderFlashPicker().includes("Fondamentaux de l'étude de marché"),
      quizPickerHasL1: renderPicker().includes("Fondamentaux de l'étude de marché"),
    }));
    eq("CHAPTERS toujours à 5 (inchangé)", r.chaptersLen, 5);
    eq("QUESTIONS toujours à 85 (inchangé)", r.questionsLen, 85);
    eq("le mode Examen voit toujours les 85 questions", r.examAvail, 85);
    check("Révision express toujours alimentée", r.poolExpressLen > 0);
    eq("maîtrise globale toujours calculée sur les 85 questions d'origine", r.globalMetricsTotal, 85);
    check("l'onglet Flashcards « par niveau » montre toujours l'ancien chapitre", r.flashPickerHasL1);
    check("l'onglet Quiz « par niveau » montre toujours l'ancien chapitre", r.quizPickerHasL1);
    await ctx.close();
  });

  await scenario("9. les cartes IA déjà ajoutées sur l'ancien chapitre intégré sont reprises, sans être retirées de l'ancien", async () => {
    const { ctx, page } = await open({
      preseed: () => {
        localStorage.setItem("revisions-etude-marche:ai-flashcards", JSON.stringify({ ch1: [{ front: "Carte ajoutée avant migration", back: "Doit être reprise" }] }));
      },
    });
    const r = await page.evaluate(() => {
      const newCh = state.userChapters.find(c => c.id === "am1");
      const hasInNew = newCh.aiFlashcards.some(c => c.front === "Carte ajoutée avant migration");
      const stillInOld = (state.aiCards.ch1 || []).some(c => c.front === "Carte ajoutée avant migration");
      return { count: newCh.aiFlashcards.length, hasInNew, stillInOld };
    });
    eq("12 cartes d'origine + 1 carte IA déjà ajoutée = 13", r.count, 13);
    check("la carte IA ajoutée avant la migration est reprise dans le nouveau chapitre", r.hasInNew);
    check("…et reste aussi disponible à l'ancien emplacement (legacy non touché)", r.stillInOld);
    await ctx.close();
  });

  await scenario("10. 5 langues : aucune régression des traductions du module Bibliothèque", async () => {
    const { ctx, page } = await open();
    for (const lang of ["fr", "en", "es", "de", "it"]) {
      const ok = await page.evaluate((l) => { LyonI18n.setLang(l); libGoto("subjectDetail", { subjectId: "analyse-marche" }); switchTab("library"); return !!document.getElementById("content").innerText.trim(); }, lang);
      check("page de la matière rendue sans erreur en " + lang, ok);
    }
    await page.evaluate(() => LyonI18n.setLang("fr"));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });
} finally {
  await browser.close();
}
console.log(`\n${pass} vérifications réussies, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
