/* REV-EM Tuteur Maths & Stats — moteur PUR (math-tutor.js) sous Node. Sans navigateur, sans WebLLM, sans réseau.
   Lancer :  node tests/math-tutor.test.js
   « PASS » = logique exacte : générateur déterministe, vérification de chaque exercice par le Fast Engine, équivalence mathématique des réponses
              (MathVerifier), indices/méthode/solution, séance complète, suivi et maîtrise. Le rendu et le branchement sont dans math-tutor-ui.test.mjs. */
const path = require("path");
const ROOT = path.join(__dirname, "..");
["math-core.js", "math-fast.js", "math-verify.js", "math-engine.js", "math-tutor.js"].forEach(f => require(path.join(ROOT, f)));
const R = globalThis.RevemMath, T = R.tutor, E = R.engine, C = R.core;

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const LANGS = ["fr", "en", "es", "de", "it"], DOM = T.DOMAINS;

(async () => {

/* ═══ 1. COUVERTURE : 8 domaines × 3 niveaux × (pure | école de commerce) ═══════════════════════════════════════ */
console.log("\n── 1. couverture ──");
{
  eq("8 domaines demandés", DOM, ["algebra", "functions", "derivatives", "integrals", "probability", "statistics", "matrices", "finance"]);
  eq("3 niveaux : débutant, intermédiaire, avancé", T.LEVELS, ["beginner", "intermediate", "advanced"]);
  const cov = T.coverage();
  const holes = [];
  DOM.forEach(d => [0, 1, 2].forEach(l => { if (!cov[d][l].pure.length) holes.push(d + "/" + l); }));
  eq("chaque domaine a au moins un type d'exercice (contexte pure) à CHAQUE niveau", holes, []);
  const noBiz = DOM.filter(d => ![0, 1, 2].some(l => cov[d][l].business.length));
  eq("chaque domaine a au moins une version « école de commerce »", noBiz, []);
  check("au moins 30 types d'exercices", T.KINDS.length >= 30, T.KINDS.length);
  eq("tous les textes pédagogiques (cadre, indice concept, indice méthode) existent en fr / en / es / de / it", T.textsComplete(), []);
  const bizThemes = { growth: "fin-cagr", gdp: "fin-percent", yield: "fin-compound", finance: "fin-npv", discount: "fin-discount", risk: "stats-stdev", businessStats: "stats-zscore", regression: "regression-slope", probability: "proba-bayes" };
  const missing = Object.keys(bizThemes).filter(k => !T.KINDS.includes(bizThemes[k]) || !T.specOf(bizThemes[k]).biz.length);
  eq("contextes réalistes demandés : croissance, PIB, rendement, finance, actualisation, risque, stats commerciales, régression, probabilités", missing, []);
}

/* ═══ 2. BALAYAGE : chaque exercice est construit, VÉRIFIÉ, déterministe, complet ══════════════════════════════ */
console.log("\n── 2. balayage (type × niveau × contexte × langue × graines) ──");
{
  let built = 0, wanted = 0, unverified = [], exampleRejected = [], placeholders = [], fewSteps = [], nondeterm = [], nonEmpty = [], hintsBad = [];
  const sigs = {};
  for (const k of T.KINDS) {
    const sp = T.specOf(k);
    for (const lvl of sp.levels) for (const ctx of ["pure", "business"]) {
      if (ctx === "business" && !sp.biz.includes(lvl)) continue;
      if (ctx === "pure" && sp.bizOnly) continue;
      for (let seed = 1; seed <= 40; seed++) for (const lang of LANGS) {
        if (lang !== "fr" && seed > 12) continue;
        wanted++;
        const ex = T.build(k, seed, lvl, ctx, lang);
        if (!ex.ok) { unverified.push(k + "/" + lvl + "/" + ctx + "/" + seed + ":" + ex.code); continue; }
        built++;
        const r = T.check(ex, ex.example);
        if (!r.success) exampleRejected.push(k + "/" + lvl + "/" + ctx + "/" + lang + "/" + seed + ": " + ex.example + " → " + r.verdict);
        if (/\{\w+\}/.test(ex.statement.text)) placeholders.push(k + "/" + lang + "/" + seed + ": " + ex.statement.text);
        if (ex.steps.length < 2) fewSteps.push(k);
        if (!ex.statement.text || ex.statement.intro.length < 8 || !ex.expectedText) nonEmpty.push(k + "/" + lang);
        if (ex.hints.length !== 3 || ex.hints[0].type !== "concept" || ex.hints[1].type !== "method" || ex.hints[2].type !== "start" || !ex.hints[0].text || !ex.hints[1].text || !ex.hints[2].lines.length) hintsBad.push(k);
        if (lang === "fr" && seed <= 5) { const again = T.build(k, seed, lvl, ctx, lang); if (JSON.stringify([again.statement, again.expectedText, again.steps]) !== JSON.stringify([ex.statement, ex.expectedText, ex.steps])) nondeterm.push(k + "/" + seed); }
        if (lang === "fr") (sigs[k] = sigs[k] || new Set()).add(ex.signature);
      }
    }
  }
  eq("« jamais un exercice non vérifié » : aucun exercice du balayage n'a été rejeté par le Fast Engine (" + built + "/" + wanted + " construits)", unverified.slice(0, 5), []);
  eq("la réponse-exemple de CHAQUE exercice est acceptée par le vérificateur (" + built + " exercices)", exampleRejected.slice(0, 5), []);
  eq("aucun marqueur {…} non résolu dans les énoncés (5 langues)", placeholders.slice(0, 3), []);
  eq("chaque exercice a ≥ 2 étapes (la solution n'est jamais dans la première)", [...new Set(fewSteps)], []);
  eq("énoncés, réponses attendues non vides", nonEmpty.slice(0, 3), []);
  eq("3 indices ordonnés : concept → méthode → début du calcul", [...new Set(hintsBad)], []);
  eq("déterministe : même graine → même exercice, mot pour mot", nondeterm, []);
  const poor = Object.keys(sigs).filter(k => sigs[k].size < 8 && !["linear"].includes(k));
  check("variété : au moins 8 énoncés distincts sur 40 graines pour chaque type (sauf rares)", poor.length === 0, poor.map(k => k + ":" + sigs[k].size));
}

/* ═══ 3. LE MATH ENGINE COMPLET CONFIRME L'ÉNONCÉ (moteur = vérité calculatoire) ═════════════════════════════ */
console.log("\n── 3. recoupement avec le Math Engine complet (analyseur + Fast Engine) ──");
{
  const bad = [];
  const ask = async (ex, q) => { const out = await E.solve(E.analyze(q, { lang: "fr" }), { lang: "fr" }); return out && out.ok ? out : null; };
  const polyOf = ex => ex.statement.formulas[0].text.replace(/^f\(x\) = /, "");
  let nCross = 0;
  for (const [kind, lvl, qf] of [
    ["linear", 0, ex => "résous " + ex.statement.formulas[0].text], ["linear", 1, ex => "résous " + ex.statement.formulas[0].text],
    ["quad-solve", 1, ex => "résous " + ex.statement.formulas[0].text], ["quad-solve-lead", 2, ex => "résous " + ex.statement.formulas[0].text],
    ["quad-factor", 1, ex => "factorise " + polyOf(ex)], ["derivative", 0, ex => "dérivée de " + polyOf(ex)], ["derivative", 1, ex => "dérivée de " + polyOf(ex)],
    ["matrix-det2", 1, ex => "déterminant de " + ex.statement.formulas[0].text.replace(/^A = /, "").replace(/\(/, "[[").replace(/\)$/, "]]").replace(/ ; /g, "],[").replace(/(-?\d+) (?=-?\d)/g, "$1,")],
  ]) {
    for (let seed = 1; seed <= 10; seed++) {
      const ex = T.build(kind, seed, lvl, "pure", "fr"); if (!ex.ok) { bad.push(kind + "/" + seed + " build"); continue; }
      const q = qf(ex), out = await ask(ex, q);
      if (!out) { bad.push(kind + "/" + seed + " moteur sans réponse : " + q); continue; }
      nCross++;
      const verdict = T.check(ex, out.exact.text);
      if (!verdict.success) bad.push(kind + "/" + seed + " : « " + q + " » → moteur « " + out.exact.text + " » ≠ attendu « " + ex.expectedText + " » (" + verdict.verdict + ")");
    }
  }
  eq("le Math Engine complet résout chaque énoncé comme le tuteur (" + nCross + " recoupements, 8 types)", bad.slice(0, 4), []);
  // intégrales : le moteur complet et l'exercice s'accordent aussi
  const bad2 = [];
  for (let seed = 1; seed <= 12; seed++) {
    const ex = T.build("integral-def", seed, 1, "pure", "fr"), m = /\((.+)\) dx {3}\[(-?\d+) → (-?\d+)\]/.exec(ex.statement.formulas[0].text);
    if (!m) { bad2.push("format " + ex.statement.formulas[0].text); continue; }
    const out = await ask(ex, "intégrale de " + m[1] + " de " + m[2] + " à " + m[3]);
    if (!out || !T.check(ex, out.exact.text).success) bad2.push(seed + ": " + (out && out.exact.text) + " vs " + ex.expectedText);
  }
  eq("intégrales : le Math Engine complet et l'exercice donnent la même valeur (12 cas)", bad2.slice(0, 3), []);
}

/* ═══ 4. ÉQUIVALENCE MATHÉMATIQUE DES RÉPONSES ═══════════════════════════════════════════════════════════════ */
console.log("\n── 4. équivalence : 1/2 = 0,5 = 2/4 ; sets ; unités ──");
{
  const exOf = (kind, lvl, ctx, lang, pred, from) => { for (let s = from || 1; s < 400; s++) { const e = T.build(kind, s, lvl, ctx || "pure", lang || "fr"); if (e.ok && (!pred || pred(e))) return e; } throw new Error("aucun exercice " + kind); };
  const half = exOf("proba-simple", 0, "pure", "fr", e => e.expected.value.eq(C.rat(1, 2)) || (e.expected.value.n === BigInt(1) && e.expected.value.d === BigInt(2)));
  // fabrique un exercice dont la réponse est 1/2 en réutilisant la structure d'un exercice réel
  const mk = (base, value) => Object.assign({}, base, { expected: Object.assign({}, base.expected, { value }), accept: { rounding: true } });
  const base = exOf("proba-simple", 0, "pure", "fr");
  const h = mk(base, C.rat(1, 2));
  for (const a of ["1/2", "0,5", "2/4", "0.5", "50 %", "50%", "(1+1)/4", "  0,50 "]) check("réponse « " + a + " » acceptée pour 1/2", T.check(h, a).success, T.check(h, a));
  for (const a of ["1/3", "0,4", "2", "5", "49 %"]) check("réponse « " + a + " » refusée pour 1/2", T.check(h, a).verdict === "incorrect", T.check(h, a));
  eq("0,5 écrit à l'anglaise avec la virgule d'un anglophone : en/« 0.5 » accepté", T.check(Object.assign({}, h, { lang: "en" }), "0.5").success, true);

  const fac = exOf("quad-factor", 1, "pure", "fr", e => e.expectedText === "(x + 6)(x - 3)" || true);
  const [r1, r2] = fac.steps[1].match(/-?\d+/g).map(Number);
  const f = x => x === 0 ? "x" : (x < 0 ? "(x+" + (-x) + ")" : "(x-" + x + ")");
  eq("factorisation : (x−r₁)(x−r₂) accepté", T.check(fac, f(r1) + f(r2)).verdict, "correct");
  eq("factorisation : ordre des facteurs sans importance", T.check(fac, f(r2) + f(r1)).verdict, "correct");
  eq("factorisation : avec « × » et signe « − » typographique", T.check(fac, (f(r1) + "×" + f(r2)).replace(/-/g, "−")).verdict, "correct");
  const poly = fac.statement.formulas[0].text.replace(/²/g, "^2");
  eq("factorisation : le trinôme recopié est équivalent mais PAS factorisé → « bonne valeur, mauvaise forme »", [T.check(fac, poly).verdict, T.check(fac, poly).success], ["correct-wrong-form", false]);
  eq("factorisation : une autre factorisation est refusée", T.check(fac, f(r1 + 1) + f(r2)).verdict, "incorrect");

  const qs = exOf("quad-solve", 1, "pure", "fr"), [q1, q2] = qs.expectedText.match(/-?\d+/g).map(Number);
  for (const a of [q1 + " ; " + q2, q2 + " ; " + q1, "x = " + q1 + " ou x = " + q2, "x=" + q1 + " et x=" + q2, "{" + q1 + ", " + q2 + "}", q1 + " , " + q2, q1 + " or " + q2, q1 + " und " + q2, q1 + " ; " + q2 + " ; " + q1])
    check("ensemble de solutions : « " + a + " » accepté", T.check(qs, a).success, T.check(qs, a));
  eq("une seule des deux solutions → « solution(s) manquante(s) »", [T.check(qs, String(q1)).verdict, T.check(qs, String(q1)).diagnosis], ["incorrect", "partial"]);
  eq("solutions de signe opposé → diagnostic « signe »", T.check(qs, (-q1) + " ; " + (-q2)).diagnosis, q1 === -q2 ? null : "sign");

  const sys = exOf("system", 1, "pure", "fr"), [sx, sy] = sys.expectedText.match(/-?\d+/g).map(Number);
  for (const a of ["x = " + sx + " ; y = " + sy, "(" + sx + " ; " + sy + ")", sx + " ; " + sy, "y=" + sy + " ; x=" + sx, "x = " + sx + " et y = " + sy]) check("système : « " + a + " » accepté", T.check(sys, a).success, T.check(sys, a));
  eq("système : valeurs inversées → diagnostic « inversé »", sx === sy ? "skip" : T.check(sys, sy + " ; " + sx).diagnosis, sx === sy ? "skip" : "swap");
  eq("système : une seule inconnue donnée → réponse illisible, pas un essai", [T.check(sys, "x = " + sx).verdict, T.check(sys, "x = " + sx).counts], ["invalid", false]);

  const der = exOf("derivative", 1, "pure", "fr"), dform = der.example;
  eq("dérivée : forme canonique acceptée", T.check(der, dform).success, true);
  eq("dérivée : préfixe « f'(x) = » toléré", T.check(der, "f'(x) = " + dform).success, true);
  eq("dérivée : écriture avec ² et · acceptée", T.check(der, dform.replace(/\^2/g, "²").replace(/(\d)([a-z])/g, "$1·$2")).success, true);
  const derq = exOf("derivative", 0, "business", "fr");
  eq("dérivée (coût marginal en q) : « x » écrit à la place de « q » accepté", T.check(derq, derq.example.replace(/q/g, "x")).success, true);
  const derp = exOf("derivative", 2, "pure", "fr", e => /^\d+\(.+\)\^\d+$/.test(e.example), 1);
  eq("dérivée d'une puissance de parenthèse : « n·a·(ax+b)^(n−1) » écrit avec « * » ou « · » accepté ; un exposant faux refusé", [T.check(derp, derp.example.replace(/^(\d+)\(/, "$1*(")).success, T.check(derp, derp.example.replace(/^(\d+)\(/, "$1·(")).success, T.check(derp, derp.example.replace(/\^(\d+)$/, (m, e) => "^" + (Number(e) + 1))).success], [true, true, false]);

  const eur = exOf("func-eval", 0, "business", "fr");
  for (const a of [eur.example, eur.example + " €", eur.example + " euros", eur.example + "€"]) check("montant : « " + a + " » accepté", T.check(eur, a).success, T.check(eur, a));
  const big = Object.assign({}, eur, { expected: Object.assign({}, eur.expected, { value: C.rat(12500) }) });
  eq("séparateur de milliers : « 12 500 » = 12500", T.check(big, "12 500").success, true);
  eq("séparateur de milliers : « 12 500 € » = 12500", T.check(big, "12 500 €").success, true);
  eq("« 12 50 » n'est PAS 12500 (groupe invalide)", T.check(big, "12 50").success, false);

  const pct = exOf("fin-percent", 0, "pure", "fr"), pv = Number(pct.expectedText.replace(/[^\d-]/g, ""));
  eq("pourcentage : « " + pv + " », « " + pv + " % » acceptés", [T.check(pct, String(pv)).success, T.check(pct, pv + " %").success, T.check(pct, pv + "%").success], [true, true, true]);
  eq("pourcentage : écrit en taux décimal → refusé avec le diagnostic « unité »", [T.check(pct, String(pv / 100).replace(".", ",")).success, T.check(pct, String(pv / 100).replace(".", ",")).diagnosis], [false, "percent-unit"]);
  eq("pourcentage : valeur opposée → diagnostic « signe »", T.check(pct, String(-pv)).diagnosis, "sign");

  const un = exOf("proba-union", 0, "business", "fr"), uv = Number(un.expectedText.replace(/[^\d]/g, ""));
  eq("proportion : « " + uv + " % » et « " + uv / 100 + " » (même quantité) sont tous deux acceptés", [T.check(un, uv + " %").success, T.check(un, String(uv / 100).replace(".", ",")).success], [true, true]);

  const cp = exOf("fin-compound", 0, "business", "fr", e => !e.expected.value.isInt(), 1), exact = cp.expected.value, rd2 = require(path.join(ROOT, "math-fast.js")) && R.fast.roundHalfUp(exact, 2);
  eq("capital placé : le montant arrondi au centime est accepté (« correct (arrondi) »)", [T.check(cp, C.fmtRatDecimal(rd2, 2, "fr", { group: false }).text).verdict], ["correct-rounded"]);
  eq("capital placé : la valeur exacte est acceptée", T.check(cp, C.fmtRatDecimal(exact, 10, "fr", { group: false }).text).success, true);
  eq("capital placé : un montant faux est refusé", T.check(cp, C.fmtRatDecimal(rd2.add(C.rat(7)), 2, "fr", { group: false }).text).success, false);

  eq("réponse vide → « empty », ne compte pas comme un essai", [T.check(h, "   ").verdict, T.check(h, "").counts], ["empty", false]);
  eq("texte illisible → « invalid », ne compte pas comme un essai", [T.check(h, "peut-être un peu").verdict, T.check(h, "peut-être un peu").counts], ["invalid", false]);
  eq("jamais d'exécution de code : « 2+2; process.exit() » est refusé proprement", ["invalid", "incorrect"].includes(T.check(h, "process.exit(1)").verdict), true);
  eq("clés de retour traduisibles pour chaque verdict", [T.fbKey(T.check(h, "1/2")), T.fbKey(T.check(h, "1/3")), T.fbKey(T.check(h, "")), T.fbKey(T.check(h, "abc"))], ["correct", "incorrect", "empty", "invalid_stray"]);
}

/* ═══ 5. INDICES PROGRESSIFS, MÉTHODE, SOLUTION ══════════════════════════════════════════════════════════════ */
console.log("\n── 5. séance : indices 1 → 2 → 3, méthode, solution ──");
{
  const ex = T.build("quad-solve", 3, 1, "pure", "fr"), S = T.session(ex);
  eq("état initial : ouvert, 0 essai, 0 indice", [S.status, S.attempts, S.hintsUsed], ["open", 0, 0]);
  eq("avant tout effort, la solution n'est PAS offerte", [S.canShowSolution(), S.showSolution().code, S.actions()], [false, "TRY_FIRST", ["hint", "method"]]);
  const h1 = S.hint(), h2 = S.hint(), h3 = S.hint(), h4 = S.hint();
  eq("indice 1 = le concept", [h1.hint.type, h1.hint.text.length > 20, h1.left], ["concept", true, 2]);
  eq("indice 2 = la méthode", [h2.hint.type, h2.left], ["method", 1]);
  eq("indice 3 = le début du calcul (formules, première étape seulement)", [h3.hint.type, h3.hint.lines.length, h3.left], ["start", 1, 0]);
  check("l'indice 3 n'est pas la réponse finale", !h3.hint.lines.join(" ").includes(ex.expectedText), h3.hint.lines);
  eq("un 4ᵉ indice n'existe pas : on propose la méthode / la solution", [h4.ok, h4.code], [false, "NO_MORE_HINTS"]);
  eq("après des indices : la solution devient disponible (« après progression »)", S.canShowSolution(), true);
  const texts = [h1.hint.text, h2.hint.text];
  check("chaque indice est plus précis : concept ≠ méthode", texts[0] !== texts[1]);
  for (const lang of LANGS) { const e2 = T.build("quad-solve", 3, 1, "pure", lang); check("indices en " + lang + " : textes non vides et distincts", e2.hints[0].text && e2.hints[1].text && e2.hints[0].text !== e2.hints[1].text); }
  const m = T.session(T.build("quad-solve", 3, 1, "pure", "fr")); m.hint(); const mv = m.showMethod();
  eq("« Voir la méthode » : texte + toutes les étapes SAUF la dernière", [mv.method.text.length > 20, mv.method.lines.length], [true, 2]);
  check("la méthode ne contient pas la réponse finale (« x₁ = … ; x₂ = … »)", !mv.method.lines.join(" ").includes("x₁ ="), mv.method.lines);
  const sv = m.showSolution();
  eq("« Voir la solution » : réponse + toutes les étapes, clôt l'exercice", [sv.ok, sv.solution.answer, sv.solution.lines.length, m.status, m.solutionShown], [true, ex.expectedText, 3, "revealed", true]);
  eq("exercice clos : plus de réponse possible", m.answer("1").code, "CLOSED");
}

/* ═══ 6. SESSION COMPLÈTE : exercice → mauvaise réponse → indice → nouvelle réponse → réponse équivalente → validation → explication ═══ */
console.log("\n── 6. session complète ──");
{
  const ex = T.build("quad-solve", 7, 1, "pure", "fr"), [a, b] = ex.expectedText.match(/-?\d+/g).map(Number), S = T.session(ex);
  check("1. un exercice est proposé, sans la solution", ex.ok && !ex.statement.text.includes(ex.expectedText), ex.statement.text);
  const w = S.answer(a + 100 + " ; " + (b + 100));
  eq("2. mauvaise réponse → « Pas encore », retour traduisible, exercice toujours ouvert, 1 essai", [w.result.verdict, w.key, S.status, S.attempts, S.failed], ["incorrect", "incorrect", "open", 1, 1]);
  eq("   les actions proposées : Indice · Nouvel essai · Voir la méthode · Voir la solution", w.actions, ["hint", "retry", "method", "solution"]);
  const hi = S.hint();
  eq("3. indice demandé : le concept, 1 indice utilisé", [hi.hint.type, S.hintsUsed], ["concept", 1]);
  const w2 = S.answer(String(a));
  eq("4. nouvelle réponse (incomplète : une seule solution) → diagnostic précis, pas la solution", [w2.result.verdict, w2.key, S.attempts], ["incorrect", "incorrect_partial", 2]);
  const ok = S.answer(b + " ou " + a);
  eq("5. réponse mathématiquement équivalente (autre ordre, « ou ») → Correct ✓", [ok.result.verdict, ok.key, ok.status], ["correct", "correct", "solved"]);
  const expl = S.explanation();
  eq("6. explication déterministe : concept + méthode + étapes + vérification moteur", [expl.concept.length > 10, expl.method.length > 10, expl.steps.length, expl.verified.engine, expl.answer], [true, true, 3, "fast", ex.expectedText]);
  eq("   la suite proposée : expliquer avec l'IA (facultatif) · un autre exercice", S.actions(), ["explain_ai", "another"]);
  const entry = S.entry(1700000000000);
  eq("7. entrée de suivi : thème, difficulté, essais, indices, succès", [entry.topic, entry.difficulty, entry.attempts, entry.hintsUsed, entry.success, entry.solutionShown, entry.kind], ["algebra", 1, 3, 1, true, false, "quad-solve"]);
  check("   valeur de l'exercice : résolu mais avec 1 indice et 2 réponses fausses → entre 0,3 et 1 (pas 1)", T.scoreOf(entry) > 0.3 && T.scoreOf(entry) < 1, T.scoreOf(entry));
  const blk = T.aiBlock(ex, "x = " + a + " ; x = " + b, "correct");
  check("   bloc pour WebLLM : « répondre certain, ne pas recalculer », réponse vérifiée, étapes du moteur, rôle = expliquer", /do not recompute/.test(blk) && blk.includes(ex.expectedText) && /Calculation steps from the engine/.test(blk) && /Explain WHY/.test(blk), blk);
  // abandon
  const S2 = T.session(T.build("linear", 4, 0, "pure", "fr")); S2.answer("999");
  eq("abandon après effort : une entrée « non réussie » est enregistrée", [S2.entry(1, { abandoned: true }).success, S2.entry(1, { abandoned: true }).attempts], [false, 1]);
  eq("aucun effort, aucun suivi (passer un exercice n'est pas un échec)", T.session(T.build("linear", 4, 0, "pure", "fr")).entry(1, { abandoned: true }), null);
  // solution = pas un succès
  const S3 = T.session(T.build("linear", 5, 0, "pure", "fr")); S3.answer("12345"); S3.showSolution();
  const e3 = S3.entry(2);
  eq("solution montrée : l'exercice compte comme terminé mais NON réussi, valeur 0", [e3.success, e3.solutionShown, T.scoreOf(e3)], [false, true, 0]);
}

/* ═══ 7. SUIVI : attempts · success · topic · difficulty · hintsUsed · mastery ═══════════════════════════════════ */
console.log("\n── 7. suivi et maîtrise ──");
{
  const E0 = (o) => T.record(Object.assign({ ts: 1, topic: "algebra", kind: "linear", difficulty: 0, attempts: 1, hintsUsed: 0, success: true, solutionShown: false }, o));
  eq("record : les 6 champs du suivi + contexte, normalisés", Object.keys(E0({})).sort(), ["attempts", "context", "difficulty", "hintsUsed", "kind", "solutionShown", "success", "topic", "ts"]);
  eq("record : valeurs hors bornes ramenées dans les bornes", [E0({ hintsUsed: 9 }).hintsUsed, E0({ attempts: -3 }).attempts, E0({ difficulty: 7 }).difficulty, E0({ topic: "zzz", kind: "nope" }).topic], [3, 0, 2, "algebra"]);
  eq("scoreOf : résolu du premier coup sans indice = 1", T.scoreOf(E0({})), 1);
  eq("scoreOf : un indice = 0,85 ; deux fausses réponses avant = 0,8", [T.scoreOf(E0({ hintsUsed: 1 })), T.scoreOf(E0({ attempts: 3 }))], [0.85, 0.8]);
  eq("scoreOf : jamais en dessous de 0,3 pour un exercice résolu", T.scoreOf(E0({ hintsUsed: 3, attempts: 9 })), 0.3);
  eq("scoreOf : solution montrée ou abandon = 0", [T.scoreOf(E0({ solutionShown: true })), T.scoreOf(E0({ success: false }))], [0, 0]);
  const empty = T.progress([]);
  eq("sans donnée : maîtrise « null » (jamais un chiffre inventé), confiance « insufficient »", [empty.topics.algebra.mastery, empty.topics.algebra.confidence, empty.total.exercises], [null, "insufficient", 0]);
  const log = [E0({ ts: 1 }), E0({ ts: 2 }), E0({ ts: 3, hintsUsed: 1 }), E0({ ts: 4, difficulty: 2, attempts: 2 }), E0({ ts: 5, topic: "finance", kind: "fin-npv", difficulty: 1, success: false, attempts: 2 })];
  const p = T.progress(log);
  eq("agrégats par thème : exercices, réussites, essais, indices", [p.topics.algebra.exercises, p.topics.algebra.success, p.topics.algebra.attempts, p.topics.algebra.hintsUsed], [4, 4, 5, 1]);
  eq("maîtrise pondérée par la difficulté (1 / 1,5 / 2) : (1+1+0,85+2×0,9) / 5", p.topics.algebra.mastery, Math.round(100 * (1 + 1 + 0.85 + 2 * 0.9) / 5));
  eq("un thème sans réussite : maîtrise 0, un autre thème intact", [p.topics.finance.mastery, p.topics.statistics.mastery], [0, null]);
  eq("détail par difficulté", [p.topics.algebra.levels[0].exercises, p.topics.algebra.levels[2].exercises, p.topics.algebra.levels[2].mastery], [3, 1, 90]);
  eq("confiance : 4 exercices = « moderate » (mêmes seuils que smart-revision)", p.topics.algebra.confidence, "moderate");
  eq("confiance : 0 → insufficient, 1-2 → low, 3-9 → moderate, ≥ 10 → high", [0, 1, 2, 3, 9, 10].map(T.confidenceOf), ["insufficient", "low", "low", "moderate", "moderate", "high"]);
  const many = []; for (let i = 0; i < 30; i++) many.push(E0({ ts: i, success: i >= 15 }));
  eq("fenêtre des 20 derniers exercices : le passé lointain s'efface", T.progress(many).topics.algebra.mastery, 75);
  eq("indifférent à l'ordre d'arrivée du journal (fusion multi-appareils)", T.progress(log.slice().reverse()).topics.algebra.mastery, p.topics.algebra.mastery);
  const up = T.progress([E0({ ts: 1 }), E0({ ts: 2 }), E0({ ts: 3 })]).topics.algebra;
  eq("niveau conseillé : monter après 3 réussites nettes", T.suggestLevel(up, 0), { level: 1, reason: "up" });
  const down1 = T.progress([1, 2, 3].map(i => E0({ ts: i, difficulty: 1, success: false }))).topics.algebra;
  eq("niveau conseillé : redescendre d'un cran si ≥ 3 échecs au niveau 1", T.suggestLevel(down1, 1), { level: 0, reason: "down" });
  eq("niveau conseillé : trop peu de données → aucun conseil", T.suggestLevel(T.progress([E0({})]).topics.algebra, 0).reason, "none");
}

/* ═══ 8. GÉNÉRATION : domaine, niveau, contexte, repli, anti-répétition ═══════════════════════════════════════ */
console.log("\n── 8. génération ──");
{
  for (const d of DOM) for (const l of [0, 1, 2]) {
    const ex = T.generate({ domain: d, level: l, context: "pure", seed: 11, lang: "fr" });
    check("generate " + d + " / " + T.LEVELS[l] + " → exercice vérifié du bon domaine et du bon niveau", ex.ok && ex.domain === d && ex.level === l && ex.verified.ok, ex);
  }
  let ctxOk = 0; for (const d of DOM) { const ex = T.generate({ domain: d, level: 1, context: "business", seed: 5, lang: "fr" }); if (ex.ok && (ex.context === "business" || ex.contextFallback)) ctxOk++; }
  eq("contexte « école de commerce » demandé : version business, ou repli signalé", ctxOk, 8);
  const fb = T.generate({ domain: "matrices", level: 0, context: "business", seed: 3, lang: "fr" });
  eq("repli honnête : matrices débutant n'a pas de version business → exercice pur, signalé (contextFallback)", [fb.ok, fb.context, fb.contextFallback], [true, "pure", true]);
  const seen = [], avoid = [];
  for (let i = 0; i < 12; i++) { const ex = T.generate({ domain: "algebra", level: 1, context: "pure", seed: 100 + i, lang: "fr", avoid }); avoid.push(ex.signature); seen.push(ex.signature); }
  eq("anti-répétition : 12 exercices enchaînés, aucun énoncé identique", new Set(seen).size, 12);
  eq("domaine inconnu → échec propre, pas d'exception", T.generate({ domain: "alchimie", level: 1 }).ok, false);
  eq("un type précis peut être demandé", T.generate({ kind: "fin-npv", domain: "finance", level: 1, context: "pure", seed: 4 }).kind, "fin-npv");
  const t0 = Date.now(); for (let i = 0; i < 200; i++) T.generate({ domain: DOM[i % 8], level: i % 3, context: i % 2 ? "business" : "pure", seed: i + 1, lang: "fr" });
  const per = (Date.now() - t0) / 200;
  check("performance : génération + vérification < 15 ms par exercice (mesuré : " + per.toFixed(2) + " ms)", per < 15, per);
  eq("énoncé localisé : en / es / de / it", ["en", "es", "de", "it"].map(l => T.build("fin-npv", 3, 1, "business", l).statement.intro.slice(0, 18)).every((s, i, a) => s !== T.build("fin-npv", 3, 1, "business", "fr").statement.intro.slice(0, 18) && a.indexOf(s) === i), true);
  const en = T.build("fin-compound", 2, 0, "pure", "en");
  eq("anglais : le séparateur décimal est le point dans l'énoncé et accepté en réponse", [/,\d/.test(en.statement.text), T.check(en, C.fmtRatDecimal(R.fast.roundHalfUp(en.expected.value, 2), 2, "en", { group: false }).text).success], [false, true]);
}

/* ═══ 9. SÉCURITÉ ET ISOLATION ═══════════════════════════════════════════════════════════════════════════════ */
console.log("\n── 9. sécurité ──");
{
  const src = require("fs").readFileSync(path.join(ROOT, "math-tutor.js"), "utf8");
  check("aucun eval / new Function / import dynamique / fetch / DOM / stockage dans math-tutor.js", !/\beval\s*\(|new Function|\bimport\s*\(|\bfetch\s*\(|document\.|window\.|localStorage|XMLHttpRequest|innerHTML/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
  check("aucune dépendance au WebLLM ni à un nom de modèle", !/WebLLM|webllm|Qwen|DeepSeek|ai-engine|assistant-core/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
  check("pas de lookbehind regex (compatibilité Safari / WKWebView)", !/\(\?<[=!]/.test(src));
  check("pas de littéral BigInt « 0n » (compatibilité)", !/[^\w.]\d+n\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"|'[^']*'/g, "")));
  const evil = T.build("linear", 4, 0, "pure", "fr");
  for (const a of ["__proto__", "constructor", "alert(1)", "x".repeat(5000), "((((((((((((((((((((1))))))))))))))))))))", "1/0", "9^9^9^9", "2^100000"])
    check("réponse hostile « " + a.slice(0, 24) + " » → refus propre, sans exception ni blocage", (() => { const t = Date.now(); const r = T.check(evil, a); return ["invalid", "incorrect", "empty"].includes(r.verdict) && Date.now() - t < 1500; })());
}

console.log("\n" + pass + " PASS, 0 PASS MOCK, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
})();
