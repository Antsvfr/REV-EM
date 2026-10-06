/* ============================================================================
   REV-EM — comptes multi-appareils : le BRANCHEMENT, dans un vrai navigateur
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html, auth.js, user-data.js, translations.js : le code du produit,
       chargé et exécuté tel quel par Chromium ;
     • l'état, le rendu, le cloisonnement du stockage local par compte, la
       modale de migration, les écrans de confirmation d'e-mail ;
     • deux « appareils » : deux contextes de navigateur INDÉPENDANTS, avec
       chacun son propre localStorage — c'est ce qui fait que « retrouver ses
       données sur l'autre appareil » veut dire quelque chose ici.

   CE QUI EST REMPLACÉ, ET POURQUOI
     Le SDK Supabase (`window.supabase`) est remplacé par un double qui garde
     les données EN MÉMOIRE, PARTAGÉES entre les deux contextes. Ce n'est pas
     une base de données : les policies RLS, les contraintes d'unicité et les
     clés étrangères ne sont pas exercées ici.

     Elles le sont ailleurs, pour de vrai : tests/user-data.test.mjs fait
     tourner le MÊME user-data.js contre un PostgreSQL réel, avec le schéma
     réel, les policies réelles et deux identités distinctes. Les deux suites
     sont complémentaires — celle-ci prouve que REV-EM appelle et applique ce
     qu'il faut, l'autre prouve que la base répond et protège comme il faut.

     Ce qu'AUCUNE des deux ne prouve : qu'un e-mail part réellement, et qu'un
     vrai téléphone retrouve les données via le vrai Supabase. Voir le rapport.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/account-sync.test.mjs
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
  /* ONLY=13 : ne rejoue que les scénarios dont le nom correspond (le n° 2
     est toujours joué, il produit la base de départ des autres). */
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name) && !/^2\./.test(name)) return;
  current = name; console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e)); }
}

/* ══════════════════════════════════════════════════════════════════════════
   LE DOUBLE DU SDK SUPABASE
   ──────────────────────────────────────────────────────────────────────────
   Injecté AVANT tout script de la page (addInitScript), donc avant auth.js :
   c'est la seule façon de faire croire à LyonAuth que Supabase est disponible.

   Les données vivent dans `globalThis.__DB`, qu'on transporte d'un contexte à
   l'autre pour simuler deux appareils partageant le même compte.
   ══════════════════════════════════════════════════════════════════════════ */
const FAKE_SDK = `
(function(){
  const CONFLICT_KEYS = {
    subjects: ["user_id","local_id"], chapters: ["user_id","local_id"],
    documents: ["user_id","local_id"], planning_events: ["user_id","local_id"],
    progress: ["user_id","kind","scope"], question_stats: ["user_id","question_uid"],
    exam_history: ["user_id","taken_at"], badges: ["user_id","badge_id"],
    ai_cards: ["user_id","builtin_chapter_id"], course_notes: ["user_id","event_id"],
    ai_history: ["user_id"], preferences: ["user_id"], study_plans: ["user_id"],
    user_stats: ["user_id"], daily_stats: ["user_id","day"],
    activities: ["user_id","ts"], chapter_visits: ["user_id","chapter_key"], math_practice: ["user_id","ts"],
    profiles: ["id"],
  };
  /* Persistance à travers un rechargement de l'onglet (F5 / réouverture) :
     la base partagée et la « coupure réseau » simulée vivent dans
     sessionStorage, comme le serveur réel survit à la fermeture d'un onglet. */
  const store = (k, v) => { try{ sessionStorage.setItem(k, v); }catch(e){} };
  const load = (k) => { try{ return sessionStorage.getItem(k); }catch(e){ return null; } };
  /* Le contenu mémorisé l'emporte sur la graine d'un contexte neuf : après
     un rechargement, le « serveur » se souvient de ce qu'il a reçu. */
  try{ const saved = load("__DBSTORE"); if(saved) globalThis.__DB = JSON.parse(saved); }catch(e){}
  const DB = globalThis.__DB = globalThis.__DB || { tables: {}, calls: [], seq: 1 };
  const netDown = () => load("__NET_DOWN") === "1";
  const rowsOf = (t) => (DB.tables[t] = DB.tables[t] || []);
  const keyOf = (t, r) => (CONFLICT_KEYS[t] || ["id"]).map(k => String(r[k])).join("|");

  function builder(table){
    const st = { op: null, payload: null, filters: [], single: false };
    const matches = (r) => st.filters.every(f =>
      f.k === "eq" ? String(r[f.c]) === String(f.v)
      : f.k === "in" ? f.v.map(String).includes(String(r[f.c]))
      : true);
    function run(){
      DB.calls.push({ table: table, op: st.op });
      if(netDown()) return { data: null, error: { message: "Failed to fetch" } };
      try{
        if(st.op === "select"){
          const data = rowsOf(table).filter(matches).map(r => JSON.parse(JSON.stringify(r)));
          return { data: st.single ? (data[0] || null) : data, error: st.single && !data.length ? { message: "no rows" } : null };
        }
        if(st.op === "upsert" || st.op === "insert"){
          const list = Array.isArray(st.payload) ? st.payload : [st.payload];
          const out = [];
          list.forEach(row => {
            const rows = rowsOf(table);
            const i = rows.findIndex(r => keyOf(table, r) === keyOf(table, row));
            const merged = Object.assign({}, i >= 0 ? rows[i] : { id: "row-" + (DB.seq++) }, row,
              { updated_at: new Date().toISOString() });
            if(!merged.created_at) merged.created_at = new Date().toISOString();
            if(i >= 0) rows[i] = merged; else rows.push(merged);
            out.push(JSON.parse(JSON.stringify(merged)));
          });
          store("__DBSTORE", JSON.stringify(DB));
          return { data: out, error: null };
        }
        if(st.op === "delete"){
          const rows = rowsOf(table);
          const kept = rows.filter(r => !matches(r));
          DB.tables[table] = kept;
          store("__DBSTORE", JSON.stringify(DB));
          return { data: [], error: null };
        }
        return { data: null, error: { message: "op inconnue" } };
      }catch(e){ return { data: null, error: { message: String(e) } }; }
    }
    const b = {
      select(){ if(!st.op) st.op = "select"; return b; },
      insert(p){ st.op = "insert"; st.payload = p; return b; },
      upsert(p){ st.op = "upsert"; st.payload = p; return b; },
      delete(){ st.op = "delete"; return b; },
      eq(c, v){ st.filters.push({ k: "eq", c: c, v: v }); return b; },
      neq(){ return b; }, in(c, v){ st.filters.push({ k: "in", c: c, v: v }); return b; },
      single(){ st.single = true; return b; },
      maybeSingle(){ st.single = true; return b; },
      then(res, rej){ return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }

  const authListeners = [];
  /* Session mémorisée comme le fait le vrai SDK (clé sb-…-auth-token). */
  const AUTH_KEY = "sb-test-auth-token";
  let storedUser = null;
  try{ storedUser = JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); }catch(e){}
  const auth = {
    _user: storedUser,
    onAuthStateChange(cb){ authListeners.push(cb); setTimeout(()=>cb("INITIAL_SESSION", auth._user ? { user: auth._user } : null), 0); return { data: { subscription: { unsubscribe(){} } } }; },
    async getUser(){ return { data: { user: auth._user }, error: null }; },
    async signUp(){ return { data: { user: null, session: null }, error: null }; },
    async signInWithPassword(){ return { data: { user: auth._user }, error: null }; },
    async signOut(){ auth._user = null; try{ localStorage.removeItem(AUTH_KEY); }catch(e){} authListeners.forEach(cb => cb("SIGNED_OUT", null)); return { error: null }; },
    async resend(){ DB.calls.push({ table: "@auth", op: "resend" }); return { error: null }; },
    async updateUser(p){ DB.calls.push({ table: "@auth", op: "updateUser", payload: p }); return { error: null }; },
    async resetPasswordForEmail(){ DB.calls.push({ table: "@auth", op: "reset" }); return { error: null }; },
  };
  /* Utilisé par le test pour « connecter » quelqu'un. */
  globalThis.__signInAs = function(id, email){
    auth._user = { id: id, email: email };
    try{ localStorage.setItem(AUTH_KEY, JSON.stringify(auth._user)); }catch(e){}
    authListeners.forEach(cb => cb("SIGNED_IN", { user: auth._user }));
  };
  globalThis.__signOut = function(){ auth.signOut(); };

  window.supabase = {
    createClient(){
      return {
        auth: auth,
        from: builder,
        storage: { from(){ return { async createSignedUrl(){ return { data: null, error: { message: "n/a" } }; },
                                     async upload(){ return { error: null }; },
                                     async remove(){ return { error: null }; } }; } },
      };
    },
  };
  window.SUPABASE_CONFIG = { url: "https://test.supabase.co", anonKey: "sb_publishable_test" };
})();
`;

/* Ouvre un « appareil » : un contexte de navigateur isolé (localStorage propre),
   avec le double du SDK et, éventuellement, le contenu de la base partagée. */
async function device(browser, db) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  /* La base partagée est semée AVANT le double du SDK : celui-ci capture
     `globalThis.__DB` par référence au moment où il s'exécute, donc la
     remplacer ensuite ne changerait rien à ce qu'il lit — l'appareil 2
     repartirait d'une base vide en croyant lire celle de l'appareil 1. */
  if (db) await ctx.addInitScript(`globalThis.__DB = ${JSON.stringify(db)};`);
  await ctx.addInitScript(FAKE_SDK);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  if (process.env.DEBUG_CONSOLE) page.on("console", m => console.log("  [page]", m.text().slice(0, 300)));
  await page.goto(APP);
  await page.waitForTimeout(1200);
  await clearMigratedSubject(page);
  return { ctx, page, errors };
}
const dumpDb = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__DB)));

/* Cette suite vérifie la synchronisation multi-appareils/multi-comptes
   (conflits, isolation, mode hors-ligne) avec des données ENTIÈREMENT
   simulées (CREATE_DATA remplace state.userSubjects/userChapters) : elle
   compte des lignes exactes envoyées à Supabase. Depuis la conversion de
   « Analyse de marché » (migrateAnalyseMarcheToUserSubject, au premier
   chargement de CHAQUE compte/espace), toute connexion ou déconnexion —
   qui recharge l'état depuis le bon espace via loadAllData(), voir
   handleAuthUserChange() — fait réapparaître cette matière réelle pour le
   compte qui vient de devenir actif. On la retire après CHAQUE appel à
   device()/signIn()/signOut()/reloadDevice() (sans jamais toucher au
   mécanisme de migration lui-même) pour garder ces scénarios de
   synchronisation focalisés sur leurs propres données ; la synchronisation
   réelle de « Analyse de marché » elle-même est vérifiée par
   tests/analyse-marche-migration.test.mjs. */
async function clearMigratedSubject(page){
  await page.evaluate(() => {
    /* migrateAnalyseMarcheToUserSubject (comme tout appel nu à une fonction
       déclarée au premier niveau d'un script classique) est aussi accessible
       en window.migrateAnalyseMarcheToUserSubject — la même liaison. La
       neutraliser ainsi empêche, pour toute la durée de vie de CETTE page,
       qu'un futur rechargement de compte (connexion/déconnexion, qui rappelle
       loadAllData()) ne la fasse réapparaître ENTRE deux instants observés
       par le test — y compris via le cycle de synchronisation automatique,
       plus rapide qu'un simple nettoyage après coup. Un vrai page.reload()
       l'exécute à nouveau depuis zéro ; voir reloadDevice(), qui la
       neutralise de nouveau juste après : dans cette seule fenêtre (entre le
       rechargement et ce nettoyage), la migration a pu tourner UNE fois et
       être poussée vers le double de Supabase par la synchronisation
       automatique — on la retire donc aussi de globalThis.__DB, pour ne
       jamais laisser une migration déjà envoyée fausser un compte de lignes.
       Les state.userSubjects/userChapters ne sont réécrits (saveUserSubjects/
       saveUserChapters, qui marquent une écriture "à envoyer") que s'il y
       avait réellement quelque chose à retirer : sinon, inutile de créer une
       écriture en attente qui n'a pas lieu d'être. */
    window.migrateAnalyseMarcheToUserSubject = () => {};
    const beforeS = state.userSubjects.length, beforeC = state.userChapters.length;
    state.userSubjects = state.userSubjects.filter(s => s.id !== "analyse-marche");
    state.userChapters = state.userChapters.filter(c => c.subjectId !== "analyse-marche");
    if(state.userSubjects.length !== beforeS) saveUserSubjects();
    if(state.userChapters.length !== beforeC) saveUserChapters();
    if(globalThis.__DB && globalThis.__DB.tables && globalThis.__DB.tables.subjects){
      const rowIds = new Set(globalThis.__DB.tables.subjects.filter(r => r.local_id === "analyse-marche").map(r => r.id));
      globalThis.__DB.tables.subjects = globalThis.__DB.tables.subjects.filter(r => r.local_id !== "analyse-marche");
      if(globalThis.__DB.tables.chapters){
        globalThis.__DB.tables.chapters = globalThis.__DB.tables.chapters.filter(r => !rowIds.has(r.subject_id) && !/^am[1-5]$/.test(r.local_id || ""));
      }
    }
  });
}
async function signIn(page, id, mail, wait = 1200){
  await page.evaluate(([id, mail]) => globalThis.__signInAs(id, mail), [id, mail]);
  await page.waitForTimeout(wait);
  await clearMigratedSubject(page);
}
async function signOut(page, wait = 600){
  await page.evaluate(() => globalThis.__signOut());
  await page.waitForTimeout(wait);
  await clearMigratedSubject(page);
}
async function reloadDevice(page, opts){
  await page.reload(opts);
  await page.waitForTimeout(opts && opts.wait || 1200);
  await clearMigratedSubject(page);
  // Un vrai rechargement ré-exécute les scripts : la neutralisation posée par
  // clearMigratedSubject() arrive après coup, donc la migration a pu tourner
  // une fois et marquer "subjects"/"chapters" à envoyer avant d'être retirée
  // ici — laisser le temps à CE cycle de synchronisation de se terminer avant
  // que le test ne lise l'indicateur/la file d'attente.
  await page.waitForTimeout(900);
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

/* Crée des données comme le ferait l'élève : par les fonctions du produit. */
const CREATE_DATA = (tag) => {
  state.userSubjects = [{ id: "subj_" + tag, name: "Matière " + tag, semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D" }];
  state.userChapters = [{ id: "ch_" + tag, subjectId: "subj_" + tag, num: "1", title: "Chapitre " + tag,
                          desc: "", content: "texte", aiQuiz: [], aiFlashcards: [], aiReviewQuestions: [],
                          createdAt: Date.now(), updatedAt: Date.now(), markedReviewed: false }];
  saveUserSubjects(); saveUserChapters();
  state.progress["chapter:ch_" + tag] = { best: 70, attempts: 2 };
  lsSet(KEY_QUIZ, state.progress);
  state.dash.totalAnswered = 20; state.dash.totalCorrect = 15;
  saveDashboardStats();
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

try {
  /* ======================================================================
     1. INVITÉ — RIEN NE CHANGE, RIEN NE PART
     ====================================================================== */
  await scenario("1. sans compte, aucune donnée ne quitte l'appareil", async () => {
    const d = await device(browser);
    await d.page.evaluate(CREATE_DATA, "invite");
    await d.page.waitForTimeout(600);
    const db = await dumpDb(d.page);
    eq("aucune écriture distante", Object.keys(db.tables), []);
    eq("aucun appel à Supabase pour les données", db.calls.filter(c => c.table !== "profiles" && c.table !== "@auth"), []);
    const local = await d.page.evaluate(() => ({
      subjects: state.userSubjects.length,
      stocke: !!localStorage.getItem("revisions-etude-marche:user-subjects"),
    }));
    eq("les données restent en local, comme avant", local, { subjects: 1, stocke: true });
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     2. PREMIÈRE CONNEXION — L'UTILISATEUR DÉCIDE, RIEN N'EST SILENCIEUX
     ====================================================================== */
  let dbAfterA = null;
  await scenario("2. première connexion : la migration est proposée, pas imposée", async () => {
    const d = await device(browser);
    await d.page.evaluate(CREATE_DATA, "a");
    await d.page.waitForTimeout(400);

    await signIn(d.page, USER_A, "a@test.invalid");

    const modal = await d.page.evaluate(() => {
      const m = document.querySelector(".modal--confirm");
      if (!m) return null;
      return {
        titre: m.querySelector(".modal-title").textContent.trim(),
        corps: m.querySelector(".ds-confirm-body").textContent.trim(),
        boutons: [...m.querySelectorAll("[data-ds-confirm]")].map(b => b.dataset.dsConfirm + ":" + b.textContent.trim()),
      };
    });
    check("une modale demande ce qu'il faut faire", !!modal, modal);
    check("elle annonce le nombre d'éléments concernés", /\d/.test(modal.corps), modal.corps);
    check("elle dit que rien n'est supprimé", /supprim/i.test(modal.corps), modal.corps);
    check("« Plus tard » est proposé", modal.boutons.some(b => b.startsWith("no:")), modal.boutons);

    /* Avant la réponse, RIEN n'est parti. */
    /* On compte les LIGNES, pas les tables : lire une table vide suffit à
       en créer l'entrée côté double du SDK, ce qui ne prouve rien. */
    const before = await dumpDb(d.page);
    const lignes = Object.values(before.tables).reduce((n, rows) => n + rows.length, 0);
    eq("rien n'est envoyé avant la réponse", lignes, 0);

    await d.page.click('[data-ds-confirm="yes"]');
    await d.page.waitForTimeout(1500);

    const db = await dumpDb(d.page);
    check("les matières sont parties", (db.tables.subjects || []).length === 1, db.tables.subjects);
    check("les chapitres aussi", (db.tables.chapters || []).length === 1, db.tables.chapters);
    check("la progression aussi", (db.tables.progress || []).length === 1, db.tables.progress);
    check("les compteurs aussi", (db.tables.user_stats || []).length === 1, db.tables.user_stats);
    eq("et ils portent bien l'identifiant du compte",
      [...new Set((db.tables.subjects || []).map(r => r.user_id))], [USER_A]);
    eq("aucune erreur JavaScript", d.errors, []);
    dbAfterA = db;
    await d.ctx.close();
  });

  /* ======================================================================
     3. DEUXIÈME APPAREIL — LES DONNÉES SONT LÀ
     ====================================================================== */
  await scenario("3. un autre appareil retrouve tout après connexion", async () => {
    const d = await device(browser, dbAfterA);
    /* Appareil vierge : aucune donnée locale. */
    const avant = await d.page.evaluate(() => ({
      subjects: state.userSubjects.length, chapters: state.userChapters.length,
    }));
    eq("il ne contient rien au départ", avant, { subjects: 0, chapters: 0 });

    await signIn(d.page, USER_A, "a@test.invalid", 1800);

    /* Aucune modale : cet appareil n'a rien à envoyer, il n'y a rien à arbitrer. */
    const modale = await d.page.evaluate(() => !!document.querySelector(".modal--confirm"));
    check("aucune question inutile n'est posée", !modale, modale);

    const apres = await d.page.evaluate(() => ({
      subjects: state.userSubjects.map(s => s.name),
      chapters: state.userChapters.map(c => c.title),
      progress: state.progress,
      totalAnswered: state.dash.totalAnswered,
      cacheLocal: !!localStorage.getItem("revisions-etude-marche:u." + LyonAuth.state.user.id + ".user-subjects"),
    }));
    eq("les matières sont retrouvées", apres.subjects, ["Matière a"]);
    eq("les chapitres aussi", apres.chapters, ["Chapitre a"]);
    eq("la progression aussi", apres.progress, { "chapter:ch_a": { best: 70, attempts: 2 } });
    eq("les compteurs aussi", apres.totalAnswered, 20);
    check("et le cache local de cet appareil est renseigné", apres.cacheLocal, apres);

    /* L'interface affiche réellement la matière retrouvée. */
    const visible = await d.page.evaluate(() => {
      libGoto("subjects"); switchTab("library");
      return document.getElementById("content").textContent;
    });
    check("la matière est visible à l'écran", /Matière a/.test(visible), visible.slice(0, 200));
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     4. UNE MODIFICATION VOYAGE
     ====================================================================== */
  let dbAfterEdit = null;
  await scenario("4. une modification faite ici se retrouve là-bas", async () => {
    const d1 = await device(browser, dbAfterA);
    await signIn(d1.page, USER_A, "a@test.invalid", 1500);

    await d1.page.evaluate(() => {
      const ch = state.userChapters[0];
      ch.title = "Chapitre révisé";
      ch.markedReviewed = true;
      ch.updatedAt = Date.now();
      saveUserChapters();
      state.progress["chapter:ch_a"] = { best: 95, attempts: 4 };
      lsSet(KEY_QUIZ, state.progress);
    });
    await d1.page.waitForTimeout(1500);
    dbAfterEdit = await dumpDb(d1.page);
    await d1.ctx.close();

    const d2 = await device(browser, dbAfterEdit);
    await signIn(d2.page, USER_A, "a@test.invalid", 1800);
    const seen = await d2.page.evaluate(() => ({
      titre: state.userChapters[0] && state.userChapters[0].title,
      revise: state.userChapters[0] && state.userChapters[0].markedReviewed,
      best: state.progress["chapter:ch_a"] && state.progress["chapter:ch_a"].best,
    }));
    eq("le nouveau titre est arrivé", seen.titre, "Chapitre révisé");
    check("l'état « révisé » aussi", seen.revise === true, seen);
    eq("le meilleur score aussi", seen.best, 95);
    eq("aucune erreur JavaScript", d2.errors, []);
    await d2.ctx.close();
  });

  /* ======================================================================
     5. CHANGEMENT DE COMPTE — AUCUNE FUITE
     ====================================================================== */
  await scenario("5. B ne voit jamais les données de A", async () => {
    const d = await device(browser, dbAfterEdit);
    await signIn(d.page, USER_A, "a@test.invalid", 1600);
    const vuParA = await d.page.evaluate(() => state.userChapters.map(c => c.title));
    eq("A voit les siennes", vuParA, ["Chapitre révisé"]);

    /* Déconnexion, puis connexion de B SUR LE MÊME APPAREIL. */
    await signOut(d.page, 1200);
    await signIn(d.page, USER_B, "b@test.invalid", 1600);

    const vuParB = await d.page.evaluate(() => ({
      subjects: state.userSubjects.map(s => s.name),
      chapters: state.userChapters.map(c => c.title),
      progress: Object.keys(state.progress),
      totalAnswered: state.dash.totalAnswered,
      ecran: document.getElementById("content").textContent,
    }));
    eq("B n'hérite d'aucune matière de A", vuParB.subjects, []);
    eq("ni d'aucun chapitre", vuParB.chapters, []);
    eq("ni d'aucune progression", vuParB.progress, []);
    eq("ni d'aucun compteur", vuParB.totalAnswered, 0);
    check("et rien de A n'apparaît à l'écran", !/Chapitre révisé|Matière a/.test(vuParB.ecran), "");

    /* B crée ses propres données, puis A revient : chacun retrouve les siennes. */
    await d.page.evaluate(CREATE_DATA, "b");
    await d.page.waitForTimeout(400);
    const modalB = await d.page.evaluate(() => !!document.querySelector(".modal--confirm"));
    if (modalB) await d.page.click('[data-ds-confirm="yes"]');
    await d.page.waitForTimeout(1500);

    await signOut(d.page, 1000);
    await signIn(d.page, USER_A, "a@test.invalid", 1800);
    const retourA = await d.page.evaluate(() => state.userChapters.map(c => c.title));
    eq("A retrouve exactement les siennes", retourA, ["Chapitre révisé"]);

    const db = await dumpDb(d.page);
    const parUser = {};
    (db.tables.subjects || []).forEach(r => { parUser[r.user_id] = (parUser[r.user_id] || 0) + 1; });
    eq("chaque compte a ses propres lignes", parUser, { [USER_A]: 1, [USER_B]: 1 });
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     6. DÉCONNEXION — ON ÉCRIT, PUIS ON EFFACE LE CACHE
     ====================================================================== */
  await scenario("6. la déconnexion n'efface qu'après avoir enregistré", async () => {
    const d = await device(browser, dbAfterEdit);
    await signIn(d.page, USER_A, "a@test.invalid", 1600);

    const avant = await d.page.evaluate((uid) =>
      localStorage.getItem("revisions-etude-marche:u." + uid + ".user-chapters") !== null, USER_A);
    check("le cache du compte existe pendant la session", avant, avant);

    await signOut(d.page, 1500);

    const apres = await d.page.evaluate((uid) => ({
      cache: localStorage.getItem("revisions-etude-marche:u." + uid + ".user-chapters"),
      etat: state.userChapters.length,
      invite: localStorage.getItem("revisions-etude-marche:user-chapters"),
    }), USER_A);
    eq("le cache du compte est effacé à la déconnexion", apres.cache, null);
    eq("l'état affiché ne contient plus ses données", apres.etat, 0);

    /* Et surtout : ce n'est pas une perte, la donnée est dans le compte. */
    const db = await dumpDb(d.page);
    eq("les données sont toujours dans le compte",
      (db.tables.chapters || []).filter(r => r.user_id === USER_A).map(r => r.title), ["Chapitre révisé"]);

    /* Se reconnecter les fait revenir. */
    await signIn(d.page, USER_A, "a@test.invalid", 1800);
    eq("et elles reviennent à la reconnexion",
      await d.page.evaluate(() => state.userChapters.map(c => c.title)), ["Chapitre révisé"]);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     7. « PLUS TARD » — ON NE SYNCHRONISE PAS DANS SON DOS
     ====================================================================== */
  await scenario("7. refuser la migration ne pousse rien en douce", async () => {
    const d = await device(browser);
    await d.page.evaluate(CREATE_DATA, "refus");
    await d.page.waitForTimeout(400);
    await signIn(d.page, USER_B, "b@test.invalid");
    await d.page.click('[data-ds-confirm="no"]');
    await d.page.waitForTimeout(800);

    /* Nouvelle écriture locale APRÈS le refus : elle ne doit pas partir. */
    await d.page.evaluate(() => { state.userSubjects.push({ id: "subj_x", name: "Après refus" }); saveUserSubjects(); });
    await d.page.waitForTimeout(1500);

    const db = await dumpDb(d.page);
    eq("aucune matière n'est partie", (db.tables.subjects || []).length, 0);
    const local = await d.page.evaluate(() => state.userSubjects.map(s => s.name));
    check("et les données locales sont intactes", local.includes("Après refus"), local);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     8. L'INDICATEUR DIT LA VÉRITÉ
     ====================================================================== */
  await scenario("8. l'état de la synchronisation est visible, sans être bruyant", async () => {
    const d = await device(browser, dbAfterEdit);
    const cache = await d.page.evaluate(() => {
      const el = document.getElementById("cloud-indicator");
      return { present: !!el, cache: el ? el.hidden : null };
    });
    check("l'indicateur existe", cache.present, cache);
    check("mais reste caché sans compte", cache.cache === true, cache);

    await signIn(d.page, USER_A, "a@test.invalid", 1800);
    const idle = await d.page.evaluate(() => {
      const el = document.getElementById("cloud-indicator");
      return { cache: el.hidden, classe: el.className };
    });
    check("et affiche « synchronisé » une fois tout enregistré", idle.cache === false && /is-synced/.test(idle.classe), idle);
    const libelle = await d.page.evaluate(() => document.querySelector("#cloud-indicator .cloud-label").textContent);
    eq("avec un libellé lisible", libelle, "Synchronisé");

    /* Une panne doit se voir. */
    const erreur = await d.page.evaluate(async () => {
      cloudState = { phase: "error", at: Date.now(), errors: [] };
      updateCloudIndicator();
      const el = document.getElementById("cloud-indicator");
      return { cache: el.hidden, classe: el.className, titre: el.getAttribute("title") };
    });
    check("une erreur, elle, est affichée", erreur.cache === false, erreur);
    check("avec une classe d'état", /is-pending/.test(erreur.classe), erreur.classe);
    check("et un libellé compréhensible, sans jargon",
      erreur.titre && erreur.titre.length > 10 && !/error|exception|null/i.test(erreur.titre), erreur.titre);
    await d.ctx.close();
  });

  /* ======================================================================
     9. LES ÉCRANS DE CONFIRMATION D'E-MAIL, DANS LES CINQ LANGUES
     ====================================================================== */
  const ETATS = [
    ["#type=signup&access_token=x", "confirmed"],
    ["#type=recovery&access_token=x", "recovery"],
    ["#type=email_change&access_token=x", "email_changed"],
    ["?error=access_denied&error_code=otp_expired", "expired"],
  ];
  await scenario("9. le retour d'un lien e-mail est expliqué, jamais muet", async () => {
    for (const [frag, attendu] of ETATS) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(FAKE_SDK);
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", e => errs.push(String(e)));
      await page.goto(APP + frag);
      await page.waitForTimeout(1400);

      const r = await page.evaluate(() => ({
        etat: state.accountUI.linkResult,
        onglet: state.tab,
        texte: document.getElementById("content").textContent.replace(/\s+/g, " ").trim(),
        url: location.href,
      }));
      eq(`[${attendu}] l'état est reconnu`, r.etat, attendu);
      eq(`[${attendu}] et l'écran du compte est affiché`, r.onglet, "myspace");
      check(`[${attendu}] le jeton est retiré de l'URL`,
        !/access_token|error_code|type=/.test(r.url), r.url);
      check(`[${attendu}] un message explique la situation`, r.texte.length > 40, r.texte.slice(0, 120));
      check(`[${attendu}] sans clé de traduction brute`, !/auth\.[a-z_]+/.test(r.texte), r.texte.slice(0, 160));
      eq(`[${attendu}] aucune erreur JavaScript`, errs, []);

      if (attendu === "recovery") {
        const form = await page.evaluate(() => ({
          champs: document.querySelectorAll("#account-newpass-form input[type=password]").length,
        }));
        eq("le formulaire de nouveau mot de passe est là", form.champs, 2);
      }
      await ctx.close();
    }

    /* Les cinq langues, sur l'écran de confirmation. */
    for (const lang of ["fr", "en", "es", "de", "it"]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(FAKE_SDK);
      await ctx.addInitScript(`try{ localStorage.setItem("lyon-lang", ${JSON.stringify(lang)}); }catch(e){}`);
      const page = await ctx.newPage();
      await page.goto(APP + "#type=signup&access_token=x");
      await page.waitForTimeout(1300);
      await page.evaluate(l => LyonI18n.setLang(l), lang);
      await page.waitForTimeout(400);
      const txt = await page.evaluate(() => {
        const h = document.querySelector("#account-section h2");
        const p = document.querySelector("#account-section p");
        const b = document.getElementById("account-continue-btn");
        return { titre: h && h.textContent.trim(), corps: p && p.textContent.trim(), cta: b && b.textContent.trim() };
      });
      check(`[${lang}] l'écran « compte confirmé » est traduit`,
        !!txt.titre && !!txt.corps && !!txt.cta
        && !/auth\./.test(txt.titre + txt.corps + txt.cta), txt);
      await ctx.close();
    }
  });

  /* ======================================================================
     10. RENVOYER L'E-MAIL
     ====================================================================== */
  await scenario("10. « Renvoyer l'e-mail » est proposé et fonctionne", async () => {
    const d = await device(browser);
    await d.page.evaluate(() => {
      state.accountUI.pendingConfirmationEmail = "eleve@test.invalid";
      switchTab("myspace");
    });
    await d.page.waitForTimeout(500);

    const ui = await d.page.evaluate(() => {
      const b = document.getElementById("account-resend-btn");
      const txt = document.getElementById("account-section").textContent;
      return { bouton: !!b, libelle: b && b.textContent.trim(), rappelleEmail: /eleve@test\.invalid/.test(txt) };
    });
    check("le bouton est là", ui.bouton, ui);
    check("il porte un libellé traduit", ui.libelle && !/auth\./.test(ui.libelle), ui.libelle);
    check("et l'adresse concernée est rappelée", ui.rappelleEmail, ui);

    await d.page.click("#account-resend-btn");
    await d.page.waitForTimeout(700);
    const db = await dumpDb(d.page);
    eq("Supabase est bien sollicité", db.calls.filter(c => c.op === "resend").length, 1);
    const msg = await d.page.evaluate(() => {
      const el = document.getElementById("account-form-msg");
      return el ? el.textContent.trim() : "";
    });
    check("et l'utilisateur est informé", /eleve@test\.invalid/.test(msg), msg);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  /* ======================================================================
     11. AUCUN SECRET DANS LE FRONTEND
     ====================================================================== */
  await scenario("11. rien de secret n'est exposé ni stocké", async () => {
    const d = await device(browser, dbAfterEdit);
    await signIn(d.page, USER_A, "a@test.invalid", 1600);

    const s = await d.page.evaluate(() => {
      const dump = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        dump.push(k + "=" + String(localStorage.getItem(k)).slice(0, 400));
      }
      const blob = dump.join("\n");
      return {
        serviceRole: /service_role|SUPABASE_SERVICE/i.test(blob),
        motDePasse: /"password"|password=/i.test(blob),
        refresh: /refresh_token/i.test(blob),
        cleConfig: (window.SUPABASE_CONFIG || {}).anonKey || "",
      };
    });
    check("aucune service_role key dans le stockage", !s.serviceRole, s);
    check("aucun mot de passe stocké par REV-EM", !s.motDePasse, s);
    check("aucun jeton de rafraîchissement écrit par REV-EM", !s.refresh, s);
    check("la clé de configuration est bien une clé publique",
      /^sb_publishable_|^ey/.test(s.cleConfig), s.cleConfig.slice(0, 20));
    await d.ctx.close();
  });

  /* ======================================================================
     12. CHANGEMENT D'ADRESSE E-MAIL
     ====================================================================== */
  await scenario("12. changer d'adresse passe par Supabase, et ne ment pas", async () => {
    const d = await device(browser, dbAfterEdit);
    await signIn(d.page, USER_A, "a@test.invalid", 1600);

    await d.page.evaluate(() => { switchTab("myspace"); openAccountEditModal(); });
    await d.page.waitForTimeout(500);

    const champ = await d.page.evaluate(() => {
      const el = document.getElementById("account-edit-email");
      const hint = el && el.parentElement.querySelector(".hint");
      return { present: !!el, valeur: el && el.value, indication: hint && hint.textContent.trim() };
    });
    check("l'adresse est modifiable", champ.present, champ);
    eq("elle est pré-remplie avec celle du compte connecté", champ.valeur, "a@test.invalid");
    check("et l'interface annonce la confirmation à venir",
      champ.indication && champ.indication.length > 20 && !/account\./.test(champ.indication), champ.indication);

    /* Une adresse invalide est refusée avant tout appel réseau. */
    await d.page.evaluate(() => { document.getElementById("account-edit-email").value = "pas-une-adresse"; });
    await d.page.click("#account-modal-save");
    await d.page.waitForTimeout(600);
    const refus = await d.page.evaluate(() => ({
      message: (document.getElementById("account-edit-msg") || {}).textContent || "",
      appels: globalThis.__DB.calls.filter(c => c.op === "updateUser").length,
    }));
    check("une adresse invalide est refusée", refus.message.length > 5, refus.message);
    eq("et rien n'est envoyé à Supabase", refus.appels, 0);

    /* Une adresse valide déclenche le mécanisme Supabase prévu. */
    await d.page.evaluate(() => { document.getElementById("account-edit-email").value = "nouvelle@test.invalid"; });
    await d.page.click("#account-modal-save");
    await d.page.waitForTimeout(900);
    const envoi = await d.page.evaluate(() => ({
      appels: globalThis.__DB.calls.filter(c => c.op === "updateUser"),
      toast: (document.querySelector(".toast") || {}).textContent || "",
    }));
    eq("Supabase est appelé une fois", envoi.appels.length, 1);
    eq("avec la nouvelle adresse", envoi.appels[0].payload, { email: "nouvelle@test.invalid" });
    check("et on annonce que la confirmation reste à faire",
      /confirmation|lien/i.test(envoi.toast), envoi.toast);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });


  /* ======================================================================
     13. HORS LIGNE — LE TRAVAIL LOCAL N'EST JAMAIS PERDU
     ====================================================================== */
  const ADD_OFFLINE = () => {
    state.userSubjects.push({ id: "subj_off", name: "Créée hors ligne", semesterId: (SEMESTERS[0] || {}).id, color: "#E31C3D" });
    saveUserSubjects();
  };
  const signedInDevice = async (db) => {
    const d = await device(browser, db);
    await signIn(d.page, USER_A, "a@test.invalid", 1800);
    return d;
  };
  const subjectsInDb = (page) => page.evaluate(() => (globalThis.__DB.tables.subjects || []).map(r => r.name).sort());

  for (const variante of ["app tuée avant tout envoi", "fermeture normale (envoi de dernière minute)"]) {
  await scenario(`13. modifié hors ligne, rouvert EN LIGNE — ${variante} : rien n'est écrasé`, async () => {
    const d = await signedInDevice(dbAfterA);
    await d.ctx.setOffline(true);
    await d.page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "1"));
    await d.page.evaluate(ADD_OFFLINE);
    await d.page.waitForTimeout(1500);
    const off = await d.page.evaluate(() => ({
      classe: document.getElementById("cloud-indicator").className,
      libelle: document.querySelector("#cloud-indicator .cloud-label").textContent,
      file: cloudPendingOf(LyonAuth.state.user.id),
    }));
    check("l'indicateur dit « Hors connexion »", /is-offline/.test(off.classe) && off.libelle === "Hors connexion", off);
    check("la modification est notée « à envoyer » (persistée)", off.file.includes("subjects"), off.file);
    eq("rien n'est encore parti", await subjectsInDb(d.page), ["Matière a"]);

    /* L'onglet est fermé, l'appareil retrouve du réseau, l'élève rouvre. */
    await d.ctx.setOffline(false);
    await d.page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "0"));
    /* « App tuée » : le navigateur est fermé sans avoir le temps d'envoyer quoi
       que ce soit. Seule la file persistée dans le stockage local survit —
       c'est précisément ce que ce scénario protège. */
    if (variante.startsWith("app tuée")) await d.page.evaluate(() => cloud.dispose());
    await reloadDevice(d.page, { wait: 2600 });
    const apres = await d.page.evaluate(() => ({
      local: state.userSubjects.map(s => s.name).sort(),
      file: cloudPendingOf(LyonAuth.state.user.id),
      classe: document.getElementById("cloud-indicator").className,
    }));
    eq("la matière créée hors ligne est TOUJOURS là", apres.local, ["Créée hors ligne", "Matière a"]);
    eq("elle est arrivée dans le compte", await subjectsInDb(d.page), ["Créée hors ligne", "Matière a"]);
    eq("la file « à envoyer » est vide", apres.file, []);
    check("et l'indicateur est revenu à « synchronisé »", /is-synced/.test(apres.classe), apres.classe);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });
  }

  await scenario("14. la reconnexion envoie sans rechargement (événement « online »)", async () => {
    const d = await signedInDevice(dbAfterA);
    await d.ctx.setOffline(true);
    await d.page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "1"));
    await d.page.evaluate(ADD_OFFLINE);
    await d.page.waitForTimeout(1300);
    eq("hors ligne : rien ne part", await subjectsInDb(d.page), ["Matière a"]);
    await d.page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "0"));
    await d.ctx.setOffline(false);
    await d.page.waitForTimeout(1800);
    eq("le réseau revient : ça part tout seul", await subjectsInDb(d.page), ["Créée hors ligne", "Matière a"]);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  await scenario("15. panne serveur (en ligne) : nouvelle tentative automatique", async () => {
    const d = await signedInDevice(dbAfterA);
    await d.page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "1"));
    await d.page.evaluate(ADD_OFFLINE);
    await d.page.waitForTimeout(1600);
    const panne = await d.page.evaluate(() => ({
      classe: document.getElementById("cloud-indicator").className,
      toasts: [...document.querySelectorAll(".toast")].map(x => x.textContent.trim()),
    }));
    check("l'indicateur dit « à terminer »", /is-pending/.test(panne.classe), panne);
    await d.page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "0"));
    await d.page.waitForTimeout(3500);
    eq("le serveur revient : réessayé sans action de l'élève", await subjectsInDb(d.page), ["Créée hors ligne", "Matière a"]);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  for (const reponse of ["yes", "alt"]) {
  await scenario(`16. première lecture en échec, travail local, puis reprise — l'utilisateur répond « ${reponse === "yes" ? "envoyer" : "utiliser mon compte"} »`, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(`globalThis.__DB = ${JSON.stringify(dbAfterA)};`);
    await ctx.addInitScript(FAKE_SDK);
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", e => errs.push(String(e)));
    await page.goto(APP);
    await page.waitForTimeout(800);
    await page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "1"));
    await signIn(page, USER_A, "a@test.invalid", 1500);
    const echec = await page.evaluate(() => ({
      classe: document.getElementById("cloud-indicator").className,
      toast: [...document.querySelectorAll(".toast")].map(x => x.textContent.trim()).join(" | "),
      chargement: state.accountLoading,
    }));
    check("l'échec est dit à l'élève (une fois)", /récupérer/i.test(echec.toast), echec.toast);
    check("l'indicateur dit « à terminer »", /is-pending/.test(echec.classe), echec.classe);
    eq("l'écran de chargement ne reste pas bloqué", echec.chargement, false);

    /* Il travaille quand même : la modification est mise de côté. */
    await page.evaluate(ADD_OFFLINE);
    check("elle est notée « à envoyer »",
      await page.evaluate(() => cloudPendingOf(LyonAuth.state.user.id).includes("subjects")));
    eq("rien n'est parti", await subjectsInDb(page), ["Matière a"]);

    /* Le réseau revient : cet appareil a du travail ET le compte a des données
       — c'est la question de première connexion, jamais une fusion en douce. */
    await page.evaluate(() => sessionStorage.setItem("__NET_DOWN", "0"));
    await page.waitForTimeout(4500);
    const modale = await page.evaluate(() => !!document.querySelector(".modal--confirm"));
    check("la question de première connexion est posée", modale);
    eq("et rien n'est parti avant la réponse", await subjectsInDb(page), ["Matière a"]);
    await page.click(reponse === "yes" ? '[data-ds-confirm="yes"]' : '[data-ds-confirm="alt"]');
    await page.waitForTimeout(2000);
    const fin = await page.evaluate(() => ({
      local: state.userSubjects.map(s => s.name).sort(),
      file: cloudPendingOf(LyonAuth.state.user.id),
      classe: document.getElementById("cloud-indicator").className,
    }));
    if (reponse === "yes") {
      eq("après fusion : données du compte ET travail local", fin.local, ["Créée hors ligne", "Matière a"]);
      eq("et le compte a reçu la matière locale", await subjectsInDb(page), ["Créée hors ligne", "Matière a"]);
    } else {
      eq("« utiliser mon compte » : le compte fait foi", fin.local, ["Matière a"]);
      eq("et le compte n'a pas reçu la matière locale écartée", await subjectsInDb(page), ["Matière a"]);
    }
    eq("la file « à envoyer » est vide", fin.file, []);
    check("indicateur « synchronisé »", /is-synced/.test(fin.classe), fin.classe);
    eq("aucune erreur JavaScript", errs, []);
    await ctx.close();
  });
  }

  /* ======================================================================
     17. ISOLATION — A puis B puis A, sans fuite ni flash
     ====================================================================== */
  await scenario("17. changement de compte : aucune donnée de A visible pour B, même une milliseconde", async () => {
    const d = await signedInDevice(dbAfterA);
    await d.page.evaluate(() => {
      state.tab = "library"; render();
      window.__leaks = [];
      window.__sample = setInterval(() => {
        const uid = currentAuthId();
        const inState = JSON.stringify([state.userSubjects, state.userChapters, state.progress, state.dash.totalAnswered]).includes("Matière a")
          || state.dash.totalAnswered === 20;
        const inDom = (document.getElementById("content").textContent || "").includes("Matière a");
        if (uid === "22222222-2222-4222-8222-222222222222" && (inState || inDom)) window.__leaks.push({ inState, inDom, t: performance.now() });
      }, 2);
    });
    const avantA = await d.page.evaluate(() => state.userSubjects.map(s => s.name));
    eq("A voit ses matières", avantA, ["Matière a"]);

    await signIn(d.page, USER_B, "b@test.invalid", 2200);
    const b = await d.page.evaluate(() => ({
      leaks: window.__leaks,
      subjects: state.userSubjects.length, answered: state.dash.totalAnswered,
      progress: Object.keys(state.progress).length,
      nsA: Object.keys(localStorage).filter(k => k.includes("u.11111111") && !k.endsWith(".cloud-choice")).length,
      texte: document.getElementById("content").textContent,
    }));
    eq("aucune fuite observée pendant toute la bascule", b.leaks, []);
    eq("B démarre sans matière", b.subjects, 0);
    eq("ni compteur", b.answered, 0);
    check("l'écran de B ne mentionne pas la matière de A", !/Matière a/.test(b.texte), b.texte.slice(0, 200));
    eq("le cache de A a été effacé après envoi confirmé (hors choix de migration, conservé)", b.nsA, 0);
    check("les données de A sont bien dans le compte", (await subjectsInDb(d.page)).includes("Matière a"));

    await d.page.evaluate(() => { ((tag)=>{ state.userSubjects = [{ id: 'subj_'+tag, name: 'Matière '+tag, semesterId: (SEMESTERS[0]||{}).id, color: '#E31C3D' }]; saveUserSubjects(); })('b'); });
    await d.page.waitForTimeout(1500);
    await signOut(d.page, 1500);
    const invite = await d.page.evaluate(() => ({ subjects: state.userSubjects.length, tab: state.tab }));
    eq("déconnecté : espace invité vide", invite.subjects, 0);

    await signIn(d.page, USER_A, "a@test.invalid", 2200);
    const a2 = await d.page.evaluate(() => ({
      subjects: state.userSubjects.map(s => s.name), leaks: window.__leaks,
    }));
    eq("A retrouve exactement ses données, sans celles de B", a2.subjects, ["Matière a"]);
    eq("toujours aucune fuite", a2.leaks, []);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  await scenario("18. déconnexion : ce qui attend encore part AVANT la fin de session", async () => {
    const d = await signedInDevice(dbAfterA);
    await d.page.evaluate(() => { state.userSubjects.push({ id: 'subj_off', name: 'Créée hors ligne', semesterId: (SEMESTERS[0]||{}).id, color: '#E31C3D' }); saveUserSubjects(); switchTab("myspace"); });
    await d.page.waitForTimeout(150);
    await d.page.click("#account-signout-btn");
    await d.page.waitForTimeout(1800);
    eq("la matière créée juste avant est dans le compte", await subjectsInDb(d.page), ["Créée hors ligne", "Matière a"]);
    eq("aucune erreur JavaScript", d.errors, []);
    await d.ctx.close();
  });

  await scenario("19. le rechargement (F5) d'un compte connecté ne montre jamais l'espace invité", async () => {
    const d = await signedInDevice(dbAfterA);
    await d.page.reload({ waitUntil: "domcontentloaded" });
    const echant = await d.page.evaluate(() => new Promise(resolve => {
      const seen = [];
      const t0 = performance.now();
      const iv = setInterval(() => {
        // Retire « Analyse de marché » (migrateAnalyseMarcheToUserSubject, voir
        // clearMigratedSubject côté Node) dès qu'elle apparaît pendant cette
        // fenêtre d'observation : ce scénario vérifie l'ISOLATION de compte
        // (jamais l'espace invité pendant le rechargement), pas l'interaction
        // avec cette matière, déjà couverte par analyse-marche-migration.test.mjs.
        if (typeof state !== "undefined" && state.userSubjects) {
          state.userSubjects = state.userSubjects.filter(s => s.id !== "analyse-marche");
          state.userChapters = state.userChapters.filter(c => c.subjectId !== "analyse-marche");
        }
        const sp = !!document.getElementById("boot-splash");
        seen.push({ splash: sp, n: state.userSubjects.length });
        if (performance.now() - t0 > 1800) { clearInterval(iv); resolve(seen); }
      }, 20);
    }));
    const flash = echant.filter(x => !x.splash && x.n === 0);
    eq("jamais d'écran vide visible après le lancement", flash.length, 0);
    check("les matières du compte sont affichées", echant[echant.length - 1].n === 1, echant[echant.length - 1]);
    await d.ctx.close();
  });

  await scenario("20. les quatre états de l'indicateur, dans les cinq langues", async () => {
    const d = await signedInDevice(dbAfterA);
    const LIBELLES = {
      fr: ["Synchronisé", "Synchronisation…", "Hors connexion", "Synchronisation à terminer"],
      en: ["Synced", "Syncing…", "Offline", "Sync to finish"],
      es: ["Sincronizado", "Sincronizando…", "Sin conexión", "Sincronización pendiente"],
      de: ["Synchronisiert", "Synchronisierung…", "Offline", "Synchronisierung ausstehend"],
      it: ["Sincronizzato", "Sincronizzazione…", "Offline", "Sincronizzazione da completare"],
    };
    for (const lang of Object.keys(LIBELLES)) {
      const r = await d.page.evaluate((l) => {
        LyonI18n.setLang(l);
        const lu = () => { updateCloudIndicator(); const el = document.getElementById("cloud-indicator"); return el.querySelector(".cloud-label").textContent + "|" + el.className; };
        const out = [];
        cloudState = { phase: "idle", at: 1, errors: [] }; out.push(lu());
        cloudState = { phase: "pulling", at: 1, errors: [] }; out.push(lu());
        cloudState = { phase: "idle", at: 1, errors: [] };
        return { out, lecture: null };
      }, lang);
      eq(`[${lang}] synchronisé`, r.out[0], LIBELLES[lang][0] + "|cloud-status is-synced");
      eq(`[${lang}] synchronisation`, r.out[1], LIBELLES[lang][1] + "|cloud-status is-syncing");
      await d.ctx.setOffline(true);
      const off = await d.page.evaluate(() => { updateCloudIndicator(); return document.querySelector("#cloud-indicator .cloud-label").textContent; });
      await d.ctx.setOffline(false);
      eq(`[${lang}] hors connexion`, off, LIBELLES[lang][2]);
      const pend = await d.page.evaluate(() => {
        cloudState = { phase: "error", at: 1, errors: [] }; updateCloudIndicator();
        const x = document.querySelector("#cloud-indicator .cloud-label").textContent;
        cloudState = { phase: "idle", at: 1, errors: [] }; updateCloudIndicator();
        return x;
      });
      eq(`[${lang}] à terminer`, pend, LIBELLES[lang][3]);
    }
    await d.page.evaluate(() => LyonI18n.setLang("fr"));
    await d.ctx.close();
  });


  await scenario("21. sauvegarde, restauration et réinitialisation ne touchent que le compte courant", async () => {
    const d = await signedInDevice(dbAfterA);
    const P = "revisions-etude-marche:";
    await d.page.evaluate(([P, B]) => {
      /* Le cache d'un AUTRE compte, resté sur cet appareil (appareil partagé). */
      localStorage.setItem(P + "u." + B + ".user-subjects", JSON.stringify([{ id: "secret_b", name: "Secret de B" }]));
      localStorage.setItem(P + "u." + B + ".sync-pending", JSON.stringify(["subjects"]));
      window.__exp = null;
      window.downloadJSON = (obj) => { window.__exp = obj; };
    }, [P, USER_B]);

    const exp = await d.page.evaluate(() => { exportAllData(); return JSON.stringify(window.__exp); });
    check("la sauvegarde contient les données du compte courant", /Matière a/.test(exp), exp.slice(0, 200));
    check("mais RIEN d'un autre compte", !/Secret de B|secret_b/.test(exp), exp.slice(0, 200));
    check("ni de clé préfixée par un compte", !/"u\./.test(exp), exp.slice(0, 200));

    /* Restauration : une clé d'un autre compte est ignorée, une clé inconnue aussi. */
    const contenu = JSON.stringify({ app: "REV-EM", data: {
      "user-subjects": [{ id: "imp1", name: "Importée", semesterId: "s1", color: "#000" }],
      ["u.22222222-2222-4222-8222-222222222222.badges"]: { intrus: { earnedDate: "2026-01-01" } },
      "lyon-lang": "de", "cle-inconnue": { x: 1 },
    } });
    const r2 = await d.page.evaluate(async (txt) => {
      window.readFileAsText = async () => txt;
      await importAllDataFromFile({ name: "sauvegarde.json" });
      return { subjects: lsGet(KEY_USER_SUBJECTS).map(s => s.name), badges: JSON.stringify(lsGet(KEY_BADGES)),
               inconnue: localStorage.getItem("revisions-etude-marche:cle-inconnue") };
    }, contenu);
    eq("la donnée du fichier est restaurée dans le stockage du compte courant (l'app recharge ensuite)", r2.subjects, ["Importée"]);
    check("la clé d'un autre compte est ignorée", !/intrus/.test(r2.badges), r2.badges);
    eq("une clé inconnue n'est pas écrite en vrac dans le stockage", r2.inconnue, null);

    /* Réinitialisation : seul l'espace de A part. */
    const rst = await d.page.evaluate(([P, B]) => {
      localStorage.setItem(P + "lyon-lang", JSON.stringify("de"));
      resetAllData();
      return {
        aRestant: Object.keys(localStorage).filter(k => k.indexOf(P + "u.11111111") === 0 && !k.endsWith(".cloud-choice")).length,
        bIntact: !!localStorage.getItem(P + "u." + B + ".user-subjects"),
        bFile: !!localStorage.getItem(P + "u." + B + ".sync-pending"),
        langue: !!localStorage.getItem(P + "lyon-lang"),
      };
    }, [P, USER_B]);
    eq("le cache du compte courant est vidé", rst.aRestant, 0);
    check("celui de l'autre compte est INTACT (il peut contenir du travail non envoyé)", rst.bIntact && rst.bFile, rst);
    check("la langue de l'appareil est conservée", rst.langue, rst);
    await d.ctx.close();
  });

  /* ======================================================================
     22. TUTEUR MATHS & STATS — le journal voyage, et ne va jamais chez un autre compte
     ====================================================================== */
  await scenario("22. journal du tuteur Maths & Stats : appareil 2 le retrouve, le compte B ne le voit jamais", async () => {
    const d1 = await signedInDevice(dbAfterA);
    await d1.page.evaluate(() => { mtLogEntry(RevemMath.tutor.record({ ts: 1790000000000, topic: "algebra", kind: "quad-solve", difficulty: 1, attempts: 2, hintsUsed: 1, success: true })); });
    await d1.page.waitForTimeout(1500);
    const db = await dumpDb(d1.page);
    const rows = db.tables.math_practice || [];
    eq("une ligne en base, au nom de A, sans énoncé ni réponse", rows.map(r => [r.user_id, r.topic, r.kind, r.difficulty, r.attempts, r.hints_used, r.success, Object.keys(r).filter(k => /statement|answer|text/.test(k)).length]), [[USER_A, "algebra", "quad-solve", 1, 2, 1, true, 0]]);
    await d1.ctx.close();

    const d2 = await device(browser, db);
    await signIn(d2.page, USER_A, "a@test.invalid", 1800);
    const seen = await d2.page.evaluate(() => ({ log: window.revemMathTutor.log().map(e => [e.topic, e.kind, e.attempts, e.hintsUsed, e.success]), m: window.revemMathTutor.progress().topics.algebra.mastery }));
    eq("l'appareil 2 retrouve l'exercice terminé", seen.log, [["algebra", "quad-solve", 2, 1, true]]);
    check("…et sa maîtrise est recalculée (jamais stockée)", seen.m > 0 && seen.m < 100, seen);
    await signOut(d2.page, 1200);
    await signIn(d2.page, USER_B, "b@test.invalid", 1600);
    const b = await d2.page.evaluate(() => { switchTab("ai"); return { log: window.revemMathTutor.log().length, keys: Object.keys(localStorage).filter(k => /math-practice$/.test(k) && k.indexOf("u.11111111") >= 0).length }; });
    await d2.page.waitForTimeout(300);
    eq("B ne voit aucun exercice de A (journal vide)", b.log, 0);
    check("l'écran de B n'affiche aucune progression de A", !/Ma progression en maths[\s\S]*Algèbre/.test(await d2.page.innerText("#mt-card")), "");
    eq("aucune erreur JavaScript", d2.errors, []);
    await d2.ctx.close();
  });

} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${(e && e.stack) || e}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
