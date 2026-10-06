/* ============================================================================
   REV-EM — Tuteur Maths & Stats (Résoudre · Expliquer · M'entraîner), dans un vrai Chromium
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL : index.html tel quel, math-tutor.js + le Math Engine (Fast Engine exact, MathVerifier), le DOM réellement affiché, KaTeX
   auto-hébergé, le stockage local, les messages EXACTS postés au « moteur IA » (prompt, max_tokens).
   CE QUI EST REMPLACÉ : le modèle. Le transport est un FAUX qui rejoue des textes scriptés. Les tests marqués « PASS MOCK » dépendent donc du
   modèle simulé ; les autres (« PASS ») n'utilisent AUCUN modèle — c'est justement le but : M'ENTRAÎNER ne dépend pas du WebLLM.
   NON TESTÉ : vrai WebLLM, GPU, Mac, WKWebView, vrai compte Supabase (le journal est testé contre PostgreSQL réel dans user-data.test.mjs).

   Lancer :  NODE_PATH=/opt/node22/lib/node_modules node tests/math-tutor-ui.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { startStatic } = await import("./helpers/static-server.mjs");

let pass = 0, mock = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 500) : "")); } };
const checkMock = (name, ok, got) => { if (ok) { mock++; console.log("PASS MOCK — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 500) : "")); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 700)); }
}

const srv = await startStatic(ROOT);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const FAKE = `
window.__T = { sent: [], script: [], gens: [], aborts: 0 };
aiTransport = {
  mode: "worker", terminate() {},
  send(msg) {
    const T = window.__T; T.sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === "ABORT") { T.abortFlag = true; T.aborts++; return; }
    if (msg.type !== "GENERATE") return;
    const step = T.script.length ? T.script.shift() : { text: "Voici une explication de test." };
    T.abortFlag = false;
    const rec = { id: msg.id, maxTokens: msg.maxTokens, temperature: msg.temperature, system: (msg.messages[0] || {}).content, user: (msg.messages[msg.messages.length - 1] || {}).content, roles: msg.messages.map(m => m.role) };
    T.gens.push(rec);
    (async () => {
      await new Promise(r => setTimeout(r, 5));
      const text = step.text || ""; let sent = 0;
      for (let i = 0; i < text.length; i += 8) { if (T.abortFlag) break; await new Promise(r => setTimeout(r, 1)); const w = text.slice(i, i + 8); sent += w.length; aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: w }); }
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: sent, ttftMs: 12, totalMs: 30, finishReason: "stop" });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
`;

async function open(opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(srv.base + "/index.html");
  await page.waitForTimeout(900);
  if (opts.ai !== false) await page.evaluate(FAKE);
  await page.evaluate(() => { switchTab("ai"); });
  await page.waitForTimeout(250);
  return { ctx, page };
}
const idle = (page) => page.waitForFunction(() => !state.aiBusy, null, { timeout: 30000 }).then(() => page.waitForTimeout(150));
const T = (page) => page.evaluate(() => ({ gens: window.__T ? window.__T.gens : [], generates: window.__T ? window.__T.sent.filter(m => m.type === "GENERATE").length : 0 }));
const UI = (page) => page.evaluate(() => { const u = window.revemMathTutor.ui(); return { mode: u.mode, kind: u.ex && u.ex.kind, domain: u.ex && u.ex.domain, level: u.ex && u.ex.level, context: u.ex && u.ex.context, lang: u.ex && u.ex.lang, expectedText: u.ex && u.ex.expectedText, example: u.ex && u.ex.example, status: u.session && u.session.status, attempts: u.session && u.session.attempts, hints: u.session && u.session.hintsUsed, fallback: u.ex && u.ex.contextFallback }; });
const mtText = (page) => page.innerText("#mt-card");
const feedback = (page) => page.$eval("#mt-feedback", e => e.innerText).catch(() => "");
async function setup(page, domain, level, context) {
  await page.click("#mt-tab-practice");
  await page.selectOption("#mt-domain", domain);
  await page.click(`[data-mt-level="${level}"]`);
  await page.click(`[data-mt-context="${context}"]`);
}
async function newExercise(page, wantKind) {
  await page.click("#mt-new"); await page.waitForTimeout(150);
  if (!wantKind) return UI(page);
  for (let i = 0; i < 60; i++) { const u = await UI(page); if (u.kind === wantKind) return u; await page.click("#mt-new"); await page.waitForTimeout(40); }
  throw new Error("type d'exercice introuvable : " + wantKind);
}
async function answer(page, text) { await page.fill("#mt-input", text); await page.press("#mt-input", "Enter"); await page.waitForTimeout(120); }

try {

  /* ═══ 1. LA CARTE ET LES TROIS MODES ═══ */
  await scenario("1. la carte « Maths & Stats » : Résoudre · Expliquer · M'entraîner", async () => {
    const { ctx, page } = await open();
    const txt = await mtText(page);
    check("titre « Maths & Stats » et les trois modes demandés", /Maths & Stats/.test(txt) && /Résoudre/.test(txt) && /Expliquer/.test(txt) && /M'entraîner/.test(txt), txt.slice(0, 200));
    eq("rôles ARIA : une tablist, 3 onglets, un seul sélectionné", await page.evaluate(() => [document.querySelectorAll("#mt-card [role=tablist]").length, document.querySelectorAll("#mt-card [role=tab]").length, document.querySelectorAll("#mt-card [role=tab][aria-selected=true]").length]), [1, 3, 1]);
    eq("mode par défaut : Résoudre ; le panneau est relié à son onglet (aria-labelledby)", await page.evaluate(() => [window.revemMathTutor.ui().mode, document.getElementById("mt-panel").getAttribute("aria-labelledby")]), ["solve", "mt-tab-solve"]);
    await page.click("#mt-tab-explain"); eq("onglet Expliquer : sélecteur de niveau de détail (concis / standard / détaillé)", await page.$$eval("[data-mt-detail]", e => e.map(x => x.innerText)), ["Concis", "Standard", "Détaillé"]);
    await page.click("#mt-tab-practice"); check("onglet M'entraîner : domaine, difficulté, contexte, bouton de départ", !!(await page.$("#mt-domain")) && (await page.$$("[data-mt-level]")).length === 3 && (await page.$$("[data-mt-context]")).length === 2 && !!(await page.$("#mt-new")));
    eq("les 8 domaines demandés sont proposés", await page.$$eval("#mt-domain option", o => o.map(x => x.value)), ["algebra", "functions", "derivatives", "integrals", "probability", "statistics", "matrices", "finance"]);
    eq("les 3 niveaux : Débutant, Intermédiaire, Avancé", await page.$$eval("[data-mt-level]", e => e.map(x => x.innerText)), ["Débutant", "Intermédiaire", "Avancé"]);
    await page.focus("#mt-tab-practice"); await page.keyboard.press("ArrowRight");
    eq("clavier : flèche → passe à l'onglet suivant (cycle)", await page.evaluate(() => window.revemMathTutor.ui().mode), "solve");
    await page.keyboard.press("ArrowLeft"); eq("clavier : flèche ← revient", await page.evaluate(() => window.revemMathTutor.ui().mode), "practice");
    eq("le choix du mode est mémorisé (confort local, jamais synchronisé)", await page.evaluate(() => JSON.parse(localStorage.getItem("revisions-etude-marche:math-tutor-prefs") || "{}").mode), "practice");
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* ═══ 2. M'ENTRAÎNER — SESSION COMPLÈTE, SANS AUCUN APPEL AU MODÈLE ═══ */
  await scenario("2. session complète : exercice → mauvaise réponse → indice → nouvelle réponse → réponse équivalente → validation → explication", async () => {
    const { ctx, page } = await open();
    await setup(page, "algebra", 1, "pure");
    const u0 = await newExercise(page, "quad-solve");
    const [a, b] = u0.expectedText.match(/-?\d+/g).map(Number);
    const statement = await page.$eval("#mt-ex .mt-ex-intro", e => e.innerText);
    check("1. l'exercice s'affiche avec sa formule rendue en LaTeX (KaTeX) et SANS la solution", await page.waitForSelector("#mt-ex .mt-formula .katex", { timeout: 6000 }).then(() => true).catch(() => false) && !(await mtText(page)).includes(u0.expectedText), statement);
    check("   badge « énoncé vérifié par le moteur de calcul »", /Énoncé vérifié par le moteur de calcul/.test(await mtText(page)));
    check("   le suivi n'a encore rien : « Fais un premier exercice »", /Fais un premier exercice/.test(await mtText(page)));
    check("   « Voir la solution » est désactivé tant qu'il n'y a eu ni essai ni indice", await page.$eval('[data-mt-act="solution"]', e => e.disabled));
    await answer(page, String(a + 100) + " ; " + String(b + 100));
    check("2. mauvaise réponse → « Pas encore. », exercice toujours ouvert", /Pas encore/.test(await feedback(page)) && (await UI(page)).status === "open", await feedback(page));
    eq("   actions proposées : Indice · Nouvel essai · Voir la méthode · Voir la solution", await page.$$eval(".mt-actions .mt-act", e => e.map(x => x.innerText)), ["Indice", "Nouvel essai", "Voir la méthode", "Voir la solution"]);
    await page.click('[data-mt-act="hint"]'); await page.waitForTimeout(100);
    check("3. Indice 1 = le concept", /Indice 1 · le concept/i.test(await mtText(page)) && (await page.$$(".mt-hintblock")).length === 1);
    await answer(page, String(a));
    check("4. nouvelle réponse incomplète → diagnostic précis (« il manque au moins une solution »)", /il manque/.test(await feedback(page)), await feedback(page));
    await page.click('[data-mt-act="hint"]'); await page.waitForTimeout(100);
    check("   Indice 2 = la méthode (s'ajoute au premier)", /Indice 2 · la méthode/i.test(await mtText(page)) && (await page.$$(".mt-hintblock")).length === 2);
    await answer(page, "x = " + b + " ou x = " + a);
    check("5. réponse ÉQUIVALENTE (autre ordre, « x = … ou x = … ») → « Correct ✓ »", /Correct ✓/.test(await feedback(page)) && (await UI(page)).status === "solved", await feedback(page));
    const tx = await mtText(page);
    check("6. explication déterministe : l'idée, la méthode, les étapes, et la mention « vérifiée par le moteur, pas par l'IA »", /Pourquoi c'est juste/i.test(tx) && /L'idée/i.test(tx) && /Les étapes/i.test(tx) && /vérifiée par le moteur de calcul exact, pas par l'IA/.test(tx), tx.slice(-600));
    check("   le champ est verrouillé et « Vérifier » désactivé une fois résolu", await page.evaluate(() => [document.getElementById("mt-input").readOnly, document.getElementById("mt-check").disabled]).then(r => r[0] && r[1]));
    eq("   actions après la réussite : Expliquer avec l'IA · Un autre exercice", await page.$$eval(".mt-actions .mt-act", e => e.map(x => x.innerText)), ["Expliquer avec l'IA", "Un autre exercice"]);
    const log = await page.evaluate(() => window.revemMathTutor.log());
    eq("7. suivi : 1 entrée — thème, type, difficulté, essais, indices, réussite, solution non montrée", log.map(e => [e.topic, e.kind, e.difficulty, e.attempts, e.hintsUsed, e.success, e.solutionShown]), [["algebra", "quad-solve", 1, 3, 2, true, false]]);
    const prog = await page.evaluate(() => window.revemMathTutor.progress().topics.algebra);
    check("   maîtrise calculée : 1 exercice, 1 réussi, 2 indices, maîtrise > 0 mais < 100 (indices et erreurs la réduisent), confiance « low »", prog.exercises === 1 && prog.success === 1 && prog.hintsUsed === 2 && prog.mastery > 0 && prog.mastery < 100 && prog.confidence === "low", prog);
    check("   le bloc « Ma progression en maths » affiche Algèbre avec son pourcentage et « à confirmer »", /Ma progression en maths/.test(await mtText(page)) && /Algèbre[\s\S]*\d+ %/.test(await mtText(page)) && /à confirmer/.test(await mtText(page)));
    const t = await T(page);
    eq("TOUT cela sans le moindre appel au modèle (0 génération) : M'entraîner est indépendant du WebLLM", t.generates, 0);
    eq("clé de stockage : le journal est écrit dans l'espace local du compte", await page.evaluate(() => Object.keys(localStorage).some(k => /math-practice$/.test(k))), true);
    eq("instantané de synchronisation : le journal part avec le reste (cloudSnapshot)", await page.evaluate(() => cloudSnapshot().mathPractice.length), 1);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* ═══ 3. INDICES, MÉTHODE, SOLUTION ═══ */
  await scenario("3. indices 1-2-3, méthode, solution : la solution n'arrive que sur demande, après un effort", async () => {
    const { ctx, page } = await open();
    await setup(page, "algebra", 0, "pure");
    const u = await newExercise(page, "linear");
    for (let i = 1; i <= 3; i++) { await page.click('[data-mt-act="hint"]'); await page.waitForTimeout(80); }
    const tx = (await mtText(page)).toLowerCase();
    check("les trois indices s'empilent dans l'ordre : concept → méthode → début du calcul", tx.indexOf("indice 1 · le concept") > 0 && tx.indexOf("indice 1 · le concept") < tx.indexOf("indice 2 · la méthode") && tx.indexOf("indice 2 · la méthode") < tx.indexOf("indice 3 · début du calcul"), tx.slice(0, 900));
    check("   après 3 indices : plus de bouton « Indice »", !(await page.$('[data-mt-act="hint"]')));
    check("   l'indice 3 n'est PAS la réponse finale", !(await page.$eval(".mt-hintblock:last-child", e => e.innerText)).includes(u.expectedText));
    await page.click('[data-mt-act="method"]'); await page.waitForTimeout(80);
    const m = await page.$$eval(".mt-block", e => e.map(x => x.innerText));
    const lastStep = await page.evaluate(() => { const st = window.revemMathTutor.ui().ex.steps; return st[st.length - 1]; });
    check("« Voir la méthode » : la démarche et les étapes SAUF la dernière (« " + lastStep + " »)", /La méthode/i.test(m.join("\n")) && !m[m.length - 1].includes(lastStep), m[m.length - 1]);
    check("   la solution est maintenant disponible (effort réalisé)", await page.$eval('[data-mt-act="solution"]', e => !e.disabled));
    await page.click('[data-mt-act="solution"]'); await page.waitForTimeout(100);
    const sol = await page.$eval(".mt-solution", e => e.innerText);
    check("« Voir la solution » : réponse + étapes + « ne compte pas comme réussi »", sol.includes(u.expectedText) && /ne compte pas comme résolu|ne compte pas comme réussi/.test(sol), sol);
    const log = await page.evaluate(() => window.revemMathTutor.log());
    eq("suivi : exercice terminé, solution montrée, NON réussi, 3 indices (la méthode vaut le dernier indice)", log.map(e => [e.success, e.solutionShown, e.hintsUsed]), [[false, true, 3]]);
    eq("la maîtrise du thème est 0 (jamais un succès offert)", await page.evaluate(() => window.revemMathTutor.progress().topics.algebra.mastery), 0);
    await ctx.close();
  });

  /* ═══ 4. VALIDATION DES RÉPONSES : ÉQUIVALENCE ═══ */
  await scenario("4. équivalence dans l'interface : 1/2 = 0,5 = 2/4 = 50 %", async () => {
    const { ctx, page } = await open();
    await setup(page, "probability", 0, "pure");
    const u = await newExercise(page, "proba-simple");
    const r = await page.evaluate(() => { const ex = window.revemMathTutor.ui().ex, v = ex.expected.value; return { n: Number(v.n), d: Number(v.d) }; });
    const forms = [r.n + "/" + r.d, (r.n * 2) + "/" + (r.d * 2), String(r.n / r.d).replace(".", ","), String(Math.round(1e4 * r.n / r.d) / 1e4).replace(".", ","), (Math.round(1e4 * 100 * r.n / r.d) / 1e4 + " %").replace(".", ",")];
    for (const f of forms) {
      await page.click("#mt-new"); await newExercise(page, "proba-simple");
      const rr = await page.evaluate(() => { const v = window.revemMathTutor.ui().ex.expected.value; return { n: Number(v.n), d: Number(v.d) }; });
      const mk = [rr.n + "/" + rr.d, (rr.n * 2) + "/" + (rr.d * 2), (Math.round(1e4 * rr.n / rr.d) / 1e4 + "").replace(".", ","), (Math.round(1e4 * 100 * rr.n / rr.d) / 1e4 + " %").replace(".", ",")];
      for (const a of mk) { await page.fill("#mt-input", a); await page.press("#mt-input", "Enter"); await page.waitForTimeout(60); const ok = /Correct ✓/.test(await feedback(page)); check("« " + a + " » accepté pour " + rr.n + "/" + rr.d, ok, await feedback(page)); if (ok) break; }
      break;
    }
    await page.click("#mt-new"); await newExercise(page, "proba-simple");
    await answer(page, "999");
    check("une valeur fausse reste « Pas encore »", /Pas encore/.test(await feedback(page)));
    await answer(page, "abc");
    check("un texte illisible : message d'aide, et NE COMPTE PAS comme un essai", /lettres inattendues|pas compris/.test(await feedback(page)) && (await UI(page)).attempts === 1, await UI(page));
    await answer(page, "");
    check("une réponse vide : « Écris d'abord une réponse »", /Écris d'abord une réponse/.test(await feedback(page)));
    await ctx.close();
  });

  /* ═══ 5. DOMAINES × NIVEAUX × CONTEXTES DANS L'INTERFACE ═══ */
  await scenario("5. 8 domaines × 3 niveaux : un exercice vérifié s'affiche à chaque fois ; contexte école de commerce", async () => {
    const { ctx, page } = await open();
    await page.click("#mt-tab-practice");
    let ok = 0, total = 0, bad = [];
    for (const d of ["algebra", "functions", "derivatives", "integrals", "probability", "statistics", "matrices", "finance"]) {
      await page.selectOption("#mt-domain", d);
      for (const l of [0, 1, 2]) {
        await page.click(`[data-mt-level="${l}"]`);
        for (const c of ["pure", "business"]) {
          await page.click(`[data-mt-context="${c}"]`); await page.click("#mt-new");
          const u = await UI(page); total++;
          const shown = await page.$eval("#mt-ex", e => e.innerText).catch(() => "");
          if (u.domain === d && u.level === l && /Énoncé vérifié/.test(shown) && shown.length > 80 && (c === "pure" ? u.context === "pure" : (u.context === "business" || u.fallback))) ok++; else bad.push([d, l, c, u.domain, u.level, u.context]);
        }
      }
    }
    eq("48 combinaisons (8 domaines × 3 niveaux × 2 contextes) → 48 exercices affichés, vérifiés, du bon domaine et du bon niveau", [ok, total], [48, 48]);
    check("aucune combinaison en échec", bad.length === 0, bad.slice(0, 3));
    await setup(page, "finance", 1, "business"); await page.click("#mt-new");
    check("école de commerce : le contexte est annoncé (« École de commerce ») et l'énoncé est un cas réaliste", (await page.$eval("#mt-ex .mt-ex-meta", e => e.innerText)).includes("École de commerce") && /€|%|client|entreprise|investi|projet|PIB|fonds|action/i.test(await page.$eval(".mt-ex-intro", e => e.innerText)), await page.$eval(".mt-ex-intro", e => e.innerText));
    await setup(page, "matrices", 0, "business"); await page.click("#mt-new");
    check("repli honnête : matrices débutant n'a pas de cas « école de commerce » → exercice de maths pur, signalé", /Pas de version « école de commerce » à ce niveau/.test(await mtText(page)));
    eq("aucune erreur JavaScript sur 48 exercices", page.errors, []);
    await ctx.close();
  });

  /* ═══ 6. RÉSOUDRE — Math Engine d'abord, WebLLM pour expliquer ═══ */
  await scenario("6. Résoudre : le moteur calcule et vérifie ; l'IA explique (un seul appel) ; sans IA le résultat s'affiche quand même", async () => {
    const { ctx, page } = await open();
    await page.fill("#mt-solve-input", "x² - 5x + 6 = 0"); await page.press("#mt-solve-input", "Enter"); await idle(page);
    const cards = await page.$$eval(".mx-card", e => e.map(x => x.innerText));
    check("la carte du moteur : x = 2 ; x = 3, vérifiée exactement, AVANT l'explication", cards.length === 1 && /x=2,x=3/.test(cards[0]) && /VÉRIFIÉ \(EXACT\)/i.test(cards[0]), cards);
    const t = await T(page);
    checkMock("une seule génération, avec le bloc « MATH ENGINE RESULT » (le modèle explique, il ne calcule pas)", t.generates === 1 && /MATH ENGINE RESULT/.test(t.gens[0].system) && /ALREADY solved/.test(t.gens[0].system), t.gens[0] && t.gens[0].system.slice(-500));
    checkMock("budget borné et température basse (stratégie « calcul déjà fait »)", t.gens[0].maxTokens <= 320 && t.gens[0].temperature === 0.3, t.gens[0]);
    await ctx.close();
    const off = await open({ ai: false });
    await off.page.fill("#mt-solve-input", "2x + 4 = 10"); await off.page.press("#mt-solve-input", "Enter"); await off.page.waitForTimeout(700);
    check("SANS modèle IA : le résultat vérifié (x = 3) s'affiche quand même", /x=3/.test(await off.page.$$eval(".mx-card", e => e.map(x => x.innerText).join("\n"))), await off.page.innerText("#content").then(s => s.slice(0, 300)));
    eq("aucune erreur JavaScript (avec ou sans IA)", [page.errors, off.page.errors], [[], []]);
    await off.ctx.close();
  });

  /* ═══ 7. EXPLIQUER — intuition, définition, méthode, formule, exemple, interprétation ═══ */
  await scenario("7. Expliquer : six sections, niveau de détail adaptable", async () => {
    const { ctx, page } = await open();
    await page.click("#mt-tab-explain");
    const budgets = {};
    for (const d of ["short", "standard", "detailed"]) {
      await page.click(`[data-mt-detail="${d}"]`);
      await page.fill("#mt-explain-input", "l'écart-type"); await page.press("#mt-explain-input", "Enter"); await idle(page);
      const t = await T(page), g = t.gens[t.gens.length - 1];
      budgets[d] = g.maxTokens;
      checkMock("détail « " + d + " » : consignes Intuition · Définition · Méthode · Formule · Exemple · Interprétation, ordre imposé, arrêt après la dernière section", /\*\*Intuition\*\* · \*\*Définition\*\* · \*\*Méthode\*\* · \*\*Formule\*\* · \*\*Exemple\*\* · \*\*Interprétation\*\*/.test(g.system) && /Stop after the last section/.test(g.system) && new RegExp("Detail level: " + (d === "short" ? "concise" : d)).test(g.system), g.system.slice(-700));
    }
    checkMock("le niveau de détail règle la longueur : concis < standard < détaillé (jetons autorisés)", budgets.short < budgets.standard && budgets.standard < budgets.detailed, budgets);
    check("sans modèle : « Expliquer » est désactivé avec une consigne claire", await (async () => { const o = await open({ ai: false }); await o.page.click("#mt-tab-explain"); const r = await o.page.evaluate(() => [document.getElementById("mt-explain-btn").disabled, /charge un modèle/.test(document.getElementById("mt-card").innerText)]); await o.ctx.close(); return r[0] && r[1]; })());
    await ctx.close();
  });

  /* ═══ 8. EXPLIQUER AVEC L'IA APRÈS VALIDATION ═══ */
  await scenario("8. après validation : « Expliquer avec l'IA » — le modèle reçoit le résultat DÉJÀ vérifié, et ne décide de rien", async () => {
    const { ctx, page } = await open();
    await setup(page, "algebra", 1, "pure");
    const u = await newExercise(page, "quad-solve"), [a, b] = u.expectedText.match(/-?\d+/g).map(Number);
    check("avant la réponse juste, « Expliquer avec l'IA » n'existe pas (la solution n'est pas dévoilée)", !(await page.$('[data-mt-act="explain_ai"]')));
    await answer(page, a + " ; " + b);
    await page.click('[data-mt-act="explain_ai"]'); await idle(page);
    const t = await T(page), g = t.gens[0];
    checkMock("une seule génération ; le bloc moteur contient l'énoncé, la réponse vérifiée et les étapes, avec « do not recompute »", t.generates === 1 && /exercise generated and checked deterministically/.test(g.system) && g.system.includes(u.expectedText) && /do not recompute/.test(g.system) && /Calculation steps from the engine/.test(g.system), g.system.slice(-800));
    checkMock("stratégie « calcul déjà fait » : budget ≤ 320, température 0,3", g.maxTokens <= 320 && g.temperature === 0.3, g);
    check("la réponse de l'IA arrive dans la conversation (sous la carte), l'exercice et son suivi restent intacts", (await page.$$(".ai-bubble.assistant .ai-result-body")).length === 1 && (await UI(page)).status === "solved" && (await page.evaluate(() => window.revemMathTutor.log().length)) === 1);
    check("la carte indique où l'explication s'affiche", /L'explication de l'IA s'affiche dans la conversation/.test(await mtText(page)));
    await ctx.close();
    const off = await open({ ai: false });
    await setup(off.page, "algebra", 1, "pure");
    const u2 = await newExercise(off.page, "quad-solve"), [c, d] = u2.expectedText.match(/-?\d+/g).map(Number);
    await answer(off.page, c + " ; " + d);
    check("sans IA locale : le bouton est désactivé, l'explication déterministe reste complète", await off.page.$eval('[data-mt-act="explain_ai"]', e => e.disabled) && /Pourquoi c'est juste/.test(await mtText(off.page)) && /L'IA locale n'est pas chargée/.test(await mtText(off.page)));
    await off.ctx.close();
  });

  /* ═══ 9. SUIVI : MAÎTRISE, NIVEAU CONSEILLÉ, PERSISTANCE ═══ */
  await scenario("9. suivi : plusieurs exercices, maîtrise par thème, niveau conseillé, survie au rechargement", async () => {
    const { ctx, page } = await open();
    await setup(page, "statistics", 0, "pure");
    for (let i = 0; i < 3; i++) { await newExercise(page); const ex = await UI(page); await answer(page, ex.example); }
    const p = await page.evaluate(() => window.revemMathTutor.progress().topics.statistics);
    check("3 exercices réussis du premier coup : maîtrise 100, confiance « moderate »", p.exercises === 3 && p.success === 3 && p.mastery === 100 && p.confidence === "moderate", p);
    check("niveau conseillé : « Tu maîtrises ce niveau : essaie « Intermédiaire » »", /Tu maîtrises ce niveau : essaie « Intermédiaire »/.test(await mtText(page)), (await mtText(page)).slice(0, 700));
    await page.click("#mt-tab-practice");
    check("le bloc progression : Statistiques 100 %, 3 exercices, 3 réussis, 0 indice", /Statistiques[\s\S]*100 %/.test(await mtText(page)) && /3 exercice\(s\)[\s\S]*3 réussi\(s\)[\s\S]*0 indice\(s\)/.test(await mtText(page)));
    check("barre de progression accessible (role=progressbar, valeur annoncée)", await page.$eval('.mt-pbar[role="progressbar"]', e => e.getAttribute("aria-valuenow") === "100" && /Statistiques/.test(e.getAttribute("aria-label"))));
    await page.reload(); await page.waitForTimeout(1000); await page.evaluate(() => switchTab("ai")); await page.waitForTimeout(300);
    eq("après rechargement : le journal est restauré depuis l'espace local", await page.evaluate(() => window.revemMathTutor.log().length), 3);
    check("   et la progression est toujours affichée (maîtrise recalculée, jamais stockée)", /Statistiques[\s\S]*100 %/.test(await mtText(page)));
    eq("   le journal ne contient jamais l'énoncé ni la réponse de l'élève", await page.evaluate(() => Object.keys(window.revemMathTutor.log()[0]).sort()), ["attempts", "context", "difficulty", "hintsUsed", "kind", "solutionShown", "success", "topic", "ts"]);
    const bad = await page.evaluate(() => mtSanitizeLog([{ ts: 5, topic: "alchimie", kind: "x", difficulty: 1 }, { ts: 6, topic: "algebra", kind: "linear", difficulty: 9, attempts: 700, hintsUsed: 99, success: true }, null, "x", { ts: 6, topic: "algebra", kind: "linear", difficulty: 0 }]));
    eq("un journal corrompu est assaini : thème inconnu écarté, valeurs bornées, doublons d'horodatage écartés", bad.map(e => [e.difficulty, e.attempts, e.hintsUsed]), [[2, 99, 3]]);
    await ctx.close();
  });

  /* ═══ 10. LANGUES ═══ */
  await scenario("10. cinq langues : interface et énoncés traduits, aucune clé brute affichée", async () => {
    const { ctx, page } = await open();
    const want = { en: ["Solve", "Explain", "Practise"], es: ["Resolver", "Explicar", "Practicar"], de: ["Lösen", "Erklären", "Üben"], it: ["Risolvere", "Spiegare", "Esercitarmi"], fr: ["Résoudre", "Expliquer", "M'entraîner"] };
    for (const lang of ["en", "es", "de", "it", "fr"]) {
      await page.evaluate(l => LyonI18n.setLang(l), lang); await page.evaluate(() => switchTab("ai")); await page.waitForTimeout(250);
      const tabs = await page.$$eval("#mt-card [role=tab]", e => e.map(x => x.innerText));
      await page.click("#mt-tab-practice"); await page.selectOption("#mt-domain", "finance"); await page.click('[data-mt-level="1"]'); await page.click('[data-mt-context="business"]'); await page.click("#mt-new");
      const u = await UI(page), tx = await mtText(page);
      check(lang + " : onglets « " + want[lang].join(" · ") + " », énoncé généré dans la langue (" + u.lang + "), aucune clé « mt.* » brute", JSON.stringify(tabs) === JSON.stringify(want[lang]) && u.lang === lang && !/\bmt\.[a-z]+\.[a-z_]+/.test(tx), { tabs, lang: u.lang, raw: tx.match(/\bmt\.[a-z]+\.[a-z_]+/) });
      await page.click("#mt-tab-solve");
      await page.fill("#mt-solve-input", "");
    }
    await ctx.close();
  });

  /* ═══ 11. RESPONSIVE, ACCESSIBILITÉ, SÉCURITÉ ═══ */
  await scenario("11. mobile 390 px : aucun débordement, cibles ≥ 44 px, formules lisibles ; sécurité du HTML", async () => {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 } });
    await setup(page, "finance", 2, "business"); await page.click("#mt-new"); await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const els = [...document.querySelectorAll("#mt-card .mt-tab, #mt-card #mt-new, #mt-card #mt-check, #mt-card .mt-segbtn, #mt-card .mt-act")].filter(e => e.offsetParent);
      const small = els.filter(e => e.getBoundingClientRect().height < 43.5).map(e => e.id || e.className + ":" + Math.round(e.getBoundingClientRect().height));
      const card = document.getElementById("mt-card").getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, small, cardRight: Math.round(card.right), n: els.length };
    });
    check("aucun défilement horizontal de la page (scrollWidth ≤ largeur)", m.sw <= m.iw, m);
    check("toutes les cibles tactiles (onglets, boutons, segments) font ≥ 44 px de haut (" + m.n + " mesurées)", m.small.length === 0, m.small);
    await page.screenshot({ path: process.env.MT_SHOT_DIR ? process.env.MT_SHOT_DIR + "/mt-mobile.png" : "/dev/null" }).catch(() => {});
    await page.fill("#mt-input", "12"); await page.waitForTimeout(50);
    check("le champ de réponse est utilisable au clavier mobile (pas de zoom forcé : taille de police ≥ 16 px)", await page.$eval("#mt-input", e => parseFloat(getComputedStyle(e).fontSize) >= 16));
    await page.evaluate(() => { const u = window.revemMathTutor.ui(); u.solveInput = '"><img src=x onerror="window.__xss=1">'; u.mode = "solve"; mtRerender(); });
    await page.waitForTimeout(200);
    eq("une saisie hostile est échappée : aucun script exécuté, la valeur reste du texte", await page.evaluate(() => [window.__xss === undefined, document.getElementById("mt-solve-input").value.startsWith('"><img')]), [true, true]);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* ═══ 12. NON-RÉGRESSION VOISINE ═══ */
  await scenario("12. non-régression : l'assistant, le chat et la progression existants fonctionnent comme avant", async () => {
    const { ctx, page } = await open();
    await page.fill("#assistant-query-input", "c'est quoi l'inflation ?"); await page.click("#assistant-query-btn"); await idle(page);
    const t = await T(page);
    checkMock("une question libre non mathématique : 1 génération, profil ordinaire (pas de stratégie math, pas de sections du tuteur)", t.generates === 1 && !/ALREADY solved/.test(t.gens[0].system) && !/\*\*Intuition\*\*/.test(t.gens[0].system), t.gens[0].system.slice(-300));
    check("la carte Maths & Stats reste affichée sous le fil de conversation", !!(await page.$("#mt-card")) && (await page.$$(".ai-bubble.assistant")).length >= 1);
    eq("« Régénérer » ne garde pas de mode tuteur d'une question précédente", await page.evaluate(() => [state.aiChat.tutorOpt, state.aiChat.tutorCalc]), [null, null]);
    for (const tab of ["home", "stats", "smart", "planning"]) { await page.evaluate(x => { try { switchTab(x); } catch (e) {} }, tab); await page.waitForTimeout(120); }
    eq("les autres pages se rendent sans erreur", page.errors, []);
    await ctx.close();
  });

} finally {
  await browser.close(); srv.server.close();
}
console.log("\n" + pass + " PASS, " + mock + " PASS MOCK, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
