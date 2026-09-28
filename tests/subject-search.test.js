/* ============================================================================
   REV-EM — le moteur de recherche de « Mes matières »
   ----------------------------------------------------------------------------
   Exécution :  node tests/subject-search.test.js
   Aucune dépendance, aucun réseau, aucun navigateur : le moteur est pur.

   Ce qui est testé ici : le filtrage lui-même, la cascade de niveaux, le tri
   sensible à la locale. Ce qui est testé AILLEURS (tests/library-search.test.mjs,
   au navigateur) : le champ réel, le bouton ×, Échap, le rendu, les cinq
   langues, le responsive.
   ============================================================================ */
"use strict";

require("../subject-search.js");
const S = globalThis.LyonSubjectSearch;

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

const named = (names) => names.map((name, i) => ({ id: "s" + i, name }));
const names = (r) => r.map(x => x.name);

/* Le jeu de matières du cahier des charges, tel quel. */
const SUBJECTS = named([
  "Marketing", "Management", "Mathématiques", "Économie", "Finance", "Management commercial",
]);

/* ══════════════════════════════════════════════════════════════════════════
   1. DÈS LA PREMIÈRE LETTRE, ET PAR PRÉFIXE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("1. une seule lettre, triée alphabétiquement", () => {
  const r = S.filterAndSortSubjects("M", SUBJECTS);
  eq("« M » trouve les quatre matières qui commencent par M, dans l'ordre alphabétique",
    names(r), ["Management", "Management commercial", "Marketing", "Mathématiques"]);
});

scenario("2. affiner la recherche resserre les résultats", () => {
  eq("« Ma »", names(S.filterAndSortSubjects("Ma", SUBJECTS)),
    ["Management", "Management commercial", "Marketing", "Mathématiques"]);
  eq("« Mar »", names(S.filterAndSortSubjects("Mar", SUBJECTS)), ["Marketing"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   3. TRI ALPHABÉTIQUE SENSIBLE À LA LOCALE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("3. tri alphabétique, accents compris", () => {
  const r = S.filterAndSortSubjects("", SUBJECTS);
  eq("é se classe avec les E, pas à part", names(r),
    ["Économie", "Finance", "Management", "Management commercial", "Marketing", "Mathématiques"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   4/5. RECHERCHE PARTIELLE — seulement si rien ne COMMENCE par la saisie
   ══════════════════════════════════════════════════════════════════════════ */
scenario("4. correspondance exacte de nom", () => {
  eq("« marketing » (minuscule) trouve « Marketing »",
    names(S.filterAndSortSubjects("marketing", SUBJECTS)), ["Marketing"]);
});

scenario("5. correspondance partielle quand rien ne commence par la saisie", () => {
  eq("« mat » trouve « Mathématiques »", names(S.filterAndSortSubjects("mat", SUBJECTS)), ["Mathématiques"]);
  eq("« commercial » ne commence aucun nom, mais est contenu dans un seul",
    names(S.filterAndSortSubjects("commercial", SUBJECTS)), ["Management commercial"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   6. LE CLASSEMENT EST UNE CASCADE — jamais un mélange de niveaux
   ══════════════════════════════════════════════════════════════════════════ */
scenario("6. la priorité va toujours à ce qui COMMENCE par la saisie", () => {
  const subs = named(["Management", "Management commercial", "Marketing", "Gestion du marketing"]);
  const r = S.filterAndSortSubjects("mar", subs);
  eq("seule « Marketing » commence par « mar » : elle seule sort, malgré un mot "
    + "« marketing » dans « Gestion du marketing »", names(r), ["Marketing"]);
});

scenario("7. un mot qui commence par la saisie, si rien ne commence par elle au début", () => {
  const subs = named(["Gestion du marketing", "Analyse financière"]);
  const r = S.filterAndSortSubjects("mar", subs);
  eq("« Gestion du marketing » sort car son second mot commence par « mar »",
    names(r), ["Gestion du marketing"]);
});

scenario("8. la simple présence, en dernier recours seulement", () => {
  const subs = named(["Ressources humaines", "Analyse financière"]);
  /* "financ" n'est ni un début de nom, ni un début de mot dans ces deux
     noms — mais "anc" est bien contenu au milieu de "financière". */
  const r = S.filterAndSortSubjects("anc", subs);
  eq("« anc » n'est trouvé qu'en milieu de mot, dans un seul nom",
    names(r), ["Analyse financière"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   9. ACCENTS ET CASSE — la recherche ne force personne à les taper juste
   ══════════════════════════════════════════════════════════════════════════ */
scenario("9. insensible aux accents et à la casse", () => {
  eq("« eco » (sans accent) trouve « Économie »",
    names(S.filterAndSortSubjects("eco", SUBJECTS)), ["Économie"]);
  eq("« ÉCO » (majuscules et accent) aussi", names(S.filterAndSortSubjects("ÉCO", SUBJECTS)), ["Économie"]);
  eq("« MARKETING » en capitales trouve « Marketing »",
    names(S.filterAndSortSubjects("MARKETING", SUBJECTS)), ["Marketing"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   10. AUCUNE CORRESPONDANCE
   ══════════════════════════════════════════════════════════════════════════ */
scenario("10. aucune correspondance renvoie une liste vide, jamais une erreur", () => {
  eq("« xyz » ne correspond à rien", S.filterAndSortSubjects("xyz", SUBJECTS), []);
  eq("une liste vide en entrée renvoie une liste vide", S.filterAndSortSubjects("m", []), []);
});

/* ══════════════════════════════════════════════════════════════════════════
   11. GETTEXT PERSONNALISÉ — la même fonction sert d'autres listes nommées
   ══════════════════════════════════════════════════════════════════════════ */
scenario("11. un accesseur de texte différent (chapitres, cours…)", () => {
  const chapters = [{ id: "c1", title: "Dérivation" }, { id: "c2", title: "Intégration" }];
  const r = S.filterAndSortSubjects("der", chapters, (c) => c.title);
  eq("filtre sur .title plutôt que .name quand on le lui demande",
    r.map(c => c.title), ["Dérivation"]);
});

/* ══════════════════════════════════════════════════════════════════════════
   12. RIEN N'EST MODIFIÉ — la fonction ne touche jamais la liste d'origine
   ══════════════════════════════════════════════════════════════════════════ */
scenario("12. la liste d'origine n'est ni mutée ni réordonnée sur place", () => {
  const original = named(["Zoologie", "Astronomie"]);
  const originalOrder = names(original);
  S.filterAndSortSubjects("", original);
  eq("l'ordre d'origine du tableau passé en argument est intact",
    names(original), originalOrder);
});

/* ══════════════════════════════════════════════════════════════════════════
   13. ROBUSTESSE — entrées limites
   ══════════════════════════════════════════════════════════════════════════ */
scenario("13. entrées limites", () => {
  eq("une requête faite uniquement d'espaces équivaut à une recherche vide",
    names(S.filterAndSortSubjects("   ", SUBJECTS)), names(S.filterAndSortSubjects("", SUBJECTS)));
  check("un élément sans nom ne fait pas planter la recherche",
    (() => { try{ S.filterAndSortSubjects("a", [{ id: "x" }, ...SUBJECTS]); return true; }catch(e){ return false; } })());
});

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
