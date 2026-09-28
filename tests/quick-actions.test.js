/* ============================================================================
   REV-EM — le moteur « Que veux-tu faire ? »
   ----------------------------------------------------------------------------
   Exécution :  node tests/quick-actions.test.js
   Aucune dépendance, aucun réseau, aucun navigateur : le moteur est pur.

   Ce qui est testé ici : la sélection elle-même — quelles actions existent
   selon le contexte, dans quel ordre, et surtout lesquelles N'existent PAS.
   Ce qui est testé AILLEURS (tests/dashboard.test.mjs, au navigateur) : le
   rendu, les libellés traduits, et le fait que chaque bouton mène quelque
   part pour de vrai.
   ============================================================================ */
"use strict";

require("../quick-actions.js");
const QA = globalThis.LyonQuickActions;

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if(ok){ pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
function scenario(name, fn){
  console.log(`\n── ${name} ──`);
  try{ fn(); }catch(e){ check(`« ${name} » s'exécute sans exception`, false, String(e && e.stack || e)); }
}

const ids   = r => r.all.map(a => a.id);
const avail = c => QA.available(c).map(a => a.id);

/* Un compte « vivant » : de quoi réviser, un historique, un planning. */
const ACTIF = {
  recoCount: 6, wrongCount: 4,
  recentChapter: { id: "ch1", title: "Dérivation", type: "quiz" },
  todayEvents: 3, hasPlanning: true,
  quizCount: 240, flashCount: 80, subjectCount: 5,
  hasAnyData: true,
};

/* ══════════════════════════════════════════════════════════════════════════
   1. LE CONTEXTE — rien n'est inventé, rien ne casse
   ══════════════════════════════════════════════════════════════════════════ */
scenario("1. normalisation du contexte", () => {
  const c = QA.normalizeContext();
  eq("un contexte absent décrit un compte vide", c.hasAnyData, false);
  eq("les compteurs valent zéro", [c.recoCount, c.wrongCount, c.quizCount], [0, 0, 0]);
  eq("les reprises sont nulles", c.quizInProgress, null);
  eq("l'IA est supposée disponible tant qu'on ne dit pas le contraire", c.aiAvailable, true);

  const sale = QA.normalizeContext({ recoCount: -4, wrongCount: "12", todayEvents: NaN, quizCount: Infinity });
  eq("un nombre négatif est ramené à zéro", sale.recoCount, 0);
  eq("une chaîne n'est pas un compteur", sale.wrongCount, 0);
  eq("NaN non plus", sale.todayEvents, 0);
  eq("l'infini non plus", sale.quizCount, 0);

  const c2 = QA.normalizeContext({ recoCount: 3 });
  eq("un champ fourni est conservé", c2.recoCount, 3);
  check("la normalisation ne modifie pas l'objet d'origine", (() => {
    const src = { recoCount: 3 };
    QA.normalizeContext(src);
    return Object.keys(src).length === 1;
  })());
});

/* ══════════════════════════════════════════════════════════════════════════
   2. AUCUNE ACTION INUTILE — la règle la plus importante
   ══════════════════════════════════════════════════════════════════════════ */
scenario("2. aucune action inutile", () => {
  const vide = avail({});
  check("sans erreurs, « Réviser mes erreurs » n'existe pas", !vide.includes("review_wrong"), vide);
  check("sans recommandation, « Révision intelligente » n'existe pas", !vide.includes("smart_revision"), vide);
  check("sans cours récent, « Reprendre mon cours » n'existe pas", !vide.includes("resume_course"), vide);
  check("sans quiz commencé, « Continuer mon quiz » n'existe pas", !vide.includes("quiz_resume"), vide);
  check("sans question disponible, « Lancer un quiz » n'existe pas", !vide.includes("quiz_start"), vide);
  check("sans carte disponible, « Réviser mes flashcards » n'existe pas", !vide.includes("flash_start"), vide);
  check("sans matière, « Voir mes matières » n'existe pas", !vide.includes("explore_subjects"), vide);
  check("sans cours aujourd'hui, « Voir mon planning » n'existe pas", !vide.includes("planning_today"), vide);

  const peu = avail({ quizCount: 9, hasAnyData: true, subjectCount: 1 });
  check("un examen blanc n'est pas proposé sur 9 questions", !peu.includes("exam"), peu);
  const assez = avail({ quizCount: 10, hasAnyData: true, subjectCount: 1 });
  check("il l'est à partir de 10", assez.includes("exam"), assez);

  const sansIA = avail({ aiAvailable: false, hasAnyData: true });
  check("sans IA disponible, l'assistant n'est pas proposé", !sansIA.includes("ai"), sansIA);
});

/* ══════════════════════════════════════════════════════════════════════════
   3. REPRENDRE PASSE DEVANT TOUT
   ══════════════════════════════════════════════════════════════════════════ */
scenario("3. une session commencée passe devant", () => {
  const ctx = Object.assign({}, ACTIF, { quizInProgress: { label: "Dérivation", index: 3, total: 12 } });
  const r = QA.pick(ctx);
  eq("l'action principale est « Continuer mon quiz »", r.primary.id, "quiz_resume");
  check("et « Lancer un quiz » disparaît : on en a déjà un",
    !ids(r).includes("quiz_start") && !avail(ctx).includes("quiz_start"), avail(ctx));

  const f = QA.pick(Object.assign({}, ACTIF, { flashInProgress: { label: "Dérivation", index: 2, total: 20 } }));
  eq("des flashcards en cours passent aussi devant", f.primary.id, "flash_resume");

  const s = QA.pick(Object.assign({}, ACTIF, { sessionInProgress: { kind: "smart", index: 1, total: 4 } }));
  eq("une session de révision en cours aussi", s.primary.id, "session_resume");

  const tous = QA.pick(Object.assign({}, ACTIF, {
    quizInProgress: { label: "A" }, flashInProgress: { label: "B" }, sessionInProgress: { kind: "smart" },
  }));
  eq("le quiz reste le plus urgent des trois", tous.primary.id, "quiz_resume");
  eq("mais la famille « reprendre » ne monopolise pas la zone",
    tous.all.filter(a => a.family === "resume").length, 2);
});

/* ══════════════════════════════════════════════════════════════════════════
   4. LES CAS QUE LE CAHIER DES CHARGES NOMME
   ══════════════════════════════════════════════════════════════════════════ */
scenario("4. des erreurs récentes → réviser ses erreurs", () => {
  const r = QA.pick({ wrongCount: 7, quizCount: 200, subjectCount: 3, hasAnyData: true });
  check("« Réviser mes erreurs » est proposée", ids(r).includes("review_wrong"), ids(r));
  eq("et comme rien ne la précède, elle est principale", r.primary.id, "review_wrong");
});

scenario("5. un cours récent → le reprendre", () => {
  const r = QA.pick({ recentChapter: { id: "c", title: "Dérivation" }, quizCount: 50, subjectCount: 2, hasAnyData: true });
  check("« Reprendre mon cours » est proposée", ids(r).includes("resume_course"), ids(r));
});

scenario("6. le compte vivant, au complet", () => {
  const r = QA.pick(ACTIF);
  eq("la priorité du moteur de révision mène la zone", r.primary.id, "smart_revision");
  eq("et les secondaires sont celles qui comptent vraiment",
    r.secondary.map(a => a.id), ["review_wrong", "resume_course", "planning_today", "import_course"]);
  check("quatre secondaires au plus", r.secondary.length <= 4, r.secondary.length);
});

/* ══════════════════════════════════════════════════════════════════════════
   7. AUCUNE DONNÉE → DES ACTIONS DE DÉCOUVERTE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("7. un compte vide reçoit des actions de découverte", () => {
  const r = QA.pick({});
  eq("importer un cours est la première chose à faire", r.primary.id, "import_course");
  check("créer une matière suit", ids(r).includes("new_subject"), ids(r));
  check("aucune action de révision n'est proposée : il n'y a rien à réviser",
    !ids(r).some(id => ["smart_revision", "review_wrong", "quiz_start", "flash_start", "exam"].includes(id)), ids(r));
  check("aucune reprise non plus",
    !ids(r).some(id => id.indexOf("resume") === 0 || id === "session_resume"), ids(r));
  check("la zone reste courte plutôt que de se remplir", r.all.length <= QA.MAX_TOTAL, r.all.length);

  /* Un compte neuf mais avec le contenu intégré de l'application : on ne
     prétend pas qu'il n'y a rien à faire, mais on ne parle pas de révision
     « intelligente » sans le moindre historique. */
  const neuf = QA.pick({ quizCount: 240, subjectCount: 6, flashCount: 80 });
  eq("avec le contenu intégré, importer reste la première marche", neuf.primary.id, "import_course");
  check("« Lancer un quiz » devient possible", ids(neuf).includes("quiz_start"), ids(neuf));
  check("mais « Révision intelligente » reste absente sans historique",
    !ids(neuf).includes("smart_revision"), ids(neuf));
});

/* ══════════════════════════════════════════════════════════════════════════
   8. UNE HIÉRARCHIE, PAS UNE GRILLE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("8. la zone ne devient jamais un mur", () => {
  const tout = {
    quizInProgress: { label: "A" }, flashInProgress: { label: "B" }, sessionInProgress: { kind: "smart" },
    recoCount: 9, wrongCount: 9, recentChapter: { id: "c", title: "T" },
    planTasksToday: 4, todayEvents: 5, hasPlanning: true,
    quizCount: 400, flashCount: 200, subjectCount: 12, hasAnyData: true,
  };
  const dispo = QA.available(tout);
  check("le contexte le plus chargé rend beaucoup d'actions possibles", dispo.length >= 10, dispo.length);
  const r = QA.pick(tout);
  eq("la zone en garde cinq", r.all.length, 5);
  eq("une seule principale", r.primary ? 1 : 0, 1);
  eq("et donc quatre secondaires", r.secondary.length, 4);

  const familles = {};
  r.all.forEach(a => { familles[a.family] = (familles[a.family] || 0) + 1; });
  check("jamais plus de deux actions de la même intention",
    Object.keys(familles).every(f => familles[f] <= QA.FAMILY_CAP), familles);

  eq("le plafond total est réglable", QA.pick(tout, { max: 3 }).all.length, 3);
  eq("le plafond par famille aussi", QA.pick(tout, { familyCap: 1 }).all.filter(a => a.family === "resume").length, 1);
});

/* ══════════════════════════════════════════════════════════════════════════
   9. L'ORDRE EST DÉTERMINISTE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("9. déterminisme", () => {
  const a = ids(QA.pick(ACTIF)), b = ids(QA.pick(ACTIF));
  eq("deux appels identiques donnent le même résultat", a, b);

  const dispo = QA.available(ACTIF);
  let trie = true;
  for(let i = 1; i < dispo.length; i++){
    if(dispo[i-1].weight < dispo[i].weight) trie = false;
    if(dispo[i-1].weight === dispo[i].weight && dispo[i-1].order > dispo[i].order) trie = false;
  }
  check("les actions sortent triées par poids, puis par ordre de catalogue", trie,
    dispo.map(x => [x.id, x.weight, x.order]));

  const uniques = new Set(QA.CATALOGUE.map(a => a.id));
  eq("aucun identifiant n'est écrit deux fois", uniques.size, QA.CATALOGUE.length);
  check("chaque action porte une icône, une famille, une condition et un poids",
    QA.CATALOGUE.every(a => a.icon && a.family && typeof a.when === "function" && typeof a.weight === "function"));
  check("aucune action ne rend jamais deux fois le même identifiant dans une sélection",
    new Set(ids(QA.pick(ACTIF))).size === ids(QA.pick(ACTIF)).length);
});

/* ══════════════════════════════════════════════════════════════════════════
   10. LES SITUATIONS INTERMÉDIAIRES
   ══════════════════════════════════════════════════════════════════════════ */
scenario("10. situations intermédiaires", () => {
  const sansPlanning = QA.pick({ hasAnyData: true, quizCount: 100, subjectCount: 3, recoCount: 2 });
  check("sans emploi du temps, on propose d'en installer un",
    ids(sansPlanning).includes("planning_setup"), ids(sansPlanning));

  const avecPlanning = avail({ hasAnyData: true, hasPlanning: true, todayEvents: 2, quizCount: 100, subjectCount: 3 });
  check("avec un emploi du temps, on ne le propose plus",
    !avecPlanning.includes("planning_setup"), avecPlanning);

  const plan = QA.pick({ hasAnyData: true, hasPlanning: true, planTasksToday: 3, quizCount: 100, subjectCount: 3 });
  check("un plan de révision avec des tâches du jour est proposé",
    ids(plan).includes("study_plan"), ids(plan));

  const seul = QA.pick({ aiAvailable: false, subjectCount: 0 });
  check("même dans le cas le plus pauvre, il reste quelque chose à faire", seul.primary !== null, seul);
  /* Trois actions, et les trois sont vraies : importer et créer sont toujours
     possibles, installer un emploi du temps aussi quand il n'y en a pas. Rien
     d'autre n'est proposé — pas de quiz sans question, pas d'IA indisponible. */
  eq("et seulement ce qui est vrai", ids(seul), ["import_course", "new_subject", "planning_setup"]);
});

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
