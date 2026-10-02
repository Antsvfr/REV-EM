/* Moteur pur de la banque de révision — sous Node, sans navigateur.
   Lancer :  node tests/revision-bank.test.js */
require("../revision-bank.js");
const B = globalThis.RevemBank;

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log("PASS — " + name); }
  else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const deepFreeze = (o) => { Object.freeze(o); Object.values(o).forEach(v => { if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v); }); return o; };

/* Une banque synthétique : 5 concepts × 4 questions, difficultés mélangées. */
const CONCEPTS = ["Croissance", "Révolution industrielle", "Productivité", "Technologie", "Niveau de vie"];
const DIFFS = ["easy", "medium", "hard", "medium"];
function makeBank(n = 20) {
  return Array.from({ length: n }, (_, i) => ({
    uid: "q" + i, id: "q" + i, q: "Question numéro " + i + " sur le concept ?", ai: true, theme: "ai",
    opts: ["Réponse A" + i, "Réponse B" + i, "Réponse C" + i, "Réponse D" + i], correct: i % 4, exp: "",
    concept: CONCEPTS[i % 5], difficulty: DIFFS[i % 4], section: i % 5,
  }));
}
const correctText = (q) => q.opts[q.correct];

/* ── 1. Fisher-Yates ──────────────────────────────────────────────────────── */
{
  const src = Object.freeze([1, 2, 3, 4, 5, 6]);
  const out = B.shuffleArray(src);
  eq("shuffleArray : mêmes éléments", out.slice().sort(), [1, 2, 3, 4, 5, 6]);
  eq("shuffleArray ne modifie pas son entrée", src.slice(), [1, 2, 3, 4, 5, 6]);
  check("shuffleArray renvoie une COPIE", out !== src);
  eq("tableau vide / à un élément", [B.shuffleArray([]), B.shuffleArray([7])], [[], [7]]);
  // Uniformité : sur 6 000 tirages de 3 éléments, chacune des 6 permutations ≈ 1 000 (χ² large).
  const rng = B.seededRng(12345), counts = {};
  for (let i = 0; i < 6000; i++) { const k = B.shuffleArray([0, 1, 2], rng).join(""); counts[k] = (counts[k] || 0) + 1; }
  const vals = Object.values(counts);
  check("6 permutations toutes atteintes", vals.length === 6, counts);
  check("répartition uniforme (aucune permutation < 850 ni > 1150)", vals.every(v => v > 850 && v < 1150), counts);
  eq("même graine → même résultat (reproductible)", B.shuffleArray([1, 2, 3, 4, 5], B.seededRng(7)), B.shuffleArray([1, 2, 3, 4, 5], B.seededRng(7)));
  check("le rng par défaut fonctionne sans crypto ni graine", B.shuffleArray([1, 2, 3]).length === 3);
}

/* ── 2. Mélange des choix : la bonne réponse reste la bonne ───────────────── */
{
  const q = makeBank(1)[0];
  const frozen = deepFreeze(JSON.parse(JSON.stringify(q)));
  let okAll = true, positions = new Set(), distinctOrders = new Set();
  const rng = B.seededRng(99);
  for (let i = 0; i < 600; i++) {
    const s = B.shuffleChoices(frozen, rng);
    if (correctText(s) !== correctText(frozen)) okAll = false;
    if (s.opts.slice().sort().join("|") !== frozen.opts.slice().sort().join("|")) okAll = false;
    if (s.perm.map(p => frozen.opts[p]).join("|") !== s.opts.join("|")) okAll = false;
    positions.add(s.correct); distinctOrders.add(s.opts.join("|"));
  }
  check("600 mélanges : la bonne réponse désigne TOUJOURS le même texte", okAll);
  eq("la bonne réponse apparaît à chaque position (pas de motif « toujours B »)", [...positions].sort(), [0, 1, 2, 3]);
  check("les 24 ordres possibles apparaissent", distinctOrders.size === 24, distinctOrders.size);
  check("la question d'origine est intacte (objet gelé, aucune exception)", frozen.correct === 0 && frozen.opts[0] === "Réponse A0");
  // Vrai/Faux : ordre naturel conservé ; options positionnelles : non mélangées.
  const tf = B.shuffleChoices({ q: "Affirmation ?", opts: ["Vrai", "Faux"], correct: 1 }, B.seededRng(1));
  eq("Vrai/Faux garde son ordre", [tf.opts, tf.correct], [["Vrai", "Faux"], 1]);
  const pos = B.shuffleChoices({ q: "Q ?", opts: ["x", "y", "z", "Toutes les réponses ci-dessus"], correct: 3 }, B.seededRng(1));
  eq("choix positionnel : ordre figé, bonne réponse intacte", [pos.opts[3], pos.correct, pos.choicesShuffled], ["Toutes les réponses ci-dessus", 3, false]);
}

/* ── 3. Session de quiz ───────────────────────────────────────────────────── */
{
  const bank = deepFreeze(makeBank(20));
  const snap = JSON.stringify(bank);
  const a = B.buildQuizSession(bank, { rng: B.seededRng(1) });
  const b = B.buildQuizSession(bank, { rng: B.seededRng(2), lastIds: a.questionIds, lastOrder: a.questionIds });
  eq("taille par défaut = Révision express existante (10)", a.size, 10);
  check("l'identifiant de session est unique", a.sessionId !== b.sessionId);
  check("deux sessions : ordre différent", a.questionIds.join() !== b.questionIds.join());
  const inter = a.questionIds.filter(id => b.questionIds.includes(id));
  eq("la session B reprend d'abord des questions ABSENTES de A (banque de 20, sessions de 10 → ensembles disjoints)", inter, []);
  check("choix mélangés : au moins une question a un ordre de choix différent de la banque", a.items.some(q => q.perm.join() !== "0,1,2,3"));
  check("bonne réponse intacte pour chaque question de la session", a.items.every(q => { const o = bank.find(x => x.id === q.id); return q.opts[q.correct] === o.opts[o.correct]; }));
  eq("la banque n'a pas bougé (aucun effet de bord)", JSON.stringify(bank), snap);
  eq("les items de session sont des COPIES", a.items.some(q => bank.includes(q)), false);

  // Couverture : 5 concepts, 5 questions → un concept chacun, à chaque session.
  let allCovered = true;
  for (let s = 1; s <= 40; s++) {
    const f = B.buildQuizSession(bank, { size: 5, rng: B.seededRng(s) });
    if (new Set(f.items.map(q => q.concept)).size !== 5) allCovered = false;
  }
  check("40 sessions de 5 questions : les 5 concepts sont TOUJOURS couverts", allCovered);
  // Sessions de 10 : jamais plus de 2 par concept (aucune session « tout sur la technologie »).
  let balanced = true;
  for (let s = 1; s <= 40; s++) {
    const c = {}; B.buildQuizSession(bank, { rng: B.seededRng(s) }).items.forEach(q => c[q.concept] = (c[q.concept] || 0) + 1);
    if (Math.max(...Object.values(c)) > 2) balanced = false;
  }
  check("40 sessions de 10 : au plus 2 questions par concept", balanced);
  // Difficulté : pas de session mono-niveau.
  let mixed = true;
  for (let s = 1; s <= 40; s++) if (new Set(B.buildQuizSession(bank, { size: 6, rng: B.seededRng(s) }).items.map(q => q.difficulty)).size < 2) mixed = false;
  check("40 sessions de 6 : difficultés toujours mélangées", mixed);
  // Variété : sur 30 sessions enchaînées (chacune connaît la précédente), jamais la même.
  let last = null, lastOrder = null, identical = 0, setsEqual = 0;
  const rng = B.seededRng(2024);
  for (let i = 0; i < 30; i++) {
    const s = B.buildQuizSession(bank, { rng, lastIds: last, lastOrder });
    if (lastOrder && s.questionIds.join() === lastOrder.join()) identical++;
    if (last && [...s.questionIds].sort().join() === [...last].sort().join()) setsEqual++;
    last = s.questionIds; lastOrder = s.questionIds;
  }
  eq("30 sessions enchaînées : jamais deux sessions identiques", identical, 0);
  eq("… ni le même ensemble de questions (banque de 20, sessions de 10)", setsEqual, 0);
}

/* ── 4. Banque petite ou vide ─────────────────────────────────────────────── */
{
  const small = makeBank(4);
  const a = B.buildQuizSession(small, { rng: B.seededRng(3) });
  eq("banque de 4 : session de 4, pas d'exception", a.size, 4);
  let diffOrder = false, prev = a.questionIds.join();
  for (let s = 10; s < 30; s++) { const x = B.buildQuizSession(small, { rng: B.seededRng(s), lastIds: a.questionIds, lastOrder: a.questionIds }); if (x.questionIds.join() !== prev) diffOrder = true; if (x.questionIds.join() === a.questionIds.join()) { diffOrder = false; break; } }
  check("banque de 4 : l'ordre change quand même d'une session à l'autre", diffOrder);
  eq("banque d'1 question : fonctionne", B.buildQuizSession(makeBank(1), {}).size, 1);
  eq("banque vide : session vide, sans exception", B.buildQuizSession([], {}).size, 0);
  eq("banque absente : session vide", B.buildQuizSession(null, {}).size, 0);
  eq("questions inexploitables ignorées", B.buildQuizSession([{ q: "x" }, { q: "y", opts: ["a"], correct: 0 }, makeBank(1)[0]], {}).size, 1);
  eq("mode flash court", B.buildQuizSession(makeBank(20), { kind: "flash" }).size, 5);
  eq("session de 5 sur une banque de 3 → 3", B.buildQuizSession(makeBank(3), { kind: "flash" }).size, 3);
}

/* ── 5. Flashcards ────────────────────────────────────────────────────────── */
{
  const cards = Array.from({ length: 18 }, (_, i) => ({ id: "f" + i, front: "Qu'est-ce que la notion " + i + " ?", back: "Définition détaillée de la notion numéro " + i + ", en une phrase.", concept: CONCEPTS[i % 5], section: i % 5 }));
  const frozen = deepFreeze(JSON.parse(JSON.stringify(cards)));
  const a = B.buildFlashSession(frozen, { rng: B.seededRng(1) });
  const b = B.buildFlashSession(frozen, { rng: B.seededRng(2), lastIds: a.questionIds, lastOrder: a.questionIds });
  eq("paquet de 18 → tirage de 15", a.size, 15);
  check("session A ≠ session B (ordre)", a.questionIds.join() !== b.questionIds.join());
  const fresh = b.questionIds.filter(id => !a.questionIds.includes(id));
  eq("B reprend d'abord les 3 cartes absentes de A", fresh.length, 3);
  check("la banque de cartes n'est pas modifiée (objet gelé)", frozen.length === 18 && frozen[0].front === "Qu'est-ce que la notion 0 ?");
  eq("petit paquet (6) : toutes les cartes", B.buildFlashSession(cards.slice(0, 6), {}).size, 6);
  // « Recommencer » : un NOUVEL ordre à chaque fois.
  const small = cards.slice(0, 8);
  let first = B.buildFlashSession(small, { rng: B.seededRng(5) }), repeats = 0, prev = first;
  for (let s = 6; s < 36; s++) { const n = B.buildFlashSession(small, { rng: B.seededRng(s), lastIds: prev.questionIds, lastOrder: prev.questionIds }); if (n.questionIds.join() === prev.questionIds.join()) repeats++; prev = n; }
  eq("30 « Recommencer » : jamais le même ordre que juste avant", repeats, 0);
  // Inversion : seulement les cartes inversibles, jamais toutes.
  const mix = cards.slice(0, 10).concat([{ id: "fx", front: "La VAN est-elle toujours positive ?", back: "Non, elle peut être négative.", concept: "x" }, { id: "fy", front: "Citer les 4 P du marketing", back: "Produit, prix, place, promotion — 4 éléments.", concept: "y" }]);
  const sessions = Array.from({ length: 200 }, (_, i) => B.buildFlashSession(mix, { rng: B.seededRng(i + 1), size: 12 }));
  const all = sessions.flatMap(s => s.items);
  const rev = all.filter(c => c.reversed);
  check("des cartes sont retournées (≈ 30 % des inversibles)", rev.length > 100 && rev.length < 900, rev.length);
  check("jamais une carte non inversible", rev.every(c => /^f\d$/.test(c.id)), rev.filter(c => !/^f\d$/.test(c.id)).map(c => c.id));
  const some = rev[0];
  check("une carte retournée : recto = définition, verso = le terme", /Définition détaillée/.test(some.front) && /^Notion \d$/.test(some.back), some);
  check("les cartes non retournées gardent recto/verso d'origine", all.filter(c => !c.reversed).every(c => /^(Qu'est|La VAN|Citer)/.test(c.front)));
  eq("reverseRate 0 désactive l'inversion", B.buildFlashSession(mix, { reverseRate: 0 }).items.some(c => c.reversed), false);
  eq("deriveReversible : « Qu'est-ce que la VAN ? »", B.deriveReversible({ front: "Qu'est-ce que la VAN ?", back: "Valeur actuelle des flux futurs moins l'investissement initial." }), { ok: true, term: "VAN" });
  eq("deriveReversible : oui/non → non", B.deriveReversible({ front: "Est-ce vrai ?", back: "Oui, dans tous les cas observés." }).ok, false);
  eq("deriveReversible : le verso contient le terme → non", B.deriveReversible({ front: "Qu'est-ce que la VAN ?", back: "La VAN est la valeur actuelle nette des flux." }).ok, false);
  eq("deriveReversible : terme court seul", B.deriveReversible({ front: "Effet de levier", back: "Utilisation de la dette pour augmenter la rentabilité des fonds propres." }), { ok: true, term: "Effet de levier" });
}

/* ── 6. Qualité des questions ─────────────────────────────────────────────── */
{
  const ctx = { courseId: "c1", chapterId: "c1", subjectId: "s1" };
  const good = { q: "Quelle est la fonction principale d'une étude de marché ?", opts: ["Soutenir la décision commerciale", "Fixer le salaire des employés", "Calculer l'impôt dû", "Choisir un fournisseur de bureau"], correct: 0, concept: "Étude de marché", type: "definition", difficulty: "Facile" };
  const n = B.normalizeQuestion(good, ctx);
  check("question valide acceptée", B.validateQuestion(n).ok, B.validateQuestion(n));
  eq("normalisation : type, difficulté, concept, rattachement", [n.type, n.difficulty, n.concept, n.chapterId, n.courseId, n.subjectId], ["definition", "easy", "Étude de marché", "c1", "c1", "s1"]);
  check("identifiant stable (même question → même id, en sens et en cours)", n.id === B.normalizeQuestion(good, ctx).id && n.id !== B.normalizeQuestion(good, { courseId: "c2" }).id);
  check("champs historiques conservés (uid, ai, theme)", n.uid === n.id && n.ai === true && n.theme === "ai");
  const bad = (over) => B.validateQuestion(B.normalizeQuestion(Object.assign({}, good, over), ctx)).reasons;
  check("« toutes les réponses ci-dessus » rejeté", bad({ opts: ["a une", "b deux", "c trois", "Toutes les réponses ci-dessus"] }).includes("choix-dependant-de-la-position"));
  check("« A et B » rejeté", bad({ opts: ["a une", "b deux", "A et B", "d quatre"] }).includes("choix-dependant-de-la-position"));
  check("choix en double rejetés", bad({ opts: ["Même", "même", "Autre", "Encore"] }).includes("choix-en-double"));
  check("bonne réponse contenue dans la question rejetée", bad({ q: "Soutenir la décision commerciale est la fonction de quoi exactement ?" }).includes("reponse-dans-la-question"));
  check("bonne réponse trop longue (indice par la longueur) rejetée", bad({ opts: ["Une réponse très longue qui détaille tout le mécanisme en question pour se démarquer", "Non", "Peut-être", "Jamais"] }).includes("bonne-reponse-trop-longue"));
  check("question trop courte rejetée", bad({ q: "Quoi ?" }).includes("question-trop-courte"));
  eq("format invalide → null", [B.normalizeQuestion(null, ctx), B.normalizeQuestion({ q: "x" }, ctx), B.normalizeQuestion({ q: "Question valable ?", opts: ["a", "b"], correct: "0" }, ctx)], [null, null, null]);
  eq("HTML retiré des textes de l'IA", B.normalizeQuestion(Object.assign({}, good, { q: "Quelle <img src=x onerror=alert(1)> fonction principale ?" }), ctx).q.includes("<"), false);
  const batch = B.parseQuizBatch([good, good, Object.assign({}, good, { q: "Quelle est la fonction principale de l'étude de marché ?" }), Object.assign({}, good, { q: "Autre sujet : définir la segmentation d'un marché ?", opts: ["Découper un marché en groupes homogènes", "Doubler les prix", "Réduire les stocks", "Embaucher plus"] })], ctx, []);
  eq("lot : doublon exact ET quasi-doublon écartés", batch.items.length, 2);
  eq("parseQuizBatch tolère une réponse qui n'est pas un tableau", B.parseQuizBatch({ nope: 1 }, ctx, []).items, []);
  // QCM Vrai/Faux accepté
  const tf = B.normalizeQuestion({ q: "Une étude qualitative produit uniquement des chiffres.", opts: ["Vrai", "Faux"], correct: 1 }, ctx);
  check("Vrai/Faux typé et accepté", tf.type === "vrai_faux" && B.validateQuestion(tf).ok);
}

/* ── 7. Cartes : qualité ─────────────────────────────────────────────────── */
{
  const ctx = { courseId: "c1", chapterId: "c1" };
  const r = B.parseCardBatch([{ front: "Qu'est-ce que le BFR ?", back: "Le besoin de financement du cycle d'exploitation." }, { front: "Qu'est-ce que le BFR ?", back: "Doublon" }, { front: "x", back: "y" }, { front: "Pareil", back: "pareil" }], ctx, []);
  eq("cartes : doublons et cartes vides écartés", r.items.map(c => c.front), ["Qu'est-ce que le BFR ?"]);
  check("la carte porte son rattachement et un id stable", r.items[0].chapterId === "c1" && /^f_/.test(r.items[0].id));
  eq("reversible calculé et stocké sur la carte", [r.items[0].reversible, r.items[0].revTerm], [true, "BFR"]);
}

/* ── 8. Taille de la banque, plan, découpage, fusion ──────────────────────── */
{
  eq("cours très court : petite banque", B.bankTargets(500), { quiz: 6, flashcards: 6 });
  eq("cours moyen", B.bankTargets(3000), { quiz: 10, flashcards: 10 });
  eq("cours long", B.bankTargets(20000), { quiz: 22, flashcards: 22 });
  check("jamais 50 questions", B.bankTargets(1e7).quiz <= 28);
  eq("plan : 6 questions → un seul lot", B.batchPlan("quiz", 6, 0).map(p => p.count), [6]);
  eq("plan : 22 questions → 3 lots équilibrés", B.batchPlan("quiz", 22, 0).map(p => p.count), [8, 7, 7]);
  eq("plan : rien à faire quand la banque est complète", B.batchPlan("quiz", 10, 12), []);
  check("plan : jamais plus de MAX_BATCHES lots", B.batchPlan("quiz", 500, 0).length <= B.MAX_BATCHES);
  check("plan : chaque lot a une tranche et un accent de types", B.batchPlan("quiz", 22, 0).every(p => p.focus.length >= 2 && p.slice >= 0));
  const long = Array.from({ length: 12 }, (_, i) => "Paragraphe " + i + " " + "mot ".repeat(400)).join("\n\n");
  const parts = B.sliceSource(long, 3, 7000);
  eq("découpage : 3 tranches", parts.length, 3);
  check("découpage : chaque tranche couvre une partie DIFFÉRENTE du cours", parts[0] !== parts[1] && parts[1] !== parts[2] && /Paragraphe 0/.test(parts[0]) && /Paragraphe 11/.test(parts[2]), parts.map(p => p.slice(0, 14)));
  check("découpage : bornée au budget de contexte", parts.every(p => p.length <= 7000));
  eq("texte court : une seule tranche", B.sliceSource("court", 3, 7000), ["court"]);
  const m = B.mergeBank([{ id: "a", q: "Première question sur la notion ?" }], [{ id: "a", q: "Première question sur la notion ?" }, { id: "b", q: "Deuxième question sur autre chose ?" }]);
  eq("fusion : l'existant reste en tête, aucun doublon", m.map(x => x.id), ["a", "b"]);
  eq("fusion : plafonnée", B.mergeBank(Array.from({ length: 59 }, (_, i) => ({ id: "x" + i, q: "Question distincte numéro " + i + " unique" + "z".repeat(i) })), Array.from({ length: 10 }, (_, i) => ({ id: "n" + i, q: "Nouveauté radicalement différente " + String.fromCharCode(97 + i).repeat(5) }))).length, B.BANK_MAX);
  check("besoin d'enrichissement : banque trop petite", B.needsEnrichment(2, 10) && !B.needsEnrichment(9, 10));
}

/* ── 9. Cours modifié ────────────────────────────────────────────────────── */
{
  const text = "Le marketing est l'ensemble des méthodes. ".repeat(50);
  const sig = B.contentSignature(text);
  const items = [{ id: "a", srcHash: sig.hash, srcLen: sig.len }];
  eq("même texte : pas obsolète", B.isStale(items, text), false);
  eq("retouche mineure (faute corrigée) : pas obsolète", B.isStale(items, text.replace("marketing", "marketing,")), false);
  eq("texte très différent : obsolète", B.isStale(items, text + " Nouveau chapitre entier. ".repeat(40)), true);
  eq("ancienne banque sans empreinte : jamais déclarée obsolète", B.isStale([{ id: "old" }], "autre chose"), false);
  eq("texte source vide : pas de verdict", B.isStale(items, ""), false);
}

/* ── 10. Instructions envoyées au modèle ─────────────────────────────────── */
{
  const p = B.quizBatchInstruction({ count: 8, focus: ["definition", "vrai_faux"], existingStems: ["Déjà posée ?"] });
  check("l'instruction demande la variété, les concepts et la difficulté", /concept/.test(p) && /difficulty/.test(p) && /plausibles/.test(p));
  check("elle interdit « toutes les réponses » / « A et B »", /toutes les réponses ci-dessus/.test(p) && /A et B/.test(p));
  check("elle liste les questions existantes à ne pas refaire", /Déjà posée/.test(p));
  check("elle ne force pas vrai/faux ni calcul", /uniquement si le cours s'y prête/.test(p));
  check("instruction flashcards", /Qu'est-ce que/.test(B.cardBatchInstruction({ count: 5 })));
}

console.log("\n" + pass + " vérifications réussies, " + fail + " échec(s).");
process.exit(fail ? 1 : 0);
