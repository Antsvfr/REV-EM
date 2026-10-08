/* Moteur pur de l'assistant (questions libres, mode Général) — sous Node, sans navigateur.
   Lancer :  node tests/assistant-core.test.js
   Tout est « PASS » (logique pure). Ce fichier ne dit RIEN de la qualité d'un vrai modèle. */
require("../assistant-core.js");
require("../ai-engine.js");
const A = globalThis.RevemAssistant, AI = globalThis.RevemAI;

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const an = (q, prev, lang) => A.analyzeQuestion(q, { previous: prev === true ? { hasAnswer: true } : (prev || null), lang: lang || "fr" });
const PREV = { hasAnswer: true };

/* ── 1. Les cas A–L du cahier des charges : analyse ───────────────────────── */
{
  for (const c of A.CASES) {
    const a = an(c.q, c.prior ? PREV : null);
    const e = c.expect;
    if (e.intent) eq(`cas ${c.id} : intention ${e.intent}`, a.intent, e.intent);
    if (e.depth) eq(`cas ${c.id} : profondeur ${e.depth}`, a.depth, e.depth);
    if (e.domain) eq(`cas ${c.id} : domaine ${e.domain}`, a.domain, e.domain);
    if (e.followType) eq(`cas ${c.id} : type de suite ${e.followType}`, a.followType, e.followType);
    if (e.needsHistory) eq(`cas ${c.id} : s'appuie sur la conversation`, a.needsHistory, true);
    if (e.oneLine) eq(`cas ${c.id} : une seule phrase demandée`, a.flags.oneLine, true);
    if (e.local) eq(`cas ${c.id} : réponse LOCALE « ${e.local} » (aucun appel au modèle)`, (A.localAnswer(a) || {}).kind, e.local);
    if (e.result) { const calc = A.localCalculation(c.q, a.lang); check(`cas ${c.id} : calcul local exact « ${e.result} »`, !!calc && calc.resultText === e.result, calc && calc.resultText); }
  }
  eq("cas L : la profondeur DEEP vient de la question, pas d'un mot clé isolé", an("Quelles sont les limites de l'EBITDA dans l'analyse financière d'une entreprise ?").depth, "DEEP");
}

/* ── 2. Profondeur adaptative, et consignes de l'utilisateur ───────────────── */
{
  eq("« EBITDA définition » → SHORT", an("EBITDA définition").depth, "SHORT");
  eq("« Explique-moi l'EBITDA » → NORMAL", an("Explique-moi l'EBITDA").depth, "NORMAL");
  eq("« plus court » → SHORT", an("Explique la VAN, en plus court").depth, "SHORT");
  eq("« plus détaillé » → DEEP", an("Explique la VAN plus en détail").depth, "DEEP");
  eq("« donne-moi juste la réponse » → SHORT", an("Combien font 12 x 7 ? donne-moi juste la réponse").depth, "SHORT");
  eq("« explique le raisonnement » → DEEP", an("Explique le raisonnement de la VAN").depth, "DEEP");
  eq("niveau débutant détecté", an("Explique-moi la loi normale comme si je débutais.").flags.beginner, true);
  eq("niveau avancé détecté", an("Explique la VAN, niveau avancé").flags.advanced, true);
  eq("« pas à pas » détecté", an("Calcule la VAN pas à pas").flags.reasoning, true);
}

/* ── 3. Faux positifs : ce qui NE DOIT PAS être pris pour du temps réel / une source ───── */
{
  const notRt = ["Qu'est-ce que la valeur actuelle nette ?", "Et si le taux d'actualisation augmente ?", "Explique le bitcoin", "Pourquoi le prix du pétrole est-il volatil ?",
    "Quelle est la valeur actuelle de 1 000 € reçus dans 3 ans à 5 % ?", "Explique l'inflation", "Qu'est-ce qu'un taux directeur ?", "Quel est le rôle du CAC 40 ?"];
  notRt.forEach(q => eq(`pas du temps réel : « ${q} »`, an(q).realtime, null));
  const rt = ["Quel est le cours du Bitcoin aujourd'hui ?", "Prix actuel du pétrole Brent ?", "Quelle est la météo à Lyon ?", "What is the Bitcoin price right now?", "¿Cuál es el precio actual del bitcoin?", "Wie ist der aktuelle Bitcoin-Kurs heute?", "Qual è il prezzo del bitcoin oggi?", "Quel est le taux d'inflation actuel en France ?", "Quels sont les derniers résultats de la Ligue 1 hier ?"];
  rt.forEach(q => check(`temps réel détecté : « ${q} »`, !!an(q).realtime, an(q).realtime));
  const notSrc = ["Donne-moi un exemple d'étude de marché", "Donne-moi les sources de financement d'une entreprise", "Qu'est-ce qu'une étude de cas ?", "Explique la source de la croissance", "Cite trois sources de revenus d'une startup"];
  notSrc.forEach(q => eq(`pas une demande de référence : « ${q} »`, an(q).source, false));
  const src = ["Donne-moi l'étude exacte qui prouve cette affirmation.", "Cite l'article scientifique qui montre ça", "Give me the exact study that proves this", "Donne-moi la source exacte", "Peux-tu me donner le lien vers cette étude ?"];
  src.forEach(q => check(`demande de référence : « ${q} »`, an(q).source === true, an(q).source));
  const ra = A.localAnswer(an("Quel est le cours du Bitcoin aujourd'hui ?"));
  check("réponse temps réel : dit qu'il n'a pas accès, n'invente aucune valeur", /pas accès/.test(ra.text) && !/\d{3}/.test(ra.text), ra.text);
  eq("réponse temps réel : traduite (EN)", /can't access real-time/.test(A.localAnswer(an("What is the Bitcoin price right now?", null, "en")).text), true);
  eq("réponse « source » : refuse d'inventer (DE)", /erfinden/.test(A.localAnswer(an("Gib mir die genaue Studie, die das beweist", null, "de")).text), true);
  eq("aucune réponse locale pour une question ordinaire", A.localAnswer(an("Qu'est-ce que la VAN ?")), null);
}

/* ── 4. Langue ────────────────────────────────────────────────────────────── */
{
  eq("français", A.detectLanguage("Pourquoi une hausse des taux fait baisser le prix ?", "en"), "fr");
  eq("anglais", A.detectLanguage("What is the difference between NPV and IRR?", "fr"), "en");
  eq("espagnol", A.detectLanguage("¿Qué es el EBITDA y para qué sirve?", "fr"), "es");
  eq("allemand", A.detectLanguage("Was ist der Unterschied zwischen Kapitalwert und Zinsfuß?", "fr"), "de");
  eq("italien", A.detectLanguage("Che cosa è il valore attuale netto e come si calcola?", "fr"), "it");
  eq("message trop court et ambigu → langue de la conversation", A.detectLanguage("OK ?", "es"), "es");
  eq("l'analyse porte la langue détectée", an("What is EBITDA?", null, "fr").lang, "en");
  eq("« What is EBITDA? » → DEFINITION", an("What is EBITDA?", null, "en").intent, "DEFINITION");
  eq("« ¿Qué es el EBITDA? » → DEFINITION", an("¿Qué es el EBITDA?", null, "es").intent, "DEFINITION");
  eq("« Was ist EBITDA? » → DEFINITION", an("Was ist EBITDA?", null, "de").intent, "DEFINITION");
  eq("« Che cos'è l'EBITDA? » → DEFINITION", an("Che cos'è l'EBITDA?", null, "it").intent, "DEFINITION");
  eq("« Explain the normal distribution » → EXPLANATION", an("Explain the normal distribution", null, "en").intent, "EXPLANATION");
  eq("« Compare NPV and IRR » → COMPARISON", an("Compare NPV and IRR", null, "en").intent, "COMPARISON");
  eq("« simpler please » → REFORMULATION (simpler)", [an("simpler please", PREV, "en").intent, an("simpler please", PREV, "en").followType], ["REFORMULATION", "simpler"]);
}

/* ── 5. Suite de conversation : le contexte fait le lien ───────────────────── */
{
  eq("« plus simplement » SANS réponse précédente : pas de fausse reformulation", an("plus simplement", null).intent === "REFORMULATION", false);
  eq("« donne-moi un exemple avec 1000 € » = suite (exemple)", [an("Donne-moi un exemple avec 1000 €.", PREV).intent, an("Donne-moi un exemple avec 1000 €.", PREV).followType], ["REFORMULATION", "example"]);
  const cmp = an("Maintenant compare-le à la VAN.", PREV);
  eq("« compare-le à la VAN » : COMPARISON qui renvoie à la conversation", [cmp.intent, cmp.needsHistory], ["COMPARISON", true]);
  const chk = an("Fais-moi une question pour vérifier si j'ai compris.", PREV);
  eq("« fais-moi une question » : exercice de vérification", [chk.intent, chk.followType, chk.needsHistory], ["EXERCISE", "check", true]);
  eq("« Explique-moi la loi normale » (nouveau sujet) n'est PAS une reformulation", an("Explique-moi la loi normale", PREV).intent, "EXPLANATION");
  eq("nouveau sujet : pas d'historique envoyé", an("Qu'est-ce que le WACC ?", PREV).needsHistory, false);
  eq("« et pour le TRI ? » = suite", an("Et pour le TRI ?", PREV).intent, "FOLLOW_UP");
  eq("« donc ? » après une réponse = suite", an("Donc ?", PREV).needsHistory, true);
}

/* ── 5bis. Suggestions cliquées : l'intention est portée par le clic ─────── */
{
  const forced = (q, ft, intent) => A.analyzeQuestion(q, { previous: PREV, lang: "fr", forced: { intent, followType: ft } });
  eq("« Explique le résultat » (saisi à la main) renvoie à la conversation", an("Explique le résultat", PREV).needsHistory, true);
  eq("« Explique la VAN » reste un nouveau sujet", an("Explique la VAN", PREV).needsHistory, false);
  const e = forced("Explique le résultat", "explain", "FOLLOW_UP");
  eq("suggestion « expliquer le résultat »", [e.intent, e.followType, e.needsHistory], ["FOLLOW_UP", "explain", true]);
  check("… sa consigne dit de ne pas recalculer", /Do not recompute/.test(A.selectStrategy(e, { tier: "avance" }).lines.join(" ")));
  const c = forced("Change une hypothèse", "change", "FOLLOW_UP");
  check("suggestion « changer une hypothèse » : consigne dédiée", /Change ONE assumption/.test(A.selectStrategy(c, { tier: "avance" }).lines.join(" ")));
  const pr = A.buildGeneralPrompt({ question: "Un indice", analysis: forced("Un indice", "hint", "FOLLOW_UP"), history: [{ role: "user", content: "Exercice : calcule la VAN", meta: { intent: "EXERCISE", topic: "VAN" } }, { role: "assistant", content: "Énoncé…" }], tier: "avance" });
  check("suggestion « indice » : l'historique est envoyé et la consigne est collée à la question", pr.meta.historyMessages === 2 && /without giving the full answer/.test(pr.messages[pr.messages.length - 1].content), pr.meta);
  // les phrases des suggestions, dans les 5 langues, sont comprises même saisies à la main
  const langs = { fr: ["Donne-moi un exemple", "Plus simplement", "Approfondis", "Fais-moi une question pour vérifier que j'ai compris"], en: ["Give me an example", "Explain it more simply", "Go deeper", "Ask me a question to check I understood"],
                  es: ["Dame un ejemplo", "Explícalo más sencillo", "Explícalo con más detalle", "Hazme una pregunta para comprobar que lo he entendido"], de: ["Gib mir ein Beispiel", "Erkläre es einfacher", "Erkläre es ausführlicher", "Stell mir eine Frage, um mein Verständnis zu prüfen"],
                  it: ["Dammi un esempio", "Spiegalo in modo più semplice", "Spiegalo più in dettaglio", "Fammi una domanda per verificare"] };
  Object.keys(langs).forEach(l => { const r = langs[l].map(q => an(q, PREV, l).followType); eq(`${l} : exemple / simplifier / approfondir / vérifier reconnus`, r, ["example", "simpler", "detailed", "check"]); });
}

/* ── 6. Calculs locaux : exacts, et jamais d'eval ──────────────────────────── */
{
  const E = A.localCalculation("1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ?", "fr");
  eq("intérêts composés : 1 000 € à 5 % sur 4 ans", [E.kind, E.resultText, E.values.gain.toFixed(2)], ["compound-interest", "1 215,51", "215.51"]);
  check("le bloc contient formule, substitution, résultat", /formula: FV = C/.test(E.block) && /substitution/.test(E.block) && /result: FV = 1 215,51/.test(E.block), E.block);
  eq("intérêts simples", A.localCalculation("1000 € à 5 % pendant 4 ans en intérêts simples", "fr").resultText, "1 200");
  eq("capitalisation mensuelle", A.localCalculation("1 000 € à 6 % pendant 2 ans, capitalisation mensuelle, combien ?", "fr").resultText, "1 127,16");
  eq("durée en mois", A.localCalculation("5 000 € placés à 3 % pendant 18 mois, combien ?", "fr").values.years, 1.5);
  eq("valeur actuelle : 1 000 € dans 3 ans à 8 %", A.localCalculation("Quelle est la valeur actuelle de 1 000 € reçus dans 3 ans avec un taux de 8 % ?", "fr").resultText, "793,83");
  const npv = A.localCalculation("Calcule la VAN : investissement initial 1000 €, flux 400, 500, 600, taux 10 %", "fr");
  eq("VAN avec flux explicites (−1000 + 400/1,1 + 500/1,1² + 600/1,1³)", [npv.kind, npv.resultText], ["npv", "227,65"]);
  eq("pourcentage d'un nombre", A.localCalculation("Combien font 20 % de 350 ?", "fr").resultText, "70");
  eq("variation en pourcentage", A.localCalculation("Quelle est l'évolution de 80 à 100 ?", "fr").resultText, "25 %");
  eq("moyenne", A.localCalculation("Calcule la moyenne de 12, 15 et 9", "fr").resultText, "12");
  eq("médiane", A.localCalculation("médiane de 3, 9, 1, 7", "fr").resultText, "5");
  eq("écart-type (échantillon)", A.localCalculation("écart-type de 2, 4, 4, 4, 5, 5, 7, 9", "fr").values.sd.toFixed(3), "2.138");
  eq("arithmétique : priorités et parenthèses", A.localCalculation("Calcule 12 * (3 + 4) / 5", "fr").resultText, "16,8");
  eq("arithmétique : puissance et signe", A.localCalculation("2^10 - 24", "fr").resultText, "1 000");
  eq("arithmétique : « × »", A.localCalculation("7 × 8", "fr").resultText, "56");
  eq("anglais : séparateurs", A.localCalculation("How much is $1,000 invested at 5% for 4 years?", "en").resultText, "1,215.51");
  eq("anglais : format du résultat", /1,215.51/.test(A.localCalculation("1,000 € invested at 5% for 4 years: how much?", "en").block), true);
  // sécurité : jamais d'exécution de code
  const evil = ["require('fs')", "process.exit()", "alert(1)", "1+1; alert(1)", "constructor.constructor('return 1')()", "2**99999999", "(((((((((((((((((((((((((1)))))))))))))))))))))))))", "1/0", "9^9999", "__proto__", "1 +", "()", "calcule 5 +* 3"];
  evil.forEach(s => eq(`entrée dangereuse ou invalide ignorée : « ${s.slice(0, 40)} »`, A.parseExpression(s), null));
  eq("division par zéro : pas de résultat", A.localCalculation("10 / 0", "fr"), null);
  check("le moteur n'utilise ni eval ni Function", !/\beval\s*\(|new Function|Function\s*\(/.test(require("fs").readFileSync(__dirname + "/../assistant-core.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  eq("une question sans nombres n'est pas un calcul", A.localCalculation("Qu'est-ce que la VAN ?", "fr"), null);
  eq("des nombres sans demande de calcul clair : rien d'inventé", A.localCalculation("Le TRI est de 12 % pour ce projet", "fr"), null);
  eq("analyse : calcul → CALCULATION", an("Combien font 20 % de 350 ?").intent, "CALCULATION");
}

/* ── 7. Historique : le bon, dans le budget, jamais tout ───────────────────── */
{
  const long = (n, tag) => ("Phrase de réponse numéro " + tag + ". ").repeat(Math.ceil(n / 30));
  const msgs = (pairs) => pairs.flatMap(([q, a, meta]) => [{ role: "user", content: q, meta: meta || {} }, { role: "assistant", content: a }]);
  const hist = msgs([["Explique-moi le TRI.", long(2400, "TRI"), { intent: "EXPLANATION", topic: "TRI" }], ["Plus simplement.", long(2400, "simple"), { intent: "REFORMULATION", followType: "simpler" }],
                     ["Donne-moi un exemple avec 1000 €.", long(2400, "exemple"), { intent: "REFORMULATION", followType: "example" }]]);
  const fu = an("Maintenant compare-le à la VAN.", PREV);
  const sel = A.selectHistory(hist, fu, 1500);
  check("le dernier échange est gardé", /exemple/.test(sel.turns[sel.turns.length - 1].content), sel.turns.map(t => t.content.slice(0, 40)));
  check("budget respecté", sel.tokens <= 1500, sel.tokens);
  eq("le sujet vient du message qui porte un sujet (TRI), pas de « plus simplement »", sel.topic, "TRI");
  check("les échanges anciens sont COMPRIMÉS, pas recopiés en entier", sel.turns.slice(0, -2).every(t => t.content.length <= 300), sel.turns.map(t => t.content.length));
  eq("question indépendante : aucun historique", A.selectHistory(hist, an("Qu'est-ce que le WACC ?", PREV), 1500).turns, []);
  const noisy = msgs([["Bonjour", "Bonjour !"], ["Qu'est-ce que la VAN ?", "La VAN est la valeur actuelle nette. " + long(300, "x"), { intent: "DEFINITION", topic: "VAN" }]]);
  noisy.push({ role: "user", content: "oups", meta: { error: true } });
  eq("salutations et messages en erreur retirés de la mémoire", A.selectHistory(noisy, an("plus simplement", PREV), 800).turns.length, 2);
  const withLocal = [{ role: "user", content: "Cours du Bitcoin aujourd'hui ?", meta: { kind: "realtime" } }, { role: "assistant", content: "Je n'ai pas accès…", meta: { kind: "realtime" } }, ...noisy.slice(2, 4)];
  check("une réponse locale (temps réel) n'entre pas dans le contexte du modèle", A.selectHistory(withLocal, an("plus simplement", PREV), 800).turns.every(t => !/Bitcoin|accès/.test(t.content)));
  const cut = [{ role: "user", content: "Explique la VAN", meta: { intent: "EXPLANATION" } }, { role: "assistant", content: "La VAN est… \n\n*(génération interrompue)*" }];
  check("le marqueur « génération interrompue » n'est pas renvoyé au modèle", !/interrompue/.test(A.selectHistory(cut, an("plus simplement", PREV), 800).turns[1].content));
  eq("budget quasi nul : on n'envoie pas un historique tronqué sans intérêt", A.selectHistory(hist, fu, 20).turns, []);
  eq("historique vide : aucune erreur", A.selectHistory([], fu, 1000).turns, []);
}

/* ── 8. Prompt : structure, rôle system, budget RÉEL par palier ────────────── */
{
  const long = "Voici une réponse très détaillée. ".repeat(110);
  const history = [
    { role: "user", content: "Qu'est-ce que la VAN ?", meta: { intent: "DEFINITION", topic: "VAN" } }, { role: "assistant", content: long },
    { role: "user", content: "plus simplement", meta: { intent: "REFORMULATION", followType: "simpler" } }, { role: "assistant", content: long },
    { role: "user", content: "donne-moi un exemple", meta: { intent: "REFORMULATION", followType: "example" } }, { role: "assistant", content: long },
  ];
  const q = "et si le taux d'actualisation augmente ?";
  for (const tier of ["rapide", "avance", "expert"]) {
    const reasoning = tier === "expert";
    const a = an(q, PREV);
    const p = A.buildGeneralPrompt({ question: q, analysis: a, history, tier, reasoning });
    const total = p.meta.promptTokens + p.params.maxTokens + 120;
    check(`${tier} : prompt + réponse tiennent dans la fenêtre réelle de 4096 jetons (${p.meta.promptTokens} + ${p.params.maxTokens})`, total <= AI.TIERS && false || total <= 4096, total);
    eq(`${tier} : le dernier message est la question`, p.messages[p.messages.length - 1].role, "user");
    check(`${tier} : la question est présente`, p.messages[p.messages.length - 1].content.indexOf(q) === 0);
    check(`${tier} : l'historique pertinent est inclus`, p.meta.historyMessages >= 2, p.meta);
    eq(`${tier} : rôle system ${reasoning ? "absent (DeepSeek-R1 : consignes dans le premier message)" : "présent en premier"}`, reasoning ? p.messages.every(m => m.role !== "system") : p.messages[0].role === "system", true);
    check(`${tier} : alternance user/assistant valide`, p.messages.filter(m => m.role !== "system").every((m, i) => m.role === (i % 2 === 0 ? "user" : "assistant")), p.messages.map(m => m.role));
    check(`${tier} : consignes présentes (réponse en français, honnêteté)`, /Answer in French/.test(JSON.stringify(p.messages)) && /Never invent/.test(JSON.stringify(p.messages)));
    check(`${tier} : le sujet de la conversation est donné explicitement`, /VAN/.test(JSON.stringify(p.messages)) && p.meta.topic === "VAN");
    eq(`${tier} : maxTokens ≥ plancher`, p.params.maxTokens >= 120, true);
  }
  const f = A.buildGeneralPrompt({ question: "plus simplement", analysis: an("plus simplement", PREV), history, tier: "avance" });
  check("« plus simplement » : la réponse précédente est dans le contexte ET la consigne dit de la réécrire", /Rewrite your PREVIOUS answer in simpler words/.test(f.messages[f.messages.length - 1].content) && f.messages.some(m => m.role === "assistant"));
  check("« plus simplement » : consigne de ne PAS repartir de zéro", /do not restart/.test(f.messages[f.messages.length - 1].content));
  const g = A.buildGeneralPrompt({ question: "donne-moi un exemple", analysis: an("donne-moi un exemple", PREV), history, tier: "avance" });
  check("« donne-moi un exemple » : le sujet (VAN) est rappelé", /Topic: VAN/.test(g.messages[g.messages.length - 1].content));
  const standalone = A.buildGeneralPrompt({ question: "Qu'est-ce que l'EBITDA ?", analysis: an("Qu'est-ce que l'EBITDA ?", PREV), history, tier: "avance" });
  eq("question indépendante : AUCUN historique (system + question)", standalone.messages.length, 2);
  check("question indépendante : plus courte que l'ancien premier message (352 jetons mesurés avant)", standalone.meta.promptTokens < 352, standalone.meta.promptTokens);   // l'instruction de langue (qualité du français) ajoute ≈ 30 jetons : toujours plus court qu'avant
  // calcul : le bloc vérifié est dans le prompt, température basse
  const calcQ = "1 000 € placés à 5 % par an pendant 4 ans : combien obtient-on ?";
  const calc = A.localCalculation(calcQ, "fr");
  const pc = A.buildGeneralPrompt({ question: calcQ, analysis: an(calcQ), history: [], tier: "avance", calc });
  check("calcul : le résultat exact est dans le prompt", /result: FV = 1 215,51/.test(pc.messages[0].content), pc.messages[0].content);
  eq("calcul : température basse, profil « calc »", [pc.params.temperature, pc.meta.profile], [0.2, "calc"]);
  // contexte énorme : la question n'est jamais tronquée ni perdue, et ça tient
  const huge = Array.from({ length: 40 }, (_, i) => [{ role: "user", content: "Question " + i + " sur le TRI ?", meta: { intent: "EXPLANATION", topic: "TRI" } }, { role: "assistant", content: "x".repeat(6000) }]).flat();
  const ph = A.buildGeneralPrompt({ question: "et si le taux baisse ?", analysis: an("et si le taux baisse ?", PREV), history: huge, tier: "rapide" });
  check("historique gigantesque : tient dans la fenêtre", ph.meta.promptTokens + ph.params.maxTokens + 120 <= 4096, ph.meta);
  check("historique gigantesque : la question est intacte", ph.messages[ph.messages.length - 1].content.indexOf("et si le taux baisse ?") === 0);
  const pq = A.buildGeneralPrompt({ question: "Explique ".concat("la VAN et le TRI en détail. ".repeat(60)), analysis: an("Explique la VAN"), history: [], tier: "rapide" });
  check("question très longue : tient dans la fenêtre", pq.meta.promptTokens + pq.params.maxTokens + 120 <= 4096 || pq.params.maxTokens === 120, pq.meta);
}

/* ── 9. Stratégies, paramètres, paliers ───────────────────────────────────── */
{
  const s = (q, tier, reasoning) => A.selectStrategy(an(q), { tier, reasoning });
  check("définition : réponse directe d'abord", /direct definition/.test(s("Qu'est-ce que l'EBITDA ?", "avance").lines.join(" ")));
  check("explication : idée → intuition → mécanisme → exemple", /core idea first.*intuition.*mechanism.*example/.test(s("Explique-moi l'EBITDA", "avance").lines.join(" ")));
  check("calcul : données → formule → substitution → résultat → sens", /data.*formula.*substitute.*compute.*result.*means/.test(s("Combien font 20 % de 350 ?", "avance").lines.join(" ")));
  check("comparaison : points communs → différences → conséquences", /in common.*differences.*consequences/.test(s("Compare VAN et TRI", "avance").lines.join(" ")));
  check("finance : intuition d'abord, formule seulement si elle apporte", /Finance: give the intuition first/.test(s("Pourquoi une hausse des taux fait baisser le prix d'une obligation ?", "avance").lines.join(" ")));
  check("statistiques : jamais une formule seule", /Never give a bare formula/.test(s("Explique la loi normale", "avance").lines.join(" ")));
  check("économie : corrélation / causalité, court / long terme", /correlation from causation/.test(s("Pourquoi l'inflation augmente quand la demande monte ?", "avance").lines.join(" ")));
  eq("définition : température basse", s("Qu'est-ce que l'EBITDA ?", "avance").temperature, 0.3);
  eq("explication : température modérée", s("Explique l'EBITDA", "avance").temperature, 0.5);
  eq("brainstorming : un peu plus créatif", s("Propose-moi des idées de sujets de mémoire", "avance").temperature, 0.8);
  eq("trois profils seulement (pas vingt)", new Set(["Qu'est-ce que la VAN ?", "Explique la VAN", "Propose des idées", "Combien font 2+2 ?", "Compare VAN et TRI"].map(q => s(q, "avance").profile)).size <= 4, true);
  const exp = s("Explique la VAN", "expert", true);
  check("Expert (R1) : température dans la plage recommandée 0,5–0,7", exp.temperature >= 0.5 && exp.temperature <= 0.7, exp.temperature);
  check("Expert : plus de marge pour le raisonnement qu'Avancé", s("Explique la VAN", "expert", true).maxTokens > s("Explique la VAN", "avance").maxTokens);
  check("Rapide : réponses plus courtes que les autres paliers", s("Explique la VAN", "rapide").maxTokens < s("Explique la VAN", "avance").maxTokens);
  check("profondeur SHORT : plafond bas", s("EBITDA définition", "avance").maxTokens <= 260);
  check("une phrase demandée : plafond très bas (hors raisonnement)", s("Réponds uniquement en une phrase : qu'est-ce que l'inflation ?", "avance").maxTokens <= 120);
  check("une phrase demandée : la consigne est dans le prompt", /exactly ONE sentence/.test(s("Réponds uniquement en une phrase : qu'est-ce que l'inflation ?", "avance").lines.join(" ")));
  eq("palier inconnu : repli sur Avancé", s("Explique la VAN", "inconnu").maxTokens, s("Explique la VAN", "avance").maxTokens);
  // l'utilisateur reste maître du modèle
  eq("question complexe en Rapide : on SUGGÈRE Avancé, on ne le charge pas", A.suggestTier(an("Quelles sont les limites de l'EBITDA dans l'analyse financière d'une entreprise ?"), "rapide"), "avance");
  eq("question simple en Rapide : aucune suggestion", A.suggestTier(an("Qu'est-ce que l'EBITDA ?"), "rapide"), null);
  eq("question très difficile en Avancé : on suggère Expert", A.suggestTier(an("Quelles sont les hypothèses et les limites d'un test de régression linéaire, et dans quelle mesure peut-on interpréter les coefficients ?"), "avance"), "expert");
  eq("en Expert : aucune suggestion", A.suggestTier(an("Quelles sont les limites de l'EBITDA dans l'analyse financière d'une entreprise ?"), "expert"), null);
  eq("temps réel : aucune suggestion de palier", A.suggestTier(an("Cours du Bitcoin aujourd'hui ?"), "rapide"), null);
  check("le moteur ne sait pas CHARGER un palier (aucune fonction de chargement exposée)", !Object.keys(A).some(k => /load|download|switch|changeModel/i.test(k)));
}

/* ── 10. Nettoyage de la réponse : pas de flatterie, pas de fausses sources ─── */
{
  eq("« Bien sûr ! » retiré", A.cleanAnswer("Bien sûr ! La VAN est la valeur actuelle nette."), "La VAN est la valeur actuelle nette.");
  eq("« Excellente question ! » retiré", A.cleanAnswer("Excellente question ! Le TRI est un taux."), "Le TRI est un taux.");
  eq("« Great question! Of course. » retirés", A.cleanAnswer("Great question! Of course. NPV is a sum."), "NPV is a sum.");
  eq("une réponse normale n'est pas modifiée", A.cleanAnswer("La VAN actualise les flux."), "La VAN actualise les flux.");
  check("une URL inventée est retirée", !/http/.test(A.cleanAnswer("Voir https://exemple.org/etude pour plus de détails.")));
  eq("un lien Markdown est réduit à son texte", A.cleanAnswer("Selon [Investopedia](https://www.investopedia.com/npv) la VAN…"), "Selon Investopedia la VAN…");
  eq("rubrique « Sources » finale retirée", A.cleanAnswer("La VAN actualise.\n\nSources :\n- Dupont (2019)\n- Martin (2021)"), "La VAN actualise.");
  eq("rubrique « **Références** » retirée", A.cleanAnswer("Le TRI est un taux.\n\n**Références**\nLivre X"), "Le TRI est un taux.");
  eq("idempotent (sûr à chaque jeton du flux)", A.cleanAnswer(A.cleanAnswer("Bien sûr ! Texte.\n\nSources : x")), "Texte.");
  eq("flux partiel : un début de phrase n'est pas abîmé", A.cleanAnswer("La VA"), "La VA");
  eq("le mot « source » dans une phrase normale reste", A.cleanAnswer("La source du risque est le levier."), "La source du risque est le levier.");
}

/* ── 11. Machine d'états : une seule génération à la fois ──────────────────── */
{
  let p = "IDLE";
  const go = (ev) => { const r = A.nextPhase(p, ev); p = r.phase; return r.ok; };
  eq("IDLE → PREPARING → GENERATING → COMPLETE", [go("SUBMIT"), go("DISPATCHED"), go("DONE"), p], [true, true, true, "COMPLETE"]);
  eq("nouvelle question depuis COMPLETE", [go("SUBMIT"), p], [true, "PREPARING"]);
  eq("un second SUBMIT pendant la préparation est REFUSÉ", [go("SUBMIT"), p], [false, "PREPARING"]);
  go("DISPATCHED");
  eq("un SUBMIT pendant la génération est REFUSÉ (pas de 2ᵉ génération silencieuse)", [go("SUBMIT"), p], [false, "GENERATING"]);
  eq("arrêt → ABORTED", [go("ABORT"), p], [true, "ABORTED"]);
  eq("on peut reposer une question après un arrêt", [go("SUBMIT"), p], [true, "PREPARING"]);
  eq("réponse locale : PREPARING → COMPLETE sans passer par le GPU", [go("LOCAL_DONE"), p], [true, "COMPLETE"]);
  go("SUBMIT"); go("DISPATCHED");
  eq("échec → ERROR, puis nouvelle question possible", [go("FAIL"), p, go("SUBMIT")], [true, "ERROR", true]);
  eq("événement illégal ignoré", A.nextPhase("IDLE", "DONE"), { phase: "IDLE", ok: false });
  eq("« occupé » = PREPARING ou GENERATING seulement", ["IDLE", "PREPARING", "GENERATING", "COMPLETE", "ABORTED", "ERROR"].map(A.isBusyPhase), [false, true, true, false, false, false]);
}

/* ── 12. Erreurs : des codes, pas « une erreur est survenue » ──────────────── */
{
  const c = (e) => A.classifyChatError(e).code;
  eq("modèle non chargé", c({ code: "NOT_READY", message: "Le modèle n'est pas prêt" }), "MODEL_NOT_READY");
  eq("contexte dépassé", [c({ contextExceeded: true, message: "x" }), A.classifyChatError({ contextExceeded: true }).shrinkContext], ["CONTEXT_TOO_LARGE", true]);
  eq("contexte dépassé (message WebLLM)", c(new Error("Prompt tokens exceed context window size")), "CONTEXT_TOO_LARGE");
  eq("périphérique GPU perdu", c({ code: "DEVICE_LOST" }), "DEVICE_LOST");
  eq("mémoire", [c({ code: "OUT_OF_MEMORY_OR_RESOURCE_LIMIT" }), A.classifyChatError({ code: "OUT_OF_MEMORY_OR_RESOURCE_LIMIT" }).retryable], ["OUT_OF_MEMORY", false]);
  eq("worker mort", c({ code: "WORKER_FAILED" }), "WORKER_FAILED");
  eq("génération occupée", c({ code: "BUSY" }), "BUSY");
  eq("échec de génération", c({ code: "GENERATION_FAILED", message: "boom" }), "GENERATION_FAILED");
  eq("réponse vide", c(new Error("réponse vide")), "EMPTY_RESPONSE");
  eq("annulation", c(new Error("cancelled")), "GENERATION_ABORTED");
  eq("inconnu", c(new Error("???")), "UNKNOWN_ERROR");
  eq("chaîne seule", c("quelque chose"), "UNKNOWN_ERROR");
}

/* ── 13. Suggestions de suite : contextuelles, 3 au plus, jamais la même chose ── */
{
  const s = (q, hist, prev) => A.suggestFollowUps(an(q, prev || null), hist || []);
  eq("après une définition : exemple / approfondir / vérifier", s("Qu'est-ce que la VAN ?"), ["example", "deeper", "check"]);
  eq("après un calcul : expliquer le résultat / changer une hypothèse", s("Combien font 20 % de 350 ?"), ["explain", "change"]);
  eq("après une explication : plus simplement / exemple", s("Explique la VAN").slice(0, 2), ["simpler", "example"]);
  eq("jamais plus de 3", s("Qu'est-ce que la VAN ?").length <= 3, true);
  eq("on ne repropose pas « exemple » juste après en avoir demandé un", s("Qu'est-ce que la VAN ?", [{ role: "user", content: "donne-moi un exemple", meta: { followType: "example" } }]).includes("example"), false);
  eq("temps réel : aucune suggestion", s("Cours du Bitcoin aujourd'hui ?"), []);
  eq("profondeur DEEP : pas « approfondir »", s("Quelles sont les limites de l'EBITDA dans l'analyse financière d'une entreprise ?").includes("deeper"), false);
}

/* ── 14. Banc de qualité : checkAnswer repère ce qui est objectivement mauvais ─── */
{
  const ck = (id, t) => A.checkAnswer(id, t);
  check("A : une définition courte est acceptée", ck("A", "L'EBITDA est le résultat avant intérêts, impôts, dépréciations et amortissements : il mesure la rentabilité opérationnelle.").ok);
  check("A : une dissertation est refusée", !ck("A", "x ".repeat(600)).ok);
  check("B : intuition + mécanisme", ck("B", "Quand les taux montent, les nouvelles obligations offrent un meilleur rendement : les anciennes deviennent moins attractives, donc leur prix baisse.").ok);
  check("E : le bon résultat est exigé", ck("E", "1 000 × 1,05^4 = 1 215,51 €").ok);
  check("E : un mauvais résultat est refusé", !ck("E", "On obtient 1 200 €.").ok);
  check("I : valeur inventée refusée", !ck("I", "Le Bitcoin vaut 64 250 $ aujourd'hui.").ok);
  check("I : refus honnête accepté", ck("I", "Je n'ai pas accès aux cours en temps réel dans ce mode.").ok);
  check("J : référence inventée refusée", !ck("J", "Voir Dupont et al. (2019), Journal of Finance.").ok);
  check("J : refus d'inventer accepté", ck("J", "Je ne peux pas citer d'étude précise, je préfère ne pas inventer de référence.").ok);
  check("K : deux phrases refusées", !ck("K", "L'inflation est la hausse des prix. Elle réduit le pouvoir d'achat.").ok);
  check("K : une phrase acceptée", ck("K", "L'inflation est la hausse générale et durable des prix.").ok);
  check("URL refusée", !ck("A", "Voir https://x.org").ok);
  check("rubrique Sources refusée", !ck("A", "Texte.\nSources : machin").ok);
  check("« Bien sûr ! » refusé", !ck("A", "Bien sûr ! L'EBITDA est…").ok);
  eq("12 cas A–L présents", A.CASES.map(c => c.id).join(""), "ABCDEFGHIJKL");
}

/* ── Stratégie « calcul déjà fait par le moteur mathématique » (répétition de la démonstration) ───────────── */
{
  console.log("\n── stratégie math ──");
  const block = "problem: x^2 - 5x + 6 = 0  [équation]\nexact result: x = 2 ; x = 3\nverification: VERIFIED (exact method)";
  const hdr = "MATH ENGINE RESULT (computed deterministically, verified exactly — authoritative)";
  const build = (q, o) => { const an = A.analyzeQuestion(q, { lang: "fr" }); return A.buildGeneralPrompt(Object.assign({ question: q, analysis: an, history: [], tier: "avance", reasoning: false, contextTokens: 4096 }, o || {})); };
  const calc = { kind: "math:equation", resultText: "", block, header: hdr };
  const withMath = build("résous x² - 5x + 6 = 0", { calc }), without = build("résous x² - 5x + 6 = 0", {});
  check("résultat vérifié fourni : budget NORMAL réduit (≤ 320 jetons au lieu de 600)", withMath.params.maxTokens <= 320 && without.params.maxTokens === 600, [withMath.params.maxTokens, without.params.maxTokens]);
  check("…température 0,3 (≠ 0,2 quasi glouton, qui fait boucler un petit modèle)", withMath.params.temperature === 0.3, withMath.params.temperature);
  check("…profil « mathExplain »", withMath.meta.profile === "mathExplain");
  const sys = withMath.messages[0].content;
  check("format imposé : une ligne de méthode, équations UNE fois, résultat copié, vérification courte, puis STOP", /followed exactly/.test(sys) && /ONCE/.test(sys) && /then STOP/.test(sys));
  check("interdictions : ne pas reposer la question, ne pas répéter après la vérification", /Never restate the question/.test(sys) && /never repeat the method or the result after the check/.test(sys));
  check("le modèle sait que le moteur a DÉJÀ résolu : pas de nouveau calcul", /ALREADY solved and verified/.test(sys));
  check("l'ancienne consigne « solve step by step, give the result, then check » n'est plus là", !/solve step by step/.test(sys));
  check("français naturel : lexique (« racines », « s'additionnent », « On factorise donc »)", /racines/.test(sys) && /s'additionnent/.test(sys) && /On factorise donc/.test(sys) && /Never « se ajoutent »/.test(sys));
  check("le lexique n'est PAS ajouté hors calcul mathématique", !/s'additionnent/.test(without.messages[0].content));
  check("en-tête MATH ENGINE conservé", sys.indexOf(hdr) > 0);
  const tiers = ["rapide", "avance", "expert"].map(t => build("résous x² - 5x + 6 = 0", { calc, tier: t }).params.maxTokens);
  check("rapide < avancé ; expert (raisonnement) garde de la place", tiers[0] < tiers[1] && tiers[2] >= tiers[1], tiers);
  const short = build("2x + 4 = 10", { calc }).params.maxTokens, deep = build("explique en détail pas à pas la résolution de x² - 5x + 6 = 0", { calc }).params.maxTokens;
  check("question courte < normale < détaillée", short <= withMath.params.maxTokens && withMath.params.maxTokens <= deep, [short, withMath.params.maxTokens, deep]);
  const rep = build("calcule 5/0", { calc: { kind: "math:arith", resultText: "", block: "reason: division par zéro", header: "MATH ENGINE REPORT (authoritative)" } });
  check("calcul impossible : réponse très courte, aucun chiffre à donner", rep.params.maxTokens <= 200 && /NO verified result/.test(rep.messages[0].content), rep.params.maxTokens);
  const plain = build("explique moi l'écart type", {});
  check("question de cours (sans moteur) : budget et température inchangés (600 / 0,5)", plain.params.maxTokens === 600 && plain.params.temperature === 0.5, plain.params);
  const legacy = build("1000 € à 5 % pendant 4 ans", { calc: { kind: "compound", resultText: "x", block: "FV = 1 215,51" } });
  check("ancien calcul local (kind sans « math: ») : stratégie ordinaire inchangée", legacy.meta.profile !== "mathExplain");
}

{
  console.log("\n── tuteur Maths & Stats : mode « Expliquer » ──");
  const build = (q, o, lang) => { const an = A.analyzeQuestion(q, { lang: lang || "fr" }); return A.buildGeneralPrompt(Object.assign({ question: q, analysis: an, history: [], tier: "avance", reasoning: false, contextTokens: 4096 }, o || {})); };
  const ex = d => build("explique moi l'écart type", { tutor: { mode: "explain", detail: d } });
  const std = ex("standard"), sh = ex("short"), de = ex("detailed"), sys = std.messages[0].content;
  check("six sections dans l'ordre : Intuition · Définition · Méthode · Formule · Exemple · Interprétation", /\*\*Intuition\*\* · \*\*Définition\*\* · \*\*Méthode\*\* · \*\*Formule\*\* · \*\*Exemple\*\* · \*\*Interprétation\*\*/.test(sys), sys.slice(-900));
  check("on part de l'intuition, pas de la formule ; chaque symbole est nommé ; arrêt après la dernière section", /Start from the intuition, never from the formula/.test(sys) && /Name every symbol/.test(sys) && /Stop after the last section/.test(sys));
  check("niveau de détail : concis < standard < détaillé (jetons autorisés)", sh.params.maxTokens < std.params.maxTokens && std.params.maxTokens < de.params.maxTokens, [sh.params.maxTokens, std.params.maxTokens, de.params.maxTokens]);
  check("…et les consignes de longueur diffèrent (≈ 80 / 180 / 330 mots)", /About 80 words/.test(sh.messages[0].content) && /About 180 words/.test(sys) && /About 330 words/.test(de.messages[0].content));
  check("profil « tutorExplain », température 0,4", std.meta.profile === "tutorExplain" && std.params.temperature === 0.4, std.params);
  const lbl = { en: "**Interpretation**", es: "**Interpretación**", de: "**Interpretation**", it: "**Interpretazione**" };
  Object.keys(lbl).forEach(l => check("libellés de section en langue « " + l + " »", build({ en: "explain standard deviation", es: "explica la desviación típica", de: "erkläre die Standardabweichung", it: "spiega la deviazione standard" }[l], { tutor: { mode: "explain", detail: "standard" } }, l).messages[0].content.indexOf(lbl[l]) > 0));
  const calc = { kind: "math:equation", resultText: "", block: "exact result: x = 2 ; x = 3", header: "MATH ENGINE RESULT (verified)" };
  const both = build("explique comment résoudre x² - 5x + 6 = 0", { calc, tutor: { mode: "explain", detail: "standard" } });
  check("problème déjà résolu par le moteur + explication : le résultat reste la vérité (« do not recompute », énoncé UNE fois) ET les six sections sont demandées", /ALREADY solved/.test(both.messages[0].content) && /state it only once/.test(both.messages[0].content) && /\*\*Intuition\*\*/.test(both.messages[0].content) && /MATH ENGINE RESULT/.test(both.messages[0].content));
  check("vocabulaire mathématique français imposé (« racines », « s'additionnent »)", /racines/.test(both.messages[0].content));
  const solve = build("résous x² - 5x + 6 = 0", { calc, tutor: { mode: "solve" } }), base = build("résous x² - 5x + 6 = 0", { calc });
  check("mode « Résoudre » : exactement la stratégie « calcul déjà fait » (inchangée)", solve.params.maxTokens === base.params.maxTokens && solve.meta.profile === "mathExplain" && solve.messages[0].content === base.messages[0].content);
  const none = build("explique moi l'écart type", {});
  check("sans tuteur : question de cours inchangée (600 / 0,5, pas de sections imposées)", none.params.maxTokens === 600 && none.params.temperature === 0.5 && !/\*\*Intuition\*\*/.test(none.messages[0].content));
  const exp = build("explique moi l'écart type", { tutor: { mode: "explain", detail: "detailed" }, reasoning: true, tier: "expert" });
  check("palier Expert (raisonnement) : marge supplémentaire pour la réflexion, température 0,5-0,6", exp.params.maxTokens >= 1400 && exp.params.temperature >= 0.5 && exp.params.temperature <= 0.6, exp.params);
  const practice = build("Explique-moi cet exercice : Résous x² + 3x - 18 = 0", { calc: { kind: "math:practice", resultText: "x = -6 ; x = 3", header: "MATH ENGINE RESULT (exercise generated and checked deterministically by the Fast Engine; this answer is certain, do not recompute it, only explain it)", block: "Exercise: x² + 3x - 18 = 0\nVerified answer: x = -6 ; x = 3" }, tutor: { mode: "practice-explain" } });
  check("explication d'un exercice validé : stratégie « calcul déjà fait » (≤ 320 jetons, 0,3), réponse vérifiée dans le prompt", practice.params.maxTokens <= 320 && practice.params.temperature === 0.3 && /Verified answer: x = -6 ; x = 3/.test(practice.messages[0].content));
}

console.log("\n" + pass + " vérifications réussies, " + fail + " échec(s).");
process.exit(fail ? 1 : 0);
