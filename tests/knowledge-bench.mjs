/* ============================================================================
   REV-EM Knowledge — banc reproductible OFF / ON sur les cas A–L du cahier des charges
   ----------------------------------------------------------------------------
   CE QUE MESURE CE BANC (réel) : pour chaque question, ce que la VRAIE page envoie au moteur
   avec les connaissances DÉSACTIVÉES puis ACTIVÉES (mode démo) : éléments choisis et leurs
   scores, jetons de connaissances, jetons de prompt, nombre d'appels, préparation JavaScript
   (clic → message GENERATE) dont la récupération.

   CE QU'IL NE MESURE PAS : la qualité des réponses, le TTFT, la justesse d'un modèle. Le
   « moteur » est un transport factice : NOT TESTED REAL WEBLLM / GPU / MAC. Ce banc prouve
   que le BON contexte part au modèle ; il NE dit PAS que la réponse en est meilleure. Pour
   cela : revemKnowledgeCompare("…", { generate: true }) sur le Mac, et LIRE les deux réponses.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/knowledge-bench.mjs
   Sortie : un tableau ; code de sortie ≠ 0 si un contexte attendu n'arrive pas.
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

const CASES = [
  { id: "A", msgs: ["Qu'est-ce que l'EBITDA ?"], want: [] , note: "pas dans la base de démo → NO KNOWLEDGE" },
  { id: "B", msgs: ["Pourquoi une hausse des taux fait-elle baisser le prix d'une obligation ?"], want: ["finance.bond-interest-rates"] },
  { id: "C", msgs: ["Explique-moi la loi normale comme si je débutais."], want: ["statistics.normal-distribution"] },
  { id: "D", msgs: ["Compare VAN et TRI."], want: ["finance.irr", "finance.npv"] },
  { id: "E", msgs: ["1 000 € placés à 5 % pendant 4 ans : combien obtient-on ?"], want: [], note: "calcul local exact → connaissances non ajoutées" },
  { id: "F", msgs: ["Qu'est-ce que la VAN ?", "Plus simplement."], want: ["finance.npv"], at: 0, note: "msg 2 : réécriture, sans connaissances" },
  { id: "G", msgs: ["Qu'est-ce que la VAN ?", "Plus simplement.", "Donne-moi un exemple."], want: ["finance.npv"], at: 2 },
  { id: "H", msgs: ["Qu'est-ce que la VAN ?", "Plus simplement.", "Donne-moi un exemple.", "Et si le taux d'actualisation augmente ?"], want: ["finance.npv"], at: 3 },
  { id: "I", msgs: ["Quel est le cours du Bitcoin aujourd'hui ?"], want: [], note: "temps réel : réponse locale, 0 appel" },
  { id: "J", msgs: ["Donne-moi l'étude exacte qui prouve cette affirmation."], want: [], note: "fausse source : réponse locale, 0 appel" },
  { id: "K", msgs: ["Réponds en une phrase : qu'est-ce que l'inflation ?"], want: ["economics.inflation"] },
  { id: "L", msgs: ["Quelles sont les limites de l'EBITDA dans l'analyse financière d'une entreprise ?"], want: [] },
  { id: "M1", msgs: ["Comment créer une campagne marketing Instagram ?"], want: [], note: "hors-sujet : ni VAN ni obligations" },
  { id: "M2", msgs: ["Quelle est la meilleure recette de crêpes ?"], want: [], note: "hors-sujet" },
  { id: "M3", msgs: ["Qu'est-ce que le taux de change ?"], want: [], note: "« taux » seul ne ramène pas les obligations" },
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = []; page.on("pageerror", e => errors.push(String(e)));
await page.goto(APP); await page.waitForTimeout(900);
await page.evaluate(() => {
  window.__gens = [];
  aiTransport = { mode: "worker", terminate() {}, send(msg) {
    if (msg.type !== "GENERATE") return;
    window.__gens.push({ messages: JSON.parse(JSON.stringify(msg.messages)), at: performance.now(), maxTokens: msg.maxTokens });
    setTimeout(() => { aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: "Réponse factice de test." }); aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: false, chars: 24, ttftMs: 10, totalMs: 20, finishReason: "stop" }); }, 5);
  } };
  state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC"; switchTab("ai");
});

async function run(c, mode) {
  await page.evaluate((m) => { aiClearThread(); window.__gens.length = 0; aiSetKnowledgeMode(m); }, mode);
  const rows = [];
  for (let i = 0; i < c.msgs.length; i++) {
    const before = await page.evaluate(() => window.__gens.length);
    const t0 = await page.evaluate(({ q, first }) => { const t = performance.now(); if (first) aiRunPersonalQuery(q); else aiFollowUp(q); return t; }, { q: c.msgs[i], first: i === 0 });
    await page.waitForFunction(() => !state.aiBusy, null, { timeout: 8000 });
    await page.waitForTimeout(40);
    rows.push(await page.evaluate(({ before, t0 }) => {
      const g = window.__gens[before], d = state.aiChat.diag || {};
      return { calls: window.__gens.length - before, sel: d.knowledgeUsed || [], scores: d.knowledgeScores || [], kTok: d.knowledgeContextTokens || 0, withheld: d.knowledgeWithheld || [],
               status: d.knowledgeStatus, promptTok: g ? AIE.estimateTokens(g.messages.map(m => m.content).join("")) : 0, prepMs: g ? Math.round(g.at - t0) : null, retrMs: d.retrievalMs, intent: d.intent, topics: d.topicsDetected || [] };
    }, { before, t0 }));
  }
  return rows;
}

let failures = 0;
const table = [];
for (const c of CASES) {
  const off = await run(c, "off"), on = await run(c, "demo");
  const at = c.at === undefined ? c.msgs.length - 1 : c.at;
  const o = off[at], n = on[at];
  const gotSet = n.sel.slice().sort(), want = c.want.slice().sort();
  const ok = JSON.stringify(gotSet) === JSON.stringify(want) && o.sel.length === 0 && o.kTok === 0 && n.calls === o.calls;
  if (!ok) failures++;
  // msg 2 de F : réécriture → aucune connaissance
  let extra = "";
  if (c.id === "F") { const s2 = on[1]; const ok2 = s2.sel.length === 0 && s2.status === "not-needed"; if (!ok2) failures++; extra = ok2 ? " | msg2 sans connaissances ✓" : " | msg2 ✗"; }
  table.push({ cas: c.id, "OFF jetons": o.promptTok, "ON jetons": n.promptTok, "ΔK": n.kTok, "appels OFF→ON": o.calls + "→" + n.calls, "éléments (ON)": n.sel.join(" + ") || "—", scores: n.scores.join("/") || "—", "retrieval ms": n.retrMs ?? "—", "prép. ms OFF→ON": (o.prepMs ?? "—") + "→" + (n.prepMs ?? "—"), "retenus (non injectés)": n.withheld.length, résultat: (ok ? "PASS MOCK" : "FAIL") + extra, note: c.note || "" });
}
console.table(table);
console.log(JSON.stringify({ app: APP, jsErrors: errors, failures }, null, 1));
await browser.close();
process.exit(failures || errors.length ? 1 : 0);
