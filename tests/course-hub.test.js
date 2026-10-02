/* ============================================================================
   REV-EM — le moteur pur du Hub de révision (course-hub.js)
   Exécution :  node tests/course-hub.test.js   (aucun navigateur, aucun réseau)
   ============================================================================ */
"use strict";
require("../course-hub.js");
const H = globalThis.RevemHub;

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if(ok){ pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const scenario = (n) => console.log(`\n── ${n} ──`);
const chap = (over) => Object.assign({ id: "ch_1", subjectId: "s_1", content: "", summary: "", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [], originalText: "", hasOriginalFile: false, heuristicMode: false }, over || {});

scenario("Les six destinations");
{
  eq("ordre et clés", H.RESOURCES.map(r => r.key), ["fiche", "summary", "quiz", "quizflash", "flashcards", "questions"]);
  eq("quatre ressources générables, « questions » est une entrée vers l'assistant", [H.GENERABLE, H.meta("questions").generable], [["fiche", "summary", "quiz", "flashcards"], false]);
  eq("champs RÉELS du chapitre", H.RESOURCES.filter(r => r.field).map(r => r.field), ["content", "summary", "aiQuiz", "aiQuiz", "aiFlashcards"]);
  eq("les cinq états", H.STATES, ["NOT_GENERATED", "QUEUED", "GENERATING", "READY", "ERROR"]);
  eq("la file connaît aussi les questions de révision (5ᵉ étape du pipeline)", H.QUEUE_KEYS.includes("reviewQuestions"), true);
}

scenario("Référence stable : courseId === chapterId, jamais le titre");
{
  const ref = H.courseRef(chap({ id: "ch_abc", subjectId: "s_fin", title: "Croissance" }));
  eq("courseId / chapterId / subjectId", ref, { courseId: "ch_abc", chapterId: "ch_abc", subjectId: "s_fin" });
  eq("deux cours de même titre ont deux références distinctes", H.courseRef(chap({ id: "a", title: "X" })).courseId !== H.courseRef(chap({ id: "b", title: "X" })).courseId, true);
  eq("pas d'identifiant → pas de référence (jamais devinée)", H.courseRef({ title: "X" }), null);
  eq("matière absente → null, pas une chaîne inventée", H.courseRef({ id: "a" }).subjectId, null);
}

scenario("État d'une ressource : déduit des données RÉELLES");
{
  const gen = H.newGen();
  const empty = chap();
  H.RESOURCES.filter(r => r.generable).forEach(r => eq(`cours sans rien → ${r.key} NOT_GENERATED`, H.resourceState(empty, gen, r.key).state, "NOT_GENERATED"));
  const full = chap({ content: "fiche", summary: "résumé", aiQuiz: [{}, {}, {}], aiFlashcards: [{}, {}] });
  eq("fiche présente → READY", H.resourceState(full, gen, "fiche").state, "READY");
  eq("résumé présent → READY", H.resourceState(full, gen, "summary").state, "READY");
  eq("quiz : le nombre RÉEL de questions", [H.resourceState(full, gen, "quiz").state, H.resourceState(full, gen, "quiz").count], ["READY", 3]);
  eq("flashcards : le nombre RÉEL de cartes", H.resourceState(full, gen, "flashcards").count, 2);
  eq("un texte d'espaces n'est pas une fiche", H.resourceState(chap({ content: "   \n " }), gen, "fiche").state, "NOT_GENERATED");
  eq("un quiz vide n'est pas prêt", H.resourceState(chap({ aiQuiz: [] }), gen, "quiz").state, "NOT_GENERATED");
  eq("un champ absent (ancien chapitre) ne plante pas", H.resourceState({ id: "old" }, gen, "quiz").state, "NOT_GENERATED");
  eq("« questions » est toujours disponible, même sur un cours vide", H.resourceState(empty, gen, "questions").state, "READY");
  eq("clé inconnue → null", H.resourceState(empty, gen, "inconnue"), null);
  const simple = chap({ content: "f", heuristicMode: true });
  eq("READY produit sans IA : signalé « simplifié »", H.resourceState(simple, gen, "fiche").simplified, true);
  eq("un cours passé par l'IA n'est pas « simplifié »", H.resourceState(full, gen, "fiche").simplified, false);
}

scenario("File séquentielle : un seul travail à la fois, aucun doublon");
{
  const gen = H.newGen(), c = chap();
  eq("on enfile quatre ressources", H.enqueue(gen, "ch_1", ["fiche", "summary", "quiz", "flashcards"]), ["fiche", "summary", "quiz", "flashcards"]);
  eq("tout est QUEUED", H.allStates(c, gen).filter(s => s.state === "QUEUED").map(s => s.key), ["fiche", "summary", "quiz", "quizflash", "flashcards"]);
  const t1 = H.takeNext(gen);
  eq("le premier travail démarre", t1, { chapterId: "ch_1", key: "fiche" });
  eq("il est GENERATING, les autres attendent", [H.resourceState(c, gen, "fiche").state, H.resourceState(c, gen, "summary").state], ["GENERATING", "QUEUED"]);
  eq("UN SEUL travail à la fois : takeNext ne rend rien tant que le premier n'est pas fini", H.takeNext(gen), null);
  eq("double lancement de la même ressource : ignoré (en cours)", H.enqueue(gen, "ch_1", ["fiche"]), []);
  eq("double lancement d'une ressource en attente : ignoré", H.enqueue(gen, "ch_1", ["quiz"]), []);
  eq("la file n'a pas grossi", gen.queue.length, 3);
  H.complete(gen, t1, null);
  eq("après la fin, le suivant peut démarrer dans l'ordre demandé", H.takeNext(gen).key, "summary");
  eq("un travail terminé libère la place", gen.current.key, "summary");
  eq("clés inconnues ignorées", H.enqueue(gen, "ch_1", ["n'importe quoi", "reviewQuestions"]), ["reviewQuestions"]);
  eq("deux fois la même clé dans une demande : une seule", H.enqueue(H.newGen(), "x", ["quiz", "quiz"]), ["quiz"]);
}

scenario("Deux cours : rien ne se mélange");
{
  const gen = H.newGen(), a = chap({ id: "A" }), b = chap({ id: "B" });
  H.enqueue(gen, "A", ["quiz"]); H.enqueue(gen, "B", ["quiz"]);
  H.takeNext(gen);
  eq("A génère, B attend", [H.resourceState(a, gen, "quiz").state, H.resourceState(b, gen, "quiz").state], ["GENERATING", "QUEUED"]);
  eq("aucune contamination : le quiz de A n'est pas celui de B", H.resourceState(chap({ id: "A", aiQuiz: [{}] }), gen, "quiz").count === 1 && H.resourceState(b, gen, "quiz").count === 0, true);
  eq("busyFor par cours", [H.busyFor(gen, "A"), H.busyFor(gen, "B"), H.busyFor(gen, "C")], [true, true, false]);
  eq("le même travail pour un AUTRE cours est accepté", H.enqueue(gen, "C", ["quiz"]), ["quiz"]);
}

scenario("Erreur et réessai");
{
  const gen = H.newGen(), c = chap();
  H.enqueue(gen, "ch_1", ["quiz"]);
  const t = H.takeNext(gen);
  H.complete(gen, t, { code: "GENERATION_FAILED", message: "format inattendu" });
  const s = H.resourceState(c, gen, "quiz");
  eq("l'échec est visible sur la ressource", [s.state, s.error.code], ["ERROR", "GENERATION_FAILED"]);
  eq("la file est libre", H.takeNext(gen), null);
  eq("réessayer : la ressource est enfilée à nouveau", H.enqueue(gen, "ch_1", ["quiz"]), ["quiz"]);
  eq("… et l'ancienne erreur a disparu", H.resourceState(c, gen, "quiz").state, "QUEUED");
  eq("un échec d'une ressource n'affecte pas les autres", H.resourceState(c, gen, "fiche").state, "NOT_GENERATED");
  const ok = chap({ aiQuiz: [{}] });
  eq("des données présentes l'emportent sur une ancienne erreur (READY)", H.resourceState(ok, gen, "quiz").state, "READY");
}

scenario("IA indisponible : tout ce qui attendait échoue proprement");
{
  const gen = H.newGen(), c = chap();
  H.enqueue(gen, "ch_1", ["fiche", "summary", "quiz"]);
  H.enqueue(gen, "AUTRE", ["quiz"]);
  H.failQueuedFor(gen, "ch_1", { code: "AI_UNAVAILABLE", message: "" });
  eq("rien ne reste « en préparation » indéfiniment", H.allStates(c, gen).filter(s => s.state === "QUEUED").length, 0);
  eq("les trois ressources sont en ERROR avec le bon motif", ["fiche", "summary", "quiz"].map(k => H.resourceState(c, gen, k).error.code), ["AI_UNAVAILABLE", "AI_UNAVAILABLE", "AI_UNAVAILABLE"]);
  eq("le cours voisin n'est pas touché", H.isQueued(gen, "AUTRE", "quiz"), true);
  eq("chaque ressource reste réessayable", H.enqueue(gen, "ch_1", ["fiche"]), ["fiche"]);
}

scenario("Quiz Flash, reprise après indisponibilité de l'IA, obsolescence");
{
  const ch = { id: "c", aiQuiz: [{}, {}, {}] };
  const g = H.newGen();
  eq("Quiz Flash est READY dès que la banque de questions existe", H.resourceState(ch, g, "quizflash").state, "READY");
  eq("Quiz Flash dépend du quiz dans la file (QUEUED)", (H.enqueue(g, "d", ["quiz"]), H.resourceState({ id: "d" }, g, "quizflash").state), "QUEUED");
  eq("Quiz Flash n'est PAS une ressource générable à part (aucune seconde génération)", H.GENERABLE.indexOf("quizflash"), -1);
  const g2 = H.newGen(); H.enqueue(g2, "w", ["quiz", "flashcards"]);
  H.failQueuedFor(g2, "w", { code: "AI_UNAVAILABLE" });
  eq("l'IA absente marque le cours « en attente »", [H.hasWaiting(g2), H.resumeKeys(g2, "w")], [true, ["quiz", "flashcards"]]);
  eq("on récupère les cours en attente une seule fois", [H.takeWaiting(g2), H.hasWaiting(g2)], [["w"], false]);
  const g3 = H.newGen(); H.enqueue(g3, "x", ["quiz"]); H.failQueuedFor(g3, "x", { code: "TIMEOUT" });
  eq("un autre échec (timeout) ne déclenche PAS de reprise automatique", [H.hasWaiting(g3), H.resumeKeys(g3, "x")], [false, []]);
  eq("l'enrichissement a ses clés de file", [H.QUEUE_KEYS.indexOf("enrich_quiz") >= 0, H.QUEUE_KEYS.indexOf("enrich_flashcards") >= 0], [true, true]);
  const st = H.resourceState(ch, g, "quiz", { stale: { quiz: true } });
  eq("banque obsolète : READY mais « à actualiser »", [st.state, st.stale, H.statusLabel(st).key], ["READY", true, "hub.state.stale"]);
  eq("libellé Quiz Flash", H.statusLabel(H.resourceState(ch, g, "quizflash")).key, "hub.state.flash_ready");
}

scenario("Libellés : uniquement des faits connus");
{
  const gen = H.newGen();
  const full = chap({ content: "f", summary: "s", aiQuiz: [{}, {}, {}, {}, {}, {}, {}, {}], aiFlashcards: new Array(14).fill({}) });
  eq("quiz prêt → « 8 questions »", H.statusLabel(H.resourceState(full, gen, "quiz")), { key: "hub.state.quiz_n", vars: { n: 8 } });
  eq("flashcards prêtes → « 14 cartes »", H.statusLabel(H.resourceState(full, gen, "flashcards")), { key: "hub.state.cards_n", vars: { n: 14 } });
  eq("fiche prête", H.statusLabel(H.resourceState(full, gen, "fiche")).key, "hub.state.ready_fiche");
  eq("résumé prêt (accord grammatical : une clé par ressource)", H.statusLabel(H.resourceState(full, gen, "summary")).key, "hub.state.ready_summary");
  eq("fiche prête en mode simplifié", H.statusLabel(H.resourceState(Object.assign({}, full, { heuristicMode: true }), gen, "fiche")).key, "hub.state.simple_fiche");
  eq("un seul quiz → singulier", H.statusLabel(H.resourceState(chap({ aiQuiz: [{}] }), gen, "quiz")).key, "hub.state.quiz_one");
  eq("une seule carte → singulier", H.statusLabel(H.resourceState(chap({ aiFlashcards: [{}] }), gen, "flashcards")).key, "hub.state.cards_one");
  eq("à générer", H.statusLabel(H.resourceState(chap(), gen, "quiz")).key, "hub.state.NOT_GENERATED");
  eq("questions", H.statusLabel(H.resourceState(chap(), gen, "questions")).key, "hub.state.ask");
  H.enqueue(gen, "ch_1", ["quiz"]);
  eq("en attente", H.statusLabel(H.resourceState(chap(), gen, "quiz")).key, "hub.state.QUEUED");
  H.takeNext(gen);
  eq("en préparation", H.statusLabel(H.resourceState(chap(), gen, "quiz")).key, "hub.state.GENERATING");
  eq("aucun nombre affiché pour une ressource sans données", H.statusLabel(H.resourceState(chap(), gen, "quiz")).vars, {});
}

scenario("Un échec connu d'ailleurs (import) s'affiche sur la ressource");
{
  const gen = H.newGen();
  H.recordError(gen, "ch_1", "quiz", { code: "TIMEOUT", message: "trop long" });
  eq("quiz en ERROR avec son motif", [H.resourceState(chap(), gen, "quiz").state, H.resourceState(chap(), gen, "quiz").error.code], ["ERROR", "TIMEOUT"]);
  H.recordError(gen, "ch_1", "inconnue", { code: "X" });
  eq("clé inconnue ignorée", Object.keys(gen.errors.ch_1), ["quiz"]);
  eq("un autre cours n'est pas touché", H.resourceState(chap({ id: "autre" }), gen, "quiz").state, "NOT_GENERATED");
}

scenario("Source : « chapitre vide » ≠ « cours importé pas encore traité »");
{
  eq("PDF conservé", H.sourceKind(chap({ hasOriginalFile: true })), "file");
  eq("texte d'origine", H.sourceKind(chap({ originalText: "du texte" })), "text");
  eq("le PDF prime sur le texte", H.sourceKind(chap({ hasOriginalFile: true, originalText: "t" })), "file");
  eq("rien du tout : vraiment vide", H.sourceKind(chap()), "none");
  eq("texte d'espaces = pas de source", H.sourceKind(chap({ originalText: "  " })), "none");
}

scenario("Générer tout : ce que le pipeline dit manquer, sans doublon");
{
  const gen = H.newGen();
  eq("les clés manquantes du pipeline, dans l'ordre", H.keysForGenerateAll(["fiche", "summary", "quiz", "flashcards", "reviewQuestions"], gen, "c"), ["fiche", "summary", "quiz", "flashcards", "reviewQuestions"]);
  H.enqueue(gen, "c", ["fiche"]); H.takeNext(gen); H.enqueue(gen, "c", ["summary"]);
  eq("ce qui tourne ou attend déjà n'est pas redemandé", H.keysForGenerateAll(["fiche", "summary", "quiz"], gen, "c"), ["quiz"]);
  eq("doublons et clés inconnues filtrés", H.keysForGenerateAll(["quiz", "quiz", "zzz"], H.newGen(), "c"), ["quiz"]);
  eq("rien de manquant → rien", H.keysForGenerateAll([], H.newGen(), "c"), []);
}

console.log(`\n${pass} vérifications réussies, ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
