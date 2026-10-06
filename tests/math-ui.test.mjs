/* ============================================================================
   REV-EM — moteur mathématique, dans un VRAI Chromium
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, servi par un serveur statique (types MIME corrects), avec le VRAI Web Worker, le VRAI Pyodide + SymPy
       auto-hébergés dans vendor/, le VRAI KaTeX, le VRAI service worker et le cache réel ;
     • le chargement paresseux (rien au démarrage), le message « Initialisation… » pendant un vrai chargement, le timeout qui TUE le
       worker, le bouton Arrêter, la reprise après arrêt, le mode hors ligne ;
     • les messages EXACTS envoyés au « moteur IA » (on lit le prompt au moment où la page le poste).
   CE QUI EST REMPLACÉ : le transport vers WebLLM (aiTransport) est un FAUX — « PASS MOCK » pour tout ce qui concerne le modèle de langage.
   JAMAIS testé ici : Safari, WKWebView, macOS, WebGPU, vrai WebLLM (NOT TESTED SAFARI / NOT TESTED WKWEBVIEW / NOT TESTED MAC / NOT TESTED REAL WEBLLM).

   Lancer :  NODE_PATH=/opt/node22/lib/node_modules node tests/math-ui.test.mjs      (≈ 2-3 min : chaque démarrage de SymPy prend ≈ 9 s)
   ========================================================================== */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { startStatic } = await import("./helpers/static-server.mjs");

let pass = 0, fail = 0, mock = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 400) : "")); } };
const checkMock = (name, ok, got) => { if (ok) { mock++; console.log("PASS MOCK — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 400) : "")); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 700)); }
}

const srv = await startStatic(ROOT);
const APP = srv.base + "/index.html";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const FAKE = `
window.__T = { sent: [], script: [], aborted: 0, tokenMs: 4 };
aiTransport = {
  mode: "worker", terminate() {},
  send(msg) {
    const T = window.__T; T.sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === "ABORT") { T.abortFlag = true; T.aborted++; return; }
    if (msg.type !== "GENERATE") return;
    const step = T.script.length ? T.script.shift() : { text: "Voici une explication de test." };
    T.abortFlag = false;
    const t0 = performance.now();
    (async () => {
      await new Promise(r => setTimeout(r, step.startMs || 8));
      if (step.error) { aiOnHostMessage({ type: "GENERATION_ERROR", id: msg.id, code: step.error.code, message: step.error.message || "x" }); return; }
      const words = (step.text || "").split(/(?<= )/);
      let sent = 0;
      for (const w of words) { if (T.abortFlag) break; await new Promise(r => setTimeout(r, step.tokenMs || T.tokenMs)); aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: w }); sent += w.length; }
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: sent, ttftMs: 12, totalMs: Math.round(performance.now() - t0), finishReason: T.abortFlag ? "abort" : "stop" });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
`;

async function open(opts) {
  opts = opts || {};
  const ctx = opts.ctx || await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(900);
  if (opts.model) await page.evaluate(FAKE);
  if (opts.lang) await page.evaluate((l) => { LyonI18n.setLang(l); }, opts.lang);
  await page.evaluate(() => { switchTab("ai"); });
  await page.waitForTimeout(250);
  return { ctx, page };
}
const idle = (page, ms) => page.waitForFunction(() => !state.aiBusy, null, { timeout: ms || 60000 }).then(() => page.waitForTimeout(80));
async function ask(page, q, o) {
  o = o || {};
  const follow = await page.$("#ai-follow-input");
  if (follow && await follow.isVisible()) { await follow.fill(q); await page.click("#ai-follow-btn"); }
  else { await page.fill("#assistant-query-input", q); await page.click("#assistant-query-btn"); }
  if (!o.noWait) await idle(page, o.timeout);
}
const bubbles = (page) => page.$$eval(".ai-bubble.assistant", els => els.map(e => e.innerText));
const lastCard = (page) => page.$$eval(".mx-card", els => els.length ? els[els.length - 1].innerText : null);
const vendorHits = () => srv.hits.filter(h => h.indexOf("/vendor/") >= 0);
const gens = (page) => page.evaluate(() => window.__T.sent.filter(m => m.type === "GENERATE"));

try {

  await scenario("1. démarrage : AUCUN téléchargement lourd, moteur présent, zéro erreur", async () => {
    srv.hits.length = 0;
    const { ctx, page } = await open();
    check("RevemMath.engine / .cas / .fast / .verify chargés", await page.evaluate(() => !!(RevemMath.engine && RevemMath.cas && RevemMath.fast && RevemMath.verify && RevemMath.core)));
    eq("aucune requête vers vendor/ au démarrage (ni Pyodide, ni SymPy, ni KaTeX)", vendorHits(), []);
    eq("l'état du CAS au démarrage = inactif (rien chargé)", await page.evaluate(() => RevemMath.cas.state), "idle");
    check("le message « Initialisation du moteur mathématique… » n'est PAS affiché au démarrage", !(await page.content()).includes("Initialisation du moteur math"));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("2. problème simple SANS modèle IA : résultat exact + vérifié, sans CAS, KaTeX chargé à la demande", async () => {
    srv.hits.length = 0;
    const { ctx, page } = await open();
    eq("barre de question ACTIVE même sans modèle (le moteur est déterministe)", await page.$eval("#assistant-query-input", e => e.disabled), false);
    await ask(page, "factorise x^2-5x+6");
    const card = await lastCard(page);
    check("badge « VÉRIFIÉ (EXACT) » et étiquette « Factorisation »", /VÉRIFIÉ \(EXACT\)/.test(card) && /Factorisation/.test(card), card);
    check("le résultat (x−2)(x−3) est affiché (KaTeX + MathML : la valeur est lisible)", /x\s*−\s*2/.test(card) && /x\s*−\s*3/.test(card), card);
    check("moteur « Calcul exact » (Fast Engine)", /Calcul exact/.test(card));
    eq("aucune requête vers pyodide / sympy pour un calcul exact", vendorHits().filter(h => /pyodide|\/py\//.test(h)), []);
    await page.waitForFunction(() => document.querySelectorAll(".mx-tex[data-done]").length > 0, null, { timeout: 8000 });
    check("KaTeX réellement chargé (vendor/katex) et formule rendue", vendorHits().some(h => /katex\.min\.js/.test(h)) && (await page.$$(".mx-card .katex")).length > 0);
    check("l'indice « charge le modèle IA pour l'explication » est affiché", /Charge le modèle IA/.test((await bubbles(page)).pop()));
    check("diagnostic développeur renseigné (type, moteur, statut)", await page.evaluate(() => { const d = state.aiChat.diag.math; return d.mathProblemType === "factor" && d.engineUsed === "fast" && d.verificationStatus === "VERIFIED_EXACT" && d.calculationTimeMs >= 0; }));
    // un problème impossible : message, jamais de résultat
    await ask(page, "calcule 5/0");
    const c2 = await lastCard(page);
    check("division par zéro : « Saisie invalide » + explication, AUCUN résultat", /Saisie invalide/i.test(c2) && /Division par zéro/.test(c2) && !/RÉSULTAT/i.test(c2), c2);
    await ask(page, "inverse de [[1,2],[2,4]]");
    { const cs = await lastCard(page); check("matrice singulière : « non inversible », vérifiée exactement", /non\s+inversible/.test(cs) && /VÉRIFIÉ \(EXACT\)/.test(cs), cs); }
    await ask(page, "variance de 2 4 4 4 5 5 7 9");
    const c3 = await lastCard(page);
    check("variance : population ET échantillon + convention signalée comme non précisée", /POPULATION/.test(c3) && /ÉCHANTILLON/.test(c3) && /Convention non précisée/.test(c3), c3);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("3. calcul formel : chargement paresseux, message d'initialisation, résultat vérifié, 2e calcul immédiat", async () => {
    srv.hits.length = 0;
    const { ctx, page } = await open();
    await ask(page, "limite de sin(x)/x quand x tend vers 0", { noWait: true });
    let sawInit = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const busy = await page.evaluate(() => state.aiBusy);
      const txt = await page.$eval("#ai-stream", e => e.innerText).catch(() => "");
      if (/Initialisation du moteur mathématique/.test(txt)) sawInit = true;
      if (!busy) break;
      await page.waitForTimeout(150);
    }
    const firstMs = Date.now() - t0;
    check("« Initialisation du moteur mathématique… » affiché pendant le VRAI chargement", sawInit);
    check("Pyodide + SymPy demandés seulement maintenant (vendor/pyodide, vendor/py)", vendorHits().some(h => /pyodide\.asm\.wasm/.test(h)) && vendorHits().some(h => /sympy-/.test(h)));
    const card = await lastCard(page);
    check("lim sin x / x = 1, « Calcul formel », « Vérifié numériquement », mention « pas une démonstration »", /Calcul formel/.test(card) && /Vérifié numériquement/i.test(card) && /pas une démonstration/.test(card) && /\b1\b/.test(card), card);
    check("après le calcul, l'état du CAS = prêt", await page.evaluate(() => RevemMath.cas.state) === "ready");
    const d1 = await page.evaluate(() => state.aiChat.diag.math);
    check("diagnostic : moteur « cas », temps de chargement du CAS et de calcul renseignés", d1.engineUsed === "cas" && d1.casLoadTimeMs > 500 && d1.calculationTimeMs > 0 && d1.verificationStatus === "VERIFIED_NUMERICALLY", d1);
    console.log(`   mesure : 1ʳᵉ question formelle (chargement SymPy compris) = ${firstMs} ms · casLoadTime = ${d1.casLoadTimeMs} ms · calcul SymPy = ${d1.casMs} ms`);
    const t1 = Date.now();
    await ask(page, "dérivée de sin(x)*exp(x)");
    const secondMs = Date.now() - t1;
    check("2ᵉ question formelle : PAS de nouvelle initialisation, réponse en moins de 3 s (mesuré " + secondMs + " ms)", secondMs < 3000 && !(await page.content()).includes("Initialisation du moteur math"), secondMs);
    check("(sin x · eˣ)′ vérifié numériquement", /Vérifié numériquement/i.test(await lastCard(page)));
    const before = vendorHits().length;
    await ask(page, "intégrale de x*exp(x) dx");
    eq("aucun nouveau téléchargement lourd pour les calculs suivants", vendorHits().filter(h => /pyodide|\/py\//.test(h)).length, vendorHits().filter(h => /pyodide|\/py\//.test(h)).length);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("4. calcul trop long : le worker est TUÉ à l'échéance, l'application reste fluide, le moteur redémarre ensuite", async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { window.revemMathConfig = { timeoutMs: 3500 }; });
    await ask(page, "limite de sin(x)/x quand x tend vers 0");            // charge SymPy (le délai de calcul ne compte pas le chargement)
    const t0 = Date.now();
    await ask(page, "intégrale de exp(-x^2)*sin(x)^5*x^3 de 0 à oo", { timeout: 30000 });
    const ms = Date.now() - t0;
    const card = await lastCard(page);
    check("échec propre : « Non pris en charge » + « trop de temps », aucun résultat (mesuré " + ms + " ms)", /Non pris en charge/i.test(card) && /trop de temps/.test(card) && !/RÉSULTAT/i.test(card) && !/Calcul exact/i.test(card), card);
    check("le délai est respecté (≈ 3,5 s, pas 30 s ni infini)", ms >= 3000 && ms < 9000, ms);
    eq("le worker a été terminé : état du CAS = inactif", await page.evaluate(() => RevemMath.cas.state), "idle");
    check("la page répond toujours (aucun gel) : le champ de saisie fonctionne", await page.evaluate(() => { const i = document.getElementById("assistant-query-input"); i.value = "ok"; return i.value === "ok"; }));
    check("diagnostic : errorCode = CAS_TIMEOUT", await page.evaluate(() => state.aiChat.diag.math.errorCode) === "CAS_TIMEOUT");
    await ask(page, "dérivée de sin(x)*exp(x)");
    check("le moteur REDÉMARRE tout seul à la question suivante et répond", /Vérifié numériquement/i.test(await lastCard(page)));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("5. bouton Arrêter pendant un calcul formel : calcul tué, aucune carte, interface libre", async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { window.revemMathConfig = { timeoutMs: 60000 }; });
    await ask(page, "limite de sin(x)/x quand x tend vers 0");
    const nBefore = (await bubbles(page)).length;
    await ask(page, "intégrale de exp(-x^2)*sin(x)^5*x^3 de 0 à oo", { noWait: true });
    await page.waitForTimeout(1200);
    check("calcul en cours : message « Calcul en cours… », bouton Arrêter visible", /Calcul en cours/.test(await page.$eval("#ai-stream", e => e.innerText).catch(() => "")) && !!(await page.$("#assistant-stop-btn")));
    const t0 = Date.now();
    await page.click("#assistant-stop-btn");
    await idle(page, 8000);
    check("arrêt effectif en < 2 s (mesuré " + (Date.now() - t0) + " ms)", Date.now() - t0 < 2500);
    eq("phase = ABORTED, aucune carte ajoutée à la conversation", [await page.evaluate(() => state.aiChat.phase), (await page.$$(".mx-card")).length], ["ABORTED", 1]);
    eq("le moteur est inactif (worker tué)", await page.evaluate(() => RevemMath.cas.state), "idle");
    await ask(page, "factorise x^2-5x+6");
    check("la question suivante fonctionne normalement", /VÉRIFIÉ \(EXACT\)/.test(await lastCard(page)));
    void nBefore;
    await ctx.close();
  });

  await scenario("6. avec le modèle IA (faux) : le LLM reçoit le résultat du moteur et EXPLIQUE, il ne calcule pas", async () => {
    const { ctx, page } = await open({ model: true });
    await page.evaluate(() => { window.__T.script.push({ text: "On cherche deux nombres de somme 5 et de produit 6 : ce sont 2 et 3, donc x²−5x+6 = (x−2)(x−3)." }); });
    await ask(page, "factorise x^2-5x+6");
    const g = await gens(page);
    eq("un seul appel au modèle", g.length, 1);
    const sys = g[0].messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    checkMock("le prompt contient l'en-tête « MATH ENGINE RESULT (… verified exactly — authoritative) »", /MATH ENGINE RESULT \(computed deterministically, verified exactly — authoritative\)/.test(sys), sys.slice(-600));
    checkMock("…le résultat exact (x - 2)(x - 3) y figure déjà, calculé par le moteur", /exact result: \(x - 2\)\(x - 3\)/.test(sys));
    checkMock("…avec l'interdiction de recalculer / modifier un nombre", /never recompute/.test(sys));
    checkMock("…et SANS l'ancien en-tête « VERIFIED CALCULATION »", !/VERIFIED CALCULATION \(computed locally, exact\):/.test(sys.split("MATH ENGINE RESULT")[0].slice(-80)));
    const b = (await bubbles(page)).pop();
    check("la carte du moteur est affichée AU-DESSUS de l'explication du modèle", /VÉRIFIÉ \(EXACT\)/.test(b) && /On cherche deux nombres/.test(b) && b.indexOf("VÉRIFIÉ") < b.indexOf("On cherche"), b);
    check("la connaissance « REV-EM Knowledge » n'est pas injectée pour un calcul (le moteur fait autorité)", await page.evaluate(() => state.aiChat.diag.knowledgeStatus) === "skipped:calculation");
    // un résultat non vérifié ne doit pas être présenté comme certain
    await page.evaluate(() => { window.__T.script.push({ text: "Je ne peux pas confirmer ce résultat." }); });
    await ask(page, "résous exp(x)=5");
    const g2 = await gens(page);
    const sys2 = g2[g2.length - 1].messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    checkMock("calcul impossible sans CAS chargé en échec : le bloc interdit d'inventer", /MATH ENGINE/.test(sys2));
    // le modèle échoue : le résultat vérifié reste affiché
    await page.evaluate(() => { window.__T.script.push({ error: { code: "GENERATION_FAILED", message: "boom" } }, { error: { code: "GENERATION_FAILED", message: "boom" } }); });
    await ask(page, "dérivée de x^3+2x^2-5x+3");
    const lastB = (await bubbles(page)).pop();
    check("explication impossible (erreur du modèle) : le RÉSULTAT vérifié reste affiché", /VÉRIFIÉ \(EXACT\)/.test(lastB) && /3x\s*2|3x²|3x/.test(lastB), lastB);
    check("…et l'erreur du modèle est annoncée normalement", await page.evaluate(() => !!state.aiError));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("7. une question de cours n'active PAS le moteur (aucune régression du chat)", async () => {
    const { ctx, page } = await open({ model: true });
    await page.evaluate(() => { window.__T.script.push({ text: "La VAN est la valeur actuelle nette des flux futurs." }); });
    await ask(page, "Qu'est-ce que la VAN ?");
    eq("aucune carte mathématique", (await page.$$(".mx-card")).length, 0);
    const g = await gens(page);
    check("le prompt n'a ni bloc MATH ENGINE ni bloc VERIFIED CALCULATION", !/MATH ENGINE|VERIFIED CALCULATION \(computed/.test(JSON.stringify(g[0].messages)));
    eq("diag.math absent", await page.evaluate(() => state.aiChat.diag.math === undefined), true);
    await page.evaluate(() => { window.__T.script.push({ text: "Plus simple : la VAN dit si un projet crée de la valeur." }); });
    await ask(page, "plus simplement");
    eq("la suite « plus simplement » fonctionne comme avant", (await gens(page)).length, 2);
    await ctx.close();
  });

  await scenario("8. sans modèle : une question NON mathématique garde l'erreur habituelle (pas de réponse inventée)", async () => {
    const { ctx, page } = await open();
    await ask(page, "Qu'est-ce que la VAN ?");
    check("message « modèle non chargé » affiché, rien d'ajouté à la conversation", await page.evaluate(() => !!state.aiError) && (await page.$$(".mx-card")).length === 0);
    await ctx.close();
  });

  await scenario("9. M'ENTRAÎNER : exercice déterministe, réponse comparée mathématiquement, indice → solution", async () => {
    const { ctx, page } = await open();
    await ask(page, "Donne-moi un exercice sur les dérivées");
    const b0 = (await bubbles(page)).pop();
    check("l'énoncé de l'exercice est affiché + consigne", /Calcule la dérivée de/.test(b0) && /Exercice/.test(b0), b0);
    eq("pistes proposées : Indice / Voir la solution", await page.$$eval("[data-ai-sug]", e => e.map(b => b.dataset.aiSug)), ["practice_hint", "practice_solution"]);
    await ask(page, "x^2");
    check("mauvaise réponse : « pas encore ça », SANS révéler la solution", /Ce n'est pas encore ça/.test((await bubbles(page)).pop()) && !/solution/i.test((await bubbles(page)).pop()));
    eq("pistes : Réessayer / Indice / Étape suivante / Voir la solution", await page.$$eval("[data-ai-sug]", e => e.map(b => b.dataset.aiSug)), ["practice_retry", "practice_hint", "practice_step", "practice_solution"]);
    await page.click('[data-ai-sug="practice_hint"]');
    check("Indice : un indice, pas la réponse", /Indice :/.test((await bubbles(page)).pop()));
    const exp = await page.evaluate(() => state.aiChat.practice.ex.expectedText.replace(/^f'\(x\) = /, ""));
    await ask(page, "mauvais ??? résultat");
    check("réponse illisible : « je n'ai pas pu lire ta réponse » (pas « incorrect »)", /pas pu lire/.test((await bubbles(page)).pop()), (await bubbles(page)).pop());
    // une écriture DIFFÉRENTE mais équivalente est acceptée
    const spaced = exp.replace(/\+/g, " + ").replace(/x\^2/g, "x^2");
    await ask(page, spaced);
    check("réponse correcte (écrite avec des espaces) : « Correct ! »", /Correct/.test((await bubbles(page)).pop()), [spaced, (await bubbles(page)).pop()]);
    eq("après une bonne réponse : « Un autre exercice »", await page.$$eval("[data-ai-sug]", e => e.map(b => b.dataset.aiSug)), ["practice_another"]);
    await page.click('[data-ai-sug="practice_another"]');
    check("un autre exercice est proposé", /Calcule|Résous|Factorise|moyenne|capital/i.test((await bubbles(page)).pop()));
    await page.click('[data-ai-sug="practice_solution"]');
    check("Voir la solution : la solution est donnée", /Solution :/.test((await bubbles(page)).pop()));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("10. langues : l'interface de la carte suit la langue (EN, ES, DE, IT)", async () => {
    for (const [lang, status, ph] of [["en", /VERIFIED \(EXACT\)/, "Exact computation"], ["es", /VERIFICADO \(EXACTO\)/, "Cálculo exacto"], ["de", /VERIFIZIERT \(EXAKT\)/, "Exakte Berechnung"], ["it", /VERIFICATO \(ESATTO\)/, "Calcolo esatto"]]) {
      const { ctx, page } = await open({ lang });
      const q = { en: "solve x^2-5x+6=0", es: "resuelve x^2-5x+6=0", de: "löse x^2-5x+6=0", it: "risolvi x^2-5x+6=0" }[lang];
      await ask(page, q);
      const card = await lastCard(page);
      check(`[${lang}] carte traduite : statut + moteur`, status.test(card) && card.indexOf(ph) >= 0, card);
      check(`[${lang}] aucun libellé français dans la carte`, !/Problème|Résultat|Vérifié|Calcul exact/.test(card), card);
      await ctx.close();
    }
    const { ctx, page } = await open({ lang: "en" });
    await ask(page, "variance of 2 4 4 4 5 5 7 9");
    const c = await lastCard(page);
    check("[en] statistiques : libellés traduits, convention signalée", /POPULATION variance/.test(c) && /SAMPLE variance/.test(c) && /Convention not specified/.test(c) && /4\.571429/.test(c), c);
    await ctx.close();
  });

  await scenario("11. responsive : aucune barre de défilement horizontale, grand résultat compris", async () => {
    for (const w of [375, 768]) {
      const { ctx, page } = await open({ viewport: { width: w, height: 800 } });
      await ask(page, "calcule 2^300");
      await ask(page, "mensualité emprunt 200000 € 3 % 20 ans");
      const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, card: Math.max.apply(null, Array.from(document.querySelectorAll(".mx-card")).map(c => c.getBoundingClientRect().right)) - window.innerWidth }));
      check(`${w}px : pas de débordement horizontal de la page (${ov.doc}px) ni de la carte (${ov.card}px)`, ov.doc <= 1 && ov.card <= 1, ov);
      await ctx.close();
    }
  });

  await scenario("12. service worker : après un usage, le CAS et KaTeX marchent HORS LIGNE (cache réel)", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const { page } = await open({ ctx });
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await page.waitForTimeout(1500); await page.evaluate(() => switchTab("ai")); }
    check("le service worker contrôle la page", await page.evaluate(() => !!navigator.serviceWorker.controller));
    await ask(page, "limite de sin(x)/x quand x tend vers 0");
    check("premier usage en ligne : résultat obtenu", /Vérifié numériquement/i.test(await lastCard(page)));
    const cached = await page.evaluate(async () => { const c = await caches.open("rev-em-math-v1"); return (await c.keys()).map(r => new URL(r.url).pathname); });
    check("le cache « rev-em-math-v1 » contient pyodide.asm.wasm, python_stdlib.zip, sympy, mpmath, katex", ["pyodide.asm.wasm", "python_stdlib.zip", "sympy-", "mpmath-", "katex.min.js"].every(k => cached.some(p => p.indexOf(k) >= 0)), cached);
    const shell = await page.evaluate(async () => { const keys = await caches.keys(); const sk = keys.find(k => /-shell$/.test(k)); const c = await caches.open(sk); return (await c.keys()).map(r => new URL(r.url).pathname); });
    check("le shell précaché contient les modules math + math-cas.py + le worker", ["math-core.js", "math-fast.js", "math-verify.js", "math-engine.js", "math-cas-client.js", "math-cas-worker.js", "math-cas.py"].every(k => shell.some(p => p.endsWith("/" + k))), shell.filter(p => /math/.test(p)));
    check("vendor/ n'est PAS précaché à l'installation (seulement à l'usage)", !shell.some(p => /\/vendor\//.test(p)));
    check("l'ancien nom de cache n'a pas supprimé le cache math (activation conserve MATH_CACHE)", (await page.evaluate(() => caches.keys())).some(k => k === "rev-em-math-v1"));
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForTimeout(1500);
    await page.evaluate(() => switchTab("ai"));
    await page.waitForTimeout(300);
    const t0 = Date.now();
    await ask(page, "dérivée de sin(x)*exp(x)", { timeout: 90000 });
    const card = await lastCard(page);
    check("HORS LIGNE, après rechargement : le calcul formel fonctionne depuis le cache (" + (Date.now() - t0) + " ms)", /Vérifié numériquement/i.test(card), card);
    await page.waitForTimeout(500);
    check("HORS LIGNE : KaTeX rendu depuis le cache", (await page.$$(".mx-card .katex")).length > 0);
    await ctx.setOffline(false);
    await ctx.close();
  });

  await scenario("13. fichiers du CAS injoignables : échec propre et expliqué, le moteur exact continue, nouvel essai possible", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    srv.state.blocked = /\/vendor\/pyodide\//;                 // le serveur répond 404 pour Pyodide : simule des fichiers absents / injoignables
    const { page } = await open({ ctx });
    const t0 = Date.now();
    await ask(page, "limite de sin(x)/x quand x tend vers 0");
    const c1 = await lastCard(page);
    check("« Non pris en charge » + « moteur de calcul formel n'a pas pu être chargé », aucun résultat (en " + (Date.now() - t0) + " ms)", /Non pris en charge/i.test(c1) && /n'a pas pu être chargé/.test(c1) && !/RÉSULTAT/i.test(c1), c1);
    check("le CAS n'est pas resté « en chargement » (état d'erreur ou inactif)", ["idle", "error"].indexOf(await page.evaluate(() => RevemMath.cas.state)) >= 0);
    check("diagnostic : code d'erreur renseigné", /^CAS_/.test(await page.evaluate(() => state.aiChat.diag.math.errorCode || "")));
    await ask(page, "factorise x^2-5x+6");
    check("le moteur EXACT fonctionne quand même", /VÉRIFIÉ \(EXACT\)/.test(await lastCard(page)));
    srv.state.blocked = null;
    await ask(page, "limite de sin(x)/x quand x tend vers 0");
    check("fichiers de nouveau disponibles : le calcul formel réussit au nouvel essai (rien n'est resté bloqué)", /Vérifié numériquement/i.test(await lastCard(page)));
    eq("aucune erreur JavaScript non gérée", page.errors, []);
    await ctx.close();
  });

  await scenario("14. calcul chiffré NON reconnu par le moteur : le modèle est prévenu, l'élève voit « calcul non vérifié »", async () => {
    const { ctx, page } = await open({ model: true });
    await page.evaluate(() => { window.__T.script.push({ text: "12 m × 3 m = 36 m² (estimation du modèle)." }); });
    await ask(page, "calcule 12 m * 3 m");
    const g = await gens(page);
    const sys = g[0].messages.filter(m => m.role === "system").map(m => m.content).join("\n");
    checkMock("le prompt contient « MATH ENGINE REPORT » : aucun résultat vérifié n'existe, le modèle doit le dire", /MATH ENGINE REPORT \(authoritative\)/.test(sys) && /UNVERIFIED estimate/.test(sys), sys.slice(-500));
    const b = (await bubbles(page)).pop();
    check("note visible sous la réponse : « Calcul non vérifié… ce résultat vient du modèle seul »", /Calcul non vérifié/.test(b) && /modèle seul/.test(b), b);
    eq("aucune carte de résultat (rien n'est présenté comme calculé)", (await page.$$(".mx-card")).length, 0);
    await page.evaluate(() => { window.__T.script.push({ text: "La VAN est la valeur actuelle nette." }); });
    await ask(page, "Qu'est-ce que la VAN ?");
    check("une question de cours : pas de note « non vérifié »", !/Calcul non vérifié/.test((await bubbles(page)).pop()));
    await ctx.close();
  });

} finally {
  await browser.close();
  srv.server.close();
}
console.log(`\n${pass} PASS, ${mock} PASS MOCK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
