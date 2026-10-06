/* ============================================================================
   REV-EM — questions libres (mode Général), dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, dans un vrai Chromium : la barre de question, la
       conversation, le flux affiché progressivement, Arrêter / Régénérer /
       Copier, les suggestions, le diagnostic, le clavier, le responsive, les 5
       langues ; toute la chaîne centralisée (aiGeneralAsk → assistant-core.js →
       aiHostGenerate → message GENERATE) ;
     • les messages EXACTS envoyés au moteur (rôles, contenu, température, top_p,
       max_tokens) : on les lit au moment où la page les poste.

   CE QUI EST REMPLACÉ : le transport vers le moteur (aiTransport) est un FAUX qui
   répond selon un scénario (jetons, délais, erreurs, arrêt). Donc tout ce fichier
   est « PASS MOCK » : il prouve le CÂBLAGE et les garde-fous, PAS la qualité des
   réponses d'un vrai modèle (NOT TESTED REAL WEBLLM, NOT TESTED MAC,
   NOT TESTED WKWEBVIEW).

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/assistant-ui.test.mjs
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

/* Le faux transport : enregistre TOUT ce que la page envoie, et répond selon `script`. */
const FAKE = `
window.__T = { sent: [], script: [], aborted: 0, tokenMs: 4 };
aiTransport = {
  mode: "worker", terminate() {},
  send(msg) {
    const T = window.__T; T.sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === "ABORT") { T.abortFlag = true; T.aborted++; return; }
    if (msg.type !== "GENERATE") return;
    const step = T.script.length ? T.script.shift() : { text: "Voici une réponse de test." };
    T.abortFlag = false;
    const t0 = performance.now();
    (async () => {
      await new Promise(r => setTimeout(r, step.startMs || 8));
      if (step.error) { aiOnHostMessage({ type: "GENERATION_ERROR", id: msg.id, code: step.error.code, message: step.error.message || "x", contextExceeded: !!step.error.contextExceeded }); return; }
      const words = (step.text || "").split(/(?<= )/);
      let sent = 0;
      for (const w of words) {
        if (T.abortFlag) break;
        await new Promise(r => setTimeout(r, step.tokenMs || T.tokenMs));
        aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: w }); sent += w.length;
      }
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: sent, ttftMs: 12, totalMs: Math.round(performance.now() - t0), finishReason: step.finish || (T.abortFlag ? "abort" : "stop") });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
switchTab("ai");
`;

async function open(vp, tier) {
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(900);
  await page.evaluate(FAKE);
  if (tier) await page.evaluate((t) => { state.aiTier = t; render(); }, tier);
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
const lastBubble = (page) => page.$$eval(".ai-bubble.assistant", els => els.length ? els[els.length - 1].innerText : null);
const thread = (page) => page.evaluate(() => state.aiThread.map(m => ({ role: m.role, content: m.content, meta: m.meta })));
const PREV_ANSWER = "La VAN est la valeur actuelle nette : la somme des flux futurs actualisés moins l'investissement initial. Si elle est positive, le projet crée de la valeur.";

try {
  /* 1. Une question simple : un seul appel, structure system/question, flux, nettoyage */
  await scenario("1. une question simple : un seul appel, prompt compact, réponse nettoyée", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "Bien sûr ! L'EBITDA est le résultat avant intérêts, impôts, dépréciations et amortissements.\n\nSources :\n- Dupont 2019" }]);
    await ask(page, "Qu'est-ce que l'EBITDA ?");
    const g = await gens(page);
    eq("un seul appel au moteur", g.length, 1);
    eq("messages : system puis la question", [g[0].messages.map(m => m.role), g[0].messages[1].content.indexOf("Qu'est-ce que l'EBITDA ?")], [["system", "user"], 0]);
    check("le prompt est compact (< 345 jetons ≈ 1 100 car. : l’instruction de langue ajoute ≈ 30 jetons)", g[0].messages.reduce((n, m) => n + m.content.length, 0) < 1100, g[0].messages.reduce((n, m) => n + m.content.length, 0));
    check("aucune donnée de maîtrise injectée pour une question générale", !/NIVEAU RÉEL|maîtrise|Par chapitre/.test(JSON.stringify(g[0].messages)));
    eq("définition : température basse, top_p fourni, réponse courte", [g[0].temperature, g[0].topP, g[0].maxTokens <= 260], [0.3, 0.9, true]);
    check("consigne de langue : réponse en français", /Answer in French/.test(g[0].messages[0].content));
    const b = await lastBubble(page);
    check("« Bien sûr ! » et la rubrique « Sources » inventée sont retirés de l'affichage", !/Bien sûr|Sources|Dupont/.test(b) && /EBITDA/.test(b), b);
    eq("la mémoire contient la réponse nettoyée", (await thread(page)).pop().content.includes("Dupont"), false);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 2. Mémoire de conversation */
  await scenario("2. « plus simplement » / « exemple » / « et si… » : la conversation est comprise", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: PREV_ANSWER }, { text: "La VAN, c'est : on compare ce qu'on gagne plus tard à ce qu'on dépense maintenant." }, { text: "Exemple : investir 1 000 € pour recevoir 1 200 € dans un an." }, { text: "Si le taux monte, la VAN baisse." }]);
    await ask(page, "Qu'est-ce que la VAN ?");
    await ask(page, "plus simplement");
    const g2 = (await gens(page))[1];
    eq("« plus simplement » : la réponse précédente est envoyée au modèle", g2.messages.map(m => m.role), ["system", "user", "assistant", "user"]);
    check("… elle y figure en entier", g2.messages[2].content.includes("somme des flux futurs actualisés"));
    check("… et la consigne dit de la RÉÉCRIRE plus simplement, sans repartir de zéro", /Rewrite your PREVIOUS answer in simpler words/.test(g2.messages[3].content) && /do not restart/.test(g2.messages[3].content));
    check("… avec le sujet explicite (VAN)", /Topic: VAN/.test(g2.messages[3].content));
    await ask(page, "donne-moi un exemple");
    const g3 = (await gens(page))[2];
    check("« exemple » : consigne d'exemple + sujet VAN", /Give ONE concrete example/.test(g3.messages[g3.messages.length - 1].content) && /Topic: VAN/.test(g3.messages[g3.messages.length - 1].content));
    await ask(page, "et si le taux d'actualisation augmente ?");
    const g4 = (await gens(page))[3];
    check("« et si… » : l'historique est envoyé (suite), le sujet est rappelé", g4.messages.length >= 4 && /VAN/.test(JSON.stringify(g4.messages)), g4.messages.map(m => m.role));
    check("l'historique n'est PAS tout recopié : les échanges anciens sont comprimés", g4.messages.slice(1, -3).every(m => m.content.length <= 300) , g4.messages.map(m => m.content.length));
    const mem = await thread(page);
    eq("la conversation affiche 4 questions et 4 réponses, sans doublon", [mem.filter(m => m.role === "user").length, mem.filter(m => m.role === "assistant").length], [4, 4]);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 3. Local : temps réel et fausses sources */
  await scenario("3. temps réel et références inventées : réponse LOCALE, aucun appel au modèle", async () => {
    const { ctx, page } = await open();
    await ask(page, "Quel est le cours du Bitcoin aujourd'hui ?");
    eq("aucun GENERATE envoyé", (await gens(page)).length, 0);
    const b = await lastBubble(page);
    check("« je n'ai pas accès aux informations en temps réel », aucune valeur chiffrée", /pas accès aux informations en temps réel/.test(b) && !/\d{3}/.test(b), b);
    eq("ce n'est PAS traité comme « mon planning » (intention personnelle évitée)", (await thread(page))[0].meta.intent, "CURRENT_INFORMATION");
    await ask(page, "Donne-moi l'étude exacte qui prouve cette affirmation.");
    eq("toujours aucun appel", (await gens(page)).length, 0);
    check("refus explicite d'inventer une référence", /préfère ne pas inventer/.test(await lastBubble(page)));
    await script(page, [{ text: "La VAN est une somme actualisée." }]);
    await ask(page, "Qu'est-ce que la VAN ?");
    await ask(page, "plus simplement");
    const g = await gens(page);
    check("les réponses locales n'entrent PAS dans le contexte du modèle", !/Bitcoin|préfère ne pas inventer/.test(JSON.stringify(g[0].messages)) && !/Bitcoin/.test(JSON.stringify(g[1].messages)));
    eq("diagnostic : llmCalls 0 pour la réponse locale", (await page.evaluate(() => state.aiThread.filter(m => m.meta && m.meta.local).length)), 2);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 4. Calcul */
  await scenario("4. calcul : le résultat exact est calculé en local et donné au modèle", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "On part de 1 000 €, on multiplie 4 fois par 1,05 : 1 215,51 €." }]);
    await ask(page, "1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ?");
    const g = (await gens(page))[0];
    /* Depuis le moteur mathématique (AI_MATH.md) le calcul est EXACT : 194481/160 (= 1215,50625), arrondi à 2 décimales seulement à l'affichage. */
    const sys4 = g.messages[0].content;
    check("le bloc « MATH ENGINE RESULT » exact (194481/160 = 1215,50625 ; arrondi 1215,51 €) est dans le prompt", /MATH ENGINE RESULT \(computed deterministically, verified exactly/.test(sys4) && /exact result: 194481\/160/.test(sys4) && /1215,50625/.test(sys4) && /1215,51/.test(sys4), sys4.slice(-700));
    eq("calcul : température 0,3 (stratégie math dédiée, AI_OUTPUT §14)", g.temperature, 0.3);
    eq("une seule génération pour tout le calcul", (await gens(page)).length, 1);
    await ctx.close();
  });

  /* 5. Arrêter */
  await scenario("5. Arrêter : réponse partielle gardée, moteur intact, nouvelle question possible", async () => {
    const { ctx, page } = await open();
    const long = Array.from({ length: 60 }, (_, i) => "mot" + i + " ").join("");
    await script(page, [{ text: long, tokenMs: 25 }, { text: "Réponse suivante normale." }]);
    await page.fill("#assistant-query-input", "Explique-moi la VAN");
    await page.click("#assistant-query-btn");
    await page.waitForSelector("#assistant-stop-btn");
    eq("pendant la génération : « Envoyer » devient « Arrêter »", (await page.innerText("#assistant-stop-btn")).trim(), "Arrêter");
    check("un bouton Arrêter est aussi dans la conversation", (await page.$$("#ai-stop-btn")).length === 1);
    await page.waitForFunction(() => document.getElementById("ai-stream") && /mot3/.test(document.getElementById("ai-stream").innerText), null, { timeout: 4000 });
    await page.click("#assistant-stop-btn");
    await idle(page);
    const T = await page.evaluate(() => ({ aborted: window.__T.aborted, types: window.__T.sent.map(m => m.type), phase: state.aiChat.phase }));
    eq("un seul ABORT envoyé, phase ABORTED", [T.aborted, T.phase], [1, "ABORTED"]);
    const mem = await thread(page);
    check("la réponse partielle est conservée, marquée interrompue (dans les données, pas dans le texte)", mem[1].meta.aborted === true && /mot0/.test(mem[1].content) && !/interrompue/.test(mem[1].content), mem[1]);
    check("l'interface le dit : « Réponse interrompue »", /Réponse interrompue/.test(await page.innerText("#content")));
    eq("le moteur n'a jamais été rechargé (aucun INIT_MODEL / SWITCH_MODEL)", T.types.filter(t => t !== "GENERATE" && t !== "ABORT"), []);
    await ask(page, "plus simplement");
    const g = await gens(page);
    check("la question suivante repart avec la réponse partielle comme contexte", g[1].messages.some(m => m.role === "assistant" && /mot0/.test(m.content)) && !JSON.stringify(g[1].messages).includes("interrompue"));
    // Échap au clavier
    await script(page, [{ text: long, tokenMs: 25 }]);
    await page.fill("#assistant-query-input", "Explique-moi le TRI");
    await page.press("#assistant-query-input", "Enter");
    await page.waitForSelector("#assistant-stop-btn");
    await page.press("#assistant-query-input", "Escape");
    await idle(page);
    eq("Échap arrête aussi la réponse", await page.evaluate(() => state.aiChat.phase), "ABORTED");
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 6. Régénérer */
  await scenario("6. Régénérer : même question, même contexte, la réponse est REMPLACÉE", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "Première version de la réponse." }, { text: "Seconde version de la réponse." }]);
    await ask(page, "Explique-moi l'EBITDA");
    const before = (await thread(page)).length;
    await page.click("#ai-regen-btn");
    await idle(page);
    const mem = await thread(page), g = await gens(page);
    eq("même nombre de messages (pas de duplication dans l'historique)", mem.length, before);
    eq("la réponse a été remplacée", mem[1].content, "Seconde version de la réponse.");
    eq("même question et même contexte envoyés", g[1].messages.map(m => m.content.slice(0, 40)), g[0].messages.map(m => m.content.slice(0, 40)));
    check("température légèrement plus haute à la régénération (réponse différente possible)", g[1].temperature > g[0].temperature, [g[0].temperature, g[1].temperature]);
    eq("pas de fantôme dans l'historique des échanges : une seule question affichée", await page.$$eval(".ai-bubble.user", e => e.length), 1);
    await ctx.close();
  });

  /* 7. Concurrence */
  await scenario("7. une seule génération à la fois : le second envoi est refusé proprement", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: Array.from({ length: 30 }, (_, i) => "a" + i + " ").join(""), tokenMs: 20 }]);
    await page.fill("#assistant-query-input", "Explique-moi la VAN");
    await page.click("#assistant-query-btn");
    await page.waitForSelector("#assistant-stop-btn");
    const r = await page.evaluate(async () => { const a = await aiGeneralAsk("Une autre question"); const b = await aiFollowUp("encore une"); return { a, b: b === undefined }; });
    eq("appel concurrent : refusé (false)", r.a, false);
    eq("exactement UN GENERATE envoyé", (await gens(page)).length, 1);
    eq("la machine reste en GENERATING", await page.evaluate(() => state.aiChat.phase), "GENERATING");
    check("le bouton « Envoyer » n'existe pas pendant la génération (remplacé par Arrêter)", (await page.$$("#assistant-query-btn")).length === 0);
    await page.click("#assistant-stop-btn"); await idle(page);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 8. Erreurs */
  await scenario("8. erreurs : messages simples, contexte trop grand → nouvel essai plus petit", async () => {
    const { ctx, page } = await open();
    await script(page, [{ error: { code: "DEVICE_LOST", message: "GPUDevice lost: très technique" } }]);
    await ask(page, "Explique-moi la VAN");
    const e1 = await page.innerText(".ai-error");
    check("DEVICE_LOST : message simple, sans texte technique", /carte graphique/.test(e1) && !/GPUDevice|technique/.test(e1), e1);
    eq("la question reste dans la conversation, avec « Réessayer »", [(await thread(page)).length, (await page.$$("#ai-retry-btn")).length], [1, 1]);
    await script(page, [{ text: "Réponse après réessai." }]);
    await page.click("#ai-retry-btn"); await idle(page);
    eq("Réessayer relance la MÊME question et obtient la réponse", [(await thread(page)).length, (await lastBubble(page)).includes("Réponse après réessai")], [2, true]);
    // contexte trop grand : un second essai avec un contexte réduit
    await script(page, [{ error: { code: "GENERATION_FAILED", message: "Prompt tokens exceed context window size", contextExceeded: true } }, { text: "Réponse avec contexte réduit." }]);
    await ask(page, "plus simplement");
    const g = await gens(page);
    eq("deux GENERATE : le second avec un prompt plus petit", [g.length, g[g.length - 1].messages.reduce((n, m) => n + m.content.length, 0) <= g[g.length - 2].messages.reduce((n, m) => n + m.content.length, 0)], [4, true]);
    check("la réponse finale est affichée, sans erreur", /contexte réduit/.test(await lastBubble(page)) && (await page.$$(".ai-error")).length === 0);
    eq("diagnostic : retry avec contexte réduit noté", await page.evaluate(() => state.aiChat.diag.retriedSmaller), true);
    // réponse vide
    await script(page, [{ text: "" }]);
    await ask(page, "Explique le TRI");
    check("réponse vide : message dédié", /rien répondu/.test(await page.innerText(".ai-error")));
    eq("diagnostic : code EMPTY_RESPONSE", await page.evaluate(() => state.aiChat.diag.errorCode), "EMPTY_RESPONSE");
    // modèle non chargé
    await page.evaluate(() => { state.aiStatus = "idle"; render(); });
    /* Le moteur mathématique est déterministe : la barre reste utilisable sans modèle (un calcul est traité), mais une question qui n'est pas un calcul
       reçoit l'erreur « modèle non prêt » et rien n'est envoyé au moteur IA (pas d'envoi dans le vide). */
    eq("modèle non chargé : la barre reste active (calculs déterministes)", await page.$eval("#assistant-query-input", e => e.disabled), false);
    const nGen = (await gens(page)).length;
    await page.fill("#assistant-query-input", "Qu'est-ce que le TRI ?");
    await page.click("#assistant-query-btn");
    await page.waitForTimeout(200);
    check("…une question hors calcul : erreur « modèle non prêt », aucune génération lancée", (await page.$$(".ai-error")).length > 0 && (await gens(page)).length === nGen);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 9. Paliers */
  await scenario("9. Rapide / Avancé / Expert : l'utilisateur reste maître du modèle", async () => {
    const { ctx, page } = await open(undefined, "rapide");
    await script(page, [{ text: "Les limites de l'EBITDA sont nombreuses…" }]);
    await ask(page, "Quelles sont les limites de l'EBITDA dans l'analyse financière d'une entreprise ?");
    const T = await page.evaluate(() => ({ types: window.__T.sent.map(m => m.type), tier: state.aiTier }));
    eq("question complexe en Rapide : AUCUN chargement de modèle (seulement GENERATE)", [T.types, T.tier], [["GENERATE"], "rapide"]);
    check("une suggestion discrète est affichée : « pourrait bénéficier du mode Avancé »", /pourrait bénéficier du mode Avancé/.test(await page.innerText("#content")));
    const g = (await gens(page))[0];
    check("profondeur DEEP : plus de jetons autorisés, mais plafonné pour Rapide", g.maxTokens > 420 && g.maxTokens <= 700, g.maxTokens);
    await ctx.close();
    const e = await open(undefined, "expert");
    await script(e.page, [{ text: "<think>je réfléchis</think>La VAN actualise les flux." }]);
    await ask(e.page, "Explique-moi la VAN");
    const ge = (await gens(e.page))[0];
    eq("Expert (DeepSeek-R1) : pas de rôle system, consignes dans le premier message utilisateur", ge.messages.map(m => m.role), ["user"]);
    check("Expert : le raisonnement <think> n'est pas affiché", /actualise les flux/.test(await lastBubble(e.page)) && !/je réfléchis/.test(await lastBubble(e.page)));
    check("Expert : plus de marge de réponse que les autres paliers", ge.maxTokens >= 1000, ge.maxTokens);
    eq("Expert : température dans la plage recommandée", ge.temperature >= 0.5 && ge.temperature <= 0.7, true);
    await e.ctx.close();
  });

  /* 10. Suggestions, actions, interface */
  await scenario("10. actions et suggestions : peu, contextuelles, sans barre de 12 boutons", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "L'EBITDA est un indicateur de rentabilité opérationnelle." }, { text: "Exemple : une boulangerie qui…" }]);
    await ask(page, "Qu'est-ce que l'EBITDA ?");
    eq("actions : Copier et Régénérer seulement", await page.$$eval(".ai-msg-actions .btn-text", e => e.map(b => b.innerText.trim())), ["Copier", "Régénérer"]);
    const chips = await page.$$eval("[data-ai-sug]", e => e.map(b => b.dataset.aiSug));
    check("2 à 3 suggestions, contextuelles (définition → exemple…)", chips.length >= 2 && chips.length <= 3 && chips.includes("example"), chips);
    check("aucune formule « Intent detected » ni nom de catégorie visible", !/DEFINITION|Intent|EXPLANATION|intent/.test(await page.innerText("#content")));
    await page.click('[data-ai-sug="example"]');
    await idle(page);
    const g = await gens(page);
    check("la suggestion envoie l'historique (la définition) et la consigne « exemple »", g[1].messages.length >= 4 && /Give ONE concrete example/.test(g[1].messages[g[1].messages.length - 1].content), g[1].messages.map(m => m.role));
    const chips2 = await page.$$eval("[data-ai-sug]", e => e.map(b => b.dataset.aiSug));
    check("« exemple » n'est pas reproposé juste après", !chips2.includes("example"), chips2);
    // Copier
    await page.click("#ai-copy-btn");
    await page.waitForFunction(() => /Copié/.test(document.getElementById("ai-copy-btn") ? document.getElementById("ai-copy-btn").innerText : ""), null, { timeout: 3000 });
    eq("Copier : le texte est dans le presse-papiers", await page.evaluate(() => navigator.clipboard.readText()), "Exemple : une boulangerie qui…");
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 11. Diagnostic */
  await scenario("11. diagnostic : toutes les mesures, uniquement dans le panneau", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "Une réponse de test.", finish: "stop" }]);
    await ask(page, "Compare VAN et TRI");
    const d = await page.evaluate(() => state.aiChat.diag);
    check("modèle, intention, profondeur, contexte, historique, temps, finishReason", d.tier === "avance" && d.intent === "COMPARISON" && d.depth && d.promptTokens > 0 && d.historyUsed === 0 && d.prepMs >= 0 && d.ttftMs === 12 && d.finishReason === "stop" && d.llmCalls === 1, d);
    eq("la conversation ne montre aucune de ces informations", /COMPARISON|promptTokens|TTFT/.test(await page.innerText(".ai-thread")), false);
    await page.evaluate(() => { document.getElementById("ai-diag-panel").open = true; });
    const txt = await page.innerText("#ai-diag-panel");
    check("le panneau de diagnostic les affiche", /questionIntent : COMPARISON/.test(txt) && /TTFT\(engine\) : 12 ms/.test(txt) && /finishReason : stop/.test(txt) && /llmCalls : 1/.test(txt), txt.slice(-700));
    check("aucune question ni réponse dans le diagnostic", !/Compare VAN et TRI|Une réponse de test/.test(txt));
    await ctx.close();
  });

  /* 12. Non-régression des autres entrées */
  await scenario("12. non-régression : intentions personnelles et actions existantes inchangées", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "Tu devrais réviser…" }]);
    await ask(page, "Qu'est-ce que je dois réviser aujourd'hui ?");
    const g = await gens(page);
    eq("une demande PERSONNELLE garde son flux (contexte du planning, rôle user)", [g.length, g[0].messages[0].role, /ÉTUDIANT|planning|SÉANCES|PRIORIT/i.test(g[0].messages[0].content)], [1, "user", true]);
    eq("… et n'est pas marquée « mode Général »", await page.evaluate(() => aiIsGeneral()), false);
    await page.evaluate(() => { aiClearThread(); });
    await script(page, [{ text: "Explication de la notion." }]);
    await page.evaluate(() => { state.aiTopic = "la segmentation"; return aiRun("explain"); });
    await idle(page);
    const g2 = await gens(page);
    check("l'action « Expliquer une notion » fonctionne comme avant (consigne historique, 250 mots)", /Maximum 250 mots/.test(g2[g2.length - 1].messages[0].content), g2[g2.length - 1].messages[0].content.slice(-200));
    await page.evaluate(() => { aiClearThread(); });
    await ask(page, "Explique-moi les types d'examen de gestion");
    eq("« examen » seul ne bascule plus sur le planning de l'étudiant", await page.evaluate(() => aiIsGeneral()), true);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 13. Moteur jamais rechargé, 5 questions d'affilée */
  await scenario("13. une conversation de 5 messages : même moteur, jamais rechargé", async () => {
    const { ctx, page } = await open();
    for (const q of ["Explique-moi le TRI.", "Plus simplement.", "Donne-moi un exemple avec 1000 €.", "Maintenant compare-le à la VAN.", "Fais-moi une question pour vérifier si j'ai compris."]) await ask(page, q);
    const T = await page.evaluate(() => window.__T.sent.map(m => m.type));
    eq("5 GENERATE, aucun autre message (ni INIT_MODEL, ni SWITCH_MODEL, ni RESET)", T, ["GENERATE", "GENERATE", "GENERATE", "GENERATE", "GENERATE"]);
    const g = await gens(page);
    check("le contexte reste borné : jamais plus de 3 000 jetons estimés", g.every(x => x.messages.reduce((n, m) => n + m.content.length, 0) / 3.2 < 3000));
    const last = g[4].messages[g[4].messages.length - 1].content;
    check("« fais-moi une question » : consigne de vérification, sans donner la réponse", /ONE short question/.test(last) && /Do not give the answer/.test(last), last);
    check("« compare-le à la VAN » : l'historique est envoyé", g[3].messages.length >= 4 && /Topic:/.test(g[3].messages[g[3].messages.length - 1].content) || g[3].messages.length >= 4);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 14. Langues */
  await scenario("14. 5 langues : question en anglais → réponse en anglais ; interface traduite", async () => {
    const { ctx, page } = await open();
    await page.evaluate(() => LyonI18n.setLang("en")); await page.waitForTimeout(150);
    await script(page, [{ text: "NPV is the sum of discounted cash flows." }]);
    await page.fill("#assistant-query-input", "What is the difference between NPV and IRR?");
    await page.click("#assistant-query-btn"); await idle(page);
    const g = (await gens(page))[0];
    check("« Answer in English » dans le prompt", /Answer in English/.test(g.messages[0].content), g.messages[0].content.slice(-120));
    const txt = await page.innerText("#content");
    check("interface en anglais : Copy / Regenerate / suggestions", /Copy/.test(txt) && /Regenerate/.test(txt) && /Give me an example|Ask me a question/.test(txt), txt.slice(-300));
    check("aucune clé de traduction brute visible", !/assistant\.[a-z_.]+/.test(txt));
    // question en espagnol alors que l'interface est en anglais
    await script(page, [{ text: "El VAN es…" }]);
    await ask(page, "¿Qué es el EBITDA y para qué sirve?");
    check("langue suivie par question : espagnol", /Answer in Spanish/.test((await gens(page))[1].messages[0].content));
    for (const [lang, word] of [["es", "Copiar"], ["de", "Kopieren"], ["it", "Copia"], ["fr", "Copier"]]) {
      await page.evaluate((l) => { LyonI18n.setLang(l); render(); }, lang); await page.waitForTimeout(100);
      check(`${lang} : « ${word} »`, (await page.innerText("#content")).includes(word));
    }
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 15. Responsive + clavier + a11y */
  await scenario("15. mobile 375 px : pas de débordement ; clavier et accessibilité", async () => {
    const { ctx, page } = await open({ width: 375, height: 800 });
    await script(page, [{ text: Array.from({ length: 8 }, (_, i) => "L'EBITDA est un indicateur numéro " + i + ". ").join("") }]);
    await ask(page, "Qu'est-ce que l'EBITDA ?");
    eq("aucun défilement horizontal", await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0), true);
    check("boutons d'action ≥ 36 px de haut (cibles tactiles)", await page.$$eval(".ai-msg-actions .btn-text, .ai-suggestion-chip", e => e.every(b => b.getBoundingClientRect().height >= 32)));
    await page.focus("#assistant-query-input");
    await page.fill("#assistant-query-input", "plus simplement");
    await script(page, [{ text: "Plus simple." }]);
    await page.press("#assistant-query-input", "Enter"); await idle(page);
    eq("Entrée envoie la question", (await gens(page)).length, 2);
    check("les boutons sont de vrais <button> avec un nom", await page.$$eval("#ai-copy-btn, #ai-regen-btn, [data-ai-sug]", e => e.length >= 3 && e.every(b => b.tagName === "BUTTON" && b.innerText.trim().length > 0)));
    check("les actions sont un groupe nommé", await page.$eval('.ai-msg-actions[role="group"]', e => !!e.getAttribute("aria-label")));
    await script(page, [{ error: { code: "GENERATION_FAILED", message: "x" } }]);
    await ask(page, "Explique le TRI");
    eq("la zone d'erreur est annoncée aux lecteurs d'écran (role=alert)", await page.$eval(".ai-error", e => e.getAttribute("role")), "alert");
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 16. Changement de compte, effacement */
  await scenario("16. effacer / changer de compte : plus rien de la conversation, rien d'écrit après coup", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: Array.from({ length: 40 }, (_, i) => "w" + i + " ").join(""), tokenMs: 25 }]);
    await page.fill("#assistant-query-input", "Explique-moi la VAN");
    await page.click("#assistant-query-btn");
    await page.waitForSelector("#assistant-stop-btn");
    await page.evaluate(() => { resetUserStateInMemory(); });          // la VRAIE remise à zéro d'un changement de compte
    eq("conversation et état effacés", await page.evaluate(() => [state.aiThread.length, state.aiChat.phase, state.aiBusy, aiIsGeneral()]), [0, "IDLE", false, false]);
    await page.waitForTimeout(1200);
    eq("la réponse qui arrive après coup n'est PAS écrite dans le nouveau compte", await page.evaluate(() => state.aiThread.length), 0);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  /* 17. Safari / WKWebView : ce qui est vérifiable ICI (WebKit n'est pas installé : le reste est NOT TESTED WKWEBVIEW) */
  await scenario("17. Safari / WKWebView : aucune API réservée à Chromium dans le code ajouté", async () => {
    const fs = await import("node:fs");
    const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const block = html.slice(html.indexOf("13bis. QUESTIONS LIBRES"), html.indexOf("function aiClearThread()"));
    const core = fs.readFileSync(new URL("../assistant-core.js", import.meta.url), "utf8");
    const bad = /showOpenFilePicker|showSaveFilePicker|userAgentData|webkitSpeechRecognition|OffscreenCanvas|navigator\.gpu|SharedArrayBuffer|structuredClone|Array\.prototype\.at\b|\.at\(-1\)|replaceAll\(/;
    eq("page (bloc questions libres) : aucune API Chromium-only / récente", bad.test(block), false);
    eq("assistant-core.js : idem", bad.test(core), false);
    eq("aucun lookbehind regex (Safari < 16.4)", /\(\?<[=!]/.test(block + core), false);
    check("la copie a un repli (execCommand) quand navigator.clipboard est absent", /execCommand\("copy"\)/.test(block));
    // le SEUL accès réseau du bloc : la lecture des fichiers statiques REV-EM Knowledge, même origine (jamais un serveur tiers, jamais Supabase)
    const fetches = block.match(/\bfetch\([^)]*\)/g) || [];
    check("aucun accès réseau ajouté, sauf la lecture des fichiers statiques ai-knowledge/ (même origine)", fetches.length === 1 && /ai-knowledge\//.test(block.slice(block.indexOf("const getJson"), block.indexOf("const getJson") + 260)) && !/XMLHttpRequest|WebSocket|https?:\/\//.test(block.slice(block.indexOf("const KEY_KNOWLEDGE_MODE"), block.indexOf("function aiChatFresh"))), fetches);
    check("aucune clé, aucun eval / Function dans le code ajouté", !/\beval\(|new Function|apikey|service_role/i.test(block + core));
  });

} catch (e) {
  fail++;
  console.log(`FAIL — exception : ${(e && e.stack) || e}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} vérifications réussies (PASS MOCK), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
