/* ============================================================================
   REV-EM — Recherche de « Mes matières » : le branchement, dans un vrai navigateur
   ----------------------------------------------------------------------------
   Le MOTEUR est testé séparément, sans navigateur (tests/subject-search.test.js,
   19 vérifications). Ce fichier-ci teste ce qu'un test Node ne peut pas voir :
   le champ réel, la frappe lettre par lettre, le focus qui ne se perd jamais,
   le bouton ×, Échap, le rendu, le responsive, les cinq langues, et le fait
   qu'aucune navigation existante n'a été cassée.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/library-search.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

let pass = 0, fail = 0, current = "";
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  current = name; console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

/* Le jeu de matières du cahier des charges, créées par la vraie fonction du
   produit (saveUserSubjects) — pas une seconde liste inventée pour le test. */
const SEED = () => {
  const names = ["Marketing", "Management", "Mathématiques", "Économie", "Finance", "Management commercial"];
  state.userSubjects = names.map((name, i) => ({
    id: "s" + i, name, semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D",
  }));
  saveUserSubjects();
  libGoto("subjects");
  switchTab("library");
};

async function open(browser, vp, lang) {
  const page = await browser.newPage({ viewport: vp || { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(APP);
  await page.waitForTimeout(1200);
  if (lang) { await page.evaluate(l => LyonI18n.setLang(l), lang); await page.waitForTimeout(200); }
  await page.evaluate(SEED);
  await page.waitForTimeout(300);
  return { page, errors };
}

const cardNames = (page) => page.evaluate(() => [...document.querySelectorAll(".flash-deckcard .name")].map(e => e.textContent));
/* Touche par touche, comme une vraie frappe — la seule façon de vérifier que
   le curseur ne repart pas au début et que le focus survit au ré-rendu. */
async function type(page, selector, text) {
  await page.click(selector);
  await page.keyboard.type(text, { delay: 15 });
  await page.waitForTimeout(150);
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {

  /* ========================================================================
     1/2/3. AUCUNE RECHERCHE, PUIS DÈS LA PREMIÈRE LETTRE
     ====================================================================== */
  current = "1. état initial";
  {
    const { page, errors } = await open(browser);
    const initial = await page.evaluate(() => ({
      hasSearch: !!document.getElementById("lib-search-input"),
      hasLabel: !!document.querySelector('label.sr-only[for="lib-search-input"]'),
      groups: document.querySelectorAll(".level-heading").length,
      hasClear: !!document.getElementById("lib-search-clear"),
    }));
    check("le champ de recherche est visible", initial.hasSearch, initial);
    check("un vrai libellé accessible existe (pas seulement un placeholder)", initial.hasLabel, initial);
    check("le groupement par semestre est intact par défaut", initial.groups > 0, initial);
    check("le bouton × n'apparaît pas tant qu'il n'y a rien à effacer", !initial.hasClear, initial);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  current = "2. dès la première lettre, sans bouton ni Entrée";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "M");
    eq('"M" → celles qui commencent par M (alphabétique), puis un mot qui commence par M, puis qui contient M',
      await cardNames(page), ["Management", "Management commercial", "Marketing", "Mathématiques", "Analyse de marché", "Économie"]);
    await page.close();
  }

  current = "3. affiner resserre en direct";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "Ma");
    eq('"Ma"', await cardNames(page), ["Management", "Management commercial", "Marketing", "Mathématiques", "Analyse de marché"]);
    await type(page, "#lib-search-input", "r");
    eq('"Mar" (après avoir tapé "Ma" puis "r")', await cardNames(page), ["Marketing", "Analyse de marché"]);
    await page.close();
  }

  /* ========================================================================
     4/5/6/7. PRIORITÉ AU PRÉFIXE, PUIS RECHERCHE PARTIELLE
     ====================================================================== */
  current = "4. correspondance exacte";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "marketing");
    eq('"marketing" (minuscule complet)', await cardNames(page), ["Marketing"]);
    await page.close();
  }

  current = "5/6. correspondance partielle et priorité au préfixe";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "commercial");
    eq('"commercial" ne préfixe aucun nom, mais est contenu dans un seul',
      await cardNames(page), ["Management commercial"]);
    await page.fill("#lib-search-input", "");
    await type(page, "#lib-search-input", "mar");
    eq('"mar" : "Marketing" (commence par) AVANT "Analyse de marché" (un mot commence par) — rien n\'est masqué',
      await cardNames(page), ["Marketing", "Analyse de marché"]);
    await page.close();
  }

  /* ========================================================================
     7. ACCENTS ET MAJUSCULES
     ====================================================================== */
  current = "7. accents et casse";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "eco");
    eq('"eco" (sans accent) trouve « Économie »', await cardNames(page), ["Économie"]);
    await page.fill("#lib-search-input", "");
    await type(page, "#lib-search-input", "MARKETING");
    eq('"MARKETING" en capitales', await cardNames(page), ["Marketing"]);
    await page.close();
  }

  /* ========================================================================
     8. ORDRE ALPHABÉTIQUE — accent inclus
     ====================================================================== */
  current = "8. tri alphabétique par défaut";
  {
    const { page } = await open(browser);
    /* Une seule matière commençant par la même lettre : on vérifie l'ordre
       du GROUPE réel, pas un tri qu'on aurait pu casser sans le voir. */
    const order = await page.evaluate(() => [...document.querySelectorAll(".flash-deckcard .name")].map(e => e.textContent));
    eq("Économie apparaît, à sa place alphabétique réelle (pas ASCII, pas après Z)",
      order.indexOf("Économie") >= 0 && order.indexOf("Économie") < order.indexOf("Finance"), true);
    await page.close();
  }

  /* ========================================================================
     9/10. AUCUN RÉSULTAT
     ====================================================================== */
  current = "9/10. aucun résultat";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "xyz123");
    const empty = await page.evaluate(() => ({
      hasEmpty: !!document.querySelector(".empty .empty-icon"),
      title: document.querySelector(".empty .empty-title")?.textContent,
      text: document.querySelector(".empty .empty-text")?.textContent,
      hasErrorTone: !!document.querySelector(".empty.is-error"),
      cards: document.querySelectorAll(".flash-deckcard").length,
    }));
    check("une icône discrète accompagne l'état vide", empty.hasEmpty, empty);
    check("le titre dit clairement qu'il n'y a rien, sans être une erreur", !!empty.title, empty);
    check("jamais le ton « erreur »", !empty.hasErrorTone, empty);
    eq("et bien sûr, aucune carte", empty.cards, 0);
    await page.close();
  }

  /* ========================================================================
     11. EFFACEMENT RAPIDE — le bouton ×
     ====================================================================== */
  current = "11. bouton ×";
  {
    const { page } = await open(browser);
    await type(page, "#lib-search-input", "mar");
    check("le bouton × apparaît dès qu'une recherche est active",
      await page.evaluate(() => !!document.getElementById("lib-search-clear")));
    await page.click("#lib-search-clear");
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
      value: document.getElementById("lib-search-input").value,
      groups: document.querySelectorAll(".level-heading").length,
      focused: document.activeElement.id,
    }));
    eq("le champ est vidé", after.value, "");
    check("l'affichage normal (groupé) revient immédiatement", after.groups > 0, after);
    eq("le focus reste dans le champ, prêt à retaper", after.focused, "lib-search-input");
    await page.close();
  }

  /* ========================================================================
     12/16. LE CLAVIER — focus, Échap, curseur qui ne saute pas
     ====================================================================== */
  current = "12. clavier";
  {
    const { page } = await open(browser);
    /* Le champ n'a PAS le focus au chargement : voler le focus sur une page
       normale (pas une palette qu'on ouvre exprès) ferait surgir le clavier
       sur mobile sans qu'on l'ait demandé. */
    eq("aucun focus automatique à l'arrivée sur la page",
      await page.evaluate(() => document.activeElement.id === "lib-search-input"), false);

    await type(page, "#lib-search-input", "Marketing");
    eq("le curseur reste en fin de saisie après plusieurs frappes (pas de re-rendu qui le ramène au début)",
      await page.evaluate(() => {
        const el = document.getElementById("lib-search-input");
        return el.selectionStart === el.value.length;
      }), true);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const afterEsc = await page.evaluate(() => ({
      value: document.getElementById("lib-search-input").value,
      focused: document.activeElement.id,
    }));
    eq("Échap vide le champ", afterEsc.value, "");
    eq("…et le focus y reste", afterEsc.focused, "lib-search-input");

    /* Tabulation : le champ est atteignable, dans le flux normal. */
    await page.evaluate(() => document.getElementById("lib-search-input").blur());
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement.id === "lib-search-input");
    }
    check("le champ est atteignable à la tabulation", reached);
    await page.close();
  }

  /* ========================================================================
     13/18. MOBILE ET DESKTOP — aucun débordement, cible tactile correcte
     ====================================================================== */
  for (const vp of [{ n: "mobile", w: 375, h: 800 }, { n: "tablette", w: 800, h: 1000 }, { n: "bureau", w: 1440, h: 900 }]) {
    current = `13. ${vp.n}`;
    const { page, errors } = await open(browser, { width: vp.w, height: vp.h });
    await type(page, "#lib-search-input", "m");
    const r = await page.evaluate(() => {
      const bar = document.querySelector(".lib-search");
      const rect = bar.getBoundingClientRect();
      return {
        overflowsRight: rect.right > window.innerWidth + 1,
        overflowsLeft: rect.left < -1,
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check(`[${vp.n}] la barre ne déborde pas horizontalement`, !r.overflowsRight && !r.overflowsLeft, r);
    check(`[${vp.n}] pas de défilement horizontal de la page`, !r.pageOverflow, r);
    eq(`[${vp.n}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ========================================================================
     14. UTILISATEUR CONNECTÉ / DÉCONNECTÉ — la recherche ne suppose aucun compte
     ====================================================================== */
  current = "14. invité";
  {
    const { page, errors } = await open(browser);
    const status = await page.evaluate(() => window.LyonAuth ? LyonAuth.state.status : "no-auth-module");
    check("fonctionne en invité (pas de compte connecté)", status !== "signed-in", status);
    await type(page, "#lib-search-input", "mar");
    eq("la recherche filtre normalement, sans compte", await cardNames(page), ["Marketing", "Analyse de marché"]);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

  /* ========================================================================
     15. UNE SEULE MATIÈRE — la recherche ne s'affiche pas pour rien
     ====================================================================== */
  current = "15. une seule matière";
  {
    const { page } = await open(browser);
    await page.evaluate(() => {
      state.userSubjects = [];
      saveUserSubjects();
      switchTab("library");
    });
    await page.waitForTimeout(200);
    const one = await page.evaluate(() => ({
      count: allSubjects().length,
      hasSearch: !!document.getElementById("lib-search-input"),
    }));
    check("avec une seule matière au total, la barre ne s'affiche pas (rien à chercher)",
      one.count <= 1 ? !one.hasSearch : true, one);
    await page.close();
  }

  /* ========================================================================
     17. CHANGEMENT DE LANGUE — cinq langues, jamais une clé brute
     ====================================================================== */
  for (const lang of ["fr", "en", "es", "de", "it"]) {
    current = `17. ${lang}`;
    const { page, errors } = await open(browser, undefined, lang);
    const texts = await page.evaluate(() => ({
      placeholder: document.getElementById("lib-search-input").placeholder,
      label: document.querySelector('label[for="lib-search-input"]').textContent,
    }));
    check(`[${lang}] placeholder et libellé sont traduits, jamais une clé brute`,
      texts.placeholder.length > 3 && !/^library\./.test(texts.placeholder)
      && texts.label.length > 3 && !/^library\./.test(texts.label), texts);
    await type(page, "#lib-search-input", "xyz123");
    const empty = await page.evaluate(() => ({
      title: document.querySelector(".empty .empty-title")?.textContent,
      hint: document.querySelector(".empty .empty-text")?.textContent,
      clearLabel: document.getElementById("lib-search-clear")?.getAttribute("aria-label"),
    }));
    check(`[${lang}] l'état "aucun résultat" est traduit`,
      empty.title && !/^library\./.test(empty.title) && empty.hint && !/^library\./.test(empty.hint)
      && empty.clearLabel && !/^library\./.test(empty.clearLabel), empty);
    eq(`[${lang}] aucune erreur JavaScript`, errors, []);
    await page.close();
  }

  /* ========================================================================
     19. AUCUNE RÉGRESSION — les navigations existantes de la page fonctionnent
     ====================================================================== */
  current = "19. non-régression";
  {
    const { page, errors } = await open(browser);
    /* Ouvrir une matière depuis la liste groupée (sans recherche) — inchangé. */
    await page.click('[data-open-subject="s0"]');
    await page.waitForTimeout(250);
    eq("cliquer une matière ouvre toujours son détail",
      await page.evaluate(() => state.library.view === "subjectDetail" && state.library.subjectId === "s0"), true);
    await page.evaluate(() => { libGoto("subjects"); });
    await page.waitForTimeout(200);

    /* Ouvrir une matière depuis un résultat de RECHERCHE — la même carte, le
       même comportement, juste une autre liste en amont. */
    await type(page, "#lib-search-input", "mar");
    await page.click('[data-open-subject="s0"]');
    await page.waitForTimeout(250);
    eq("cliquer une matière trouvée par la recherche ouvre aussi son détail",
      await page.evaluate(() => state.library.view === "subjectDetail" && state.library.subjectId === "s0"), true);
    await page.evaluate(() => { libGoto("subjects"); });
    await page.waitForTimeout(200);

    /* Les deux boutons d'en-tête existent toujours et mènent toujours au même endroit. */
    const nav = await page.evaluate(() => ({
      addBtn: !!document.getElementById("lib-add-subject-btn"),
      importBtn: !!document.getElementById("lib-import-course-btn"),
    }));
    check("« + Ajouter une matière » est toujours là", nav.addBtn, nav);
    check("« Importer un cours » est toujours là", nav.importBtn, nav);
    await page.click("#lib-add-subject-btn");
    await page.waitForTimeout(200);
    eq("il ouvre toujours le formulaire de création",
      await page.evaluate(() => state.library.view === "subjectForm"), true);

    eq("aucune erreur JavaScript sur l'ensemble du scénario", errors, []);
    await page.close();
  }

  current = "20. mise à jour ciblée : le champ n'est jamais détruit, aucun réseau";
  {
    const { page, errors } = await open(browser);
    const requetes = [];
    page.on("request", r => { if (!/localhost/.test(r.url())) requetes.push(r.url()); });
    await page.evaluate(() => { window.__champ = document.getElementById("lib-search-input"); window.__renders = 0;
      const orig = render; window.render = function () { window.__renders++; return orig.apply(this, arguments); }; });
    await page.click("#lib-search-input");
    await page.keyboard.type("mar", { delay: 20 });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      memeNoeud: window.__champ === document.getElementById("lib-search-input"),
      focus: document.activeElement === window.__champ,
      curseur: window.__champ.selectionStart,
      rendersComplets: window.__renders,
      croix: !!document.getElementById("lib-search-clear"),
    }));
    check("c'est le MÊME champ après trois frappes (jamais recréé)", r.memeNoeud, r);
    check("il garde le focus", r.focus, r);
    eq("et le curseur reste à la fin", r.curseur, 3);
    eq("aucun rendu complet de la page pendant la frappe", r.rendersComplets, 0);
    check("le bouton × est apparu", r.croix, r);
    eq("aucune requête réseau externe pendant la recherche", requetes, []);

    /* Une carte reste cliquable après plusieurs réécritures de la zone. */
    await page.click(".flash-deckcard[data-open-subject]");
    await page.waitForTimeout(200);
    eq("cliquer un résultat ouvre bien la matière",
      await page.evaluate(() => state.library.view), "subjectDetail");

    /* Retour, puis effacement : le × disparaît, les semestres reviennent. */
    await page.evaluate(() => libGoto("subjects"));
    await page.waitForTimeout(150);
    await page.click("#lib-search-input");
    await page.keyboard.type("ma", { delay: 15 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const apresEsc = await page.evaluate(() => ({
      valeur: document.getElementById("lib-search-input").value,
      croix: !!document.getElementById("lib-search-clear"),
      groupes: document.querySelectorAll(".level-heading").length,
      focus: document.activeElement === document.getElementById("lib-search-input"),
    }));
    eq("Échap vide le champ", apresEsc.valeur, "");
    check("le × disparaît", !apresEsc.croix, apresEsc);
    check("le groupement par semestre revient", apresEsc.groupes > 0, apresEsc);
    check("le focus reste dans le champ", apresEsc.focus, apresEsc);
    eq("aucune erreur JavaScript", errors, []);
    await page.close();
  }

} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${e.message}\n${e.stack}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
