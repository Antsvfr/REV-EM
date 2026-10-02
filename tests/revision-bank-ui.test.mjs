/* ============================================================================
   REV-EM — banque de révision et sessions mélangées, dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, dans un vrai Chromium : le hub (six cartes), les
       sessions Quiz / Quiz Flash / Flashcards construites par le vrai
       SessionBuilder (revision-bank.js), le vrai quiz (clics sur les vrais
       boutons de réponse), « Nouveau quiz », « Recommencer », la génération de
       banque par lots (generateQuestionBank), la file séquentielle, l'import ;
     • le stockage local (rechargement de la page) ;
     • la fonction réelle de changement de compte (resetUserStateInMemory).

   CE QUI EST REMPLACÉ, ET POURQUOI
     `webllmChat`/`webllmJsonChat` : un double déterministe (WebLLM exige un
     vrai GPU WebGPU, absent ici). Il fabrique des questions/cartes DISTINCTES à
     chaque appel et compte les travaux simultanés (maxActive).
   CE QU'AUCUNE SUITE NE PROUVE : qu'un vrai modèle sur un vrai GPU (le Mac de
   l'utilisateur) écrit de bonnes questions. NOT TESTED contre un vrai WebLLM.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/revision-bank-ui.test.mjs
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
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  current = name; console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

/* Double de WebLLM : questions / cartes DISTINCTES à chaque appel (compteur), 4 choix plausibles
   de longueur comparable, concept et difficulté renseignés. */
const FAKE_AI = `
(function(){
  const AI = window.__AI = { calls: [], fail: new Set(), delay: {}, detect: {}, active: 0, maxActive: 0, n: 0 };
  const CONCEPTS = ["Croissance", "Révolution industrielle", "Productivité", "Technologie", "Niveau de vie"];
  const DIFF = ["easy", "medium", "hard"];
  /* Deux mots UNIQUES par élément (comme de vraies questions, qui portent sur des points différents) :
     sans cela, le dédoublonnage (Jaccard ≥ 0,8) les prendrait à raison pour des doublons. */
  const A = ["agriculture", "machine", "vapeur", "électricité", "pétrole", "acier", "chemin", "usine", "salaire", "épargne", "capital", "travail"];
  const B = ["brevet", "innovation", "commerce", "banque", "transport", "énergie", "automatisation", "urbanisation", "mondialisation", "productivité", "croissance", "logistique"];
  const FRAMES = ["Quelle affirmation décrit correctement le rôle de X dans le cours étudié ?", "Pourquoi X est-il mentionné parmi les mécanismes essentiels de cette partie ?", "Dans quel cas précis faut-il appliquer la notion de X selon le texte ?", "Quel élément distingue X des autres notions présentées ici ?"];
  const C = ["rural", "urbain", "public", "privé", "ancien", "récent", "local", "global", "fiscal", "social", "rare", "massif", "léger", "lourd", "lent", "rapide"];
  const term = (k) => A[k % 12] + " " + B[(k * 5 + Math.floor(k / 12)) % 12] + " " + C[(k * 3) % 16];
  function keyOfChat(p){
    if (/déduis un titre court/.test(p)) return "detect";
    if (/fiche de révision structurée/.test(p)) return "fiche";
    if (/résumé très court/.test(p)) return "summary";
    return "unknown-chat";
  }
  function keyOfJson(p){
    if (/questions pour réviser CETTE partie/.test(p)) return "quiz";
    if (/flashcards de révision pour CETTE partie/.test(p)) return "flashcards";
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
    const p = turns[0].content, key = keyOfJson(p);
    await step(key);
    const ms = p.match(/TÂCHE : génère (\\d+)/g); const count = ms ? parseInt(ms[ms.length - 1].replace(/\\D/g, "")) : 6;
    if (key === "quiz") return Array.from({ length: count }, () => { const k = AI.n++; return {
      q: FRAMES[k % 4].replace("X", term(k)),
      opts: ["Définition exacte du point " + k, "Contresens plausible numéro " + k, "Confusion fréquente numéro " + k, "Simplification abusive " + k], correct: k % 4 === 0 ? 0 : 0,
      concept: CONCEPTS[k % 5], type: "definition", difficulty: DIFF[k % 3], exp: "Parce que.", sourceQuote: "texte" }; });
    if (key === "flashcards") return Array.from({ length: count }, () => { const k = AI.n++; return {
      front: "Qu'est-ce que " + term(k) + " ?", back: "Une définition détaillée de ce point du cours, en une phrase claire (" + k + ").",
      concept: CONCEPTS[k % 5], sourceQuote: "texte" }; });
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

const CONCEPTS = ["Croissance", "Révolution industrielle", "Productivité", "Technologie", "Niveau de vie"];
const bankQ = (tag, n = 20) => Array.from({ length: n }, (_, i) => ({
  uid: "q_" + tag + i, id: "q_" + tag + i, ai: true, theme: "ai", type: "mcq",
  q: "Question " + tag + " numéro " + i + " sur le concept étudié ?",
  opts: ["Réponse juste " + tag + i, "Réponse fausse B" + tag + i, "Réponse fausse C" + tag + i, "Réponse fausse D" + tag + i], correct: i % 4, exp: "",
  concept: CONCEPTS[i % 5], difficulty: ["easy", "medium", "hard"][i % 3], section: i % 5, chapterId: tag, courseId: tag,
})).map(q => { q.opts = q.opts.slice(); const good = q.opts[0]; q.opts.splice(0, 1); q.opts.splice(q.correct, 0, good); return q; });
const bankF = (tag, n = 18) => Array.from({ length: n }, (_, i) => ({ id: "f_" + tag + i, front: "Qu'est-ce que la notion " + tag + i + " ?", back: "Définition détaillée de la notion numéro " + tag + i + ", en une phrase.", ai: true, concept: CONCEPTS[i % 5], section: i % 5, chapterId: tag, reversible: true, revTerm: "Notion " + tag + i }));
const SRC = "Le marketing est l'ensemble des méthodes qui permettent de comprendre un marché. Une étude de marché collecte et analyse des informations pour soutenir la décision commerciale.";

async function seed(page, chapters) {
  return page.evaluate((chapters) => {
    const subjectId = "subj_bank";
    state.userSubjects.push({ id: subjectId, name: "Économie", semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D", icon: "", description: "" });
    saveUserSubjects();
    chapters.forEach((c, i) => {
      state.userChapters.push(Object.assign({
        id: "uc" + i, subjectId, num: "0" + (i + 1), desc: "", level: "", title: "Chapitre " + (i + 1),
        content: "Fiche du cours.\n\n- point", summary: "Résumé", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [],
        keyNotions: [], sourceFileName: "", pageCount: null, hasOriginalFile: false, originalText: "",
        createdAt: Date.now(), updatedAt: Date.now(), markedReviewed: false, heuristicMode: false, generationPending: false,
      }, c));
    });
    saveUserChapters();
    return subjectId;
  }, chapters);
}
const goChapter = (page, id) => page.evaluate((id) => { libGoto("chapterDetail", { chapterId: id }); switchTab("library"); }, id);
const cardStates = (page) => page.$$eval("[data-hub-open]", els => Object.fromEntries(els.map(e => [e.dataset.hubOpen, e.dataset.hubState])));
const poolIds = (page) => page.evaluate(() => state.pool.map(q => q.uid));
const bankSnap = (page, id) => page.evaluate((id) => JSON.stringify([findAnyChapter(id).aiQuiz, findAnyChapter(id).aiFlashcards]), id);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* 1-2-4 : sessions successives différentes, choix mélangés, questions fraîches d'abord */
  await scenario("1. Quiz : chaque ouverture crée une NOUVELLE session (autres questions, autre ordre, choix mélangés)", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), aiFlashcards: bankF("A"), originalText: SRC }]);
    await goChapter(page, "uc0");
    eq("six accès : Fiche, Résumé, Quiz, Quiz Flash, Flashcards, Questions", await page.$$eval("[data-hub-open]", e => e.map(x => x.dataset.hubOpen)), ["fiche", "summary", "quiz", "quizflash", "flashcards", "questions"]);
    const sessions = [], perms = [];
    for (let i = 0; i < 6; i++) {
      await page.click('[data-hub-open="quiz"]');
      await page.waitForSelector(".qz-opt");
      sessions.push(await poolIds(page));
      perms.push(await page.evaluate(() => state.pool.map(q => q.perm.join(""))));
      await page.click('.hub-crumb [data-hub-goto="chapter"]');
      await page.waitForSelector("#course-hub");
    }
    eq("chaque session joue 10 questions (taille de la Révision express existante)", sessions.map(s => s.length), [10, 10, 10, 10, 10, 10]);
    const consecutive = sessions.slice(1).map((s, i) => s.join() === sessions[i].join());
    check("TEST 1 — jamais deux sessions consécutives identiques (ordre)", consecutive.every(x => !x), consecutive);
    const overlap = sessions.slice(1).map((s, i) => s.filter(id => sessions[i].includes(id)).length);
    check("TEST 4 — la session suivante reprend d'abord des questions ABSENTES de la précédente (banque 20, sessions 10 → aucune en commun)", overlap.every(n => n === 0), overlap);
    const nonIdentity = perms.flat().filter(p => p !== "0123").length;
    check("TEST 2 — les choix QCM sont mélangés (la plupart des questions ont un autre ordre que la banque)", nonIdentity > 40, nonIdentity);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* 3 : la bonne réponse reste la bonne, jouée pour de vrai */
  await scenario("3. TEST 3 — en cliquant la bonne réponse DU TEXTE d'origine, le quiz mélangé donne 10/10", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), originalText: SRC }]);
    await goChapter(page, "uc0");
    for (const key of ["quiz", "quizflash"]) {
      await page.click(`[data-hub-open="${key}"]`);
      await page.waitForSelector(".qz-opt");
      await page.waitForTimeout(300);
      const total = await page.evaluate(() => state.pool.length);
      for (let i = 0; i < total; i++) {
        const idx = await page.evaluate(() => {
          const q = state.pool[state.index];
          const orig = findAnyChapter("uc0").aiQuiz.find(x => x.uid === q.uid);
          const goodText = orig.opts[orig.correct];                 // vérité = la BANQUE, jamais l'index mélangé
          return q.opts.indexOf(goodText);
        });
        await page.click(`.qz-opt[data-i="${idx}"]`);
        await page.click("#next-btn");
      }
      const score = await page.evaluate(() => [state.screen, state.score, state.pool.length]);
      eq(`${key} : tout juste d'après la banque → ${total}/${total}`, score, ["results", total, total]);
      await page.click("#picker-btn").catch(() => {});
      await goChapter(page, "uc0");
    }
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* 5-19 : flashcards */
  await scenario("5. TEST 5 — Flashcards : session A ≠ session B, « Recommencer » = nouvel ordre", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiFlashcards: bankF("A"), originalText: SRC }]);
    await goChapter(page, "uc0");
    const orders = [];
    for (let i = 0; i < 5; i++) {
      await page.click('[data-hub-open="flashcards"]');
      await page.waitForSelector("#flashcard-el");
      orders.push(await page.evaluate(() => state.flashDeck.cards.map(c => c.id)));
      await page.click('.hub-crumb [data-hub-goto="chapter"]');
      await page.waitForSelector("#course-hub");
    }
    eq("paquet de 18 → sessions de 15 cartes", orders.map(o => o.length), [15, 15, 15, 15, 15]);
    check("deux sessions consécutives ne sont jamais identiques", orders.slice(1).every((o, i) => o.join() !== orders[i].join()));
    const inv = await page.evaluate(() => { let n = 0, tot = 0; for (let i = 0; i < 200; i++) { const s = RevemBank.buildFlashSession(findAnyChapter("uc0").aiFlashcards); s.items.forEach(c => { tot++; if (c.reversed) n++; }); } return { n, tot }; });
    check("des cartes sont retournées (≈30 %), jamais toutes", inv.n > 0.15 * inv.tot && inv.n < 0.5 * inv.tot, inv);
    // « Recommencer » depuis le résumé
    await page.click('[data-hub-open="flashcards"]');
    await page.waitForSelector("#flashcard-el");
    const first = await page.evaluate(() => state.flashDeck.cards.map(c => c.id));
    await page.evaluate(() => { const d = state.flashDeck; d.known = d.cards.slice(); d.unknown = []; state.flashScreen = "summary"; render(); });
    await page.waitForSelector("#flash-replay-all");
    eq("le bouton s'appelle « Recommencer »", (await page.innerText("#flash-replay-all")).trim(), "Recommencer");
    await page.click("#flash-replay-all");
    await page.waitForSelector("#flashcard-el");
    const again = await page.evaluate(() => state.flashDeck.cards.map(c => c.id));
    check("« Recommencer » : un NOUVEL ordre (pas F1→F2→F3 comme avant)", again.join() !== first.join());
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* 6-7 : banque intacte, aucun appel IA */
  await scenario("6. TESTS 6 et 7 — la banque n'est jamais modifiée ; aucun appel WebLLM, même IA indisponible", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), aiFlashcards: bankF("A"), originalText: SRC }]);
    const before = await bankSnap(page, "uc0");
    await page.evaluate(() => {                                    // l'IA devient un piège : tout appel échoue bruyamment
      state.aiStatus = "nogpu";
      window.webllmChat = window.webllmJsonChat = () => { window.__AI.calls.push("APPEL-INTERDIT"); throw new Error("WebLLM ne doit pas être appelé"); };
    });
    await goChapter(page, "uc0");
    for (const key of ["quiz", "quizflash", "flashcards", "quiz", "flashcards"]) {
      await page.click(`[data-hub-open="${key}"]`);
      await page.waitForSelector(key === "flashcards" ? "#flashcard-el" : ".qz-opt");
      await page.click('.hub-crumb [data-hub-goto="chapter"]');
      await page.waitForSelector("#course-hub");
    }
    eq("TEST 7 — aucun appel IA pour créer des sessions depuis une banque existante", await page.evaluate(() => window.__AI.calls), []);
    eq("TEST 6 — la banque est strictement identique après 5 sessions", await bankSnap(page, "uc0"), before);
    // … et après avoir JOUÉ un quiz jusqu'au bout.
    await page.click('[data-hub-open="quizflash"]');
    await page.waitForSelector(".qz-opt");
    for (let i = 0; i < 5; i++) { await page.click('.qz-opt[data-i="0"]'); await page.click("#next-btn"); }
    eq("… et après un quiz terminé", await bankSnap(page, "uc0"), before);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* Quiz Flash */
  await scenario("7. Quiz Flash : série courte (5), état et nombre réels", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), originalText: SRC }]);
    await goChapter(page, "uc0");
    check("la carte Quiz Flash est prête", (await cardStates(page)).quizflash === "READY");
    check("la carte Quiz affiche le nombre RÉEL de questions de la banque", (await page.innerText('[data-hub-open="quiz"]')).includes("20 questions"));
    await page.click('[data-hub-open="quizflash"]');
    await page.waitForSelector(".qz-opt");
    eq("5 questions", await page.evaluate(() => [state.pool.length, state.playing.kind]), [5, "flash"]);
    check("le titre du quiz dit « Quiz Flash »", (await page.innerText("#content")).includes("Quiz Flash"));
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* 8-9-10-11 */
  await scenario("8. TEST 8 — deux cours : banques complètement séparées", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ title: "Même titre", aiQuiz: bankQ("A"), aiFlashcards: bankF("A") }, { title: "Même titre", aiQuiz: bankQ("B"), aiFlashcards: bankF("B") }]);
    await goChapter(page, "uc1");
    await page.click('[data-hub-open="quiz"]'); await page.waitForSelector(".qz-opt");
    check("le quiz de B ne contient que des questions de B", (await poolIds(page)).every(id => id.startsWith("q_B")));
    await goChapter(page, "uc0");
    await page.click('[data-hub-open="flashcards"]'); await page.waitForSelector("#flashcard-el");
    check("les flashcards de A ne contiennent que des cartes de A", await page.evaluate(() => state.flashDeck.cards.every(c => c.id.startsWith("f_A"))));
    eq("la mémoire de « session précédente » est séparée par cours", await page.evaluate(() => Object.keys(state.revisionLast).sort()), ["uc0:flashcards", "uc1:quiz"]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("9. TEST 9 — deux comptes : aucune contamination", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), aiFlashcards: bankF("A") }]);
    await goChapter(page, "uc0");
    await page.click('[data-hub-open="quiz"]'); await page.waitForSelector(".qz-opt");
    check("la session du compte A mémorise sa dernière session", await page.evaluate(() => !!state.revisionLast["uc0:quiz"]));
    await page.evaluate(() => {
      resetUserStateInMemory();                                    // la VRAIE remise à zéro d'un changement de compte
      state.userChapters = [{ id: "uc0", subjectId: "sB", title: "Cours du compte B", num: "01", content: "x", summary: "", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [], originalText: "" }];
    });
    eq("mémoire des sessions du compte A effacée", await page.evaluate(() => state.revisionLast), {});
    await page.evaluate(() => { libGoto("chapterDetail", { chapterId: "uc0" }); switchTab("library"); });
    eq("même identifiant de cours côté B, mais AUCUNE question de A : cartes « à préparer »", (await cardStates(page)).quiz, "NOT_GENERATED");
    await page.evaluate(() => courseQuizStart(findAnyChapter("uc0")));
    eq("aucune session ne se lance depuis une banque vide", await page.evaluate(() => state.tab), "library");
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("10. TEST 10 — après rechargement de la page, la banque est toujours là", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), aiFlashcards: bankF("A"), originalText: SRC }]);
    const before = await bankSnap(page, "uc0");
    await page.reload(); await page.waitForTimeout(1000);
    eq("banque identique après rechargement (stockage local)", await bankSnap(page, "uc0"), before);
    await page.evaluate(() => { state.aiStatus = "nogpu"; });
    await goChapter(page, "uc0");
    await page.click('[data-hub-open="quiz"]'); await page.waitForSelector(".qz-opt");
    eq("et une session se construit tout de suite", await page.evaluate(() => state.pool.length), 10);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("11. TEST 11 — cours très court : le système fonctionne avec une petite banque", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A", 3), aiFlashcards: bankF("A", 2), originalText: SRC }]);
    await goChapter(page, "uc0");
    const orders = [];
    for (let i = 0; i < 4; i++) {
      await page.click('[data-hub-open="quiz"]'); await page.waitForSelector(".qz-opt");
      orders.push((await poolIds(page)).join());
      await page.click('.hub-crumb [data-hub-goto="chapter"]'); await page.waitForSelector("#course-hub");
    }
    eq("banque de 3 : sessions de 3 questions", await page.evaluate(() => RevemBank.buildQuizSession(findAnyChapter("uc0").aiQuiz).size), 3);
    check("l'ordre change quand même d'une session à l'autre", orders.slice(1).every((o, i) => o !== orders[i]), orders);
    await page.click('[data-hub-open="flashcards"]'); await page.waitForSelector("#flashcard-el");
    eq("2 cartes : le paquet se lance", await page.evaluate(() => state.flashDeck.cards.length), 2);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("12. TEST 12 — cours long : les sessions couvrent les différents concepts", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A", 25), originalText: SRC }]);
    const r = await page.evaluate(() => {
      const bank = findAnyChapter("uc0").aiQuiz; let covered = 0, maxShare = 0, last = null;
      for (let i = 0; i < 100; i++) {
        const s = RevemBank.buildQuizSession(bank, { lastIds: last, lastOrder: last }); last = s.questionIds;
        const c = {}; s.items.forEach(q => c[q.concept] = (c[q.concept] || 0) + 1);
        if (Object.keys(c).length === 5) covered++;
        maxShare = Math.max(maxShare, ...Object.values(c));
      }
      return { covered, maxShare };
    });
    eq("100 sessions : les 5 concepts sont TOUJOURS représentés", r.covered, 100);
    check("jamais plus de 2 questions du même concept sur 10", r.maxShare <= 2, r);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* 13 : double clic */
  await scenario("13. TEST 13 — double clic sur « Nouveau quiz » : une seule session, cohérente", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), originalText: SRC }]);
    await goChapter(page, "uc0");
    await page.click('[data-hub-open="quiz"]'); await page.waitForSelector(".qz-opt");
    await page.evaluate(() => { state.score = 7; state.screen = "results"; render(); });
    await page.waitForSelector("#retry-btn");
    eq("le bouton s'appelle « Nouveau quiz »", (await page.innerText("#retry-btn")).trim(), "Nouveau quiz");
    const before = await page.evaluate(() => state.playing.sessionId);
    const r = await page.evaluate(() => {
      const b = document.getElementById("retry-btn");
      b.click(); b.click(); b.click();                                // trois clics immédiats sur le MÊME bouton
      selectOption(0);                                                // … puis un clic de réponse parasite, aussitôt
      return { screen: state.screen, index: state.index, answered: state.answered, score: state.score, sid: state.playing.sessionId, n: state.pool.length };
    });
    check("une nouvelle session (autre identifiant)", r.sid !== before, r);
    eq("état cohérent : écran quiz, question 1, la réponse parasite est ignorée, score 0", [r.screen, r.index, r.answered, r.score], ["quiz", 0, false, 0]);
    eq("la session a sa taille normale (pas relancée en cascade)", r.n, 10);
    // un clic de réponse immédiat (rebond) ne valide rien
    eq("un rebond de clic dans les 250 ms n'enregistre pas de réponse involontaire", await page.evaluate(() => { const b = document.getElementById("retry-btn"); return state.answered; }), false);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* 14 : centaines de mélanges */
  await scenario("14. TEST 14 — 600 sessions simulées : la bonne réponse est TOUJOURS correcte", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ aiQuiz: bankQ("A"), originalText: SRC }]);
    const r = await page.evaluate(() => {
      const bank = findAnyChapter("uc0").aiQuiz, snap = JSON.stringify(bank); let bad = 0, total = 0, last = null; const pos = [0, 0, 0, 0];
      for (let i = 0; i < 600; i++) {
        const s = RevemBank.buildQuizSession(bank, { lastIds: last, lastOrder: last }); last = s.questionIds;
        s.items.forEach(q => { total++; const o = bank.find(x => x.uid === q.uid); if (q.opts[q.correct] !== o.opts[o.correct]) bad++; pos[q.correct]++; });
      }
      return { bad, total, pos, intact: JSON.stringify(bank) === snap };
    });
    eq("0 erreur sur " + r.total + " questions jouées", r.bad, 0);
    check("la bonne réponse tombe sur chaque position (≈ 25 % chacune)", r.pos.every(n => n > r.total * 0.2 && n < r.total * 0.3), r.pos);
    eq("la banque d'origine est intacte", r.intact, true);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  /* Génération par lots, file, import non bloquant, reprise, enrichissement, obsolescence */
  await scenario("15. Génération de la banque par lots : taille adaptée, un seul travail GPU, qualité", async () => {
    const { page, errors } = await open(browser);
    const long = Array.from({ length: 14 }, (_, i) => "Paragraphe " + i + " : " + "le sujet évolue avec la technologie et la croissance. ".repeat(10)).join("\n\n");
    await seed(page, [{ id: "L", title: "Cours long", originalText: long, content: "", summary: "" }, { id: "S", title: "Cours court", originalText: SRC, content: "", summary: "" }]);
    await page.evaluate(() => { window.__AI.delay.quiz = 120; window.__AI.delay.flashcards = 120; });
    await page.evaluate(() => courseHubGenerate("L", ["quiz", "flashcards"]));
    await page.waitForFunction(() => !state.courseGen.running, null, { timeout: 15000 });
    const r = await page.evaluate(() => { const c = findAnyChapter("L"); return { q: c.aiQuiz.length, f: c.aiFlashcards.length, calls: window.__AI.calls.slice(), max: window.__AI.maxActive, hasHash: !!c.aiQuiz[0].srcHash, ids: new Set(c.aiQuiz.map(x => x.uid)).size, ch: c.aiQuiz.every(x => x.chapterId === "L" && x.courseId === "L" && x.subjectId === "subj_bank"), concept: new Set(c.aiQuiz.map(x => x.concept)).size, sections: new Set(c.aiQuiz.map(x => x.section)).size }; });
    check("cours long (~7 000 car.) : banque de 16 questions, pas 4", r.q === 16, r);
    check("… et 16 flashcards", r.f === 16, r);
    check("plusieurs lots courts (≥ 2 appels par banque)", r.calls.filter(c => c === "quiz").length >= 2 && r.calls.filter(c => c === "flashcards").length >= 2, r.calls);
    eq("jamais deux travaux GPU en même temps", r.max, 1);
    check("chaque question a un identifiant stable, unique, et son rattachement cours/chapitre/matière", r.ids === 16 && r.ch && r.hasHash, r);
    check("plusieurs concepts et plusieurs parties du cours couvertes", r.concept >= 4 && r.sections >= 2, r);
    await page.evaluate(() => { window.__AI.calls.length = 0; window.__AI.delay = {}; });
    await page.evaluate(() => courseHubGenerate("S", ["quiz", "flashcards"]));
    await page.waitForFunction(() => !state.courseGen.running, null, { timeout: 15000 });
    const s = await page.evaluate(() => { const c = findAnyChapter("S"); return { q: c.aiQuiz.length, f: c.aiFlashcards.length, qc: window.__AI.calls.filter(x => x === "quiz").length }; });
    check("cours très court : petite banque (6), un seul lot", s.q === 6 && s.f === 6 && s.qc === 1, s);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("16. L'import ne bloque pas : le cours s'ouvre tout de suite, les ressources se préparent ensuite", async () => {
    const { page, errors } = await open(browser);
    await page.evaluate(() => { window.__AI.delay.quiz = 900; });
    await page.evaluate(() => {
      switchTab("library"); libGoto("import");
      state.courseImport.pasteText = "Le marketing est l'ensemble des méthodes qui permettent de comprendre un marché, avec ses études qualitatives et quantitatives.";
      courseImportAddPasteAsFile(); state.courseImport.files[0].name = "marketing.pdf"; state.courseImport.step = "detect";
      return courseImportProcessFile(0);
    });
    await page.click("#import-confirm-generate-btn");
    await page.waitForSelector("#course-hub", { timeout: 6000 });
    const early = await cardStates(page);
    check("la page du cours est affichée AVANT la fin de la préparation (le quiz n'est pas prêt)", early.quiz !== "READY", early);
    check("les ressources sont « en préparation / en attente »", Object.values(early).some(s => s === "QUEUED" || s === "GENERATING"), early);
    await page.waitForFunction(() => !state.courseGen.running && state.courseGen.queue.length === 0, null, { timeout: 20000 });
    await page.waitForTimeout(200);
    eq("puis tout devient prêt, progressivement et sans rien faire", await cardStates(page), { fiche: "READY", summary: "READY", quiz: "READY", quizflash: "READY", flashcards: "READY", questions: "READY" });
    eq("l'ordre du pipeline est respecté, un seul travail à la fois", await page.evaluate(() => [window.__AI.calls.filter(c => c !== "detect").slice(0, 3), window.__AI.maxActive]), [["fiche", "summary", "quiz"], 1]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("17. IA indisponible à l'import : le cours est gardé, la préparation REPREND quand l'IA revient", async () => {
    const { page, errors } = await open(browser);
    await page.evaluate(() => { state.aiStatus = "nogpu"; state.aiGpuDiag = { message: "WebGPU indisponible." }; });
    await seed(page, [{ id: "W", title: "Cours en attente", originalText: SRC, content: "", summary: "", generationPending: true, hasOriginalFile: true }]);
    await page.evaluate(() => courseHubGenerate("W", ["fiche", "summary", "quiz", "flashcards"]));
    await page.waitForFunction(() => !state.courseGen.running, null, { timeout: 8000 });
    await goChapter(page, "W");
    eq("le cours existe toujours, ressources en erreur « IA »", await page.evaluate(() => [!!findAnyChapter("W"), RevemHub.resumeKeys(state.courseGen, "W").length]), [true, 4]);
    check("« L'assistant IA doit être disponible… » est affiché", await page.evaluate(() => { libGoto("chapterResource", { chapterId: "W", resource: "quiz" }); return document.body.innerText.includes("L'assistant IA doit être disponible pour générer cette ressource."); }));
    await page.evaluate(() => { state.aiStatus = "ready"; render(); });                // l'assistant redevient prêt
    await page.waitForFunction(() => (findAnyChapter("W").aiQuiz || []).length > 0 && (findAnyChapter("W").aiFlashcards || []).length > 0, null, { timeout: 15000 });
    eq("la préparation a repris TOUTE SEULE : banques créées, cours non recréé", await page.evaluate(() => [state.userChapters.filter(c => c.id === "W").length, findAnyChapter("W").aiQuiz.length > 0]), [1, true]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("18. Enrichissement de la banque (sur demande) et cours modifié (obsolescence)", async () => {
    const { page, errors } = await open(browser);
    await seed(page, [{ id: "E", title: "Cours E", originalText: SRC, aiQuiz: bankQ("E", 6), aiFlashcards: bankF("E", 6) }]);
    const idsBefore = await page.evaluate(() => findAnyChapter("E").aiQuiz.map(q => q.uid));
    await goChapter(page, "E");
    await page.evaluate(() => { document.querySelector(".lib-tools").open = true; });
    await page.click("#lib-enrich-quiz");
    await page.waitForFunction(() => findAnyChapter("E").aiQuiz.length > 6, null, { timeout: 12000 });
    const after = await page.evaluate(() => ({ ids: findAnyChapter("E").aiQuiz.map(q => q.uid), n: findAnyChapter("E").aiQuiz.length }));
    check("la banque grandit (6 → 14)", after.n === 14, after.n);
    eq("l'existant est conservé, en tête, sans modification", after.ids.slice(0, 6), idsBefore);
    eq("une session ne déclenche JAMAIS d'enrichissement (aucun appel IA de plus)", await page.evaluate(() => { const n = window.__AI.calls.length; courseQuizStart(findAnyChapter("E")); return window.__AI.calls.length - n; }), 0);
    // cours modifié
    await page.evaluate(() => { const c = findAnyChapter("E"); const sig = RevemBank.contentSignature(c.originalText); c.aiQuiz.forEach(q => { q.srcHash = sig.hash; q.srcLen = sig.len; }); saveUserChapters(); });
    await goChapter(page, "E");
    eq("texte inchangé : pas de bandeau", (await page.$$("#hub-stale-note")).length, 0);
    await page.evaluate(() => { findAnyChapter("E").originalText += " " + "Un tout nouveau chapitre entier ajouté au cours. ".repeat(10); saveUserChapters(); libGoto("chapterDetail", { chapterId: "E" }); });
    await page.waitForSelector("#hub-stale-note");
    eq("texte nettement modifié : le quiz est « À actualiser »", await page.innerText('[data-hub-open="quiz"]').then(t => t.includes("À actualiser")), true);
    await page.click("[data-hub-refresh]");
    await page.waitForFunction(() => !state.courseGen.running, null, { timeout: 15000 });
    eq("« Actualiser » régénère la banque à partir du nouveau texte", await page.evaluate(() => RevemBank.isStale(findAnyChapter("E").aiQuiz, chapterSourceText(findAnyChapter("E")))), false);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  });

  await scenario("19. Mobile 390 px : six cartes, une colonne, aucun débordement", async () => {
    const { page, errors } = await open(browser, { width: 390, height: 800 });
    await seed(page, [{ aiQuiz: bankQ("A"), aiFlashcards: bankF("A"), originalText: SRC }]);
    await goChapter(page, "uc0");
    const m = await page.evaluate(() => ({ n: document.querySelectorAll(".hub-card").length, cols: new Set([...document.querySelectorAll(".hub-card")].map(c => Math.round(c.getBoundingClientRect().left))).size, ov: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    eq("6 cartes, 1 colonne, pas de défilement horizontal", [m.n, m.cols, m.ov <= 0], [6, 1, true]);
    await page.setViewportSize({ width: 1280, height: 900 });
    eq("bureau : 3 colonnes", await page.evaluate(() => new Set([...document.querySelectorAll(".hub-card")].map(c => Math.round(c.getBoundingClientRect().left))).size), 3);
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
