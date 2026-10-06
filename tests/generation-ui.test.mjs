/* ============================================================================
   REV-EM — répétitions et fin de génération, dans un vrai Chromium
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL : index.html tel quel (chaîne aiGeneralAsk → assistant-core → aiHostGenerate → assembleur → rendu), le moteur mathématique
   (Fast Engine exact), le DOM réellement affiché, les messages EXACTS postés au « moteur IA » (prompt, max_tokens, température).
   CE QUI EST REMPLACÉ : le modèle. Le transport (aiTransport) est un FAUX qui rejoue des flux SCRIPTÉS (deltas, boucle, coupure par la limite,
   erreur de contexte, flux cumulatif). Donc tout est « PASS MOCK » : on prouve que, POUR UN FLUX DONNÉ, le pipeline n'ajoute aucune répétition,
   arrête tôt une génération qui redémarre, retire la queue coupée, n'efface rien de légitime. On NE PROUVE PAS ce que fait un vrai WebLLM
   (NOT TESTED REAL WEBLLM, NOT TESTED GPU, NOT TESTED MAC, NOT TESTED WKWEBVIEW).

   Lancer :  NODE_PATH=/opt/node22/lib/node_modules node tests/generation-ui.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { startStatic } = await import("./helpers/static-server.mjs");

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS MOCK — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 500) : "")); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 700)); }
}

const srv = await startStatic(ROOT);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

/* Faux transport : rejoue un script ; enregistre ce que la page envoie ; s'arrête dès ABORT (comme l'hôte). */
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
    const rec = { id: msg.id, maxTokens: msg.maxTokens, temperature: msg.temperature, topP: msg.topP, promptChars: msg.messages.reduce((n, m) => n + m.content.length, 0), sentChars: 0, totalChars: (step.text || "").length + (step.partial || "").length };
    T.gens.push(rec);
    const t0 = performance.now();
    (async () => {
      await new Promise(r => setTimeout(r, 5));
      const emit = async (text, size) => {
        const parts = []; for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
        let acc = "";
        for (const w of parts) {
          if (T.abortFlag) return false;
          await new Promise(r => setTimeout(r, 1));
          acc += w; rec.sentChars += w.length;
          aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: step.cumulative ? acc : w });
        }
        return true;
      };
      if (step.partial) await emit(step.partial, step.chunk || 6);
      if (step.error) { aiOnHostMessage({ type: "GENERATION_ERROR", id: msg.id, code: step.error.code, message: step.error.message || "x", contextExceeded: !!step.error.contextExceeded }); return; }
      await emit(step.text || "", step.chunk || 6);
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: rec.sentChars, ttftMs: 12, totalMs: Math.round(performance.now() - t0), finishReason: T.abortFlag ? "abort" : (step.finish || "stop") });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
`;

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(srv.base + "/index.html");
  await page.waitForTimeout(900);
  await page.evaluate(FAKE);
  await page.evaluate(() => { switchTab("ai"); });
  await page.waitForTimeout(250);
  return { ctx, page };
}
const script = (page, steps) => page.evaluate((s) => { window.__T.script.push(...s); }, steps);
const idle = (page) => page.waitForFunction(() => !state.aiBusy, null, { timeout: 30000 }).then(() => page.waitForTimeout(120));
async function ask(page, q) {
  const follow = await page.$("#ai-follow-input");
  if (follow && await follow.isVisible()) { await follow.fill(q); await page.click("#ai-follow-btn"); }
  else { await page.fill("#assistant-query-input", q); await page.click("#assistant-query-btn"); }
  await idle(page);
}
const body = (page) => page.$$eval(".ai-bubble.assistant .ai-result-body", els => els.length ? els[els.length - 1].innerText : "");
const T = (page) => page.evaluate(() => ({ gens: window.__T.gens, generates: window.__T.sent.filter(m => m.type === "GENERATE").length, aborts: window.__T.aborts }));
const diag = (page) => page.evaluate(() => state.aiChat.diag);
const count = (s, re) => (s.match(re) || []).length;

/* Le cas réel rapporté : la même démonstration, reformulée, trois fois, puis coupée en plein milieu. */
const A = "Pour résoudre x² - 5x + 6 = 0, on factorise le trinôme. On cherche deux nombres de somme 5 et de produit 6 : ce sont 2 et 3.\n\nDonc x² - 5x + 6 = (x - 2)(x - 3). Ainsi (x - 2)(x - 3) = 0, donc x = 2 ou x = 3.\n\nVérification : 2² - 5×2 + 6 = 0 et 3² - 5×3 + 6 = 0.";
const B = "Pour résoudre l'équation x² - 5x + 6 = 0, on la factorise. On cherche deux nombres dont la somme vaut 5 et le produit vaut 6 : ce sont 2 et 3.\n\nDonc x² - 5x + 6 = (x - 2)(x - 3). Ainsi (x - 2)(x - 3) = 0, donc x = 2 ou x = 3.\n\nVérification : 2² - 5×2 + 6 = 0 et 3² - 5×3 + 6 = 0.";
const CUT = "Par (x - 2)(x - 3) = ... se factorise l'équation x² - 5x + 6 = 0 en (";
const LOOPING = A + "\n\n" + B + "\n\n" + A + "\n\n" + B + "\n\n" + CUT;

try {

  await scenario("1. le cas rapporté : « x² - 5x + 6 = 0 » → démonstration répétée puis coupée", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: LOOPING, finish: "length", chunk: 6 }]);
    await ask(page, "x² - 5x + 6 = 0");
    const t = await T(page), d = await diag(page), shown = await body(page);
    eq("UNE seule génération pour la question (generationCount = 1, un seul GENERATE posté)", [d.generationCount, t.generates], [1, 1]);
    check("une ÉQUATION NUE est reconnue par le moteur : résultat déterministe fourni au modèle", d.math && d.math.mathProblemType === "equation" && d.math.verificationStatus === "VERIFIED_EXACT", d.math);
    check("carte du moteur affichée (x = 2 ; x = 3, vérifié exactement)", /VÉRIFIÉ \(EXACT\)/.test(await page.$$eval(".mx-card", e => e[e.length - 1].innerText)));
    const g = t.gens[0];
    check("budget proportionné : max_tokens ≤ 320 (et non 600), température 0,3", g.maxTokens <= 320 && g.temperature === 0.3, g);
    check("le redémarrage est détecté PENDANT le flux : un ABORT est envoyé, la génération s'arrête bien avant la fin du script", t.aborts === 1 && g.sentChars < g.totalChars * 0.75, [t.aborts, g.sentChars, g.totalChars]);
    eq("AFFICHÉ : la conclusion « x = 2 ou x = 3 » n'apparaît qu'UNE fois", count(shown, /x = 2 ou x = 3/g), 1);
    check("AFFICHÉ : aucune des reformulations ultérieures, aucune queue coupée « en ( »", shown.indexOf("Pour résoudre l'équation") < 0 && !/en \($/.test(shown.trim()) && !/se factorise l'équation/.test(shown), shown);
    check("AFFICHÉ : la vérification est présente (réponse complète)", /Vérification : 2²/.test(shown));
    const lo = await page.evaluate(() => window.revemLastRawOutput());
    check("DIAGNOSTIC : le BRUT contient bien la répétition (le modèle a redémarré) ; l'AFFICHÉ non", count(lo.rawModelOutput, /donc x = 2 ou x = 3/g) >= 2 && count(lo.displayedOutput, /donc x = 2 ou x = 3/g) === 1, [count(lo.rawModelOutput, /donc x = 2 ou x = 3/g), count(lo.displayedOutput, /donc x = 2 ou x = 3/g)]);
    check("DIAGNOSTIC : stades raw/assembled = répété ; processed/displayed = propre ; première apparition = « raw » (le modèle, pas l'interface)", d.repeatStages.raw === true && d.repeatStages.assembled === true && d.repeatStages.processed === false && d.repeatStages.displayed === false && d.firstRepeatStage === "raw", [d.repeatStages, d.firstRepeatStage]);
    check("DIAGNOSTIC : transport sain — deltas comptés = caractères envoyés par l'hôte, aucun chunk cumulatif ni rejoué", d.chunks.deltaChars === d.hostChars && d.chunks.cumulative === 0 && d.chunks.longestIdenticalRun < 3, [d.chunks, d.hostChars]);
    check("DIAGNOSTIC : stopReason = repeat-detected, aucun retry", d.stopReason === "repeat-detected" && d.attempts.length === 1 && d.retriedSmaller !== true, [d.stopReason, d.attempts]);
    check("le BRUT n'est jamais dans l'interface normale", !(await page.content()).includes("se factorise l'équation x² - 5x + 6 = 0 en ("));
    const panel = await page.evaluate(() => { state.aiDiagPanelOpen = true; render(); return document.getElementById("ai-diag-panel") ? document.getElementById("ai-diag-panel").innerText : ""; });
    check("le panneau de diagnostic affiche generationCount, stopReason et les stades (sans texte brut)", /generationCount : 1/.test(panel) && /stopReason : repeat-detected/.test(panel) && /firstRepeatStage : raw/.test(panel) && !/se factorise/.test(panel), panel.slice(0, 600));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("2. réponse coupée par la limite (sans répétition) : queue incomplète retirée, phrases complètes gardées", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "On factorise : (x - 2)(x - 3) = 0. Donc x = 2 ou x = 3. La vérification consiste à remplacer x par chaque valeur dans l'expression de départ et à calculer le résultat en (", finish: "length" }]);
    await ask(page, "x² - 5x + 6 = 0");
    const shown = await body(page), d = await diag(page);
    check("finish_reason = length : la phrase coupée « … résultat en ( » n'est PAS affichée", !/en \($/.test(shown.trim()) && /Donc x = 2 ou x = 3\./.test(shown), shown);
    check("l'élève est prévenu (réponse tronquée) et peut continuer", /tronqu|coup|continuer|interrompu/i.test(await page.innerText("#content")) && d.tailTrimmed === true && d.finishReason === "length", d.finishReason);
    await ctx.close();
  });

  await scenario("3. retry : la tentative précédente (même partielle) n'est JAMAIS recollée à la nouvelle", async () => {
    const { ctx, page } = await open();
    await script(page, [{ partial: "Première tentative qui ne doit JAMAIS apparaître dans la réponse finale, ", error: { code: "GENERATION_FAILED", message: "context window exceeded", contextExceeded: true } },
                        { text: "Deuxième tentative : x = 2 ou x = 3, car (x - 2)(x - 3) = 0." }]);
    await ask(page, "x² - 5x + 6 = 0");
    const t = await T(page), d = await diag(page), shown = await body(page);
    check("deux générations, la seconde avec un prompt plus petit", t.gens.length === 2 && t.gens[1].promptChars <= t.gens[0].promptChars, t.gens);
    check("generationCount = 2, attempts : #1 CONTEXT_TOO_LARGE → retry, #2 ok", d.generationCount === 2 && d.attempts[0].error === "CONTEXT_TOO_LARGE" && d.attempts[0].retried === true && d.attempts[1].ok === true, d.attempts);
    check("AFFICHÉ : seulement la 2ᵉ tentative", /Deuxième tentative/.test(shown) && !/Première tentative/.test(shown), shown);
    const thread = await page.evaluate(() => state.aiThread.map(m => m.content));
    check("HISTORIQUE : la tentative abandonnée n'y est pas non plus", !thread.join("\n").includes("Première tentative"));
    const lo = await page.evaluate(() => window.revemLastRawOutput());
    check("DIAGNOSTIC : le brut ne contient que la 2ᵉ tentative (un assembleur par génération)", !/Première tentative/.test(lo.rawModelOutput) && /Deuxième tentative/.test(lo.rawModelOutput));
    await ctx.close();
  });

  await scenario("4. transport CUMULATIF (chaque chunk = tout le texte déjà reçu) : jamais « AABABC »", async () => {
    const { ctx, page } = await open();
    const text = "On factorise le trinôme : (x - 2)(x - 3) = 0, donc x = 2 ou x = 3. Vérification : les deux valeurs annulent l'expression.";
    await script(page, [{ text, cumulative: true, chunk: 9 }]);
    await ask(page, "explique moi l'écart type");
    const shown = await body(page), d = await diag(page);
    eq("le texte affiché est exactement le texte du modèle (aucune duplication)", shown.trim(), text);
    check("le garde-fou le signale (chunks cumulatifs comptés)", d.chunks.cumulative > 0, d.chunks);
    await ctx.close();
  });

  await scenario("5. répétitions LÉGITIMES : jamais supprimées", async () => {
    const { ctx, page } = await open();
    const text = "Résolvons 2x + 4 = 10. On soustrait 4 : 2x = 6. On divise par 2 : x = 3.\n\nRésolvons maintenant 3x + 5 = 20. On soustrait 5 : 3x = 15. On divise par 3 : x = 5.\n\nConclusion : x = 3 pour la première équation et x = 5 pour la seconde.";
    await script(page, [{ text }]);
    await ask(page, "explique moi comment résoudre deux équations du premier degré");
    const shown = await body(page);
    check("deux exercices de même structure, nombres différents : tout est affiché", /x = 3\./.test(shown) && /x = 5\./.test(shown) && /Conclusion/.test(shown) && (await diag(page)).repeatCollapsed === false, shown);
    await ctx.close();
  });

  await scenario("6. banc : 7 questions — nombre d'appels, budget, température, retries, répétitions, troncature", async () => {
    const { ctx, page } = await open();
    const Q = [
      ["x² - 5x + 6 = 0", "Les racines sont 2 et 3 : (x - 2)(x - 3) = 0, donc x = 2 ou x = 3. Vérification : 2² - 5×2 + 6 = 0."],
      ["2x + 4 = 10", "On soustrait 4 : 2x = 6, puis on divise par 2 : x = 3. Vérification : 2×3 + 4 = 10."],
      ["x² = 4", "x² = 4 donne x = 2 ou x = -2. Vérification : 2² = 4 et (-2)² = 4."],
      ["c'est quoi l'inflation ?", "L'inflation est la hausse générale et durable des prix. Elle réduit le pouvoir d'achat de la monnaie."],
      ["explique moi l'écart type", "L'écart type mesure la dispersion des valeurs autour de la moyenne : plus il est grand, plus les valeurs sont éloignées de la moyenne."],
      ["calcule un taux de variation de 100 à 120", "Le taux de variation est (120 - 100) / 100 = 0,2, soit +20 %. Vérification : 100 × 1,2 = 120."],
      ["Explique en détail la différence entre la VAN et le TRI, avec un exemple chiffré, les limites et quand utiliser chacun", "La VAN donne une valeur en euros : c'est la somme des flux futurs actualisés moins l'investissement initial. Le TRI donne un taux : celui qui annule la VAN.\n\nLimites : le TRI peut être multiple quand les flux changent plusieurs fois de signe, et il suppose un réinvestissement au taux du TRI lui-même. La VAN dépend du taux d'actualisation choisi.\n\nExemple : pour un projet de 1 000 € rapportant 600 € puis 600 €, la VAN à 10 % vaut environ 41,3 €.\n\nQuand les utiliser : la VAN pour comparer des projets de tailles différentes, le TRI pour juger la rentabilité relative d'un seul projet."],
    ];
    const rows = [];
    for (const [q, a] of Q) {
      await script(page, [{ text: a }]);
      const before = (await T(page)).gens.length;
      await ask(page, q);
      const t = await T(page), d = await diag(page), g = t.gens[t.gens.length - 1], shown = await body(page);
      rows.push({ q: q.slice(0, 34), calls: t.gens.length - before, engine: d.math ? d.math.engineUsed + ":" + d.math.mathProblemType : "-", maxTokens: g.maxTokens, temp: g.temperature, retries: (d.attempts || []).filter(x => x.retried).length, finish: d.finishReason, chars: shown.length, repeated: d.repeatStages ? d.repeatStages.displayed : null, trimmed: d.tailTrimmed });
      await page.evaluate(() => { state.aiThread = []; state.aiChat = aiChatFresh(); window.__T.gens = []; });
      await page.evaluate(() => { state.aiThread = []; render(); });
    }
    console.log("   banc (modèle SIMULÉ ; les budgets et le routage, eux, sont réels) :");
    console.table(rows);
    check("chaque question = EXACTEMENT 1 génération, 0 retry", rows.every(r => r.calls === 1 && r.retries === 0), rows.map(r => r.calls));
    check("calculs avec résultat du moteur : max_tokens ≤ 320 et température 0,3", rows.slice(0, 3).concat(rows[5]).every(r => r.maxTokens <= 320 && r.temp === 0.3 && /^fast:/.test(r.engine)), rows);
    check("équations nues (« 2x + 4 = 10 », « x² = 4 ») : SHORT → 180 jetons", rows[1].maxTokens === 180 && rows[2].maxTokens === 180, [rows[1].maxTokens, rows[2].maxTokens]);
    check("questions de cours : budgets habituels inchangés (définition 260, explication 600, question longue 1000), pas de moteur", rows[3].maxTokens === 260 && rows[4].maxTokens === 600 && rows[6].maxTokens === 1000 && [3, 4, 6].every(i => rows[i].engine === "-"), rows);
    check("aucune réponse tronquée, aucune répétition affichée", rows.every(r => r.finish === "stop" && r.repeated === false && r.trimmed === false), rows);
    await ctx.close();
  });

} finally {
  await browser.close();
  srv.server.close();
}
console.log(`\n${pass} PASS MOCK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
