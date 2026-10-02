/* ============================================================================
   REV-EM Knowledge Engine — dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel dans un vrai Chromium, ET les vrais fichiers ai-knowledge/
       servis par le serveur statique (manifeste, lexique, 5 éléments de démo) ;
     • le chargement paresseux, la validation au chargement, la récupération, le budget
       de contexte, le prompt réellement posté au moteur, les réglages Auto / Off / Démo,
       le panneau de diagnostic, la fonction de comparaison.

   CE QUI EST REMPLACÉ : le transport vers WebLLM (aiTransport) est un FAUX. Tout est donc
   « PASS MOCK » : ces tests prouvent que le BON contexte arrive au moteur, PAS que le
   modèle répond mieux (NOT TESTED REAL WEBLLM / GPU / MAC / WKWEBVIEW).

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/knowledge-ui.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS MOCK — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 700)); }
}
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const FAKE = `
window.__T = { sent: [], script: [], tokenMs: 3 };
aiTransport = {
  mode: "worker", terminate() {},
  send(msg) {
    const T = window.__T; T.sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === "ABORT") { T.abortFlag = true; return; }
    if (msg.type !== "GENERATE") return;
    const step = T.script.length ? T.script.shift() : { text: "Voici une réponse de test." };
    T.abortFlag = false; const t0 = performance.now();
    (async () => {
      await new Promise(r => setTimeout(r, step.startMs || 8));
      const words = (step.text || "").split(/(?<= )/); let sent = 0;
      for (const w of words) { if (T.abortFlag) break; await new Promise(r => setTimeout(r, T.tokenMs)); aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: w }); sent += w.length; }
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: sent, ttftMs: 12, totalMs: Math.round(performance.now() - t0), finishReason: T.abortFlag ? "abort" : "stop" });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
switchTab("ai");
`;
/* opts.mode : réglage de connaissances posé AVANT la première question ; opts.block : liste de motifs d'URL à faire échouer */
async function open(o) {
  o = o || {};
  const ctx = await browser.newContext({ viewport: o.vp || { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = []; page.knowledgeFetches = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.on("request", r => { if (/ai-knowledge\//.test(r.url())) page.knowledgeFetches.push(r.url().split("/ai-knowledge/")[1]); });
  if (o.block) await page.route(/ai-knowledge\//, route => route.abort());
  await page.goto(APP);
  await page.waitForTimeout(900);
  await page.evaluate(FAKE);
  if (o.tier) await page.evaluate((t) => { state.aiTier = t; render(); }, o.tier);
  if (o.mode) await page.evaluate((m) => { aiSetKnowledgeMode(m); }, o.mode);
  return { ctx, page };
}
const script = (page, steps) => page.evaluate((s) => { window.__T.script.push(...s); }, steps);
const gens = (page) => page.evaluate(() => window.__T.sent.filter(m => m.type === "GENERATE"));
const idle = (page) => page.waitForFunction(() => !state.aiBusy, null, { timeout: 8000 }).then(() => page.waitForTimeout(40));
async function ask(page, q) {
  const follow = await page.$("#ai-follow-input");
  if (follow && await follow.isVisible()) { await follow.fill(q); await page.click("#ai-follow-btn"); }
  else { await page.fill("#assistant-query-input", q); await page.click("#assistant-query-btn"); }
  await idle(page);
}
const diag = (page) => page.evaluate(() => state.aiChat.diag);
const sysOf = (g) => g.messages.map(m => m.content).join("\n");
const KN = /\[REV-EM KNOWLEDGE\]/;

try {
  await scenario("1. chargement PARESSEUX : rien n'est lu avant la première question", async () => {
    const { ctx, page } = await open();
    eq("ouverture de l'assistant : aucune requête vers ai-knowledge/", page.knowledgeFetches, []);
    eq("état « idle »", await page.evaluate(() => aiKnowledge.status), "idle");
    await ask(page, "Qu'est-ce que l'EBITDA ?");
    check("après la première question : manifeste, lexique ET les 5 éléments lus", page.knowledgeFetches.length === 7 && page.knowledgeFetches.includes("index.json") && page.knowledgeFetches.includes("topics.json"), page.knowledgeFetches);
    const st = await page.evaluate(() => ({ s: aiKnowledge.status, n: aiKnowledge.items, v: aiKnowledge.verified, d: aiKnowledge.demo, rej: aiKnowledge.rejected }));
    eq("5 éléments chargés, 0 vérifié, 5 démo, 0 rejeté", st, { s: "ready", n: 5, v: 0, d: 5, rej: [] });
    await ask(page, "Qu'est-ce que la VAN ?");
    eq("deuxième question : AUCUNE relecture (index construit une fois)", page.knowledgeFetches.length, 7);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("2. mode « off » : rien n'est lu, rien n'est envoyé (comparaison ON/OFF)", async () => {
    const { ctx, page } = await open({ mode: "off" });
    await ask(page, "Qu'est-ce que la VAN ?");
    eq("aucune requête vers ai-knowledge/", page.knowledgeFetches, []);
    const g = (await gens(page))[0];
    check("aucun bloc de connaissances dans le prompt", !KN.test(sysOf(g)));
    const d = await diag(page);
    check("diagnostic : mode off, statut off, rien de sélectionné", d.knowledgeMode === "off" && d.knowledgeStatus === "off" && d.knowledgeSelected.length === 0 && d.llmCalls === 1, d);
    await ctx.close();
  });

  await scenario("3. mode « auto » (défaut) : les éléments de DÉMO non vérifiés ne sont PAS envoyés", async () => {
    const { ctx, page } = await open();
    eq("le mode par défaut est auto", await page.evaluate(() => aiKnowledgeMode()), "auto");
    await ask(page, "Qu'est-ce que la VAN ?");
    const g = (await gens(page))[0];
    check("aucun bloc de connaissances envoyé au modèle", !KN.test(sysOf(g)));
    const d = await diag(page);
    check("…mais le diagnostic dit honnêtement que la VAN a été retrouvée et RETENUE (demo)", d.knowledgeWithheld.some(x => /finance\.npv \(demo\)/.test(x)) && d.knowledgeSelected.length === 0, d);
    eq("un seul appel au moteur", d.llmCalls, 1);
    await ctx.close();
  });

  await scenario("4. mode « démo » : le bon élément arrive au moteur, étiqueté non vérifié", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await ask(page, "Qu'est-ce que la VAN ?");
    const g = (await gens(page))[0];
    const sys = g.messages[0].content;
    check("message système contient le bloc [REV-EM KNOWLEDGE] de la VAN", KN.test(sys) && /Concept: Valeur actuelle nette \(VAN\)/.test(sys) && /Formula: VAN : VAN = −I0/.test(sys), sys.slice(0, 600));
    check("étiqueté NON VÉRIFIÉ, et la consigne le dit", /UNVERIFIED demo content/.test(sys) && /UNVERIFIED reference material/.test(sys));
    check("aucune source, aucune URL dans le contexte", !/Source:|https?:\/\//.test(sys));
    check("un SEUL élément (la question ne parle que de la VAN)", (sys.match(/Concept:/g) || []).length === 1);
    eq("rôles : system puis la question — la question reste le dernier message", [g.messages.map(m => m.role), g.messages[1].content.startsWith("Qu'est-ce que la VAN ?")], [["system", "user"], true]);
    const d = await diag(page);
    check("diagnostic : sujets, candidats, sélection, scores, taille, temps de retrieval", d.knowledgeMode === "demo" && d.topicsDetected.includes("npv") && d.knowledgeCandidates === 1 && d.knowledgeSelected[0] === "finance.npv" && d.knowledgeScores[0] >= 100 && d.knowledgeContextTokens > 100 && d.knowledgeUsed[0] === "finance.npv" && d.retrievalMs >= 0, d);
    eq("UN SEUL appel au moteur (aucun appel pour analyser, récupérer ou résumer)", [d.llmCalls, (await gens(page)).length], [1, 1]);
    check("prompt + réponse + marge ≤ fenêtre réelle de 4096", d.promptTokens + d.maxTokens + 120 <= 4096, [d.promptTokens, d.maxTokens]);
    await ctx.close();
  });

  await scenario("5. questions du cahier des charges : le bon concept, jamais un hors-sujet", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    const cases = [
      ["Pourquoi les obligations baissent lorsque les taux montent ?", ["finance.bond-interest-rates"]],
      ["Explique-moi la loi normale.", ["statistics.normal-distribution"]],
      ["Pourquoi les taux font-ils baisser les obligations ?", ["finance.bond-interest-rates"]],
      ["Compare VAN et TRI.", ["finance.irr", "finance.npv"]],
      ["Qu'est-ce que l'inflation ?", ["economics.inflation"]],
      ["Comment créer une campagne marketing Instagram ?", []],
      ["Qu'est-ce que l'EBITDA ?", []],
    ];
    for (const [q, want] of cases) {
      await ask(page, q);
      const d = await diag(page);
      eq("« " + q + " » → " + (want.join(", ") || "aucune connaissance"), d.knowledgeSelected.slice().sort(), want);
    }
    const gs = await gens(page);
    check("campagne marketing : aucun bloc de connaissances, ni VAN ni obligations dans le prompt", !KN.test(sysOf(gs[5])) && !/VAN|obligation/.test(sysOf(gs[5])));
    check("« NO KNOWLEDGE » : la génération se fait quand même, normalement (7 appels pour 7 questions)", gs.length === 7);
    await ctx.close();
  });

  await scenario("6. conversation : « et si le taux d'actualisation augmente ? » retrouve la VAN par le sujet", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await script(page, [{ text: "La VAN est la valeur actuelle nette : la somme des flux actualisés moins l'investissement." }]);
    await ask(page, "Qu'est-ce que la VAN ?");
    await ask(page, "Et si le taux d'actualisation augmente ?");
    const g = (await gens(page))[1];
    const d = await diag(page);
    check("la suite reçoit l'historique ET le bloc de connaissances de la VAN", g.messages.length >= 4 && KN.test(g.messages[0].content) && /Valeur actuelle nette/.test(g.messages[0].content), g.messages.map(m => m.role));
    eq("sélection : la VAN", d.knowledgeSelected, ["finance.npv"]);
    check("prompt + réponse + marge ≤ 4096 avec connaissances ET conversation", d.promptTokens + d.maxTokens + 120 <= 4096, d);
    await script(page, [{ text: "Plus simplement : on compare l'argent futur à l'argent d'aujourd'hui." }]);
    await ask(page, "plus simplement");
    const g3 = (await gens(page))[2];
    check("« plus simplement » : on réécrit la réponse précédente, SANS connaissances (inutiles ici)", !KN.test(sysOf(g3)) && /Rewrite your PREVIOUS answer in simpler words/.test(g3.messages[g3.messages.length - 1].content), (await diag(page)));
    eq("…et le diagnostic dit pourquoi", (await diag(page)).knowledgeStatus, "not-needed");
    await script(page, [{ text: "Exemple : investir 1 000 € pour 1 200 €." }]);
    await ask(page, "donne-moi un exemple");
    check("« donne-moi un exemple » : les connaissances de la VAN (sujet de la conversation) sont de retour", KN.test(sysOf((await gens(page))[3])), (await diag(page)));
    await ctx.close();
  });

  await scenario("7. temps réel, fausse source, calcul : la logique locale PASSE AVANT les connaissances", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await ask(page, "Quel est le cours du Bitcoin aujourd'hui ?");
    eq("temps réel : aucun appel, aucune lecture de connaissances", [(await gens(page)).length, page.knowledgeFetches.length], [0, 0]);
    await ask(page, "Donne-moi l'étude exacte qui prouve cette affirmation.");
    eq("fausse source : aucun appel", (await gens(page)).length, 0);
    await ask(page, "1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ?");
    const g = (await gens(page))[0];
    const d = await diag(page);
    check("calcul : le résultat exact est fourni au modèle ; les connaissances ne sont pas ajoutées (inutiles, et plus lent)", /1 215,51/.test(g.messages[0].content) && !KN.test(g.messages[0].content) && d.knowledgeStatus === "skipped:calculation", d.knowledgeStatus);
    await ctx.close();
  });

  await scenario("8. Rapide / Avancé / Expert : le palier de l'utilisateur ne change JAMAIS", async () => {
    for (const tier of ["rapide", "avance", "expert"]) {
      const { ctx, page } = await open({ mode: "demo", tier });
      await ask(page, "Compare VAN et TRI.");
      const g = (await gens(page))[0];
      const d = await diag(page);
      check(tier + " : les deux éléments arrivent, dans le plafond du palier", d.knowledgeUsed.length === 2 && d.knowledgeContextTokens <= (tier === "rapide" ? 520 : 640), d);
      eq(tier + " : le palier est resté " + tier + " (aucun changement automatique, aucun chargement)", [await page.evaluate(() => state.aiTier), await page.evaluate(() => window.__T.sent.filter(m => m.type !== "GENERATE").length)], [tier, 0]);
      if (tier === "expert") check("Expert : aucun rôle system, connaissances dans le message utilisateur", g.messages.every(m => m.role !== "system") && KN.test(g.messages[0].content));
      check(tier + " : prompt + réponse + marge ≤ 4096", d.promptTokens + d.maxTokens + 120 <= 4096, d);
      await ctx.close();
    }
  });

  await scenario("9. régénération : mêmes connaissances, pas de doublon dans l'historique", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await ask(page, "Qu'est-ce que la VAN ?");
    await page.click("#ai-regen-btn"); await idle(page);
    const gs = await gens(page);
    check("la régénération renvoie le MÊME bloc de connaissances", gs.length === 2 && KN.test(gs[1].messages[0].content) && /Valeur actuelle nette/.test(gs[1].messages[0].content));
    const th = await page.evaluate(() => state.aiThread.map(m => m.role));
    eq("la conversation reste user/assistant (réponse remplacée, pas dupliquée)", th, ["user", "assistant"]);
    eq("le modèle sélectionné est inchangé", await page.evaluate(() => state.aiTier), "avance");
    await ctx.close();
  });

  await scenario("10. arrêt pendant la préparation et pendant la génération : propre", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await script(page, [{ text: "mot ".repeat(200), startMs: 30 }]);
    await page.fill("#assistant-query-input", "Qu'est-ce que la VAN ?"); await page.click("#assistant-query-btn");
    await page.waitForSelector("#ai-stop-btn", { timeout: 4000 });
    await page.waitForTimeout(150);
    await page.$eval("#ai-stop-btn", b => b.click()); await idle(page);
    eq("phase ABORTED, pas d'erreur", [await page.evaluate(() => state.aiChat.phase), await page.evaluate(() => state.aiError)], ["ABORTED", null]);
    eq("le moteur n'est pas recréé (aucun message autre que GENERATE/ABORT)", await page.evaluate(() => window.__T.sent.filter(m => !["GENERATE", "ABORT"].includes(m.type)).length), 0);
    await script(page, [{ text: "Suite normale." }]);
    await ask(page, "Qu'est-ce que l'inflation ?");
    eq("la question suivante répond normalement", await page.evaluate(() => state.aiChat.phase), "COMPLETE");
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("10b. arrêt PENDANT la lecture des connaissances (réseau lent) : aucune génération, état propre", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await page.route(/ai-knowledge\/index\.json/, async route => { await new Promise(r => setTimeout(r, 900)); await route.continue(); });
    await page.fill("#assistant-query-input", "Qu'est-ce que la VAN ?"); await page.click("#assistant-query-btn");
    await page.waitForSelector("#ai-stop-btn", { timeout: 4000 });
    eq("pendant la lecture : phase PREPARING", await page.evaluate(() => state.aiChat.phase), "PREPARING");
    await page.$eval("#ai-stop-btn", b => b.click()); await idle(page);
    eq("arrêtée : phase ABORTED, aucune génération envoyée, aucune erreur", [await page.evaluate(() => state.aiChat.phase), (await gens(page)).length, await page.evaluate(() => state.aiError)], ["ABORTED", 0, null]);
    await page.unroute(/ai-knowledge\/index\.json/);
    await script(page, [{ text: "Réponse normale." }]);
    await ask(page, "Qu'est-ce que la VAN ?");
    check("la question suivante fonctionne et reçoit les connaissances", (await page.evaluate(() => state.aiChat.phase)) === "COMPLETE" && KN.test(sysOf((await gens(page))[0])));
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("11. connaissances INDISPONIBLES (réseau coupé) : l'assistant répond quand même", async () => {
    const { ctx, page } = await open({ mode: "demo", block: true });
    await ask(page, "Qu'est-ce que la VAN ?");
    const g = (await gens(page))[0];
    check("la question est envoyée sans connaissances, normalement", !!g && !KN.test(sysOf(g)) && (await page.evaluate(() => state.aiChat.phase)) === "COMPLETE");
    const d = await diag(page);
    check("diagnostic : « unavailable », jamais une erreur affichée à l'élève", d.knowledgeStatus === "unavailable" && (await page.evaluate(() => state.aiError)) === null, d.knowledgeStatus);
    await page.unroute(/ai-knowledge\//);
    await ask(page, "Qu'est-ce que la VAN ?");
    check("réseau revenu : nouvel essai automatique à la question suivante, connaissances de retour", KN.test(sysOf((await gens(page))[1])));
    await ctx.close();
  });

  await scenario("12. fichier de connaissances INVALIDE : rejeté, jamais envoyé au modèle", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await page.route(/ai-knowledge\/finance\/npv\.json/, async route => {
      const r = await route.fetch(); const j = await r.json(); j.verified = "oui"; delete j.summary;
      await route.fulfill({ response: r, json: j });
    });
    await ask(page, "Qu'est-ce que la VAN ?");
    const st = await page.evaluate(() => ({ n: aiKnowledge.items, rej: aiKnowledge.rejected }));
    eq("5 fichiers lus, 4 acceptés, la VAN cassée REJETÉE", [st.n, st.rej], [4, ["finance.npv"]]);
    check("rien de la VAN cassée dans le prompt", !/Valeur actuelle nette|VAN = −I0/.test(sysOf((await gens(page))[0])));
    await ctx.close();
  });

  await scenario("13. réglage Auto / Désactivées / Démo dans le diagnostic, et mémorisé", async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => { state.aiDiagPanelOpen = true; render(); });
    await page.waitForSelector("#ai-kn-control");
    const labels = await page.$$eval("[data-ai-kn-mode]", e => e.map(b => b.innerText.trim()));
    eq("trois choix", labels, ["Auto", "Désactivées", "Démo"]);
    check("le choix actif est exposé (aria-pressed)", (await page.$eval('[data-ai-kn-mode="auto"]', b => b.getAttribute("aria-pressed"))) === "true");
    await page.click('[data-ai-kn-mode="demo"]');
    eq("le choix « Démo » est appliqué", await page.evaluate(() => aiKnowledgeMode()), "demo");
    check("…et le panneau reste ouvert", await page.$eval("#ai-diag-panel", d => d.open));
    await page.waitForFunction(() => /5 éléments chargés · 0 vérifiés · 5 démo/.test(document.getElementById("ai-kn-control").innerText), null, { timeout: 4000 });
    check("le statut dit : 5 éléments chargés, 0 vérifié, 5 démo", true);
    check("une explication honnête accompagne le mode", /NON vérifiés/.test(await page.innerText("#ai-kn-control")));
    eq("persisté via lsGet/lsSet (pas de localStorage direct, pas de synchro)", await page.evaluate(() => lsGet(KEY_KNOWLEDGE_MODE)), "demo");
    await page.evaluate(() => aiSetKnowledgeMode("n'importe quoi"));
    eq("une valeur invalide est ignorée", await page.evaluate(() => aiKnowledgeMode()), "demo");
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("14. diagnostic : mesures complètes, ni question ni réponse", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await script(page, [{ text: "Réponse secrète de test." }]);
    await ask(page, "Qu'est-ce que la VAN ?");
    await page.evaluate(() => { document.getElementById("ai-diag-panel").open = true; });
    const txt = await page.innerText("#ai-diag-panel");
    check("knowledge : mode, sujets, candidats, sélection, scores", /knowledge : mode demo · ready · topicsDetected : npv · candidates 1 · selected finance\.npv · scores \d+/.test(txt), txt.slice(-900));
    check("knowledgeContext : jetons, éléments utilisés, retrievalTime", /knowledgeContext : \d+ tokens≈ · used finance\.npv/.test(txt) && /retrievalTime : [\d.]+ ms/.test(txt));
    check("les mesures d'avant (intention, profondeur, TTFT, finishReason) sont toujours là", /questionIntent : DEFINITION/.test(txt) && /TTFT\(engine\) : 12 ms/.test(txt) && /llmCalls : 1/.test(txt));
    check("aucune question ni réponse dans le panneau", !/Qu'est-ce que la VAN|Réponse secrète/.test(txt));
    check("aucune de ces informations dans la conversation", !/knowledge|topicsDetected|REV-EM KNOWLEDGE/.test(await page.innerText(".ai-thread")));
    // copie du diagnostic
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (x) => { window.__copied = x; }; });
    await page.click("#ai-copy-diag-btn");
    await page.waitForFunction(() => window.__copied !== null, null, { timeout: 3000 });
    const copied = await page.evaluate(() => window.__copied);
    check("le diagnostic copiable contient l'état de Knowledge et la dernière réponse, SANS texte", /\[REV-EM Knowledge\] mode=demo status=ready items=5 verified=0 demo=5/.test(copied) && /"knowledgeSelected":\["finance\.npv"\]/.test(copied) && !/Qu'est-ce que la VAN|Réponse secrète/.test(copied), copied.slice(-500));
    await ctx.close();
  });

  await scenario("15. revemKnowledgeCompare : prompts avec / sans (jamais d'écriture dans la conversation)", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    const out = await page.evaluate(() => revemKnowledgeCompare("Pourquoi les obligations baissent lorsque les taux montent ?"));
    eq("deux exécutions : off puis demo", out.runs.map(r => r.mode), ["off", "demo"]);
    check("OFF : aucune sélection, aucun jeton de connaissances", out.runs[0].selected.length === 0 && out.runs[0].knowledgeTokens === 0);
    check("ON : l'élément obligations/taux, des jetons en plus", /finance\.bond-interest-rates/.test(out.runs[1].selected[0]) && out.runs[1].knowledgeTokens > 100 && out.runs[1].promptTokens > out.runs[0].promptTokens);
    eq("la conversation n'a pas été touchée, aucune génération", [await page.evaluate(() => state.aiThread.length), (await gens(page)).length], [0, 0]);
    // avec génération : deux réponses, l'une après l'autre
    await script(page, [{ text: "Réponse SANS connaissances." }, { text: "Réponse AVEC connaissances." }]);
    const out2 = await page.evaluate(() => revemKnowledgeCompare("Qu'est-ce que la VAN ?", { generate: true, temperature: 0.2 }));
    eq("deux réponses, dans l'ordre", out2.runs.map(r => r.answer), ["Réponse SANS connaissances.", "Réponse AVEC connaissances."]);
    const gs = await gens(page);
    check("deux GENERATE séquentiels : le 1er sans bloc, le 2e avec ; température imposée", gs.length === 2 && !KN.test(sysOf(gs[0])) && KN.test(sysOf(gs[1])) && gs.every(g => g.temperature === 0.2));
    eq("rien n'a été ajouté à la conversation ni à l'historique", [await page.evaluate(() => state.aiThread.length), await page.evaluate(() => state.aiHistory.length)], [0, 0]);
    await ctx.close();
  });

  await scenario("16. 5 langues : question en anglais → réponse en anglais ; textes du réglage traduits", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await ask(page, "Why do bond prices fall when interest rates rise?");
    const g = (await gens(page))[0];
    check("EN : consigne « Answer in English » ET connaissances (alias multilingues, un seul élément, pas de base dupliquée)", /Answer in English/.test(g.messages[0].content) && /Prix d'une obligation et taux d'intérêt/.test(g.messages[0].content));
    await ask(page, "¿Qué es el valor actual neto?");
    check("ES : la VAN retrouvée par son alias espagnol", (await diag(page)).knowledgeSelected[0] === "finance.npv");
    await ask(page, "Was ist die Normalverteilung?");
    check("DE : la loi normale retrouvée par son alias allemand", (await diag(page)).knowledgeSelected[0] === "statistics.normal-distribution");
    await ask(page, "Che cos'è l'inflazione?");
    check("IT : l'inflation retrouvée par son alias italien", (await diag(page)).knowledgeSelected[0] === "economics.inflation");
    for (const lang of ["fr", "en", "es", "de", "it"]) {
      const ok = await page.evaluate((l) => { LyonI18n.setLang(l); const keys = ["title", "mode_auto", "mode_off", "mode_demo", "hint_auto", "hint_off", "hint_demo", "status", "status_idle", "status_loading", "status_unavailable"]; return keys.every(k => { const v = t("assistant.kn." + k, { n: 1, v: 0, d: 1 }); return v && v !== "assistant.kn." + k; }); }, lang);
      check("textes du réglage présents en " + lang, ok);
    }
    await page.evaluate(() => LyonI18n.setLang("fr"));
    await ctx.close();
  });

  await scenario("17. mobile 375 px : le réglage et le diagnostic ne débordent pas", async () => {
    const { ctx, page } = await open({ mode: "demo", vp: { width: 375, height: 800 } });
    await ask(page, "Qu'est-ce que la VAN ?");
    await page.evaluate(() => { state.aiDiagPanelOpen = true; render(); });
    await page.waitForSelector("#ai-kn-control");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("aucun défilement horizontal de la page", over <= 1, over);
    const small = await page.$$eval("[data-ai-kn-mode]", bs => bs.filter(b => b.getBoundingClientRect().height < 24).length);
    eq("les trois boutons ont une hauteur tactile raisonnable", small, 0);
    await ctx.close();
  });

  await scenario("18. non-régression : le reste de l'assistant et les autres modes sont intacts", async () => {
    const { ctx, page } = await open({ mode: "demo" });
    await script(page, [{ text: "Tu devrais réviser…" }]);
    await ask(page, "Qu'est-ce que je dois réviser aujourd'hui ?");
    const g = await gens(page);
    check("les questions personnelles ne reçoivent AUCUNE connaissance REV-EM (séparation Knowledge / Mes cours)", g.length >= 0 && !g.some(x => KN.test(sysOf(x))), g.map(x => x.messages[0].content.slice(0, 80)));
    eq("aucune lecture de ai-knowledge/ pour une question personnelle", page.knowledgeFetches, []);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });
} finally {
  await browser.close();
}
console.log(`\n${pass} vérifications réussies (PASS MOCK), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
