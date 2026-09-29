/* ============================================================================
   REV-EM — le moteur de recherche de « Mes matières »
   ----------------------------------------------------------------------------
   Exécution :  node tests/subject-search.test.js
   Aucune dépendance, aucun réseau, aucun navigateur : le moteur est pur.

   Ce qui est testé ici : le filtrage lui-même, le classement à cinq niveaux, le tri
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
scenario("1. une seule lettre : ce qui COMMENCE par M d'abord (alphabétique), puis ce qui le contient", () => {
  const r = S.filterAndSortSubjects("M", SUBJECTS);
  eq("les quatre qui commencent par M, alphabétiquement, puis « Économie » (contient un m)",
    names(r), ["Management", "Management commercial", "Marketing", "Mathématiques", "Économie"]);
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
   6. LE CLASSEMENT MÉLANGE LES NIVEAUX — le plus fort d'abord, rien de masqué
   ══════════════════════════════════════════════════════════════════════════ */
scenario("6. l'exemple du cahier des charges : « mar »", () => {
  const subs = named(["Marketing", "Management", "Management commercial", "Gestion du marketing", "Finance"]);
  const r = S.filterAndSortSubjects("mar", subs);
  eq("« Marketing » (commence par) puis « Gestion du marketing » (un mot commence par)",
    names(r), ["Marketing", "Gestion du marketing"]);
});

scenario("6 bis. les cinq niveaux, dans un même résultat", () => {
  const subs = named(["Économie du marketing digital", "Supermarché", "Marché du travail", "Mar", "Marketing", "Marge"]);
  eq("exact, commence par (alphabétique), un mot commence par, contient",
    names(S.filterAndSortSubjects("mar", subs)),
    ["Mar", "Marché du travail", "Marge", "Marketing", "Économie du marketing digital", "Supermarché"]);
});

scenario("6 ter. plusieurs mots saisis", () => {
  const subs = named(["Gestion du marketing", "Gestion financière", "Marketing de la gestion"]);
  eq("« gestion mar » : chaque mot commence un mot du nom",
    names(S.filterAndSortSubjects("gestion mar", subs)), ["Gestion du marketing", "Marketing de la gestion"]);
});

scenario("6 quater. égalité de niveau : ordre alphabétique, puis ordre d'origine", () => {
  const subs = [{ id: "1", name: "Droit B" }, { id: "2", name: "droit b" }, { id: "3", name: "Droit A" }];
  eq("« droit » : A avant B, et les deux « B » gardent leur ordre",
    S.filterAndSortSubjects("droit", subs).map(x => x.id), ["3", "1", "2"]);
});

scenario("6 quinquies. le nom affiché reste l'original (accents et casse intacts)", () => {
  const r = S.filterAndSortSubjects("eco", named(["Économie"]));
  eq("« Économie » n'est pas réécrit en « economie »", names(r), ["Économie"]);
});

scenario("6 sexies. searchSubjects est le même moteur", () => {
  check("alias exposé", S.searchSubjects === S.filterAndSortSubjects);
});

scenario("6 septies. rapide : 2 000 matières, une frappe en moins de 30 ms", () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ id: "s" + i, name: (i % 3 ? "Gestion du marketing " : "Marketing ") + i }));
  const t0 = process.hrtime.bigint();
  const r = S.filterAndSortSubjects("mar", many);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(`classées en ${ms.toFixed(1)} ms`, ms < 30 && r.length === 2000, ms);
});

scenario("7. un mot qui commence par la saisie, même si rien ne commence par elle au début", () => {
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
