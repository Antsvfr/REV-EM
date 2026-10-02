/* ============================================================================
   REV-EM — pipeline de SORTIE de l'assistant, dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI : index.html tel quel dans un vrai Chromium ; la chaîne
   aiOnHostMessage → assembleur (output-processor.js) → aiGeneralAsk → affichage,
   l'historique réellement renvoyé au moteur au tour suivant, le diagnostic. On
   OBSERVE le DOM pendant le flux (MutationObserver) pour prouver qu'AUCUN morceau
   de raisonnement n'est affiché, même une fraction de seconde.

   CE QUI EST REMPLACÉ : le transport vers WebLLM est un FAUX qui rejoue des flux
   SIMULÉS (raisonnement sans balise ouvrante, balises coupées, retry, texte cumulé,
   boucle…). Tout est donc « PASS MOCK ». Cela prouve que, POUR CES FLUX, la page
   affiche et mémorise la bonne chose ; cela ne dit RIEN de ce que fait un vrai
   DeepSeek-R1 : NOT TESTED REAL WEBLLM / GPU / MAC / WKWEBVIEW.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/output-ui.test.mjs
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

/* Faux transport. Une étape : { chunks:[…] } (deltas exacts) | { text } | { cumulative:true, chunks } (renvoie le texte CUMULÉ)
   | { loop:"bloc" } (répète à l'infini jusqu'à ABORT) | { error:{code,contextExceeded}, after:n } | { finish } */
const FAKE = `
window.__T = { sent: [], script: [], seen: [], tokenMs: 3 };
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
      let chunks = step.chunks || (step.text || "").split(/(?<= )/);
      if (step.loop) { chunks = []; for (let i = 0; i < 400; i++) chunks.push(step.loop); }
      let sent = 0, acc = "";
      for (let i = 0; i < chunks.length; i++) {
        if (T.abortFlag) break;
        if (step.error && i === (step.after || 0)) { aiOnHostMessage({ type: "GENERATION_ERROR", id: msg.id, code: step.error.code, message: "x", contextExceeded: !!step.error.contextExceeded }); return; }
        await new Promise(r => setTimeout(r, step.tokenMs || T.tokenMs));
        acc += chunks[i];
        aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: step.cumulative ? acc : chunks[i] }); sent += chunks[i].length;
      }
      if (step.error && step.after >= chunks.length) { await new Promise(r => setTimeout(r, 160)); aiOnHostMessage({ type: "GENERATION_ERROR", id: msg.id, code: step.error.code, message: "x", contextExceeded: !!step.error.contextExceeded }); return; }
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: sent, ttftMs: 12, totalMs: Math.round(performance.now() - t0), finishReason: step.finish || (T.abortFlag ? "abort" : "stop") });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
/* Enregistre tout ce que l'élève PEUT voir : le flux ET la conversation, à chaque mutation du DOM. */
new MutationObserver(() => {
  const s = document.getElementById("ai-stream"), th = document.querySelector(".ai-thread");
  window.__T.seen.push({ stream: s ? s.innerText : null, thread: th ? th.innerText : null });
}).observe(document.body, { childList: true, subtree: true, characterData: true });
switchTab("ai");
`;
async function open(o) {
  o = o || {};
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.errors = []; page.on("pageerror", e => page.errors.push(String(e)));
  await page.goto(APP); await page.waitForTimeout(900);
  await page.evaluate(FAKE);
  if (o.tier) await page.evaluate((t) => { state.aiTier = t; state.aiModelId = AIE.TIERS[t].ids.f16; render(); }, o.tier);
  await page.evaluate(() => aiSetKnowledgeMode("off"));          // ce fichier teste la SORTIE : pas de connaissances dans le prompt
  return { ctx, page };
}
const script = (page, steps) => page.evaluate((s) => { window.__T.script.push(...s); }, steps);
const gens = (page) => page.evaluate(() => window.__T.sent.filter(m => m.type === "GENERATE"));
const idle = (page) => page.waitForFunction(() => !state.aiBusy, null, { timeout: 12000 }).then(() => page.waitForTimeout(40));
async function ask(page, q) {
  const follow = await page.$("#ai-follow-input");
  if (follow && await follow.isVisible()) { await follow.fill(q); await page.click("#ai-follow-btn"); }
  else { await page.fill("#assistant-query-input", q); await page.click("#assistant-query-btn"); }
  await idle(page);
}
const seen = (page) => page.evaluate(() => window.__T.seen);
const thread = (page) => page.evaluate(() => state.aiThread.map(m => ({ role: m.role, content: m.content })));
const diag = (page) => page.evaluate(() => state.aiChat.diag);
const lastBubble = (page) => page.$$eval(".ai-bubble.assistant", els => els.length ? els[els.length - 1].innerText : null);
const everything = (frames) => frames.map(f => (f.stream || "") + "\n" + (f.thread || "")).join("\n§§\n");

// La réponse réelle observée : raisonnement SANS balise ouvrante, brouillons, </think>, mélange de langues, triplement.
const REASONING = "Okay, the user asks what the standard deviation is for in finance. Let me draft: L'écart standard, 衡量 les risques. Hmm, wait, mesyre is wrong. Let me rewrite it properly in French. ";
const ANSWER = "En finance, l'écart-type mesure la dispersion des rendements d'un actif autour de leur moyenne : plus il est élevé, plus l'actif est risqué.";
const LEAK = /Okay|Let me|Hmm|wait|draft|mesyre|think|<\/|<th/;

try {
  await scenario("1. le cas OBSERVÉ : raisonnement sans balise ouvrante + </think> orphelin (palier Expert)", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    await script(page, [{ chunks: [REASONING.slice(0, 60), REASONING.slice(60, 140), REASONING.slice(140) + "\n</thi", "nk>\n\n", ANSWER.slice(0, 50), ANSWER.slice(50)] }]);
    await ask(page, "Explique-moi simplement à quoi sert l'écart-type en finance.");
    const fr = await seen(page);
    check("AUCUN morceau du raisonnement, de brouillon ou de balise n'est JAMAIS affiché, à aucun moment du flux", !LEAK.test(everything(fr)), fr.map(f => f.stream).filter(Boolean).slice(0, 4));
    eq("la réponse affichée est la réponse finale seule", (await lastBubble(page)).trim(), ANSWER);
    eq("la mémoire de la conversation contient la VERSION NETTOYÉE", (await thread(page))[1].content, ANSWER);
    const d = await diag(page);
    check("diagnostic : raisonnement masqué, balise orpheline détectée, durée de traitement mesurée", d.orphanThink === true && d.reasoningChars > 100 && d.rawChars > d.cleanChars && d.outputProcessingMs >= 0 && d.outputProcessingMs < 50 && d.outputIssues.includes("REASONING_STRIPPED"), d);
    eq("UN seul appel au modèle (aucune correction par un second LLM)", [d.llmCalls, (await gens(page)).length], [1, 1]);
    eq("aucune erreur JavaScript", page.errors, []);
    await ctx.close();
  });

  await scenario("2. TEST 6 : « <thi » « nk>… » « </thi » « nk> » — balises coupées entre les chunks", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    await script(page, [{ chunks: ["<thi", "nk>internal reasoning", "</thi", "nk>La réponse est 42."] }]);
    await ask(page, "Quelle est la réponse ?");
    const fr = await seen(page);
    check("« internal reasoning » et les morceaux de balise n'apparaissent jamais dans le DOM", !/internal|reasoning|think|<thi|<\//.test(everything(fr)));
    eq("affiché : « La réponse est 42. »", (await lastBubble(page)).trim(), "La réponse est 42.");
    await ctx.close();
  });

  await scenario("3. TEST 2 : « en français » après une réponse — réécriture, historique PROPRE, pas de réponse triplée", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    const messy = REASONING + "\n</think>\n\n" + ANSWER + "\n\n" + ANSWER + "\n\n" + ANSWER + " !";
    await script(page, [{ chunks: messy.match(/.{1,23}/gs) }, { text: "L'écart-type mesure la dispersion des rendements autour de leur moyenne." }]);
    await ask(page, "Explique-moi simplement à quoi sert l'écart-type en finance.");
    eq("1re réponse : UN exemplaire, sans raisonnement", (await thread(page))[1].content, ANSWER);
    await ask(page, "en français");
    const g = await gens(page);
    const sent = JSON.stringify(g[1].messages.filter(m => m.role === "assistant"));      // la consigne système parle de « thinking » : on ne regarde que ce qui vient du modèle
    check("le 2e tour renvoie au modèle la réponse NETTOYÉE (pas de </think>, pas de brouillon, pas de copies)", !LEAK.test(sent) && (sent.split("En finance, l'écart-type mesure").length - 1) === 1, sent.slice(0, 600));
    check("le message « en français » est compris comme une RÉÉCRITURE en français de la réponse précédente", /Rewrite your PREVIOUS answer in French/.test(g[1].messages[g[1].messages.length - 1].content) && g[1].messages.some(m => m.role === "assistant"));
    eq("verrou de langue : explicite, français", [(await diag(page)).preferredLanguage, (await diag(page)).langSource], ["fr", "explicit"]);
    eq("la conversation : 2 questions, 2 réponses, pas de réponse supplémentaire", (await thread(page)).map(m => m.role), ["user", "assistant", "user", "assistant"]);
    await ctx.close();
  });

  await scenario("4. TEST 7 : retry — l'ancienne tentative partielle n'est JAMAIS recollée à la nouvelle", async () => {
    const { ctx, page } = await open({ tier: "avance" });
    await script(page, [
      { chunks: ["Une obligation est… ", "encore partielle "], error: { code: "GENERATION_FAILED", contextExceeded: true }, after: 2, tokenMs: 20 },
      { chunks: ["Une obligation est un titre ", "de dette qui verse des coupons."] },
    ]);
    await ask(page, "Qu'est-ce qu'une obligation ?");
    const g = await gens(page);
    eq("deux tentatives (nouvel essai avec un contexte plus petit)", [g.length, (await diag(page)).retriedSmaller], [2, true]);
    eq("seule la réponse finale reste dans la conversation", (await thread(page))[1].content, "Une obligation est un titre de dette qui verse des coupons.");
    const fr = await seen(page);
    const after = fr.findIndex(f => /encore partielle/.test(f.stream || ""));
    const mixed = fr.some(f => /encore partielle[\s\S]*Une obligation est un titre/.test(f.stream || ""));
    check("l'affichage n'a JAMAIS montré « ancien partiel + nouvelle réponse »", !mixed && after >= 0, { after });
    check("le tampon d'affichage est réinitialisé au nouvel essai (le partiel disparaît avant la nouvelle réponse)", fr.slice(after + 1).some(f => !/encore partielle/.test(f.stream || "") ));
    eq("diagnostic : 2 appels comptés (honnête), aucune erreur affichée", [(await diag(page)).llmCalls, await page.evaluate(() => state.aiError)], [2, null]);
    await ctx.close();
  });

  await scenario("5. TEST 8 : deltas A, B, C et texte CUMULÉ — jamais « AABABC »", async () => {
    const { ctx, page } = await open();
    await script(page, [{ chunks: ["Une ", "obligation ", "est ", "un titre."] }, { cumulative: true, chunks: ["Une ", "obligation ", "est ", "un titre."] }]);
    await ask(page, "Qu'est-ce qu'une obligation ?");
    eq("deltas : « Une obligation est un titre. »", (await thread(page))[1].content, "Une obligation est un titre.");
    await page.click("#ai-regen-btn"); await idle(page);
    const t = await thread(page);
    eq("moteur qui renverrait le texte CUMULÉ : remplacé, pas recollé", t[1].content, "Une obligation est un titre.");
    eq("…et le diagnostic le signale (cumulativeChunks)", (await diag(page)).cumulativeChunks, 3);
    eq("la régénération remplace la réponse (pas de doublon)", t.map(m => m.role), ["user", "assistant"]);
    await ctx.close();
  });

  await scenario("6. TEST 9 : Markdown (liste, formule, paragraphes) préservé de bout en bout", async () => {
    const { ctx, page } = await open();
    const md = "La VAN actualise les flux.\n\n- flux 1 : 1 200 €\n- flux 2 : 800 €\n\nFormule : VAN = −I0 + F1/(1+t) + F2/(1+t)^2\n\nConclusion : si la VAN > 0, le projet crée de la valeur.";
    await script(page, [{ chunks: md.match(/.{1,9}/gs) }]);
    await ask(page, "Explique la VAN.");
    eq("le texte mémorisé est identique à l'original", (await thread(page))[1].content, md);
    const html = await page.$eval(".ai-bubble.assistant", e => e.innerHTML);
    check("rendu : une vraie liste <li>, les formules et « > 0 » intacts", (html.match(/<li>/g) || []).length === 2 && /VAN = −I0 \+ F1\/\(1\+t\) \+ F2\/\(1\+t\)\^2/.test(html) && /VAN &gt; 0/.test(html), html.slice(0, 400));
    await ctx.close();
  });

  await scenario("7. TEST 10 : « Explique la VAN. » → « Plus simplement. » → « Donne-moi un exemple. » — aucun artefact ne se propage", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    const a1 = "La VAN est la somme des flux futurs actualisés moins l'investissement initial : positive, elle crée de la valeur pour l'entreprise.";
    await script(page, [
      { chunks: ["Okay, ", "explain NPV, ", "draft: la VAN... ", "</think>", "\n\n", a1.slice(0, 40), a1.slice(40), "<｜end▁of▁sentence｜>"] },
      { chunks: ["<think>simplify</think>", "On compare ce qu'on gagne plus tard à ce qu'on dépense maintenant."] },
      { chunks: ["Exemple : investir 1 000 € pour recevoir 1 200 € dans un an."] },
    ]);
    await ask(page, "Explique la VAN.");
    await ask(page, "Plus simplement.");
    await ask(page, "Donne-moi un exemple.");
    const g = await gens(page);
    const clean = (i) => JSON.stringify(g[i].messages.filter(m => m.role === "assistant"));
    check("tour 2 : l'historique renvoyé ne contient ni raisonnement, ni balise, ni jeton spécial", !/Okay|draft|explain NPV|<\/|<｜|end▁of/.test(clean(1)) && clean(1).includes("La VAN est la somme"), clean(1).slice(0, 500));
    check("tour 3 : idem, et la réponse « plus simplement » est propre aussi", !/Okay|draft|simplify|<think|<\/|<｜/.test(clean(2)) && clean(2).includes("On compare ce qu'on gagne"), clean(2).slice(0, 500));
    eq("conversation propre", (await thread(page)).filter(m => m.role === "assistant").map(m => m.content), [a1, "On compare ce qu'on gagne plus tard à ce qu'on dépense maintenant.", "Exemple : investir 1 000 € pour recevoir 1 200 € dans un an."]);
    eq("l'historique persistant (aiHistory) est propre lui aussi", (await page.evaluate(() => state.aiHistory.map(h => h.text))).slice(-3), [a1, "On compare ce qu'on gagne plus tard à ce qu'on dépense maintenant.", "Exemple : investir 1 000 € pour recevoir 1 200 € dans un an."]);
    await ctx.close();
  });

  await scenario("8. boucle : un bloc répété à l'infini est détecté PENDANT le flux, la génération est arrêtée, le texte réduit", async () => {
    const { ctx, page } = await open();
    const unit = "Le taux d'actualisation reflète le risque du projet et le rendement exigé. ";
    await script(page, [{ chunks: ["Introduction utile. "], }, { loop: unit, tokenMs: 2 }]);
    await ask(page, "Qu'est-ce que le taux d'actualisation ?");           // 1re étape (courte) : réponse normale
    await ask(page, "Et pourquoi ?");
    const aborts = await page.evaluate(() => window.__T.sent.filter(m => m.type === "ABORT").length);
    const t = await thread(page);
    eq("exactement UN ABORT envoyé au moteur", aborts, 1);
    eq("phase COMPLETE (ce n'est pas une annulation de l'élève), aucune erreur", [await page.evaluate(() => state.aiChat.phase), await page.evaluate(() => state.aiError)], ["COMPLETE", null]);
    check("la réponse mémorisée contient UN exemplaire du bloc (pas 400)", t[3].content.trim() === unit.trim() && (t[3].content.match(/taux d'actualisation reflète/g) || []).length === 1, t[3].content.length);
    check("diagnostic : boucle détectée", (await diag(page)).loop === true && (await diag(page)).outputIssues.includes("LOOP"));
    await ctx.close();
  });

  await scenario("9. raisonnement qui n'aboutit pas : jamais affiché comme une réponse, message clair", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    await script(page, [{ chunks: ["Let me think about this. ", "The user wants a long explanation. ", "I should first consider "], finish: "length" }]);
    await ask(page, "Explique en détail le CAPM.");
    const t = await thread(page);
    eq("aucune réponse n'est ajoutée à la conversation (le raisonnement n'est pas une réponse)", t.map(m => m.role), ["user"]);
    check("message simple (traduit), pas le texte du raisonnement", /limite de réflexion/.test(await page.evaluate(() => state.aiError)) && !/Let me think/.test(everything(await seen(page))), await page.evaluate(() => state.aiError));
    eq("code d'erreur de diagnostic REASONING_TRUNCATED", (await diag(page)).errorCode, "REASONING_TRUNCATED");
    check("Réessayer est proposé", !!(await page.$("#ai-retry-btn")));
    await ctx.close();
  });

  await scenario("10. TEST 5 : « Que signifie le mot chinois 衡量 ? » — le caractère chinois est CONSERVÉ", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "Le mot 衡量 (héngliáng) signifie « mesurer » ou « évaluer » en chinois." }]);
    await ask(page, "Que signifie le mot chinois 衡量 ?");
    check("le caractère chinois est affiché, intact", /衡量 \(héngliáng\)/.test(await lastBubble(page)), await lastBubble(page));
    const d = await diag(page);
    check("aucune alerte (contenu étranger demandé par l'élève) et rien n'a été supprimé", d.allowForeign === true && !d.outputIssues.includes("FOREIGN_SCRIPT") && !(await page.$(".ai-bubble-note[role=note]")));
    await ctx.close();
  });

  await scenario("11. TEST 1 : contamination (fragment chinois non demandé) — DÉTECTÉE, signalée, jamais supprimée en silence", async () => {
    const { ctx, page } = await open();
    const bad = "L'écart-type, ou écart standard,衡量 les risques d'un portefeuille financier.";
    await script(page, [{ text: bad }]);
    await ask(page, "Explique-moi simplement à quoi sert l'écart-type en finance.");
    eq("le texte n'est PAS réécrit : aucun filtre destructif", (await thread(page))[1].content, bad);
    const d = await diag(page);
    check("diagnostic : FOREIGN_SCRIPT (Han ×2), langue attendue fr", d.outputIssues.includes("FOREIGN_SCRIPT") && d.preferredLanguage === "fr" && d.allowForeign === false, d);
    const note = await page.$eval(".ai-bubble-note[role=note]", e => e.innerText);
    check("une note discrète propose de régénérer (traduite)", /caractères inattendus/.test(note) && !!(await page.$("#ai-regen-btn")), note);
    await page.evaluate(() => { document.getElementById("ai-diag-panel").open = true; });
    const panel = await page.innerText("#ai-diag-panel");
    check("le panneau de diagnostic montre la sortie : raw → clean, raisonnement masqué, problèmes, durée", /output : raw \d+ → clean \d+ chars/.test(panel) && /issues : FOREIGN_SCRIPT/.test(panel) && /outputProcessingTime : [\d.]+ ms/.test(panel), panel.slice(-700));
    check("…sans aucun texte de question ni de réponse", !/衡量|écart-type, ou/.test(panel));
    await ctx.close();
  });

  await scenario("12. TEST 4 : « Explain inflation in English. » — le verrou de langue n'empêche pas un changement explicite", async () => {
    const { ctx, page } = await open();
    await script(page, [{ text: "Inflation is a general and lasting rise in prices." }]);
    await ask(page, "Qu'est-ce que l'inflation ?");
    const g1 = (await gens(page))[0];
    check("TEST 3 : question française → « Answer in French » et le prompt demande un français naturel", /Answer in French: natural, idiomatic, grammatical/.test(g1.messages[0].content));
    await ask(page, "Explain inflation in English.");
    const g2 = (await gens(page))[1];
    check("TEST 4 : « Answer in English » (explicite)", /Answer in English: natural/.test(g2.messages[0].content) && (await diag(page)).langSource === "explicit" && (await diag(page)).preferredLanguage === "en");
    await ask(page, "Et pourquoi la banque centrale s'en préoccupe-t-elle ?");
    eq("changement logique de conversation : retour au français", (await diag(page)).preferredLanguage, "fr");
    await ctx.close();
  });

  await scenario("13. le BRUT n'est jamais enregistré, envoyé ni affiché", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    await script(page, [{ chunks: ["SECRET-RAISONNEMENT-42 brouillon ", "</think>", "Réponse propre et complète sur la dispersion des rendements."] }]);
    await ask(page, "Explique l'écart-type.");
    const raw = await page.evaluate(() => revemLastRawOutput());
    check("revemLastRawOutput() (console, en mémoire) donne brut et propre pour les comparer", raw && /SECRET-RAISONNEMENT-42/.test(raw.raw) && raw.clean === "Réponse propre et complète sur la dispersion des rendements.", raw);
    const store = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) o[localStorage.key(i)] = localStorage.getItem(localStorage.key(i)); return JSON.stringify(o); });
    check("aucune trace du brut dans localStorage (donc rien à synchroniser avec Supabase)", !/SECRET-RAISONNEMENT-42/.test(store));
    check("aucune trace du brut dans le DOM", !/SECRET-RAISONNEMENT-42/.test(await page.content()));
    await page.evaluate(() => { document.getElementById("ai-diag-panel").open = true; });
    check("ni dans le panneau de diagnostic", !/SECRET-RAISONNEMENT-42/.test(await page.innerText("#ai-diag-panel")));
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (x) => { window.__copied = x; }; });
    await page.click("#ai-copy-diag-btn");
    await page.waitForFunction(() => window.__copied !== null, null, { timeout: 3000 });
    check("ni dans le diagnostic copiable", !/SECRET-RAISONNEMENT-42/.test(await page.evaluate(() => window.__copied)));
    await page.evaluate(() => aiClearThread());
    eq("effacer la conversation efface aussi le brut mémorisé", await page.evaluate(() => revemLastRawOutput()), null);
    await ctx.close();
  });

  await scenario("14. les autres tâches (cours, JSON) bénéficient du filtre du raisonnement, sans retouche de contenu", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    await script(page, [{ chunks: ["Let me plan the cards first, thinking in English.\n", "</think>", "[{\"front\":\"VAN  ?\",\"back\":\"Valeur  actuelle nette\"}]"] }]);
    const out = await page.evaluate(() => webllmJsonChat([{ role: "user", content: "fais des cartes" }]));
    eq("JSON : raisonnement orphelin retiré, contenu INTACT (espaces internes conservés)", out, [{ front: "VAN  ?", back: "Valeur  actuelle nette" }]);
    await script(page, [{ chunks: ["Raisonnement.\n</think>\nTexte  du  cours\n\n\n\nsuite"] }]);
    const res = await page.evaluate(() => webllmChat([{ role: "user", content: "x" }], { task: "summary" }).then(r => r.text));
    eq("tâche de cours : raisonnement retiré, typographie et déduplication NON appliquées", res, "Texte  du  cours\n\n\n\nsuite");
    await ctx.close();
  });

  await scenario("15. Expert : paramètres réellement envoyés", async () => {
    const { ctx, page } = await open({ tier: "expert" });
    await script(page, [{ text: "L'écart-type mesure la dispersion." }]);
    await ask(page, "Explique-moi simplement à quoi sert l'écart-type en finance.");
    const g = (await gens(page))[0];
    eq("température 0,6 (valeur recommandée par DeepSeek pour R1), top_p 0,9, max_tokens 1 600", [g.temperature, g.topP, g.maxTokens], [0.6, 0.9, 1600]);
    check("aucun rôle system (R1) ; la consigne de langue est dans le premier message utilisateur, compacte", g.messages.every(m => m.role !== "system") && /Answer in French: natural/.test(g.messages[0].content) && /Your final answer, after any thinking, must be entirely in French/.test(g.messages[0].content));
    await ctx.close();
  });

  await scenario("16. textes traduits dans les 5 langues", async () => {
    const { ctx, page } = await open();
    for (const lang of ["fr", "en", "es", "de", "it"]) {
      const ok = await page.evaluate((l) => { LyonI18n.setLang(l); return ["assistant.err.REASONING_TRUNCATED", "assistant.err.OUTPUT_LOOP", "assistant.note_foreign", "assistant.note_lang"].every(k => { const v = t(k); return v && v !== k; }); }, lang);
      check("messages de sortie présents en " + lang, ok);
    }
    await page.evaluate(() => LyonI18n.setLang("fr"));
    await ctx.close();
  });
} finally {
  await browser.close();
}
console.log(`\n${pass} vérifications réussies (PASS MOCK), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
