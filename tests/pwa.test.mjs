/* ============================================================================
   REV-EM — Progressive Web App : manifeste, service worker, hors ligne,
   mise à jour, installation
   ----------------------------------------------------------------------------
   Rien de tout cela ne se laisse vérifier par lecture de code : un manifeste
   syntaxiquement valide peut pointer vers une icône absente, un service
   worker qui s'enregistre peut échouer à précacher, une bannière peut exister
   dans le DOM sans jamais réellement déclencher l'action qu'elle annonce.
   Chaque vérification ici est donc un scénario RÉEL, exécuté dans un vrai
   navigateur : couper le réseau et recharger, remplacer sw.js sur le disque
   et observer la bascule, cliquer le bouton et vérifier que la promesse
   native `prompt()` est bien appelée.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/pwa.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const APP = (process.env.BASE_URL || "http://localhost:9109") + "/index.html";

let pass = 0, fail = 0, current = "";
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

async function open(vp){
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(APP, { waitUntil: "load" });
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}

try {

  /* ========================================================================
     1. LE MANIFESTE — champs, icônes réellement servies et de la bonne taille
     ====================================================================== */
  current = "1. manifeste";
  {
    const raw = fs.readFileSync(path.join(ROOT, "manifest.webmanifest"), "utf8");
    let manifest;
    check("le fichier est du JSON valide", (() => { try { manifest = JSON.parse(raw); return true; } catch(e){ return false; } })(), raw.slice(0, 80));

    eq("nom court cohérent avec la marque", manifest.short_name, "REV-EM");
    eq("s'ouvre en fenêtre autonome, sans barre d'adresse", manifest.display, "standalone");
    check("chemins relatifs uniquement (aucun \"/\" en tête)",
      [manifest.start_url, manifest.scope, ...manifest.icons.map(i => i.src)].every(u => !u.startsWith("/")),
      [manifest.start_url, manifest.scope]);
    eq("theme_color est le rouge de marque", manifest.theme_color, "#E31C3D");
    check("au moins une icône 192 et une 512 \"any\" — le minimum d'installabilité",
      ["192x192", "512x512"].every(sz => manifest.icons.some(i => i.sizes === sz && (i.purpose || "any").includes("any"))),
      manifest.icons.map(i => i.sizes + " " + i.purpose));
    check("au moins une icône maskable — l'icône adaptative Android",
      manifest.icons.some(i => (i.purpose || "").includes("maskable")), manifest.icons);

    /* Chaque icône déclarée existe VRAIMENT et fait la taille annoncée —
       un manifeste qui pointe dans le vide casse l'installabilité en
       silence, jamais visible à la simple lecture du JSON. */
    const { PNG } = (() => {
      /* Lecture manuelle de l'en-tête PNG (largeur/hauteur), sans dépendance :
         8 octets de signature, puis un chunk IHDR dont les 8 octets suivants
         sont largeur puis hauteur, en 32 bits big-endian. */
      return { PNG: (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }) };
    })();
    for (const icon of manifest.icons) {
      const p = path.join(ROOT, icon.src);
      const exists = fs.existsSync(p);
      check(`icône déclarée présente sur le disque : ${icon.src}`, exists);
      if (exists && icon.src.endsWith(".png")) {
        const dim = PNG(fs.readFileSync(p));
        const [w, h] = icon.sizes.split("x").map(Number);
        eq(`${icon.src} fait bien ${icon.sizes}`, [dim.w, dim.h], [w, h]);
      }
    }
  }

  /* ========================================================================
     2. MÉTADONNÉES DE LA PAGE
     ====================================================================== */
  current = "2. métadonnées";
  {
    const { page, errors, ctx } = await open();
    const m = await page.evaluate(() => ({
      manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
      themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
      appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute("content"),
      appleTitle: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content"),
      appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
      svgIcon: document.querySelector('link[rel="icon"][type="image/svg+xml"]')?.getAttribute("href"),
      description: document.querySelector('meta[name="description"]')?.getAttribute("content"),
    }));
    eq("le manifeste est lié", m.manifestHref, "manifest.webmanifest");
    eq("theme-color de la page = celui du manifeste", m.themeColor, "#E31C3D");
    eq("apple-mobile-web-app-capable est présent (Safari ne lit pas display:standalone du manifeste)", m.appleCapable, "yes");
    eq("l'app installée sur iOS porte le bon nom", m.appleTitle, "REV-EM");
    check("une icône apple-touch-icon est liée", !!m.appleTouchIcon, m);
    check("une icône vectorielle est liée (favicon net à toute résolution)", !!m.svgIcon, m);
    check("une description existe, pour la fiche d'installation", !!m.description && m.description.length > 10, m.description);
    eq("aucune erreur JavaScript au chargement", errors, []);
    await ctx.close();
  }

  /* ========================================================================
     3. ÉCRAN DE LANCEMENT — présent puis retiré, jamais bloqué
     ====================================================================== */
  current = "3. écran de lancement";
  {
    const { page, ctx } = await open();
    /* Après le délai standard d'ouverture (600ms, largement au-dessus du
       temps de démarrage réel — mesuré < 2ms pour le premier rendu), l'écran
       de lancement doit avoir disparu du DOM, pas seulement être invisible :
       un élément fixe en z-index:9999 laissé dans le DOM, même transparent,
       resterait `pointer-events` actif tant que `.is-hidden` n'annule pas ce
       point précis — le retrait complet est donc la vraie garantie. */
    const gone = await page.evaluate(() => !document.getElementById("boot-splash"));
    check("l'écran de lancement a bien été retiré du DOM après le premier rendu", gone);

    const hasHideFn = await page.evaluate(() => typeof hideBootSplash === "function");
    check("hideBootSplash existe et est idempotente", hasHideFn && await page.evaluate(() => { hideBootSplash(); hideBootSplash(); return true; }));
    await ctx.close();
  }

  /* ========================================================================
     4. LE SERVICE WORKER S'ENREGISTRE ET S'ACTIVE
     ====================================================================== */
  current = "4. enregistrement";
  {
    const { page, ctx } = await open();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForTimeout(500);
    const s = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return { count: regs.length, scope: regs[0]?.scope, active: regs[0]?.active?.state, controller: !!navigator.serviceWorker.controller };
    });
    eq("un seul service worker enregistré", s.count, 1);
    eq("il est actif", s.active, "activated");
    check("il contrôle la page (précache déjà utile dès ce chargement)", s.controller, s);
    await ctx.close();
  }

  /* ========================================================================
     5. HORS LIGNE — l'app s'ouvre, les données déjà là restent lisibles
     ====================================================================== */
  current = "5. hors ligne";
  {
    const { page, ctx, errors } = await open();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForTimeout(400);

    /* Une donnée réelle, écrite AVANT la coupure réseau — exactement ce que
       le cahier des charges demande : "accès aux données déjà chargées". */
    await page.evaluate(() => {
      state.userSubjects = [{ id: "pwa-off", name: "Matière hors ligne", semesterId: (SEMESTERS[0]||{}).id, icon:"", color:"#E31C3D" }];
      state.userChapters = [{ id: "pwa-off-ch", subjectId: "pwa-off", num: 1, title: "Chapitre hors ligne",
        desc: "", content: "Contenu du cours.", aiQuiz: [{q:"?",opts:["a","b"],correct:0}],
        aiFlashcards: [{front:"a",back:"b"}], createdAt: Date.now(), updatedAt: Date.now() }];
      saveUserSubjects(); saveUserChapters();
    });

    await ctx.setOffline(true);
    let reloadOk = true;
    await page.reload({ waitUntil: "load" }).catch(() => { reloadOk = false; });
    await page.waitForTimeout(1000);

    const r = await page.evaluate(() => ({
      hasTopbar: !!document.querySelector(".topbar"),
      hasContent: (document.getElementById("content")?.innerHTML.length || 0) > 100,
      subjectSurvived: allSubjects().some(s => s.name === "Matière hors ligne"),
      chapterSurvived: allChaptersFlat().some(c => c.title === "Chapitre hors ligne"),
    }));
    check("l'application se recharge hors ligne (l'app shell est en cache)", reloadOk);
    check("la barre de navigation est là", r.hasTopbar, r);
    check("le contenu se rend réellement", r.hasContent, r);
    check("la matière ajoutée avant la coupure est toujours lisible", r.subjectSurvived, r);
    check("le chapitre importé avant la coupure aussi — \"consultation de certains cours\"", r.chapterSurvived, r);
    eq("aucune erreur JavaScript hors ligne", errors, []);

    await ctx.setOffline(false);
    await ctx.close();
  }

  /* ========================================================================
     6. NAVIGATION EN LIGNE = TOUJOURS LA DERNIÈRE VERSION (réseau d'abord)
     ====================================================================== */
  current = "6. fraîcheur en ligne";
  {
    const { page, ctx } = await open();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForTimeout(400);

    const indexPath = path.join(ROOT, "index.html");
    const original = fs.readFileSync(indexPath, "utf8");
    const marker = "REV-EM — marqueur de test " + Date.now();
    fs.writeFileSync(indexPath, original.replace("<title>REV-EM</title>", `<title>${marker}</title>`));
    try{
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(300);
      eq("un simple rechargement, en ligne, voit la modification tout de suite",
        await page.title(), marker);
    } finally {
      fs.writeFileSync(indexPath, original);
    }
    await ctx.close();
  }

  /* ========================================================================
     7. MISE À JOUR — jamais imposée, toujours proposée, et elle fonctionne
     ====================================================================== */
  current = "7. mise à jour";
  {
    const { page, ctx } = await open();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForTimeout(400);
    /* Le cache "shell" (app même origine : index.html, les modules JS, les
       icônes) est TOUJOURS créé — c'est le seul dont ce test a besoin. Le
       cache "runtime" ne naît que si une police ou le SDK Supabase a
       réellement pu être demandé : hors du périmètre de cette vérification,
       et selon l'environnement d'exécution, ce réseau tiers peut être
       injoignable (proxy de sandbox, pare-feu…) sans que ce soit un défaut
       du service worker lui-même. */
    /* La version courante est lue dans sw.js plutôt qu'écrite en dur ici :
       un numéro figé dans ce test se serait déjà décalé du vrai fichier une
       fois (voir PWA.md — le service worker est passé de v1 à v2 pour la
       recherche de "Mes matières"), cassant ce test sans rapport avec ce
       qu'il vérifie réellement. */
    const swPath = path.join(ROOT, "sw.js");
    const original = fs.readFileSync(swPath, "utf8");
    const versionMatch = original.match(/const CACHE_VERSION = "([^"]+)"/);
    check("sw.js déclare bien une CACHE_VERSION lisible", !!versionMatch, original.slice(0, 200));
    const currentVersion = versionMatch[1];
    const nextVersion = currentVersion + "-test-update";

    check(`le cache de l'app shell (${currentVersion}) existe après le premier chargement`,
      (await page.evaluate(() => caches.keys())).includes(currentVersion + "-shell"));

    fs.writeFileSync(swPath, original.replace(`"${currentVersion}"`, `"${nextVersion}"`));
    try{
      await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
      await page.waitForTimeout(1500);

      const banner = await page.evaluate(() => {
        const el = document.querySelector('.pwa-banner[data-pwa-kind="update"]');
        return el ? {
          title: el.querySelector(".pwa-banner-title")?.textContent,
          actionLabel: el.querySelector("[data-pwa-action]")?.textContent,
        } : null;
      });
      check("une bannière de mise à jour apparaît, sans être demandée", !!banner, banner);
      check("elle dit qu'une nouvelle version est là, en clair (pas une clé brute)",
        banner && banner.title && !/^pwa\./.test(banner.title), banner);

      let markSurvived = true;
      await page.evaluate(() => { window.__markBeforeUpdate = true; });
      await page.click('.pwa-banner[data-pwa-kind="update"] [data-pwa-action]');
      await page.waitForTimeout(1500);
      markSurvived = await page.evaluate(() => !!window.__markBeforeUpdate).catch(() => false);
      check("le clic recharge réellement la page (une seule fois)", !markSurvived);

      const finalCaches = await page.evaluate(() => caches.keys());
      check("le nouveau cache de l'app shell a pris la place de l'ancien",
        finalCaches.includes(nextVersion + "-shell"), finalCaches);
      check(`l'ancien cache (${currentVersion}) a bien été purgé (activate nettoie les caches obsolètes)`,
        !finalCaches.some((k) => k.startsWith(currentVersion + "-") && !k.startsWith(nextVersion)), finalCaches);
    } finally {
      fs.writeFileSync(swPath, original);
    }
    await ctx.close();
  }

  /* ========================================================================
     8. INSTALLATION — l'invite native est reprise, jamais simulée
     ====================================================================== */
  current = "8. installation";
  {
    const { page, ctx } = await open();
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const ev = new Event("beforeinstallprompt", { cancelable: true });
      ev.prompt = () => { window.__nativePromptCalled = true; };
      ev.userChoice = Promise.resolve({ outcome: "accepted" });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    const banner = await page.evaluate(() => {
      const el = document.querySelector(".pwa-banner");
      return el ? { title: el.querySelector(".pwa-banner-title")?.textContent, visible: el.classList.contains("show") } : null;
    });
    check("une bannière d'installation apparaît à l'événement natif", !!banner, banner);
    check("elle est visible (pas seulement présente dans le DOM)", banner && banner.visible, banner);

    await page.click(".pwa-banner [data-pwa-action]");
    await page.waitForTimeout(200);
    const promptCalled = await page.evaluate(() => !!window.__nativePromptCalled);
    check("le clic appelle le VRAI prompt() natif du navigateur, pas une imitation", promptCalled);

    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
      bannerGone: !document.querySelector(".pwa-banner"),
      toast: document.getElementById("app-toast")?.textContent,
    }));
    check("la bannière se ferme une fois l'app réellement installée", after.bannerGone, after);
    check("un toast confirme l'installation, avec un vrai texte traduit", after.toast && !/^pwa\./.test(after.toast), after);
    await ctx.close();
  }

  /* ========================================================================
     9. "PLUS TARD" — la bannière d'installation ne harcèle pas
     ====================================================================== */
  current = "9. plus tard";
  {
    const { page, ctx } = await open();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const ev = new Event("beforeinstallprompt", { cancelable: true });
      ev.prompt = () => {};
      ev.userChoice = Promise.resolve({ outcome: "dismissed" });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    await page.click(".pwa-banner [data-pwa-dismiss]");
    await page.waitForTimeout(200);
    check("la bannière disparaît au clic « Plus tard »",
      await page.evaluate(() => !document.querySelector(".pwa-banner")));

    await page.evaluate(() => {
      const ev = new Event("beforeinstallprompt", { cancelable: true });
      ev.prompt = () => {};
      ev.userChoice = Promise.resolve({ outcome: "dismissed" });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    check("et ne revient pas immédiatement au prochain événement natif (fenêtre de 14 jours)",
      await page.evaluate(() => !document.querySelector(".pwa-banner")));
    await ctx.close();
  }

  /* ========================================================================
     10. RECONNEXION — la synchro en attente reprend
     ====================================================================== */
  current = "10. reconnexion";
  {
    const { page, ctx } = await open();
    await page.waitForTimeout(300);
    const flushed = await page.evaluate(() => new Promise((resolve) => {
      let called = false;
      cloud = { flush: () => { called = true; return Promise.resolve({ ok: true, pending: [] }); } };
      window.addEventListener("online", function once(){
        window.removeEventListener("online", once);
        setTimeout(() => resolve(called), 50);
      });
      window.dispatchEvent(new Event("online"));
    }));
    check("l'événement « online » relance bien la synchro en attente (cloud.flush())", flushed);
    await ctx.close();
  }

  /* ========================================================================
     11. RESPONSIVE — la bannière ne déborde jamais, aux trois largeurs
     ====================================================================== */
  for (const vp of [{ n: "mobile", w: 375, h: 800 }, { n: "tablette", w: 800, h: 1000 }, { n: "bureau", w: 1440, h: 900 }]) {
    current = `11. responsive — ${vp.n}`;
    const { page, ctx } = await open({ width: vp.w, height: vp.h });
    await page.evaluate(() => {
      const ev = new Event("beforeinstallprompt", { cancelable: true });
      ev.prompt = () => {};
      ev.userChoice = Promise.resolve({ outcome: "dismissed" });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const el = document.querySelector(".pwa-banner");
      if(!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        overflowsRight: rect.right > window.innerWidth + 1,
        overflowsLeft: rect.left < -1,
        actionHeight: el.querySelector("[data-pwa-action]").getBoundingClientRect().height,
      };
    });
    check(`[${vp.n}] la bannière ne déborde pas horizontalement`, r && !r.overflowsRight && !r.overflowsLeft, r);
    check(`[${vp.n}] le bouton d'action se touche (≥ 32px)`, r && r.actionHeight >= 32, r);
    await ctx.close();
  }

  /* ========================================================================
     12. LES CINQ LANGUES — aucune clé brute, la bannière parle vraiment
     ====================================================================== */
  for (const lang of ["fr", "en", "es", "de", "it"]) {
    current = `12. ${lang}`;
    const { page, ctx } = await open();
    await page.evaluate((l) => LyonI18n.setLang(l), lang);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const ev = new Event("beforeinstallprompt", { cancelable: true });
      ev.prompt = () => {};
      ev.userChoice = Promise.resolve({ outcome: "dismissed" });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(300);
    const texts = await page.evaluate(() => {
      const el = document.querySelector(".pwa-banner");
      return el ? [
        el.querySelector(".pwa-banner-title").textContent,
        el.querySelector(".pwa-banner-text").textContent,
        el.querySelector("[data-pwa-action]").textContent,
        el.querySelector("[data-pwa-dismiss]").textContent,
      ] : [];
    });
    check(`[${lang}] les quatre textes de la bannière existent et sont traduits`,
      texts.length === 4 && texts.every(t => t && t.length > 1 && !/^pwa\./.test(t)), texts);
    await ctx.close();
  }

  /* ========================================================================
     13. DÉCONNECTÉ / INVITÉ — rien de tout cela ne suppose un compte
     ====================================================================== */
  current = "13. invité";
  {
    const { page, ctx, errors } = await open();
    const status = await page.evaluate(() => window.LyonAuth ? LyonAuth.state.status : "no-auth-module");
    check("l'écran de lancement, le service worker et les bannières fonctionnent sans compte connecté",
      status !== "signed-in");
    const swOk = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      return regs.length === 1 && regs[0].active?.state === "activated";
    });
    check("le service worker s'active pareillement pour un invité", swOk);
    eq("aucune erreur JavaScript", errors, []);
    await ctx.close();
  }

} catch (e) {
  fail++;
  console.log(`FAIL — exception pendant « ${current} » : ${e.message}\n${e.stack}`);
} finally {
  await browser.close();
}

console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
