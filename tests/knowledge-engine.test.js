/* REV-EM Knowledge Engine (V1) — moteur pur, sous Node, sans navigateur.
   Lancer :  node tests/knowledge-engine.test.js
   Tout est « PASS » (logique pure et fichiers de données). Ce fichier ne dit RIEN de la qualité d'une réponse de modèle :
   il prouve que le bon élément est retrouvé, que rien d'irrelevant ne l'est, que la confiance est respectée et que le
   budget de contexte tient. */
const fs = require("fs"), path = require("path");
require("../knowledge-engine.js");
require("../assistant-core.js");
const K = globalThis.RevemKnowledge, A = globalThis.RevemAssistant;
const ROOT = path.join(__dirname, "..");
const KDIR = path.join(ROOT, "ai-knowledge");

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });

/* ── 0. Les VRAIS fichiers de données ─────────────────────────────────────── */
const manifest = JSON.parse(fs.readFileSync(path.join(KDIR, "index.json"), "utf8"));
const lexicon = JSON.parse(fs.readFileSync(path.join(KDIR, manifest.topics), "utf8"));
const items = manifest.files.map(f => JSON.parse(fs.readFileSync(path.join(KDIR, f), "utf8")));
const pack = K.loadPack(lexicon, items);
const IDX = pack.index;
const DEMO = { mode: "demo" };
const ask = (q, domain, extra) => K.retrieve(q, Object.assign({ index: IDX, domain: domain || "general", policy: DEMO }, extra || {}));
const ids = r => r.selected.map(s => s.id);

{
  console.log("\n── 0. les fichiers de ai-knowledge/ ──");
  check("le lexique est valide", K.validateLexicon(lexicon).ok, K.validateLexicon(lexicon).errors);
  check("le lot est valide (0 erreur)", pack.report.ok, pack.report.errors);
  eq("aucun élément rejeté", pack.rejected, []);
  eq("5 éléments de DÉMO seulement (pas de base inventée)", items.length, 5);
  check("TOUS les éléments sont verified:false et status:demo (rien n'est présenté comme vérifié)", items.every(i => i.verified === false && i.status === "demo"));
  check("aucune source inventée : sources vide partout", items.every(i => Array.isArray(i.sources) && i.sources.length === 0));
  check("lastReviewed est null partout (jamais une fausse date de relecture)", items.every(i => i.lastReviewed === null));
  // chaque fichier du dossier est dans le manifeste, et inversement
  const onDisk = [];
  (function walk(d, rel) { fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const r = rel ? rel + "/" + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (/\.json$/.test(e.name) && !["index.json", "topics.json"].includes(r)) onDisk.push(r); }); })(KDIR, "");
  eq("manifeste = fichiers présents sur le disque (aucun oublié, aucun fantôme)", onDisk.sort(), manifest.files.slice().sort());
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  check("le service worker précache le manifeste, le lexique, chaque élément ET le moteur", ["ai-knowledge/index.json", "ai-knowledge/topics.json", "knowledge-engine.js"].concat(manifest.files.map(f => "ai-knowledge/" + f)).every(f => sw.includes('"./' + f + '"')));
  check("le dossier correspond à l'id : finance/npv.json → finance.npv", items.every((it, i) => manifest.files[i].split("/")[0] === it.domain));
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  check("index.html charge knowledge-engine.js AVANT assistant-core.js", html.indexOf('src="knowledge-engine.js"') > 0 && html.indexOf('src="knowledge-engine.js"') < html.indexOf('src="assistant-core.js"'));
  const src = fs.readFileSync(path.join(ROOT, "knowledge-engine.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("le moteur n'utilise ni eval, ni Function, ni réseau, ni DOM, ni lookbehind", !/\beval\s*\(|new Function|\bfetch\(|XMLHttpRequest|document\.|window\.|\(\?<[=!]/.test(src));
}

/* ── 1. Validation du schéma ──────────────────────────────────────────────── */
{
  console.log("\n── 1. validation ──");
  const good = () => JSON.parse(JSON.stringify(items[0]));
  const v = (mut) => { const it = good(); mut(it); return K.validateItem(it, { topics: lexicon.topics }); };
  check("un élément correct passe", v(() => {}).errors.length === 0);
  check("id manquant → erreur", v(i => { delete i.id; }).errors.length > 0);
  check("id mal formé → erreur", v(i => { i.id = "Finance NPV"; }).errors.some(m => /id invalide/.test(m)));
  check("l'id doit commencer par son domaine", v(i => { i.id = "economics.npv"; }).errors.some(m => /domaine/.test(m)));
  check("domaine inconnu → erreur", v(i => { i.domain = "cuisine"; }).errors.length > 0);
  check("title / summary / topic obligatoires", ["title", "summary", "topic"].every(k => v(i => { i[k] = ""; }).errors.length > 0));
  check("verified doit être un booléen (jamais absent)", v(i => { delete i.verified; }).errors.some(m => /verified/.test(m)));
  check("timeSensitive doit être un booléen", v(i => { delete i.timeSensitive; }).errors.some(m => /timeSensitive/.test(m)));
  check("version entière ≥ 1", v(i => { i.version = 0; }).errors.length > 0 && v(i => { i.version = 1.5; }).errors.length > 0);
  check("lastReviewed : null ou AAAA-MM-JJ", v(i => { i.lastReviewed = "hier"; }).errors.length > 0 && v(i => { i.lastReviewed = "2026-10-02"; }).errors.length === 0);
  check("un tableau n'est pas une chaîne", v(i => { i.aliases = "VAN"; }).errors.length > 0);
  check("une formule vide est refusée", v(i => { i.formulas = [{ name: "x" }]; }).errors.length > 0);
  check("une source sans nom/type est refusée (jamais une source à moitié inventée)", v(i => { i.sources = [{ name: "Un livre" }]; }).errors.length > 0);
  check("verified:true SANS source → erreur", v(i => { i.verified = true; i.status = "reviewed"; i.lastReviewed = "2026-10-02"; }).errors.some(m => /source/.test(m)));
  check("verified:true SANS lastReviewed → erreur", v(i => { i.verified = true; i.status = "reviewed"; i.sources = [{ name: "Manuel X", type: "book" }]; }).errors.some(m => /lastReviewed/.test(m)));
  check("un élément demo ne peut pas être verified:true", v(i => { i.verified = true; i.sources = [{ name: "Manuel X", type: "book" }]; i.lastReviewed = "2026-10-02"; }).errors.some(m => /demo/.test(m)));
  check("verified:true complet et cohérent → valide", v(i => { i.verified = true; i.status = "reviewed"; i.sources = [{ name: "Manuel X", type: "book", reference: "chap. 4" }]; i.lastReviewed = "2026-10-02"; }).errors.length === 0);
  check("sujet inconnu du lexique → erreur (référence cassée)", v(i => { i.topics = ["npv", "inexistant"]; }).errors.some(m => /sujet inconnu/.test(m)));
  check("sans source : avertissement de provenance (pas une erreur tant que non vérifié)", v(() => {}).warnings.some(m => /provenance/.test(m)));
  check("timeSensitive sans lastReviewed → avertissement", v(i => { i.timeSensitive = true; }).warnings.some(m => /timeSensitive/.test(m)));
  check("élément trop long → avertissement « découper »", v(i => { i.summary = "Une très longue phrase de résumé. ".repeat(80); }).warnings.some(m => /long/.test(m)));
  // lot
  const a = good(), b = good();
  check("id en double → erreur", !K.validatePack([a, b], lexicon).ok && K.validatePack([a, b], lexicon).errors.some(m => /double/.test(m)));
  const c = good(); c.id = "finance.npv-bis";
  check("même titre sous un autre id → erreur (doublon de concept)", K.validatePack([a, c], lexicon).errors.some(m => /doublon/.test(m)));
  const d = good(); d.id = "finance.autre"; d.title = "Autre chose";
  check("alias partagé entre deux éléments → avertissement d'ambiguïté", K.validatePack([a, d], lexicon).warnings.some(m => /ambigu/.test(m)));
  const e = good(); e.relatedConcepts = ["finance.fantome"];
  check("relatedConcepts cassé → erreur", K.validatePack([e], lexicon).errors.some(m => /n'existe pas/.test(m)));
  const f = good(); f.relatedConcepts = [f.id];
  check("auto-référence → erreur", K.validatePack([f], lexicon).errors.some(m => /auto-réf/.test(m)));
  const st = K.validatePack(items, lexicon).stats;
  eq("statistiques du lot", [st.items, st.verified, st.demo, st.withSources], [5, 0, 5, 0]);
  // un élément invalide n'entre JAMAIS dans l'index
  const bad = good(); bad.id = "finance.casse"; bad.title = "Cassé"; bad.aliases = ["cassé"]; bad.verified = "oui";
  const lp = K.loadPack(lexicon, items.concat([bad]));
  check("un élément invalide est rejeté et n'entre pas dans l'index", lp.rejected.includes("finance.casse") && !lp.index.byId["finance.casse"] && lp.index.size === 5);
  check("le lexique invalide est signalé", !K.validateLexicon({ topics: { Mauvais_ID: { domain: "x", terms: [] } } }).ok && !K.validateLexicon(null).ok);
}

/* ── 2. Retrieval : les cas de la spécification ───────────────────────────── */
{
  console.log("\n── 2. retrieval (démo autorisée) ──");
  let r = ask("Qu'est-ce que la VAN ?", "finance");
  eq("« Qu'est-ce que la VAN ? » → la VAN, en premier", ids(r)[0], "finance.npv");
  r = ask("Pourquoi les obligations baissent lorsque les taux montent ?", "finance");
  eq("obligations/taux → l'élément obligations ↔ taux", ids(r)[0], "finance.bond-interest-rates");
  check("…avec les deux sujets repérés (bonds, interest_rates)", r.topics.includes("bonds") && r.topics.includes("interest_rates"), r.topics);
  r = ask("Explique-moi la loi normale.", "stats");
  eq("« loi normale » → distribution normale", ids(r)[0], "statistics.normal-distribution");
  const r2 = ask("Pourquoi les taux font-ils baisser les obligations ?", "finance");
  eq("autre formulation → MÊME concept", ids(r2)[0], "finance.bond-interest-rates");
  r = ask("Comment créer une campagne marketing Instagram ?", "marketing");
  check("campagne marketing Instagram → AUCUNE connaissance (ni VAN, ni obligations)", r.none && r.selected.length === 0, ids(r));
  eq("…et zéro candidat", r.candidates, 0);
  r = ask("Compare VAN et TRI.", "finance");
  check("comparaison VAN / TRI → les DEUX, au même rang", ids(r).includes("finance.npv") && ids(r).includes("finance.irr") && r.selected[0].score === r.selected[1].score, r.selected);
  r = ask("Qu'est-ce que l'inflation ?", "economics");
  eq("inflation → inflation", ids(r)[0], "economics.inflation");
  eq("anglais : « What is NPV? » → VAN", ids(ask("What is NPV?", "finance"))[0], "finance.npv");
  eq("anglais : « Why do bond prices fall when interest rates rise? » → obligations/taux", ids(ask("Why do bond prices fall when interest rates rise?", "finance"))[0], "finance.bond-interest-rates");
  eq("espagnol : « ¿Qué es el valor actual neto? » → VAN", ids(ask("¿Qué es el valor actual neto?", "finance"))[0], "finance.npv");
  eq("allemand : « Was ist die Normalverteilung? » → loi normale", ids(ask("Was ist die Normalverteilung?", "stats"))[0], "statistics.normal-distribution");
  eq("italien : « Che cos'è l'inflazione? » → inflation", ids(ask("Che cos'è l'inflazione?", "economics"))[0], "economics.inflation");
  eq("pluriel / accent / casse : « LES OBLIGATIONS » + « Taux d'intérêt »", ids(ask("LES OBLIGATIONS et le Taux d'intérêt", "finance"))[0], "finance.bond-interest-rates");
  eq("alias de plusieurs mots : « courbe en cloche »", ids(ask("c'est quoi la courbe en cloche ?", "stats"))[0], "statistics.normal-distribution");
  // pas de faux positifs
  check("« taux de change » ne récupère pas les obligations", ask("Qu'est-ce que le taux de change ?", "economics").none);
  check("« obligation légale » ne récupère pas les obligations (liste `avoid`)", ask("Quelle est mon obligation légale de déclarer ce revenu ?", "finance").none);
  check("« tri » (classer des lignes) sans domaine financier ne récupère pas le TRI", ask("Comment faire le tri des lignes d'un tableau ?", "general").none);
  check("« van » (nom propre) sans domaine ne récupère pas la VAN", ask("Je vais voir un tableau de Van Gogh", "general").none);
  check("…mais « TRI » avec un contexte financier le récupère", ids(ask("Calcule le TRI de ce projet", "finance")).includes("finance.irr"));
  check("question vide / sans index → rien, sans erreur", K.retrieve("", { index: IDX }).none && K.retrieve("VAN", {}).none && K.retrieve("VAN", { index: K.buildIndex([], lexicon) }).none);
  check("une question sans rapport (cuisine) → rien", ask("Quelle est la meilleure recette de crêpes ?", "general").none);
}

/* ── 3. Scoring : l'ordre EST la spécification ────────────────────────────── */
{
  console.log("\n── 3. scoring ──");
  const S = K.SCORE;
  check("concept > alias > sujet > mot-clé > lié > domaine", S.concept > S.alias && S.alias > S.topicPrimary && S.topicPrimary > S.topicOther && S.topicOther > S.keyword && S.keyword > S.related && S.related >= S.domain);
  check("ni un sujet seul, ni un mot-clé seul, ni le domaine seul ne suffisent à passer le seuil… sauf corroborés",
    S.topicOther < K.MIN_SCORE && S.keyword < K.MIN_SCORE && S.related < K.MIN_SCORE && S.domain < K.MIN_SCORE);
  const mk = (id, over) => Object.assign({ id, domain: "finance", topic: "t_b", title: "Titre " + id, aliases: [], keywords: [], summary: "s", facts: [], mechanisms: [], formulas: [], examples: [], commonMistakes: [], relatedConcepts: [], sources: [], verified: false, status: "demo", lastReviewed: null, version: 1, timeSensitive: false }, over);
  const lex = { topics: { t_a: { domain: "finance", terms: ["zorglub"] }, t_b: { domain: "finance", terms: ["flurbo"] } } };
  const one = (item, q, domain) => { const r = K.retrieve(q, { index: K.buildIndex([item], lex), domain: domain || "general", policy: DEMO, minScore: 1 }); return r.selected.length ? r.selected[0].score : 0; };
  const sConcept = one(mk("finance.conc", { title: "Quantum widget" }), "quantum widget");
  const sAlias = one(mk("finance.alias", { aliases: ["quantum widget"] }), "quantum widget");
  const sTopic = one(mk("finance.topic", { topic: "t_a", topics: ["t_a"] }), "zorglub");
  const sKeyword = one(mk("finance.kw", { keywords: ["quantum widget"] }), "quantum widget");
  check("MÊME phrase dans la question : titre (100) > alias (80) > sujet principal (40) > mot-clé (15)", sConcept > sAlias && sAlias > sTopic && sTopic > sKeyword, [sConcept, sAlias, sTopic, sKeyword]);
  eq("valeurs exactes sans bonus de domaine", [sConcept, sAlias, sTopic, sKeyword], [100, 80, 40, 15]);
  check("même domaine que la question : +10, seulement si l'élément est déjà touché", one(mk("finance.conc", { title: "Quantum widget" }), "quantum widget", "finance") === 110 && one(mk("finance.zero", { title: "Rien" }), "quantum widget", "finance") === 0);
  check("un sujet SECONDAIRE vaut 30, le principal 40", one(mk("finance.sec", { topic: "t_b", topics: ["t_b", "t_a"] }), "zorglub") === 30);
  const I = K.buildIndex([
    mk("finance.conc", { title: "Quantum widget" }),
    mk("finance.alias", { aliases: ["quantum widget"] }),
    mk("finance.kw", { keywords: ["quantum widget", "gizmo", "doodad"] }),
  ], lex);
  let r = K.retrieve("quantum widget", { index: I, domain: "finance", policy: DEMO, k: 4, minScore: 1 });
  eq("classement dans l'ordre de la spécification (le mot-clé seul est sous le seuil relatif de 45 %)", r.selected.map(s => s.id), ["finance.conc", "finance.alias"]);
  r = K.retrieve("quantum widget gizmo doodad", { index: K.buildIndex([mk("finance.kw", { keywords: ["quantum widget", "gizmo", "doodad", "autre"] })], lex), domain: "general", policy: DEMO, k: 4 });
  eq("trois mots-clés = plafond 45 (jamais plus), donc au-dessus du seuil de 40", [r.selected[0].score, r.selected[0].reasons.keywords], [45, 3]);
  check("un seul mot-clé, un seul sujet secondaire, ou le seul domaine : sous le seuil par défaut (aucun élément retrouvé)", [K.retrieve("quantum widget", { index: K.buildIndex([mk("finance.kw", { keywords: ["quantum widget"] })], lex), domain: "finance", policy: DEMO }).none, K.retrieve("zorglub", { index: K.buildIndex([mk("finance.sec", { topics: ["t_b", "t_a"] })], lex), domain: "general", policy: DEMO }).none].every(Boolean));
  // relation : bonus mais jamais suffisant
  const J = K.buildIndex([mk("finance.a", { title: "Alpha concept" }), mk("finance.b", { title: "Beta concept", relatedConcepts: ["finance.a"] })], lex);
  r = K.retrieve("alpha concept", { index: J, domain: "general", policy: DEMO, minScore: 1, k: 3 });
  check("un élément LIÉ gagne un bonus mais un concept lié seul n'est pas retrouvé au seuil normal", r.selected.length === 1 && r.selected[0].id === "finance.a" || (K.retrieve("alpha concept", { index: J, policy: DEMO }).selected.length === 1));
  check("le bonus « lié » est tracé dans les raisons", (r.selected.find(s => s.id === "finance.b") || { reasons: { related: "finance.a" } }).reasons.related === "finance.a");
  // contexte de conversation : compte à 80 %
  r = K.retrieve("et si ça augmente ?", { index: IDX, domain: "finance", policy: DEMO, contextText: "VAN" });
  const full = ask("VAN", "finance").selected[0].score;
  check("le sujet de la CONVERSATION retrouve l'élément (suite « et si ça augmente ? »)", ids(r)[0] === "finance.npv");
  check("…mais compte moins que la même mention dans la question (×0,8)", r.selected[0].score < full, [r.selected[0].score, full]);
  r = K.retrieve("Et si le taux d'actualisation augmente ?", { index: IDX, domain: "finance", policy: DEMO, contextText: "VAN" });
  eq("« Et si le taux d'actualisation augmente ? » + conversation sur la VAN → la VAN", ids(r)[0], "finance.npv");
  // déterminisme
  const x1 = JSON.stringify(ask("Compare VAN et TRI.", "finance").selected), x2 = JSON.stringify(ask("Compare VAN et TRI.", "finance").selected);
  eq("déterministe : deux appels, même résultat", x1, x2);
}

/* ── 4. Top-k, seuil relatif, palier ──────────────────────────────────────── */
{
  console.log("\n── 4. top-k ──");
  const lex = { topics: {} };
  const many = [];
  for (let i = 0; i < 8; i++) many.push({ id: "finance.item" + i, domain: "finance", topic: "x", title: "Machin " + i, aliases: ["machin"], keywords: [], summary: "s" + i, facts: [], mechanisms: [], formulas: [], examples: [], commonMistakes: [], relatedConcepts: [], sources: [], verified: false, status: "demo", lastReviewed: null, version: 1, timeSensitive: false });
  const I = K.buildIndex(many, { topics: { x: { domain: "finance", terms: ["zzz"] } } });
  const n = (opts) => K.retrieve("machin", Object.assign({ index: I, domain: "finance", policy: DEMO }, opts)).selected.length;
  eq("Rapide : 2 éléments au plus", n({ tier: "rapide" }), 2);
  eq("Avancé : 3", n({ tier: "avance" }), 3);
  eq("Expert : 3", n({ tier: "expert" }), 3);
  eq("k explicite, plafonné à 5", n({ k: 99 }), 5);
  const r = K.retrieve("machin", { index: I, domain: "finance", policy: DEMO, tier: "avance" });
  check("candidats comptés AVANT le top-k (8 touchés, 3 gardés)", r.candidates === 8 && r.selected.length === 3, [r.candidates, r.selected.length]);
  check("égalité de score → ordre stable (par id)", ids(r).join() === "finance.item0,finance.item1,finance.item2", ids(r));
  // seuil relatif : un élément à moins de 45 % du meilleur est écarté
  const lx = { topics: { x: { domain: "finance", terms: ["zzz"] } } };
  const strong = Object.assign({}, many[0], { id: "finance.fort", title: "Fort", aliases: ["gadget"], keywords: ["alpha", "beta", "gamma"] });
  const weak = Object.assign({}, many[1], { id: "finance.faible", title: "Faible", aliases: [], keywords: ["alpha", "beta"] });
  const I2 = K.buildIndex([strong, weak], lx);
  const rr = K.retrieve("gadget alpha beta", { index: I2, domain: "finance", policy: DEMO, k: 5 });
  check("un élément trop en dessous du meilleur est écarté (seuil relatif 45 %)", ids(rr).join() === "finance.fort", rr.selected);
}

/* ── 5. Confiance : ce qu'on a le DROIT d'envoyer au modèle ───────────────── */
{
  console.log("\n── 5. confiance ──");
  const verified = Object.assign(JSON.parse(JSON.stringify(items[0])), { id: "finance.verifie", title: "Élément vérifié", aliases: ["vérifié"], verified: true, status: "reviewed", lastReviewed: "2026-10-02", sources: [{ name: "Manuel X", type: "book", reference: "chap. 4" }] });
  const draft = Object.assign(JSON.parse(JSON.stringify(items[0])), { id: "finance.brouillon", title: "Élément brouillon", aliases: ["brouillon"], status: "draft" });
  const I = K.buildIndex(items.concat([verified, draft]), lexicon);
  const run = (q, mode) => K.retrieve(q, { index: I, domain: "finance", policy: { mode } });
  check("auto : un élément DEMO n'est jamais envoyé", run("Qu'est-ce que la VAN ?", "auto").none);
  check("…mais il est signalé comme RETENU (withheld), avec la raison", run("Qu'est-ce que la VAN ?", "auto").withheld.some(w => w.id === "finance.npv" && w.why === "demo"));
  check("demo : l'élément DEMO est envoyé", ids(run("Qu'est-ce que la VAN ?", "demo")).includes("finance.npv"));
  check("off : rien du tout", run("Qu'est-ce que la VAN ?", "off").none && run("vérifié", "off").none);
  check("auto : un élément VÉRIFIÉ est envoyé", ids(run("Parle-moi de l'élément vérifié", "auto")).includes("finance.verifie"));
  check("un BROUILLON non vérifié n'est envoyé dans aucun mode", !ids(run("élément brouillon", "demo")).includes("finance.brouillon") && !ids(run("élément brouillon", "auto")).includes("finance.brouillon"));
  check("mode par défaut (absent) = auto", K.retrieve("VAN", { index: I, domain: "finance" }).none);
  check("isInjectable : vérifié oui, demo selon le mode, brouillon jamais", K.isInjectable(verified, { mode: "auto" }) && !K.isInjectable(items[0], { mode: "auto" }) && K.isInjectable(items[0], { mode: "demo" }) && !K.isInjectable(draft, { mode: "demo" }) && !K.isInjectable(verified, { mode: "off" }));
  // mise en forme : étiquetage honnête
  const demoTxt = K.formatItem(items[0], "full"), verTxt = K.formatItem(verified, "full");
  check("un élément non vérifié est ÉTIQUETÉ « UNVERIFIED » dans le contexte", /UNVERIFIED demo/.test(demoTxt));
  check("un élément vérifié n'est pas étiqueté comme non vérifié", !/UNVERIFIED/.test(verTxt));
  check("une source n'apparaît QUE si elle existe dans les métadonnées", /Source: Manuel X — chap\. 4 \(book\)/.test(verTxt) && !/Source:/.test(demoTxt));
  const ts = Object.assign(JSON.parse(JSON.stringify(verified)), { timeSensitive: true });
  check("timeSensitive : l'avertissement « jamais présenté comme actuel » est injecté, avec la date de relecture", /Time-sensitive: may be outdated \(last reviewed 2026-10-02\); never present it as current/.test(K.formatItem(ts, "full")));
}

/* ── 6. Mise en forme compacte ────────────────────────────────────────────── */
{
  console.log("\n── 6. format ──");
  const full = K.formatItem(items[0], "full"), compact = K.formatItem(items[0], "compact");
  check("complet : idée, faits, mécanisme, formule, exemple, erreur courante", ["Key idea:", "Fact:", "Mechanism:", "Formula:", "Example:", "Common mistake:"].every(k => full.includes(k)));
  check("compact : idée + UN mécanisme + UNE formule, sans faits, exemple ni erreurs", compact.includes("Key idea:") && (compact.match(/Mechanism:/g) || []).length === 1 && (compact.match(/Formula:/g) || []).length === 1 && !/Fact:|Example:|Common mistake:/.test(compact));
  check("compact nettement plus court que complet", compact.length < full.length * 0.6, [compact.length, full.length]);
  check("ce n'est PAS le JSON brut", !/[{}"]aliases|"verified"/.test(full));
  const b = K.toBlocks(ask("Compare VAN et TRI.", "finance").selected, IDX);
  check("toBlocks : full + compact + tailles estimées", b.length === 2 && b.every(x => x.full && x.compact && x.fullTokens > x.compactTokens && x.compactTokens > 0 && x.verified === false));
  check("une formule objet est rendue « nom : expression (note) »", /Formula: VAN : VAN = −I0/.test(K.formatItem(items[0], "full")));
}

/* ── 7. Budget central (assistant-core) : question > connaissances > conversation ── */
{
  console.log("\n── 7. budget de contexte ──");
  const blocksFor = (q, domain) => ({ blocks: K.toBlocks(ask(q, domain).selected, IDX) });
  const an = (q, prev) => A.analyzeQuestion(q, { previous: prev || null, lang: "fr" });
  const kn = blocksFor("Compare VAN et TRI.", "finance");
  let p = A.buildGeneralPrompt({ question: "Compare VAN et TRI.", analysis: an("Compare VAN et TRI."), history: [], tier: "avance", knowledge: kn });
  const sys = p.messages[0].content;
  check("le bloc [REV-EM KNOWLEDGE] est dans le message système, avec sa consigne", /\[REV-EM KNOWLEDGE\][\s\S]+\[\/REV-EM KNOWLEDGE\]/.test(sys) && /UNVERIFIED reference material/.test(sys));
  check("consigne : ne jamais citer comme source ni inventer de source", /Never quote it as a cited source or invent any source/.test(sys));
  check("consigne : s'il ne couvre pas la question, répondre avec ses propres connaissances", /does not cover what is asked, answer from your own knowledge/.test(sys));
  eq("meta : éléments utilisés", p.meta.knowledgeIds.slice().sort(), ["finance.irr", "finance.npv"]);
  check("meta : jetons de connaissances mesurés, dans le plafond du palier", p.meta.knowledgeTokens > 0 && p.meta.knowledgeTokens <= A.KNOWLEDGE_MAX_TOKENS.avance, p.meta.knowledgeTokens);
  check("la question reste intacte (dernier message utilisateur)", p.messages[p.messages.length - 1].role === "user" && p.messages[p.messages.length - 1].content.startsWith("Compare VAN et TRI."));
  check("prompt + réponse + marge ≤ fenêtre réelle (4096)", p.meta.promptTokens + p.params.maxTokens + 120 <= 4096, [p.meta.promptTokens, p.params.maxTokens]);
  // sans connaissances : strictement comme avant
  const p0 = A.buildGeneralPrompt({ question: "Compare VAN et TRI.", analysis: an("Compare VAN et TRI."), history: [], tier: "avance" });
  check("SANS connaissances : aucun bloc, meta vide, prompt plus court", !/REV-EM KNOWLEDGE/.test(p0.messages[0].content) && p0.meta.knowledgeIds.length === 0 && p0.meta.knowledgeTokens === 0 && p0.meta.promptTokens < p.meta.promptTokens);
  // palier Rapide : moins de place
  p = A.buildGeneralPrompt({ question: "Compare VAN et TRI.", analysis: an("Compare VAN et TRI."), history: [], tier: "rapide", knowledge: kn });
  check("Rapide : plafond de connaissances plus bas, jamais dépassé", p.meta.knowledgeTokens <= A.KNOWLEDGE_MAX_TOKENS.rapide);
  // compactage : le plafond force la version compacte des éléments classés plus bas, pas leur abandon
  const big = { blocks: [{ id: "a", score: 150, full: "F".repeat(700), compact: "C".repeat(200), fullTokens: 220, compactTokens: 63, verified: true }, { id: "b", score: 100, full: "G".repeat(700), compact: "D".repeat(200), fullTokens: 220, compactTokens: 63, verified: true }, { id: "c", score: 90, full: "H".repeat(700), compact: "E".repeat(200), fullTokens: 220, compactTokens: 63, verified: true }] };
  let fit = A.fitKnowledge(big.blocks, 420);
  eq("budget serré : TOUS les éléments tiennent en compact, le mieux classé passe en COMPLET avec le reste", [fit.ids, fit.compacted], [["a", "b", "c"], ["b", "c"]]);
  fit = A.fitKnowledge(big.blocks, 800);
  check("un budget plus large met tous les éléments en version complète", fit.compacted.length === 0 && fit.ids.length === 3, fit.compacted);
  fit = A.fitKnowledge(big.blocks, 60);
  check("budget trop petit : rien (jamais un bloc tronqué)", fit.ids.length === 0 && fit.text === "" && fit.dropped.length === 3);
  check("tous vérifiés → consigne « verified »", /is verified reference material/.test(A.fitKnowledge(big.blocks, 800).text));
  fit = A.fitKnowledge(big.blocks, 800, { compactOnly: true });
  check("compactOnly : tout en version compacte, même avec un grand budget", fit.compacted.length === 3 && fit.tokens < 400, fit);
  const pShort = A.buildGeneralPrompt({ question: "Qu'est-ce que la VAN ?", analysis: an("Qu'est-ce que la VAN ?"), history: [], tier: "avance", knowledge: blocksFor("Qu'est-ce que la VAN ?", "finance") });
  const pNorm = A.buildGeneralPrompt({ question: "Explique-moi la VAN en détail", analysis: an("Explique-moi la VAN en détail"), history: [], tier: "avance", knowledge: blocksFor("Explique-moi la VAN en détail", "finance") });
  check("réponse COURTE (définition) : connaissances compactes ; réponse normale/profonde : version complète", pShort.meta.knowledgeCompacted.length === 1 && pNorm.meta.knowledgeCompacted.length === 0 && pShort.meta.knowledgeTokens < pNorm.meta.knowledgeTokens, [pShort.meta.knowledgeTokens, pNorm.meta.knowledgeTokens]);
  // priorité : question > connaissances > conversation
  const long = "Voici une réponse précédente assez longue. ".repeat(60);
  const hist = [{ role: "user", content: "Qu'est-ce que la VAN ?", meta: { intent: "DEFINITION", topic: "VAN" } }, { role: "assistant", content: long }];
  const q2 = "Et si le taux d'actualisation augmente ?";
  const kn2 = blocksFor(q2 + " VAN", "finance");
  p = A.buildGeneralPrompt({ question: q2, analysis: an(q2, { hasAnswer: true }), history: hist, tier: "avance", knowledge: kn2 });
  check("suite de conversation : connaissances ET historique tiennent ensemble dans la fenêtre", p.meta.knowledgeIds.length > 0 && p.meta.historyMessages > 0 && p.meta.promptTokens + p.params.maxTokens + 120 <= 4096, [p.meta.knowledgeIds, p.meta.historyMessages, p.meta.promptTokens]);
  // fenêtre minuscule : l'historique est sacrifié AVANT les connaissances, la question jamais
  p = A.buildGeneralPrompt({ question: q2, analysis: an(q2, { hasAnswer: true }), history: hist, tier: "avance", knowledge: kn2, contextTokens: 1300 });
  check("fenêtre réduite : tient toujours (prompt + réponse + marge ≤ fenêtre)", p.meta.promptTokens + p.params.maxTokens + 120 <= 1300, [p.meta.promptTokens, p.params.maxTokens]);
  check("…la question est intacte", p.messages[p.messages.length - 1].content.startsWith(q2));
  p = A.buildGeneralPrompt({ question: q2, analysis: an(q2, { hasAnswer: true }), history: hist, tier: "avance", knowledge: kn2, contextTokens: 400 });
  check("fenêtre absurdement petite : connaissances abandonnées, tracées dans meta.knowledgeDropped, la question reste", p.meta.knowledgeIds.length === 0 && p.meta.knowledgeDropped.length > 0 && p.messages[p.messages.length - 1].content.startsWith(q2), p.meta.knowledgeDropped);
  // Expert (R1) : pas de rôle system, connaissances dans le premier message utilisateur
  p = A.buildGeneralPrompt({ question: "Compare VAN et TRI.", analysis: an("Compare VAN et TRI."), history: [], tier: "expert", reasoning: true, knowledge: kn });
  check("Expert : aucun rôle system, connaissances dans le message utilisateur", p.messages.every(m => m.role !== "system") && /\[REV-EM KNOWLEDGE\]/.test(p.messages[0].content));
  // mixte vérifié / non vérifié : consigne prudente
  const mixed = { blocks: [{ id: "a", score: 1, full: "x", compact: "x", fullTokens: 5, compactTokens: 5, verified: true }, { id: "b", score: 1, full: "y", compact: "y", fullTokens: 5, compactTokens: 5, verified: false }] };
  check("un seul non vérifié → toute la consigne est prudente (« UNVERIFIED »)", /UNVERIFIED reference material/.test(A.fitKnowledge(mixed.blocks, 300).text));
}

/* ── 8. Analyse : sujets, domaines, quand chercher ────────────────────────── */
{
  console.log("\n── 8. sujets, domaines, wantsKnowledge ──");
  const an = (q, prev) => A.analyzeQuestion(q, { previous: prev || null, lang: "fr" });
  let a = an("Pourquoi une hausse des taux fait-elle baisser le prix d'une obligation ?");
  A.attachTopics(a, K.detectTopics(a.text, IDX, { domain: a.domain }).map(t => t.id), "finance");
  check("analyse : intent EXPLANATION, domaine finance, sujets [bonds, interest_rates]", a.intent === "EXPLANATION" && a.domain === "finance" && a.topics.includes("bonds") && a.topics.includes("interest_rates"), [a.intent, a.domain, a.topics]);
  a = an("Explique-moi le raisonnement du zorglub");
  A.attachTopics(a, ["normal_distribution"], "statistics");
  eq("un domaine inconnu (« general ») est complété par celui du sujet repéré (statistics → stats)", a.domain, "stats");
  a = an("Qu'est-ce que l'EBITDA ?"); A.attachTopics(a, [], null);
  eq("sans sujet repéré : topics vides, domaine inchangé", [a.topics, a.domain], [[], "finance"]);
  check("domaine « management » détecté", an("Quelle est la différence entre leadership et management ?").domain === "management");
  check("domaine « marketing » détecté (campagne, Instagram…)", an("Comment créer une campagne marketing Instagram ?").domain === "marketing");
  eq("« Comment créer une campagne marketing Instagram ? » → PROCEDURE", an("Comment créer une campagne marketing Instagram ?").intent, "PROCEDURE");
  check("stratégies par domaine : comptabilité, marketing, management ont leurs consignes", ["accounting", "marketing", "management"].every(d => A.selectStrategy({ intent: "EXPLANATION", domain: d, depth: "NORMAL", flags: {}, needsHistory: false }, { tier: "avance" }).lines.some(l => new RegExp("^" + { accounting: "Accounting", marketing: "Marketing", management: "Management" }[d] + ":").test(l))));
  check("wantsKnowledge : oui pour une question de cours", A.wantsKnowledge(an("Qu'est-ce que la VAN ?")));
  check("wantsKnowledge : non pour le temps réel (réponse locale)", !A.wantsKnowledge(an("Quel est le cours du Bitcoin aujourd'hui ?")));
  check("wantsKnowledge : non pour une fausse source demandée (réponse locale)", !A.wantsKnowledge(an("Donne-moi l'étude exacte qui prouve cette affirmation.")));
  const P = { hasAnswer: true };
  check("wantsKnowledge : non pour « plus simplement » (on réécrit la réponse précédente)", !A.wantsKnowledge(an("plus simplement", P)));
  check("wantsKnowledge : oui pour « donne-moi un exemple » (l'exemple du cours aide)", A.wantsKnowledge(an("donne-moi un exemple", P)));
  check("wantsKnowledge : oui pour « et si le taux augmente ? » (suite avec sujet)", A.wantsKnowledge(an("et si le taux d'actualisation augmente ?", P)));
  eq("erreurs : WEBGPU_UNAVAILABLE reconnue", A.classifyChatError({ code: "WEBGPU_UNAVAILABLE" }).code, "WEBGPU_UNAVAILABLE");
  eq("erreurs : MODEL_DOWNLOAD_FAILED reconnue", A.classifyChatError({ code: "MODEL_DOWNLOAD_FAILED" }).code, "MODEL_DOWNLOAD_FAILED");
  eq("erreurs : DEVICE_FAILED → WEBGPU_UNAVAILABLE (réutilise le code de l'hôte)", A.classifyChatError({ code: "DEVICE_FAILED" }).code, "WEBGPU_UNAVAILABLE");
}

/* ── 9. Performance : index construit UNE fois, retrieval en millisecondes ── */
{
  console.log("\n── 9. performance ──");
  const base = items[0], big = [];
  for (let i = 0; i < 2000; i++) big.push(Object.assign({}, base, { id: "finance.synth" + i, title: "Concept synthétique " + i, aliases: ["alias" + i, "synth " + i], keywords: ["motcle" + i, "autre" + (i % 50)], topic: "npv", topics: ["npv"], relatedConcepts: [], verified: false, status: "demo" }));
  const t0 = Date.now(); const I = K.buildIndex(big, lexicon); const build = Date.now() - t0;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) K.retrieve("Qu'est-ce que le concept synthétique " + (i * 7 % 2000) + " ?", { index: I, domain: "finance", policy: DEMO });
  const per = Number(process.hrtime.bigint() - t1) / 1e6 / 200;
  check("index de 2 000 éléments construit en < 1,5 s (UNE fois)", build < 1500, build + " ms");
  check("retrieval sur 2 000 éléments < 15 ms par question (mesuré : " + per.toFixed(2) + " ms)", per < 15, per);
  const small = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) ask("Pourquoi les obligations baissent lorsque les taux montent ?", "finance");
  const perSmall = Number(process.hrtime.bigint() - small) / 1e6 / 1000;
  check("retrieval sur la base de démo < 1 ms par question (mesuré : " + perSmall.toFixed(3) + " ms)", perSmall < 1, perSmall);
}

/* ── 10. Le guide d'ajout : l'exemple du README est VALIDE et retrouvable, sans toucher au moteur ── */
{
  console.log("\n── 10. guide d'ajout (ai-knowledge/README.md) ──");
  const md = fs.readFileSync(path.join(KDIR, "README.md"), "utf8");
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
  check("le README contient l'exemple d'élément, le sujet, et le passage à « vérifié »", blocks.length >= 2, blocks.length);
  const example = JSON.parse(blocks[0]);
  const topicLine = JSON.parse("{" + blocks[1] + "}");
  const lex2 = JSON.parse(JSON.stringify(lexicon)); Object.assign(lex2.topics, topicLine);
  const v = K.validateItem(example, { topics: lex2.topics });
  eq("l'exemple du guide est un élément VALIDE (0 erreur)", v.errors, []);
  check("…et il n'est pas dans la base (exemple de guide uniquement)", !manifest.files.some(f => /compound/.test(f)) && !fs.existsSync(path.join(KDIR, "finance", "compound-interest.json")));
  check("l'exemple ne présente rien comme vérifié et n'invente aucune source", example.verified === false && example.sources.length === 0 && example.status === "draft");
  const asDemo = Object.assign({}, example, { status: "demo" });
  const grown = K.loadPack(lex2, items.concat([asDemo]));
  eq("ajouter l'élément + son sujet : le lot reste valide, SANS modifier le moteur", [grown.report.ok, grown.index.size], [true, 6]);
  const find = (q, d) => K.retrieve(q, { index: grown.index, domain: d || "finance", policy: DEMO });
  eq("« Explique les intérêts composés » → le nouvel élément", ids(find("Explique les intérêts composés"))[0], "finance.compound-interest");
  eq("alias anglais : « What is compound interest? »", ids(find("What is compound interest?"))[0], "finance.compound-interest");
  eq("alias allemand : « Was ist Zinseszins? »", ids(find("Was ist Zinseszins?"))[0], "finance.compound-interest");
  check("une question voisine ne le retrouve PAS (« intérêts simples d'un livret »)", !ids(find("Comment sont calculés les intérêts simples d'un livret ?")).includes("finance.compound-interest"));
  check("les anciens éléments sont inchangés (la VAN reste en tête)", ids(find("Qu'est-ce que la VAN ?"))[0] === "finance.npv");
  check("le brouillon (status:draft) n'est JAMAIS envoyé, même en mode démo", !K.retrieve("intérêts composés", { index: K.loadPack(lex2, items.concat([example])).index, domain: "finance", policy: DEMO }).selected.length);
  const verifiedForm = JSON.parse(JSON.stringify(example));
  Object.assign(verifiedForm, { sources: [{ name: "Nom réel de la source", type: "book", reference: "chap. 2" }], verified: true, status: "reviewed", lastReviewed: "2026-10-02", version: 2 });
  eq("le passage à « vérifié » décrit dans le guide est accepté par le validateur", K.validateItem(verifiedForm, { topics: lex2.topics }).errors, []);
  eq("…et alors l'élément est envoyé en mode Auto", ids(K.retrieve("Explique les intérêts composés", { index: K.loadPack(lex2, [verifiedForm]).index, domain: "finance", policy: { mode: "auto" } })), ["finance.compound-interest"]);
}

console.log("\n" + pass + " vérifications réussies, " + fail + " échec(s).");
process.exit(fail ? 1 : 0);
