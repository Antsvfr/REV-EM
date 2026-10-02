/* ============================================================================
   REV-EM — banc de mesure de l'assistant (questions libres) : AVANT / APRÈS
   ----------------------------------------------------------------------------
   CE QUE MESURE CE BANC (réel) : ce que la VRAIE page envoie au moteur — nombre
   d'appels, nombre de messages, taille du contexte en caractères et en jetons
   estimés (ai-engine.js : 1 jeton ≈ 3,2 car.), part d'historique, temps de
   PRÉPARATION côté JavaScript (clic → message GENERATE envoyé).

   CE QU'IL NE MESURE PAS : le temps jusqu'au premier jeton (TTFT) ni la qualité
   des réponses — il n'y a pas de GPU ici. Le « moteur » est un transport factice
   qui répond un texte fixe : NOT TESTED REAL WEBLLM. Tout ce qui est affiché
   comme TTFT dans l'interface vient du moteur réel, chez l'utilisateur.

   Lancer :
     BASE_URL=http://localhost:9110 node tests/assistant-bench.mjs   (ancienne version)
     BASE_URL=http://localhost:9109 node tests/assistant-bench.mjs   (version actuelle)
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

/* Longueur de la réponse factice : 600 car. par défaut ; REPLY_LEN=2400 simule des réponses réelles
   (≈ 750 jetons), qui font réellement jouer la compaction de l'historique. */
const UNIT = "Une réponse factice de test, longue d'environ six cents caractères, qui sert uniquement à mesurer combien d'historique est renvoyé au moteur à chaque message. ";
const REPLY = UNIT.repeat(Math.max(1, Math.round(parseInt(process.env.REPLY_LEN || "600") / 150)));

const SCENARIOS = [
  { name: "S1 définition seule", msgs: ["Qu'est-ce que l'EBITDA ?"] },
  { name: "S2 conversation TRI (5 messages)", msgs: ["Explique-moi le TRI.", "Plus simplement.", "Donne-moi un exemple avec 1000 €.", "Maintenant compare-le à la VAN.", "Fais-moi une question pour vérifier si j'ai compris."] },
  { name: "S3 conversation VAN (4 messages)", msgs: ["Qu'est-ce que la VAN ?", "plus simplement", "donne-moi un exemple", "et si le taux d'actualisation augmente ?"] },
  { name: "S4 calcul", msgs: ["1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ?"] },
  { name: "S5 temps réel", msgs: ["Quel est le cours du Bitcoin aujourd'hui ?"] },
];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
await page.goto(APP);
await page.waitForTimeout(900);
await page.evaluate((REPLY) => {
  window.__bench = { gens: [] };
  aiTransport = {
    mode: "worker", terminate() {},
    send(msg) {
      if (msg.type === "GENERATE") {
        window.__bench.gens.push({ at: performance.now(), temperature: msg.temperature, topP: msg.topP, maxTokens: msg.maxTokens, messages: msg.messages.map(m => ({ role: m.role, content: m.content })) });
        setTimeout(() => aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: REPLY }), 15);
        setTimeout(() => aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: false, chars: REPLY.length, ttftMs: 15, totalMs: 40, finishReason: "stop" }), 40);
      }
    },
  };
  state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
  switchTab("ai");
}, REPLY);

const out = [];
for (const sc of SCENARIOS) {
  await page.evaluate(() => { aiClearThread(); window.__bench.gens.length = 0; });
  const rows = [];
  for (let i = 0; i < sc.msgs.length; i++) {
    const q = sc.msgs[i];
    const before = await page.evaluate(() => window.__bench.gens.length);
    const t0 = await page.evaluate(({ q, i }) => { const t = performance.now(); window.__t0 = t; if (i === 0) aiRunPersonalQuery(q); else aiFollowUp(q); return t; }, { q, i });
    await page.waitForFunction(() => !state.aiBusy, null, { timeout: 8000 });
    await page.waitForTimeout(60);
    const r = await page.evaluate(({ before, t0 }) => {
      const gens = window.__bench.gens.slice(before);
      const g = gens[0];
      const chars = g ? g.messages.reduce((n, m) => n + m.content.length, 0) : 0;
      const last = state.aiThread[state.aiThread.length - 1];
      return {
        llmCalls: gens.length,
        messages: g ? g.messages.length : 0,
        firstRole: g ? g.messages[0].role : null,
        promptChars: chars,
        promptTokensEst: g ? AIE.estimateTokens(g.messages.map(m => m.content).join("")) : 0,
        historyMessages: g ? Math.max(0, g.messages.length - 2) : 0,
        maxTokens: g ? g.maxTokens : null, temperature: g ? g.temperature : null, topP: g ? (g.topP === undefined ? null : g.topP) : null,
        prepMs: g ? Math.round(g.at - t0) : null,
        answerPreview: last && last.role === "assistant" ? String(last.content).slice(0, 70) : null,
        answerSource: g ? "modèle" : "local (sans appel au modèle)",
      };
    }, { before, t0 });
    rows.push({ q, ...r });
  }
  out.push({ scenario: sc.name, rows });
}
console.log(JSON.stringify({ app: APP, errors, out }, null, 1));
await browser.close();
