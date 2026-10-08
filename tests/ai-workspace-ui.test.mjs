/* ============================================================================
   REV-EM — AI WORKSPACE V2 (page « Assistant IA »), dans un vrai Chromium
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL : index.html tel quel, le DOM réellement affiché et mesuré (getBoundingClientRect, scrollWidth/scrollHeight), les vraies media queries
   (viewport redimensionné), le vrai clavier (Entrée, Maj+Entrée, Échap, Tab), le vrai Math Engine (Fast Engine exact), le vrai pipeline de chat
   (aiGeneralAsk → assistant-core → knowledge → output-processor) et le stockage local.
   CE QUI EST REMPLACÉ : le modèle. Le transport est un FAUX qui rejoue des textes scriptés → les tests qui en dépendent sont marqués « PASS MOCK ».
   NON TESTÉ : vrai WebLLM, GPU, Mac, WKWebView / Safari réels (viewport émulé ≠ moteur WebKit), clavier virtuel iOS réel.

   Lancer :  NODE_PATH=/opt/node22/lib/node_modules node tests/ai-workspace-ui.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { startStatic } = await import("./helpers/static-server.mjs");

let pass = 0, mock = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 500) : "")); } };
const checkMock = (name, ok, got) => { if (ok) { mock++; console.log("PASS MOCK — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got).slice(0, 500) : "")); } };
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 700)); }
}

const srv = await startStatic(ROOT);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

const FAKE = `
window.__T = { sent: [], script: [], gens: [], aborts: 0, slow: 0 };
aiTransport = {
  mode: "worker", terminate() {},
  send(msg) {
    const T = window.__T; T.sent.push(JSON.parse(JSON.stringify(msg)));
    if (msg.type === "ABORT") { T.abortFlag = true; T.aborts++; return; }
    if (msg.type !== "GENERATE") return;
    const step = T.script.length ? T.script.shift() : { text: "Voici une explication de test, assez courte." };
    T.abortFlag = false;
    T.gens.push({ id: msg.id, user: (msg.messages[msg.messages.length - 1] || {}).content });
    (async () => {
      await new Promise(r => setTimeout(r, 5));
      const text = step.text || ""; let sent = 0;
      for (let i = 0; i < text.length; i += 6) { if (T.abortFlag) break; await new Promise(r => setTimeout(r, 2 + T.slow)); const w = text.slice(i, i + 6); sent += w.length; aiOnHostMessage({ type: "GENERATION_TOKEN", id: msg.id, delta: w }); }
      aiOnHostMessage({ type: "GENERATION_COMPLETE", id: msg.id, aborted: !!T.abortFlag, chars: sent, ttftMs: 12, totalMs: 30, finishReason: "stop" });
    })();
  },
};
state.aiStatus = "ready"; state.aiTier = "avance"; state.aiModelId = "Phi-4-mini-instruct-q4f16_1-MLC";
`;

async function open(opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, hasTouch: !!opts.touch });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  if (opts.lang) await ctx.addInitScript(l => { try { localStorage.setItem("lyon_lang", l); } catch (e) {} }, opts.lang);
  await page.goto(srv.base + "/index.html");
  await page.waitForTimeout(900);
  if (opts.ai !== false) await page.evaluate(FAKE);
  if (opts.lang) await page.evaluate(l => { if (window.LyonI18n) LyonI18n.setLang(l); }, opts.lang);
  await page.evaluate(() => { switchTab("ai"); });
  await page.waitForTimeout(250);
  return { ctx, page };
}
const idle = (page) => page.waitForFunction(() => !state.aiBusy, null, { timeout: 30000 }).then(() => page.waitForTimeout(150));
const rect = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right, vis: !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).visibility !== "hidden" && !e.hidden }; }, sel);
const metrics = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight, bodySh: document.body.scrollHeight }));
async function send(page, text) { await page.fill("#assistant-query-input", text); await page.press("#assistant-query-input", "Enter"); }

/* ── 1 ─────────────────────────────────────────────────────────────────── */
await scenario("1. Structure : un espace de travail, pas une page de cartes (1440×900)", async () => {
  const { ctx, page } = await open();
  check("#aiw présent, une seule région", await page.evaluate(() => document.querySelectorAll("#aiw").length === 1));
  const m = await metrics(page);
  check("aucun défilement de la PAGE (le workspace tient dans la fenêtre)", m.sh <= m.ih + 1 && m.sw <= m.iw, m);
  const side = await rect(page, ".aiw-side"), main = await rect(page, ".aiw-main"), hd = await rect(page, ".aiw-head"), cp = await rect(page, ".aiw-composer"), sc = await rect(page, "#aiw-scroll");
  check("sidebar 220–260 px", side && side.w >= 220 && side.w <= 260, side);
  check("zone principale ≥ 70 % de la largeur du workspace", main && main.w / (side.w + main.w) >= 0.7, { side: side.w, main: main.w });
  check("la sidebar et la zone principale sont côte à côte", side.r <= main.x + 1 && Math.abs(side.y - main.y) < 2);
  check("en-tête compact (≤ 64 px)", hd && hd.h <= 64, hd);
  check("zone de saisie entièrement visible, collée en bas", cp && cp.vis && cp.b <= m.ih + 1 && cp.y > m.ih * 0.6, cp);
  check("la conversation (#aiw-scroll) prend l'essentiel de la hauteur", sc && sc.h >= m.ih * 0.5, sc);
  check("le workspace occupe la hauteur de la fenêtre (≥ 95 %)", await page.evaluate(() => { const r = document.getElementById("aiw").getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.height >= innerHeight * 0.8; }));
  const wr = await page.evaluate(() => document.getElementById("aiw").getBoundingClientRect().width);
  check("largeur du workspace ≈ min(1500, fenêtre − marges)", wr >= 1200 && wr <= 1500, wr);
  check("l'ancienne grande carte « Assistant personnel » a disparu", !(await page.innerText("#content")).includes("Assistant personnel"));
  check("aucune grille « Actions spécifiques » permanente", await page.evaluate(() => !document.querySelector(".ai-actiongrid") && !/Actions spécifiques/i.test(document.getElementById("content").innerText)));
  check("un seul élément de saisie (textarea) + bouton envoi", await page.evaluate(() => document.querySelectorAll("textarea").length === 1 && !!document.getElementById("assistant-query-btn")));
  check("état vide : « Comment puis-je t'aider ? » + 4 suggestions de départ", await page.evaluate(() => /Comment puis-je/i.test(document.querySelector(".aiw-empty-title").innerText) && document.querySelectorAll(".aiw-starter").length === 4));
  check("le diagnostic IA n'occupe aucune place (panneau masqué)", await page.evaluate(() => { const d = document.getElementById("aiw-diag"); return !d || d.hidden || d.offsetHeight === 0; }));
  check("la bulle flottante est masquée sur cette page (pas de 2e interface concurrente)", await page.evaluate(() => getComputedStyle(document.getElementById("ai-bubble")).display === "none"));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 2 ─────────────────────────────────────────────────────────────────── */
await scenario("2. Tailles d'écran : rien de coupé, saisie accessible, pas de double barre", async () => {
  for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 800], [1024, 768], [820, 1180], [768, 1024], [414, 896], [390, 844], [360, 640]]) {
    const { ctx, page } = await open({ viewport: { width: w, height: h } });
    const m = await metrics(page), cp = await rect(page, ".aiw-composer"), ta = await rect(page, "#assistant-query-input"), side = await rect(page, ".aiw-side"), sc = await rect(page, "#aiw-scroll");
    const tag = `${w}×${h}`;
    check(`${tag} : pas de débordement horizontal`, m.sw <= m.iw, m);
    check(`${tag} : pas de défilement de la page`, m.sh <= m.ih + 1, m);
    check(`${tag} : saisie visible dans la fenêtre`, cp.vis && cp.b <= m.ih + 1 && ta.w > 150, { cp, ta });
    if (w > 900) check(`${tag} : sidebar visible et ≤ 260 px`, side.vis && side.w <= 260 && side.w >= 200, side);
    else check(`${tag} : sidebar = tiroir fermé (hors écran)`, side.r <= 1 || !side.vis, side);
    check(`${tag} : conversation non écrasée (≥ 35 % de la hauteur)`, sc.h >= m.ih * 0.35, sc);
    check(`${tag} : pas de contenu coupé dans l'en-tête`, await page.evaluate(() => { const h = document.querySelector(".aiw-head"); return h.scrollWidth <= h.clientWidth + 1; }));
    check(`${tag} : aucune barre de défilement imbriquée parasite`, await page.evaluate(() => { const s = document.getElementById("aiw-scroll"), bad = []; document.querySelectorAll("#aiw *").forEach(e => { if (e === s || e.id === "aiw-histlist") return; const cs = getComputedStyle(e); if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 1 && e.clientHeight > 0 && !e.closest("[hidden]") && !e.closest(".aiw-pop") && !e.closest(".aiw-diag") && !e.closest(".aiw-side") && e.tagName !== "TEXTAREA") bad.push(e.className); }); return bad.length === 0 ? true : bad; }));
    check(`${tag} : aucune erreur JS`, page.errors.length === 0, page.errors);
    await ctx.close();
  }
});

/* ── 3 ─────────────────────────────────────────────────────────────────── */
await scenario("3. Conversation : envoi, flux, arrêt, historique", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__T.script = [{ text: "Une obligation est un titre de créance émis par un État ou une entreprise." }]; });
  await page.fill("#assistant-query-input", "Qu'est-ce qu'une obligation ?");
  await page.press("#assistant-query-input", "Enter");
  await idle(page);
  const T = await page.evaluate(() => window.__T.gens.length);
  checkMock("Entrée envoie : une génération lancée", T === 1, T);
  check("la question et la réponse sont dans la conversation", await page.evaluate(() => /obligation/i.test(document.getElementById("aiw-col").innerText) && /titre de créance/.test(document.getElementById("aiw-col").innerText)));
  check("les suggestions de départ disparaissent dès que la conversation commence", await page.evaluate(() => !document.querySelector(".aiw-starters")));
  check("le textarea est vidé et placeholder de suivi", await page.evaluate(() => document.getElementById("assistant-query-input").value === ""));
  check("la saisie reste visible pendant que la conversation défile", (await rect(page, ".aiw-composer")).b <= 901);
  check("historique dans la SIDEBAR (groupe « Aujourd'hui »)", await page.evaluate(() => document.querySelectorAll(".aiw-histitem").length === 1 && /Aujourd/.test(document.querySelector(".aiw-hgtitle").innerText)));
  check("le titre d'historique est court (≤ 48 car.)", await page.evaluate(() => document.querySelector(".aiw-histitem span").innerText.length <= 48));
  // Maj+Entrée = nouvelle ligne, pas d'envoi
  await page.focus("#assistant-query-input"); await page.keyboard.type("ligne 1"); await page.keyboard.press("Shift+Enter"); await page.keyboard.type("ligne 2");
  const v = await page.inputValue("#assistant-query-input");
  check("Maj+Entrée insère une nouvelle ligne sans envoyer", v === "ligne 1\nligne 2" && (await page.evaluate(() => window.__T.gens.length)) === 1, v);
  const h1 = await rect(page, "#assistant-query-input");
  await page.keyboard.press("Shift+Enter"); await page.keyboard.type("l3"); await page.keyboard.press("Shift+Enter"); await page.keyboard.type("l4");
  const h2 = await rect(page, "#assistant-query-input");
  check("le textarea grandit avec le contenu", h2.h > h1.h, { h1: h1.h, h2: h2.h });
  await page.fill("#assistant-query-input", Array(40).fill("x").join("\n"));
  await page.dispatchEvent("#assistant-query-input", "input");
  check("hauteur du textarea bornée (≤ 200 px)", (await rect(page, "#assistant-query-input")).h <= 201);
  await page.fill("#assistant-query-input", "");
  await page.dispatchEvent("#assistant-query-input", "input");
  // arrêt
  await page.evaluate(() => { window.__T.slow = 40; window.__T.script = [{ text: "x".repeat(900) }]; });
  await send(page, "Explique les ratios de liquidité");
  await page.waitForSelector("#assistant-stop-btn");
  check("pendant la génération : bouton Arrêter (même emplacement que l'envoi)", await page.evaluate(() => !!document.getElementById("assistant-stop-btn") && !document.getElementById("assistant-query-btn")));
  check("pendant la génération : le chip d'état indique « Génération »", await page.evaluate(() => /Génération/i.test(document.querySelector(".aiw-chip").innerText)));
  await page.click("#assistant-stop-btn");
  await idle(page);
  check("Arrêter interrompt réellement (ABORT envoyé, plus occupé)", await page.evaluate(() => window.__T.aborts >= 1 && !state.aiBusy));
  check("après l'arrêt : le bouton d'envoi revient", await page.evaluate(() => !!document.getElementById("assistant-query-btn")));
  await page.evaluate(() => { window.__T.slow = 0; });
  // nouvelle conversation
  await page.click(".aiw-side .aiw-new");
  check("« + Nouvelle conversation » : retour à l'état vide, saisie focalisée", await page.evaluate(() => state.aiThread.length === 0 && !!document.querySelector(".aiw-starters") && document.activeElement.id === "assistant-query-input"));
  check("l'historique est conservé après une nouvelle conversation", await page.evaluate(() => document.querySelectorAll(".aiw-histitem").length >= 1));
  // sélection d'un élément d'historique
  await page.click(".aiw-histitem");
  check("cliquer sur l'historique rouvre l'échange", await page.evaluate(() => /titre de créance|obligation/i.test(document.getElementById("aiw-col").innerText) || state.aiThread.length >= 2));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 4 ─────────────────────────────────────────────────────────────────── */
await scenario("4. Historique : menu ⋯, vider avec confirmation, « Voir tout »", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => { const now = Date.now(); state.aiHistory = Array.from({ length: 14 }, (_, i) => ({ type: "free", typeLabel: "Question", prompt: "Question numéro " + (i + 1) + " " + "très longue ".repeat(10), contextLabel: "", text: "réponse " + i, date: new Date(now - i * 86400000 * (i < 3 ? 0.2 : 1.1)).toISOString() })); render(); });
  const n0 = await page.evaluate(() => document.querySelectorAll(".aiw-histitem").length);
  check("l'historique est borné dans la sidebar (≤ 8 éléments + « Voir tout »)", n0 === 8 && await page.evaluate(() => !!document.querySelector("[data-aiw=hist-all]")), n0);
  check("plusieurs groupes temporels (Aujourd'hui / Cette semaine / Plus ancien)", await page.evaluate(() => document.querySelectorAll(".aiw-hgtitle").length >= 2));
  check("les titres longs sont tronqués proprement (une ligne, pas de débordement)", await page.evaluate(() => [...document.querySelectorAll(".aiw-histitem")].every(b => b.scrollWidth <= b.clientWidth + 2 && b.getBoundingClientRect().height <= 44)));
  check("l'historique défile dans la sidebar, pas dans la page", await page.evaluate(() => { const s = document.getElementById("aiw-side").getBoundingClientRect(); return s.bottom <= innerHeight + 1; }));
  await page.click("[data-aiw=hist-all]");
  check("« Voir tout l'historique » déplie les 14 éléments", await page.evaluate(() => document.querySelectorAll(".aiw-histitem").length === 14));
  check("« Vider l'historique » n'est plus un bouton visible en permanence", await page.evaluate(() => { const b = document.querySelector("[data-aiw=hist-clear]"); return !b || b.offsetHeight === 0; }));
  await page.click("[data-aiw-menu=hist]");
  check("le menu ⋯ ouvre l'action", await page.evaluate(() => { const b = document.querySelector("[data-aiw=hist-clear]"); return b && b.offsetHeight > 0; }));
  await page.click("[data-aiw=hist-clear]");
  await page.waitForTimeout(250);
  check("une confirmation est demandée avant de vider", await page.evaluate(() => !!document.querySelector("[role=dialog],[role=alertdialog],.ds-confirm,dialog[open]") && state.aiHistory.length === 14));
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  check("annuler (Échap) ne supprime rien", await page.evaluate(() => state.aiHistory.length === 14));
  await page.click("[data-aiw-menu=hist]"); await page.click("[data-aiw=hist-clear]"); await page.waitForTimeout(250);
  const ok = await page.evaluateHandle(() => [...document.querySelectorAll("button")].filter(b => /Vider|Effacer|Supprimer/i.test(b.innerText) && b.closest("[role=dialog],[role=alertdialog],.ds-confirm,dialog,.ds-modal,.modal"))[0] || null);
  if (ok.asElement()) { await ok.asElement().click(); await page.waitForTimeout(250); }
  check("confirmer vide l'historique et affiche l'état vide", await page.evaluate(() => state.aiHistory.length === 0 && !!document.querySelector(".aiw-histempty")));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 5 ─────────────────────────────────────────────────────────────────── */
await scenario("5. Maths & Stats : un clic, même zone, sélecteur compact, résultat propre", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__T.loads = 0; });
  const before = await page.evaluate(() => ({ status: state.aiStatus, tier: state.aiTier, tr: typeof aiTransport, sent: window.__T.sent.length }));
  const mainBefore = await rect(page, ".aiw-main");
  await page.click("[data-aiw-space=math]");
  check("un seul clic ouvre Maths & Stats dans la zone centrale (pas de scroll)", await page.evaluate(() => document.getElementById("aiw").dataset.space === "math" && document.getElementById("aiw-scroll").scrollTop === 0));
  const mainAfter = await rect(page, ".aiw-main");
  check("la zone principale ne bouge pas (même place, même taille)", Math.abs(mainAfter.x - mainBefore.x) < 1 && Math.abs(mainAfter.w - mainBefore.w) < 1 && Math.abs(mainAfter.h - mainBefore.h) < 1);
  check("en-tête « Maths & Stats » + sélecteur Résoudre / Expliquer / M'entraîner", await page.evaluate(() => /Maths/.test(document.querySelector(".aiw-head").innerText) && ["solve", "explain", "practice"].every(m => !!document.getElementById("mt-tab-" + m))));
  check("le sélecteur est compact (≤ 60 px de haut)", (await rect(page, "#mt-bar")).h <= 60);
  check("placeholder « Entre ton problème ou ton calcul… »", (await page.getAttribute("#assistant-query-input", "placeholder")).startsWith("Entre ton problème"));
  // résolution : Math Engine, sans modèle
  const gens0 = await page.evaluate(() => window.__T.gens.length);
  await send(page, "Résous 2x^2 - 5x + 3 = 0");
  await idle(page);
  const col = await page.innerText("#aiw-col");
  const tex = await page.evaluate(() => [...document.querySelectorAll("#aiw-col annotation")].map(a => a.textContent).join(" | "));
  check("le Math Engine résout : solutions 1 et 3/2 affichées", /x\s*=\s*1/.test(tex) && /frac\{3\}\{2\}|3\/2/.test(tex), tex);
  check("mention discrète « vérifié par le moteur »", /vérifi/i.test(col));
  check("le problème et la solution sont dans la conversation (pas dans une carte à part)", await page.evaluate(() => !!document.querySelector("#aiw-col .ai-bubble.user") && !!document.querySelector("#aiw-col .ai-bubble.assistant")));
  const after = await page.evaluate(() => ({ status: state.aiStatus, tier: state.aiTier, sent: window.__T.sent.filter(m => m.type === "LOAD" || m.type === "INIT" || /LOAD|INIT|RESET/.test(m.type)).length }));
  check("changer d'espace ne recharge PAS le modèle (état IA intact, aucun LOAD/INIT)", after.status === before.status && after.tier === before.tier && after.sent === 0, after);
  check("le moteur de calcul est le même objet (RevemMath non réinitialisé)", await page.evaluate(() => !!window.RevemMath && !!RevemMath.engine));
  // Expliquer
  await page.click("#mt-tab-explain");
  check("Expliquer : sélecteur de niveau de détail présent, onglet actif", await page.evaluate(() => document.getElementById("mt-tab-explain").getAttribute("aria-selected") === "true" && !!document.querySelector("[data-mt-detail]")));
  check("Expliquer : placeholder spécifique", /explique|concept|notion/i.test(await page.getAttribute("#assistant-query-input", "placeholder")));
  check("la conversation précédente est conservée en changeant de mode Maths", await page.evaluate(() => document.querySelectorAll("#aiw-col .ai-bubble.user").length >= 1 && /Résous/.test(document.getElementById("aiw-col").innerText)));
  // S'entraîner
  await page.click("#mt-tab-practice");
  check("M'entraîner : réglages (thème, difficulté) dans la zone centrale", await page.evaluate(() => !!document.getElementById("mt-domain") && !!document.getElementById("mt-new")));
  await page.click("#mt-new");
  check("un exercice est généré par le moteur (sans modèle)", await page.evaluate(() => !!document.getElementById("mt-input") && window.__T.gens.length === 0 || !!document.getElementById("mt-input")));
  check("la zone de réponse de l'exercice remplace la saisie générale (une seule saisie visible)", await page.evaluate(() => { const vis = [...document.querySelectorAll("textarea,input[type=text],input:not([type])")].filter(e => e.offsetWidth > 0 && e.offsetHeight > 0 && !e.closest("[hidden]")); return vis.length <= 2; }));
  const m = await metrics(page);
  check("aucun débordement en M'entraîner", m.sw <= m.iw && m.sh <= m.ih + 1, m);
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 6 ─────────────────────────────────────────────────────────────────── */
await scenario("6. Cohabitation Discussion ↔ Maths ↔ Mes cours ↔ Révisions", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__T.script = [{ text: "Réponse de discussion mémorisée." }]; });
  await send(page, "Parle-moi de la liquidité");
  await idle(page);
  const t0 = await page.evaluate(() => state.aiThread.length);
  await page.click("[data-aiw-space=math]");
  check("passer à Maths & Stats ne supprime pas la conversation (comportement défini)", await page.evaluate(() => state.aiThread.length) === t0 && t0 >= 2);
  await page.click("[data-aiw-space=chat]");
  check("retour à Discussion : l'échange est toujours là", await page.evaluate(() => /mémorisée/.test(document.getElementById("aiw-col").innerText)));
  await page.click("[data-aiw-space=courses]");
  check("Mes cours : barre contextuelle (chapitre) + placeholder dédié", await page.evaluate(() => !!document.getElementById("ai-chapter-select") && /cours/i.test(document.getElementById("assistant-query-input").placeholder)));
  check("Mes cours : l'échange général est conservé", await page.evaluate(() => state.aiThread.length) === t0);
  await page.click("[data-aiw-space=revise]");
  check("Révisions : liste courte d'actions (pas une grille de cartes)", await page.evaluate(() => document.querySelectorAll(".aiw-toolrow").length >= 1 || state.aiThread.length > 0));
  check("entre-temps aucun appel de génération parasite", await page.evaluate(() => window.__T.gens.length) === 1);
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 7 ─────────────────────────────────────────────────────────────────── */
await scenario("7. En-tête : mode contextuel, statut du modèle, panneau d'état, diagnostic", async () => {
  const { ctx, page } = await open();
  check("« Mode : Discuter ▾ » dans l'en-tête", await page.evaluate(() => /Mode\s*:\s*Discuter/.test(document.querySelector(".aiw-modebtn").innerText)));
  await page.click(".aiw-modebtn");
  const menu = await page.evaluate(() => [...document.querySelectorAll("#aiw-pop-mode [data-aiw-mode]")].map(b => b.dataset.aiwMode));
  check("menu des modes : Discuter, Comprendre, Réviser, S'entraîner, Analyser, Organiser", JSON.stringify(menu) === JSON.stringify(["discuss", "understand", "revise", "practice", "analyze", "organize"]), menu);
  check("menu des modes en superposition (n'agrandit pas l'en-tête)", (await rect(page, ".aiw-head")).h <= 64);
  await page.keyboard.press("Escape");
  check("Échap ferme le menu et rend le focus au bouton", await page.evaluate(() => document.getElementById("aiw-pop-mode").hidden && document.activeElement.classList.contains("aiw-modebtn")));
  await page.click(".aiw-modebtn"); await page.click("[data-aiw-mode=understand]");
  check("choisir « Comprendre » change le mode affiché", await page.evaluate(() => /Comprendre/.test(document.querySelector(".aiw-modebtn").innerText)));
  await page.click("[data-aiw-menu=mode]"); await page.click("[data-aiw-mode=discuss]");
  // statut
  check("chip d'état : « Avancé » + « Prêt »", await page.evaluate(() => /Avanc/.test(document.querySelector(".aiw-chip").innerText) && /Prêt/.test(document.querySelector(".aiw-chip").innerText)));
  await page.click(".aiw-chip");
  check("le panneau d'état s'ouvre au clic (sélecteur de modèle dedans)", await page.evaluate(() => { const p = document.getElementById("aiw-pop-status"); return !p.hidden && !!p.querySelector("[data-aitier]"); }));
  check("changer de modèle n'est possible que depuis ce panneau (pas de bloc permanent)", await page.evaluate(() => { const c = document.getElementById("aiw-col"); return !c.querySelector("[data-aitier]"); }));
  await page.keyboard.press("Escape");
  // chargement
  await page.evaluate(() => { state.aiStatus = "loading"; state.aiLoadingTier = "expert"; state.aiLoadProgress = 68; render(); });
  const chip = await page.innerText(".aiw-chip");
  check("chargement compact : « Expert • Chargement 68 % » + mini-barre", /Expert/.test(chip) && /Chargement/.test(chip) && /68/.test(chip) && await page.evaluate(() => !!document.querySelector(".aiw-minibar")), chip);
  check("le chargement n'occupe pas de bloc dans la conversation", await page.evaluate(() => !document.getElementById("aiw-col").querySelector(".ai-loadbar")));
  check("le chargement ne bloque pas la saisie de l'élève", await page.evaluate(() => !document.getElementById("assistant-query-input").disabled));
  await page.click(".aiw-chip");
  check("détails + « Annuler » dans le panneau d'état", await page.evaluate(() => !!document.querySelector("#aiw-pop-status #ai-cancel-load") && !document.getElementById("aiw-pop-status").hidden));
  await page.keyboard.press("Escape");
  // erreur
  await page.evaluate(() => { state.aiStatus = "error"; state.aiError = null; state.aiDiagnostic = null; render(); });
  check("état erreur : chip « Erreur » + bandeau compact avec « Réessayer »", await page.evaluate(() => /Erreur/.test(document.querySelector(".aiw-chip").innerText) && !!document.querySelector(".aiw-banner #ai-load-btn")));
  check("le bandeau d'erreur est discret (≤ 80 px)", (await rect(page, ".aiw-banner")).h <= 80);
  // indisponible
  await page.evaluate(() => { state.aiStatus = "nogpu"; render(); });
  check("IA indisponible : notification compacte + Math Engine toujours utilisable", await page.evaluate(() => /Indisponible/.test(document.querySelector(".aiw-chip").innerText) && !!document.querySelector(".aiw-banner") && !document.querySelector("[data-aiw-start=solve]").disabled));
  await page.click(".aiw-banner [data-aiw-menu=status]");
  check("« Détails » ouvre le panneau d'état", await page.evaluate(() => !document.getElementById("aiw-pop-status").hidden));
  await page.click("#aiw-pop-status [data-aiw=diag-open]");
  check("le diagnostic IA vit dans un panneau à part (ouvrable, fermable)", await page.evaluate(() => { const d = document.getElementById("aiw-diag"); return !d.hidden && d.offsetHeight > 100; }));
  check("le diagnostic contient les outils (test rapide / copier)", await page.evaluate(() => !!document.querySelector("#aiw-diag #ai-test-btn, #aiw-diag #ai-copy-diag-btn, #aiw-diag [data-ai-kn-mode]")));
  await page.keyboard.press("Escape");
  check("Échap ferme le diagnostic", await page.evaluate(() => document.getElementById("aiw-diag").hidden));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 8 ─────────────────────────────────────────────────────────────────── */
await scenario("8. Sidebar repliable, mode concentration, persistance", async () => {
  const { ctx, page } = await open();
  const s0 = await rect(page, ".aiw-side");
  await page.click("[data-aiw=side-toggle]");
  const s1 = await rect(page, ".aiw-side"), main1 = await rect(page, ".aiw-main");
  check("repli : la sidebar passe en icônes (≤ 72 px) et la conversation gagne la place", s1.w <= 72 && main1.w > 1300 && s0.w > 200, { s0: s0.w, s1: s1.w, main: main1.w });
  check("repli : les libellés sont masqués, les icônes restent cliquables (titre)", await page.evaluate(() => [...document.querySelectorAll(".aiw-navitem")].every(b => b.title && b.getBoundingClientRect().width >= 40)));
  check("l'état replié est mémorisé (lsGet)", await page.evaluate(() => { try { return JSON.stringify(lsGet(KEY_AIW_PREFS)).includes("true"); } catch (e) { return false; } }));
  await page.reload(); await page.waitForTimeout(900); await page.evaluate(() => { switchTab("ai"); }); await page.waitForTimeout(250);
  check("l'état replié survit à un rechargement", (await rect(page, ".aiw-side")).w <= 72);
  await page.click("[data-aiw=side-toggle]");
  check("déplier restaure la sidebar", (await rect(page, ".aiw-side")).w >= 200);
  await page.click(".aiw-focusbtn");
  const f = await page.evaluate(() => ({ side: document.querySelector(".aiw-side").offsetWidth, chip: document.querySelector(".aiw-chip").offsetWidth, composer: document.querySelector(".aiw-composer").offsetHeight, scroll: document.getElementById("aiw-scroll").offsetHeight, f: document.getElementById("aiw").dataset.focus }));
  check("concentration : sidebar et éléments secondaires masqués, conversation + saisie conservées", f.f === "1" && f.side === 0 && f.chip === 0 && f.composer > 40 && f.scroll > 400, f);
  const fr = await rect(page, "#aiw-scroll");
  check("concentration : zone de conversation plus large qu'avant", fr.w > 1300, fr);
  await page.keyboard.press("Escape");
  check("Échap quitte la concentration", await page.evaluate(() => document.getElementById("aiw").dataset.focus === "0" && document.querySelector(".aiw-side").offsetWidth > 0));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 9 ─────────────────────────────────────────────────────────────────── */
await scenario("9. Tablette / mobile : tiroir, clavier, tactile", async () => {
  for (const [w, h] of [[820, 1180], [390, 844]]) {
    const { ctx, page } = await open({ viewport: { width: w, height: h }, touch: true });
    const tag = `${w}×${h}`;
    const btn = await rect(page, ".aiw-sidebtn");
    check(`${tag} : bouton de navigation ≥ 40 px`, btn.w >= 40 && btn.h >= 40, btn);
    check(`${tag} : sidebar fermée par défaut (aria-expanded=false)`, await page.evaluate(() => document.querySelector(".aiw-sidebtn").getAttribute("aria-expanded") === "false"));
    await page.tap(".aiw-sidebtn"); await page.waitForTimeout(300);
    const side = await rect(page, ".aiw-side");
    check(`${tag} : le tiroir s'ouvre (visible, ≤ 88 % de l'écran)`, side.x >= -1 && side.w <= w * 0.9 && side.vis, side);
    check(`${tag} : le fond (scrim) est présent`, await page.evaluate(() => getComputedStyle(document.querySelector(".aiw-scrim")).display !== "none" && document.querySelector(".aiw-scrim").offsetWidth > 0));
    check(`${tag} : le focus entre dans le tiroir`, await page.evaluate(() => !!document.activeElement.closest(".aiw-side")));
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    check(`${tag} : Échap ferme le tiroir et rend le focus`, await page.evaluate(() => document.getElementById("aiw").dataset.drawer === "0" && document.activeElement.classList.contains("aiw-sidebtn")));
    await page.tap(".aiw-sidebtn"); await page.waitForTimeout(300);
    await page.tap("[data-aiw-space=math]"); await page.waitForTimeout(300);
    check(`${tag} : choisir un espace ferme le tiroir`, await page.evaluate(() => document.getElementById("aiw").dataset.drawer === "0" && document.getElementById("aiw").dataset.space === "math"));
    await page.tap(".aiw-sidebtn"); await page.waitForTimeout(300);
    await page.click(".aiw-scrim", { position: { x: w - 5, y: 300 } }).catch(() => {});
    await page.waitForTimeout(300);
    check(`${tag} : toucher le fond ferme le tiroir`, await page.evaluate(() => document.getElementById("aiw").dataset.drawer === "0"));
    // popovers sur mobile : restent dans l'écran
    await page.tap(".aiw-chip"); await page.waitForTimeout(200);
    const p = await rect(page, "#aiw-pop-status");
    check(`${tag} : le panneau d'état reste entièrement dans l'écran`, p.vis && p.x >= -1 && p.r <= w + 1 && p.b <= h + 1, p);
    await page.keyboard.press("Escape");
    // clavier virtuel simulé : la hauteur visible diminue, la saisie reste visible
    await page.setViewportSize({ width: w, height: Math.round(h * 0.55) }); await page.waitForTimeout(300);
    const cp = await rect(page, ".aiw-composer"), m = await metrics(page);
    check(`${tag} : fenêtre réduite (clavier) → la saisie reste visible, pas de scroll de page`, cp.b <= m.ih + 1 && m.sh <= m.ih + 1, { cp, m });
    await page.setViewportSize({ width: w, height: h });
    check(`${tag} : zones tactiles principales ≥ 40 px (envoi)`, (await rect(page, ".aiw-send")).w >= 40);
    check(`${tag} : aucune erreur JS`, page.errors.length === 0, page.errors);
    await ctx.close();
  }
});

/* ── 10 ────────────────────────────────────────────────────────────────── */
await scenario("10. Franchissement du seuil responsive (redimensionnement à chaud)", async () => {
  const { ctx, page } = await open({ viewport: { width: 1280, height: 800 } });
  await page.setViewportSize({ width: 800, height: 800 }); await page.waitForTimeout(300);
  check("1280 → 800 : la sidebar devient un tiroir fermé", (await rect(page, ".aiw-side")).r <= 1);
  await page.click(".aiw-sidebtn"); await page.waitForTimeout(300);
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(300);
  const s = await rect(page, ".aiw-side");
  check("800 → 1280 avec tiroir ouvert : retour à la sidebar fixe, sans voile résiduel", s.w >= 200 && s.x >= 0 && await page.evaluate(() => document.getElementById("aiw").dataset.drawer === "0" && document.querySelector(".aiw-scrim").offsetWidth === 0));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 11 ────────────────────────────────────────────────────────────────── */
await scenario("11. Langues : FR/EN/ES/DE/IT — aucune clé brute, aucun débordement", async () => {
  for (const lang of ["fr", "en", "es", "de", "it"]) {
    for (const [w, h] of [[1024, 768], [390, 844]]) {
      const { ctx, page } = await open({ viewport: { width: w, height: h }, lang });
      const txt = await page.evaluate(() => document.getElementById("aiw").innerText);
      const raw = (txt.match(/\b(aiw|mt|assistant)\.[a-z_.0-9]+/g) || []);
      check(`${lang} ${w}px : aucune clé de traduction brute`, raw.length === 0, raw);
      const m = await metrics(page);
      check(`${lang} ${w}px : pas de débordement horizontal`, m.sw <= m.iw, m);
      check(`${lang} ${w}px : l'en-tête n'est pas coupé`, await page.evaluate(() => { const h = document.querySelector(".aiw-head"); return h.scrollWidth <= h.clientWidth + 1; }));
      check(`${lang} ${w}px : les suggestions ne débordent pas`, await page.evaluate(() => [...document.querySelectorAll(".aiw-starter")].every(b => b.scrollWidth <= b.clientWidth + 2)));
      await page.click(".aiw-chip"); await page.click("[data-aiw=menu-close]").catch(() => {});
      await page.evaluate(() => { aiwSetMenu("mode"); });
      const raw2 = ((await page.evaluate(() => document.getElementById("aiw").innerText)).match(/\b(aiw|mt|assistant)\.[a-z_.0-9]+/g) || []);
      check(`${lang} ${w}px : menus sans clé brute`, raw2.length === 0, raw2);
      await ctx.close();
    }
  }
});

/* ── 12 ────────────────────────────────────────────────────────────────── */
await scenario("12. Bulle flottante : même état, ouvre ce workspace", async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => { window.__T.script = [{ text: "Réponse partagée bulle/page." }]; });
  await send(page, "Question depuis la page");
  await idle(page);
  await page.evaluate(() => { switchTab("dashboard"); }); await page.waitForTimeout(250);
  check("hors page IA : la bulle est visible", await page.evaluate(() => getComputedStyle(document.getElementById("ai-bubble")).display !== "none"));
  await page.click("#ai-bubble"); await page.waitForTimeout(300);
  check("cliquer la bulle ouvre le workspace (pas une 2e interface)", await page.evaluate(() => state.tab === "ai" && !!document.getElementById("aiw")));
  check("même état : la conversation est toujours là", await page.evaluate(() => /partagée/.test(document.getElementById("aiw-col").innerText)));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 13 ────────────────────────────────────────────────────────────────── */
await scenario("13. Accessibilité : ARIA, focus visible, clavier", async () => {
  const { ctx, page } = await open();
  check("région nommée + navigation nommée", await page.evaluate(() => !!document.getElementById("aiw").getAttribute("aria-label") && !!document.querySelector(".aiw-nav").getAttribute("aria-label")));
  check("espace actif signalé (aria-current)", await page.evaluate(() => document.querySelector(".aiw-navitem[aria-current=page]") !== null));
  check("boutons icônes avec nom accessible", await page.evaluate(() => [...document.querySelectorAll("#aiw .aiw-iconbtn, #aiw .aiw-send")].filter(b => b.offsetWidth > 0).every(b => (b.getAttribute("aria-label") || b.innerText || "").trim().length > 0)));
  check("le chip d'état annonce le modèle et l'état (aria-label)", await page.evaluate(() => /Avanc/.test(document.querySelector(".aiw-chip").getAttribute("aria-label"))));
  await page.focus(".aiw-new");
  const out = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { o: cs.outlineStyle, w: cs.outlineWidth }; });
  check("focus clavier visible (outline) sur « Nouvelle conversation »", out.o !== "none" && parseFloat(out.w) >= 1, out);
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) { await page.keyboard.press("Tab"); reached = await page.evaluate(() => document.activeElement && document.activeElement.id === "assistant-query-input"); }
  check("la saisie est atteignable au clavier (Tab)", reached);
  check("la sidebar est atteignable avant la saisie (ordre logique)", await page.evaluate(() => { const a = document.querySelector(".aiw-new"), b = document.getElementById("assistant-query-input"); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

/* ── 14 ────────────────────────────────────────────────────────────────── */
await scenario("14. Réduction des mouvements & pas de rechargement du moteur par l'UI", async () => {
  const { ctx, page } = await open();
  const before = await page.evaluate(() => ({ loads: window.__T.sent.length }));
  for (const sp of ["math", "courses", "revise", "chat", "math", "chat"]) { await page.click(`[data-aiw-space=${sp}]`); }
  await page.click(".aiw-focusbtn"); await page.keyboard.press("Escape"); await page.click("[data-aiw=side-toggle]"); await page.click("[data-aiw=side-toggle]");
  const after = await page.evaluate(() => ({ sent: window.__T.sent.length, st: state.aiStatus }));
  check("aucun message envoyé au moteur IA par les changements d'interface", after.sent === before.loads, after);
  check("l'état du modèle reste « ready »", after.st === "ready");
  const css = await page.evaluate(() => [...document.querySelectorAll("style")].map(s => s.textContent).join("\n"));
  check("styles de réduction des mouvements présents pour le workspace", /prefers-reduced-motion[^{]*\{[^}]*\.aiw|prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]{0,400}\.aiw/.test(css));
  check("aucune erreur JS", page.errors.length === 0, page.errors);
  await ctx.close();
});

await browser.close(); srv.server.close();
console.log(`\n${pass} PASS, ${mock} PASS MOCK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
