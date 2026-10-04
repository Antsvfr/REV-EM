/* ============================================================================
   REV-EM — synchronisation par compte avec le VRAI SDK Supabase
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • le SDK officiel @supabase/supabase-js (chargé exactement comme le fait le
       site), dans un vrai Chromium : ses événements d'authentification
       (INITIAL_SESSION / SIGNED_IN), sa session persistée, sa sérialisation
       PostgREST, ses en-têtes ;
     • index.html, auth.js, user-data.js tels quels ;
     • plusieurs contextes de navigateur = plusieurs « appareils » sans aucun
       stockage commun.

   CE QUI EST SIMULÉ
     Le SERVEUR : un backend HTTP en mémoire (tests/helpers/mock-supabase-http.mjs)
     qui imite GoTrue et PostgREST et applique la règle « seules mes lignes »
     (auth.uid()). Ce n'est PAS un vrai projet Supabase : ni contraintes SQL, ni
     vraies policies, ni réseau réel (celles-ci sont exercées contre un vrai
     PostgreSQL par tests/user-data.test.mjs). Aucun test ici ne prouve donc que
     TON projet Supabase se comporte ainsi : voir le rapport (PARTIAL).

   Prérequis :  npm install --no-save --no-package-lock @supabase/supabase-js pg
   Lancer   :  python3 -m http.server 9109   puis
               NODE_PATH=/opt/node22/lib/node_modules node tests/real-sdk-sync.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import fs from "node:fs";
import { createMockSupabase } from "./helpers/mock-supabase-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";
const SDK = new URL("../node_modules/@supabase/supabase-js/dist/umd/supabase.js", import.meta.url).pathname;
if (!fs.existsSync(SDK)) {
  console.log("NOT TESTED — le SDK Supabase n'est pas installé (npm install --no-save --no-package-lock @supabase/supabase-js pg).");
  process.exit(2);
}

let pass = 0, fail = 0, current = "";
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  current = name; console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const EMAIL_A = "eleve.a@test.fr", EMAIL_B = "eleve.b@test.fr", PASSWORD = "motdepasse1";

/* Un « appareil » : contexte isolé (stockage propre), SW bloqué (son comportement
   est couvert par pwa.test.mjs ; ici il intercepterait le SDK avant Playwright). */
async function device(mock, label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await mock.attach(ctx, SDK);
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { const t = m.text(); if (/REV-EM Sync/.test(t)) logs.push(t); if (/eyJ|access_token|refresh_token|password/i.test(t) && !/PROFILE/.test(t)) errors.push("SECRET DANS LA CONSOLE : " + t.slice(0, 80)); });
  await page.goto(APP);
  await page.waitForTimeout(1100);
  await clearMigratedSubject(page);
  return { ctx, page, errors, logs, label };
}
/* migrateAnalyseMarcheToUserSubject (migration, au premier chargement, de
   l'ancienne matière intégrée « Analyse de marché » vers une matière réelle
   dans state.userSubjects/userChapters — voir index.html) se déclenche à
   CHAQUE loadAllData(), donc à chaque connexion/déconnexion. Cette suite
   compare des tableaux exacts de matières par compte : on neutralise la
   fonction (comme toute fonction déclarée au premier niveau d'un script
   classique, elle est aussi accessible, et réassignable, en
   window.migrateAnalyseMarcheToUserSubject — même liaison) dès le premier
   chargement, pour toute la durée de vie de CETTE page — un vrai
   page.reload() l'exécute à nouveau depuis zéro, donc reloadDevice() la
   neutralise de nouveau juste après. La synchronisation réelle de
   « Analyse de marché » elle-même est vérifiée par
   tests/analyse-marche-migration.test.mjs. */
async function clearMigratedSubject(page){
  await page.evaluate(() => {
    window.migrateAnalyseMarcheToUserSubject = () => {};
    const beforeS = state.userSubjects.length, beforeC = state.userChapters.length;
    state.userSubjects = state.userSubjects.filter(s => s.id !== "analyse-marche");
    state.userChapters = state.userChapters.filter(c => c.subjectId !== "analyse-marche");
    if(state.userSubjects.length !== beforeS) saveUserSubjects();
    if(state.userChapters.length !== beforeC) saveUserChapters();
  });
}
async function reloadDevice(d, opts){
  const { wait, ...reloadOpts } = opts || {};
  await d.page.reload(reloadOpts);
  await d.page.waitForTimeout(wait || 1200);
  await clearMigratedSubject(d.page);
  await d.page.waitForTimeout(900);
}
async function login(d, email, wait) {
  await d.page.evaluate(() => switchTab("myspace"));
  await d.page.waitForTimeout(300);
  await d.page.fill("#account-email", email);
  await d.page.fill("#account-password", PASSWORD);
  await d.page.click("#account-form button[type=submit]");
  await d.page.waitForTimeout(wait || 2500);
  await clearMigratedSubject(d.page);
}
async function logout(d, wait) {
  await d.page.evaluate(() => switchTab("myspace"));
  await d.page.waitForTimeout(250);
  await d.page.click("#account-signout-btn");
  await d.page.waitForTimeout(wait || 2200);
  await clearMigratedSubject(d.page);
}
const addSubject = (d, id, name) => d.page.evaluate(([id, name]) => {
  state.userSubjects.push({ id, name, semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D", icon: "", description: "" });
  saveUserSubjects();
}, [id, name]);
const subjects = (d) => d.page.evaluate(() => state.userSubjects.map(s => s.name).sort());
const baseNames = (mock, email) => mock.rows("subjects", mock.userId(email)).map(r => r.name).sort();
const ui = (d) => d.page.evaluate(() => { libGoto("subjects"); switchTab("library"); return document.getElementById("content").innerText; });
const settle = (ms) => new Promise(r => setTimeout(r, ms));
const newMock = () => { const m = createMockSupabase(); m.addUser(EMAIL_A, PASSWORD); m.addUser(EMAIL_B, PASSWORD); return m; };

try {
  /* ======================================================================
     1 → 2. APPAREIL A → SUPABASE → APPAREIL B VIERGE (le test principal)
     ====================================================================== */
  await scenario("1. appareil A crée une matière : elle arrive dans Supabase, au nom du bon compte", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A);
    await addSubject(A, "s_a", "TEST CLOUD A");
    await A.page.waitForTimeout(2500);
    eq("la matière est en base", baseNames(mock, EMAIL_A), ["TEST CLOUD A"]);
    eq("et rattachée à l'identifiant Supabase du compte", mock.rows("subjects").map(r => r.user_id), [mock.userId(EMAIL_A)]);
    eq("aucune erreur JavaScript, aucun secret dans la console", A.errors, []);
    await A.ctx.close();
  });

  await scenario("2. appareil B vierge, même compte : la matière est téléchargée, injectée dans l'état ET affichée", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_a", "TEST CLOUD A"); await A.page.waitForTimeout(2500);

    const B = await device(mock, "B");
    /* « Vierge » veut dire : rien de l'appareil A, pas une absence totale de
       clé. Au tout premier chargement, migrateAnalyseMarcheToUserSubject()
       (voir index.html) a déjà écrit une fois "user-subjects" avant que
       device() n'ait eu la main pour neutraliser la fonction — c'est elle
       que la clé contient, jamais le travail de A : on vérifie l'isolation
       réelle, pas la présence d'une clé que la migration crée pour tout le
       monde dès le premier chargement, invité compris. */
    eq("B est réellement vierge", await B.page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(k => k.includes("user-subjects"));
      return [state.userSubjects.length, keys.every(k => !localStorage.getItem(k).includes("TEST CLOUD A"))];
    }), [0, true]);
    await login(B, EMAIL_A);
    eq("même identifiant de compte", await B.page.evaluate(() => LyonAuth.state.user.id), mock.userId(EMAIL_A));
    eq("état REV-EM reconstruit", await subjects(B), ["TEST CLOUD A"]);
    check("l'interface l'affiche (rerendu après hydratation)", /TEST CLOUD A/.test(await ui(B)));
    check("le cache local de B est renseigné", await B.page.evaluate(() => !!localStorage.getItem("revisions-etude-marche:u." + LyonAuth.state.user.id + ".user-subjects")));
    check("aucune modale inutile (B n'a rien à envoyer)", !(await B.page.evaluate(() => !!document.querySelector(".modal--confirm"))));
    /* Les journaux disent l'ordre réel, sans secret. */
    const order = B.logs.map(l => l.replace("[REV-EM Sync] ", "").split(/[ :]/)[0] + ":" + (l.includes("hydration") ? l.split("hydration ")[1].split(" ")[0] : ""));
    const i = (frag) => B.logs.findIndex(l => l.includes(frag));
    check("journal : hydration started → downloaded → hydration completed", i("hydration started") >= 0 && i("hydration started") < i("downloaded") && i("downloaded") < i("hydration completed"), B.logs);
    eq("aucune erreur JavaScript, aucun secret dans la console", B.errors, []);
    await A.ctx.close(); await B.ctx.close();
  });

  /* ======================================================================
     3. BIDIRECTIONNEL
     ====================================================================== */
  await scenario("3. A crée Finance, B la retrouve puis crée Marketing, A la retrouve : tout le monde a les deux", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(2500);
    const B = await device(mock, "B"); await login(B, EMAIL_A);
    eq("B a Finance", await subjects(B), ["Finance"]);
    await addSubject(B, "s_mkt", "Marketing"); await B.page.waitForTimeout(2500);
    eq("la base a les deux", baseNames(mock, EMAIL_A), ["Finance", "Marketing"]);
    await reloadDevice(A, { wait: 3500 });
    eq("A (après rechargement) a les deux", await subjects(A), ["Finance", "Marketing"]);
    eq("B a toujours les deux", await subjects(B), ["Finance", "Marketing"]);
    await A.ctx.close(); await B.ctx.close();
  });

  /* ======================================================================
     4. RECONNEXION SUR LE MÊME APPAREIL
     ====================================================================== */
  await scenario("4. déconnexion puis reconnexion : les données reviennent, la base n'est jamais vidée", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_r", "TEST RELOGIN"); await A.page.waitForTimeout(2500);
    await logout(A);
    eq("déconnecté : espace vide à l'écran", await subjects(A), []);
    eq("la déconnexion n'a rien supprimé en base", baseNames(mock, EMAIL_A), ["TEST RELOGIN"]);
    await login(A, EMAIL_A);
    eq("« TEST RELOGIN » réapparaît", await subjects(A), ["TEST RELOGIN"]);
    await addSubject(A, "s_r2", "Créée puis déconnexion immédiate");
    await logout(A, 2500);
    eq("une création suivie d'une déconnexion IMMÉDIATE n'est pas perdue", baseNames(mock, EMAIL_A), ["Créée puis déconnexion immédiate", "TEST RELOGIN"]);
    eq("aucune erreur JavaScript", A.errors, []);
    await A.ctx.close();
  });

  await scenario("5. rechargement (F5) d'un compte connecté : la session et les données reviennent", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_f5", "Avant F5"); await A.page.waitForTimeout(2500);
    await reloadDevice(A, { wait: 3500 });
    eq("toujours connecté", await A.page.evaluate(() => LyonAuth.state.status), "signed-in");
    eq("données présentes", await subjects(A), ["Avant F5"]);
    check("indicateur « synchronisé »", /is-synced/.test(await A.page.evaluate(() => document.getElementById("cloud-indicator").className)));
    await A.ctx.close();
  });

  /* ======================================================================
     6. COMPTE A ≠ COMPTE B
     ====================================================================== */
  await scenario("6. A → B → A sur le même appareil : B ne voit jamais Finance, même brièvement", async () => {
    const mock = newMock(); const D = await device(mock, "D");
    await login(D, EMAIL_A); await addSubject(D, "s_fin", "Finance"); await D.page.waitForTimeout(2500);
    await D.page.evaluate((idB) => {
      window.__leaks = [];
      window.__iv = setInterval(() => {
        if (currentAuthId() !== idB) return;
        const inState = JSON.stringify([state.userSubjects, state.userChapters]).includes("Finance");
        const inDom = (document.getElementById("content").textContent || "").includes("Finance");
        if (inState || inDom) window.__leaks.push({ inState, inDom });
      }, 2);
    }, mock.userId(EMAIL_B));
    await logout(D);
    await login(D, EMAIL_B);
    await addSubject(D, "s_mkt", "Marketing"); await D.page.waitForTimeout(2500);
    eq("B ne voit que Marketing", await subjects(D), ["Marketing"]);
    eq("aucune fuite observée pendant toute la bascule", await D.page.evaluate(() => window.__leaks), []);
    eq("aucune clé de A dans le stockage de l'appareil (hors choix de migration)", await D.page.evaluate((idA) => Object.keys(localStorage).filter(k => k.includes("u." + idA) && !k.endsWith(".cloud-choice")), mock.userId(EMAIL_A)), []);
    eq("la base garde chaque compte séparé", [baseNames(mock, EMAIL_A), baseNames(mock, EMAIL_B)], [["Finance"], ["Marketing"]]);
    await logout(D); await login(D, EMAIL_A);
    eq("A retrouve Finance, sans Marketing", await subjects(D), ["Finance"]);
    eq("toujours aucune fuite", await D.page.evaluate(() => window.__leaks), []);
    await D.ctx.close();
  });

  /* ======================================================================
     7. LOCALSTORAGE VIDE / NON VIDE
     ====================================================================== */
  await scenario("7. appareil avec données locales + compte non vide : la question est posée, « Envoyer » fusionne sans perte", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(2500);
    const P = await device(mock, "P");
    await addSubject(P, "s_local", "Local téléphone");
    await login(P, EMAIL_A, 1800);
    check("la question de première connexion est posée", await P.page.evaluate(() => !!document.querySelector(".modal--confirm")));
    check("pendant la question, l'indicateur ne dit PAS « Synchronisé »", !/is-synced/.test(await P.page.evaluate(() => document.getElementById("cloud-indicator").className)), await P.page.evaluate(() => document.getElementById("cloud-indicator").className));
    eq("rien n'est parti avant la réponse", baseNames(mock, EMAIL_A), ["Finance"]);
    await P.page.click('[data-ds-confirm="yes"]'); await P.page.waitForTimeout(2500);
    eq("l'appareil a les deux", await subjects(P), ["Finance", "Local téléphone"]);
    eq("la base a les deux", baseNames(mock, EMAIL_A), ["Finance", "Local téléphone"]);
    await A.ctx.close(); await P.ctx.close();
  });

  await scenario("8. Échap sur la question : la synchronisation reste EN ATTENTE, visible, et se rouvre d'un clic", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(2500);
    const P = await device(mock, "P");
    await addSubject(P, "s_local", "Local téléphone");
    await login(P, EMAIL_A, 1800);
    await P.page.keyboard.press("Escape"); await P.page.waitForTimeout(700);
    const ind = await P.page.evaluate(() => { const e = document.getElementById("cloud-indicator"); return { hidden: e.hidden, cls: e.className, role: e.getAttribute("role"), title: e.getAttribute("title") }; });
    check("l'indicateur n'a PAS disparu", ind.hidden === false, ind);
    check("il dit « à terminer » et invite à agir", /is-pending/.test(ind.cls) && /is-actionable/.test(ind.cls) && ind.role === "button", ind);
    check("un message explique quoi faire", (await P.page.evaluate(() => [...document.querySelectorAll(".toast")].map(x => x.textContent).join(" "))).length > 20);
    eq("rien n'a été envoyé ni supprimé", [await subjects(P), baseNames(mock, EMAIL_A)], [["Local téléphone"], ["Finance"]]);
    await P.page.click("#cloud-indicator"); await P.page.waitForTimeout(1500);
    check("un clic rouvre la question", await P.page.evaluate(() => !!document.querySelector(".modal--confirm")));
    await P.page.click('[data-ds-confirm="alt"]'); await P.page.waitForTimeout(2500);
    eq("« Utiliser mon compte » : le compte fait foi", await subjects(P), ["Finance"]);
    check("l'indicateur est revenu à « synchronisé »", /is-synced/.test(await P.page.evaluate(() => document.getElementById("cloud-indicator").className)));
    await A.ctx.close(); await P.ctx.close();
  });

  /* ======================================================================
     9 → 10. RÉSEAU
     ====================================================================== */
  await scenario("9. panne réseau : le travail local est conservé ; retour du réseau : la synchronisation reprend seule", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A);
    mock.setNetworkDown(true); await A.ctx.setOffline(true);
    await addSubject(A, "s_off", "Créée hors ligne"); await A.page.waitForTimeout(1500);
    eq("la donnée locale est conservée", await subjects(A), ["Créée hors ligne"]);
    check("l'indicateur dit « hors connexion »", /is-offline/.test(await A.page.evaluate(() => document.getElementById("cloud-indicator").className)));
    eq("rien n'est encore en base", baseNames(mock, EMAIL_A), []);
    mock.setNetworkDown(false); await A.ctx.setOffline(false); await A.page.waitForTimeout(2500);
    eq("le réseau revient : la donnée part toute seule", baseNames(mock, EMAIL_A), ["Créée hors ligne"]);
    eq("aucune erreur JavaScript", A.errors, []);
    await A.ctx.close();
  });

  await scenario("10. rechargement PENDANT l'hydratation : aucune corruption, aucun doublon", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(2500);
    const B = await device(mock, "B");
    mock.setLatency(500);
    await B.page.evaluate(() => switchTab("myspace")); await B.page.waitForTimeout(300);
    await B.page.fill("#account-email", EMAIL_A); await B.page.fill("#account-password", PASSWORD);
    await B.page.click("#account-form button[type=submit]");
    await B.page.waitForTimeout(1600);                     // en pleine lecture (17 requêtes à 500 ms)
    check("on est bien EN COURS d'hydratation", await B.page.evaluate(() => syncState.hydrating === true), await B.page.evaluate(() => JSON.stringify(syncState)));
    await B.page.reload();
    /* Un vrai reload() ré-exécute tout depuis zéro : la neutralisation posée
       par device() est perdue, et la migration (voir clearMigratedSubject)
       aurait le temps d'ajouter puis de pousser « Analyse de marché » DURANT
       ces 4,5 s si on ne la repose pas tout de suite — exactement la course
       que ce scénario vérifie par ailleurs (pas de corruption pendant une
       hydratation interrompue). */
    await B.page.waitForTimeout(300);
    await clearMigratedSubject(B.page);
    mock.setLatency(0); await B.page.waitForTimeout(4500);
    eq("après le rechargement, les données sont là, une seule fois", await subjects(B), ["Finance"]);
    eq("la base n'a pas été touchée", baseNames(mock, EMAIL_A), ["Finance"]);
    eq("aucune erreur JavaScript", B.errors, []);
    await A.ctx.close(); await B.ctx.close();
  });

  await scenario("11. aucun envoi ne part avant la fin de la lecture du compte", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(2500);
    const B = await device(mock, "B");
    mock.log.length = 0; mock.setLatency(300);
    await B.page.evaluate(() => switchTab("myspace")); await B.page.waitForTimeout(300);
    await B.page.fill("#account-email", EMAIL_A); await B.page.fill("#account-password", PASSWORD);
    await B.page.click("#account-form button[type=submit]");
    await B.page.waitForFunction(() => syncState.hydrating === true, null, { timeout: 8000 });
    /* Une modification arrive PENDANT la lecture (l'écran de chargement masque l'interface, mais un minuteur le peut). */
    await B.page.evaluate(() => { state.userSubjects.push({ id: "s_during", name: "Pendant l'hydratation", semesterId: (SEMESTERS[0]||{}).id, color: "#000", icon: "", description: "" }); saveUserSubjects(); });
    await B.page.waitForSelector(".modal--confirm", { timeout: 12000 });   // l'appareil a désormais des données locales : la question s'ouvre
    eq("rien n'est parti tant que la question est ouverte", baseNames(mock, EMAIL_A), ["Finance"]);
    mock.setLatency(0);
    await B.page.click('[data-ds-confirm="yes"]'); await B.page.waitForTimeout(3000);
    const rest = mock.log.filter(l => l.table !== "@auth");
    const firstWrite = rest.findIndex(l => l.method === "POST" || l.method === "DELETE");
    const domainReads = rest.slice(0, firstWrite < 0 ? rest.length : firstWrite).filter(l => l.method === "GET" && l.table !== "profiles" && l.table !== "brightspace_connections").length;
    check("les 17 catégories ont été lues AVANT la première écriture", firstWrite < 0 || domainReads >= 17, { firstWrite, domainReads });
    eq("la modification faite pendant la lecture n'est pas perdue", baseNames(mock, EMAIL_A), ["Finance", "Pendant l'hydratation"]);
    await A.ctx.close(); await B.ctx.close();
  });

  /* ======================================================================
     12. MATIÈRE INTÉGRÉE
     ====================================================================== */
  /* 12. RETIRÉ — cette matière n'existe plus : « Analyse de marché » était le
     SEUL sujet builtin:true du produit (SUBJECTS). Depuis sa conversion
     (migrateAnalyseMarcheToUserSubject, voir index.html), SUBJECTS est vide :
     plus aucune matière n'est intégrée, donc plus aucun chapitre ne peut
     emprunter le mécanisme « miroir » (BUILTIN_MIRROR, user-data.js) que ce
     scénario vérifiait — il n'a simplement plus de sujet réel pour s'exercer
     dans CE produit. Le mécanisme lui-même reste couvert, intact, au niveau
     moteur : tests/user-data.test.mjs garde son propre tableau BUILTINS de
     test (synthétique, indépendant de index.html) précisément pour continuer
     à l'exercer. Si une matière intégrée réapparaît un jour, réintroduire ce
     scénario avec son id réel. */
  await scenario("12. (retiré) un chapitre rangé dans une matière intégrée — mécanisme encore testé au niveau moteur, voir tests/user-data.test.mjs", async () => {
    console.log("  SKIP — plus aucune matière builtin dans ce produit (voir commentaire ci-dessus)");
  });

  /* ======================================================================
     13. COURS IMPORTÉ, PUIS AUTRE APPAREIL
     ====================================================================== */
  await scenario("13. cours importé et généré sur A : fiche, flashcards, quiz retrouvés sur B", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A);
    await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(1200);
    /* IA locale remplacée (WebGPU absent ici) : le PIPELINE d'import, lui, est réel. */
    await A.page.addScriptTag({ content: `
      window.webllmChat = async (turns) => { const p = turns[0].content;
        if (/déduis un titre court/.test(p)) return { text: JSON.stringify({ title: "Bilan comptable", chapter: "Le bilan", level: "", notions: ["actif", "passif"] }) };
        if (/fiche de révision structurée/.test(p)) return { text: JSON.stringify({ introduction: "i", sections: [{ type: "notions", title: "N", items: [{ title: "Actif", content: "Ce que possède l'entreprise." }] }], keyPoints: ["p"] }) };
        return { text: "Résumé court\\nx\\nIdées essentielles\\n- y" }; };
      window.webllmJsonChat = async (turns) => { const p = turns[0].content;
        if (/questions à choix multiples|questions pour réviser CETTE partie/.test(p)) return [{ q: "Que présente le bilan comptable ?", opts: ["Actif et passif", "Seulement les ventes", "Le plan de marketing", "Les congés annuels"], correct: 0, exp: "", sourceQuote: "actif" }];
        if (/flashcards de révision/.test(p)) return [{ front: "Actif", back: "Ce que possède l'entreprise", sourceQuote: "actif" }];
        return [{ q: "Question ?", a: "Réponse." }]; };
    ` });
    await A.page.evaluate(() => { state.aiStatus = "ready"; });
    await A.page.evaluate(() => { libGoto("subjectDetail", { subjectId: "s_fin" }); switchTab("library"); });
    await A.page.click("#lib-import-into-subject-btn"); await A.page.waitForTimeout(300);
    await A.page.evaluate(() => { closeImportCenter(); libGoto("import"); });   // l'Import Center est une fenêtre : ce scénario alimente le pipeline directement, depuis la vue d'import
    await A.page.evaluate(() => { state.courseImport.pasteText = "Le bilan comptable présente l'actif et le passif de l'entreprise à une date donnée, avec leurs composantes."; courseImportAddPasteAsFile(); state.courseImport.files[0].name = "bilan.txt"; state.courseImport.step = "detect"; return courseImportProcessFile(0); });
    await A.page.click("#import-confirm-generate-btn");
    await A.page.waitForTimeout(3500);
    const onA = await A.page.evaluate(() => state.userChapters.map(c => [c.title, !!c.content, c.aiQuiz.length, c.aiFlashcards.length, c.aiReviewQuestions.length, c.generationPending]));
    eq("le cours est complet sur A", onA.map(x => x.slice(1)), [[true, 1, 1, 1, false]]);
    const row = mock.rows("chapters", mock.userId(EMAIL_A))[0];
    check("en base : fiche, quiz, flashcards, questions, texte source", row && row.content && row.ai_quiz.length === 1 && row.ai_flashcards.length === 1 && row.ai_review_questions.length === 1 && row.original_text, row && Object.keys(row));
    const B = await device(mock, "B"); await login(B, EMAIL_A);
    eq("B retrouve matière, cours, fiche, flashcards, quiz", await B.page.evaluate(() => [state.userSubjects.map(s => s.name), state.userChapters.map(c => [!!c.content, c.aiQuiz.length, c.aiFlashcards.length, c.aiReviewQuestions.length, c.sourceFileName])]), [["Finance"], [[true, 1, 1, 1, "bilan.txt"]]]);
    check("le chapitre de B référence bien la matière Finance", await B.page.evaluate(() => state.userChapters[0].subjectId === "s_fin"));
    await A.ctx.close(); await B.ctx.close();
  });

  /* ======================================================================
     14. DIAGNOSTIC
     ====================================================================== */
  await scenario("14. le diagnostic compare ce qui est ici et ce que le compte contient, sans contenu ni jeton", async () => {
    const mock = newMock(); const A = await device(mock, "A");
    await login(A, EMAIL_A); await addSubject(A, "s_fin", "Finance"); await A.page.waitForTimeout(2500);
    const rows = await A.page.evaluate(() => revemSyncDiagnostic());
    const subj = rows.find(r => r.domain === "subjects");
    eq("matières : 1 ici, 1 dans le compte, aucune erreur", [subj.local, subj.cloud, subj.error], [1, 1, ""]);
    check("chaque catégorie a une ligne", rows.length >= 15, rows.length);
    check("aucun jeton ni contenu dans le résultat", !/eyJ|Finance/.test(JSON.stringify(rows)));
    mock.failTable("chapters", true);
    const rows2 = await A.page.evaluate(() => revemSyncDiagnostic());
    check("une panne d'une table montre la VRAIE erreur Supabase", /panne simulée sur chapters/.test(rows2.find(r => r.domain === "chapters").error), rows2.find(r => r.domain === "chapters"));
    await A.ctx.close();
  });
} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${(e && e.stack) || e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
