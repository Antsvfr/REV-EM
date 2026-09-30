/* ============================================================================
   REV-EM — l'assistant IA de bout en bout : VRAIE page, VRAI worker, VRAI hôte
   ----------------------------------------------------------------------------
   CE QUI EST RÉEL ICI
     • index.html tel quel, dans un vrai Chromium ;
     • le VRAI Worker (ai-worker.js → ai-host.js → ai-engine.js), le vrai
       protocole postMessage, la vraie machine d'états ;
     • le vrai Cache Storage et le vrai IndexedDB du navigateur (test du bouton
       « Réinitialiser le cache IA » : on y met des données AI et non-AI, puis
       on vérifie lesquelles survivent) ;
     • le vrai rendu (cartes, progression, notices, diagnostic).

   CE QUI EST REMPLACÉ — donc TOUT ce fichier est « PASS MOCK », jamais « PASS »
   pour ce qui touche au GPU :
     • navigator.gpu (page ET worker) : un faux adaptateur qui déclare ses
       fonctionnalités et ses limites ;
     • @mlc-ai/web-llm : un faux module servi à la place de l'URL du CDN. Il
       simule le téléchargement (progression), l'initialisation, la génération
       en flux, les erreurs (sous forme de CHAÎNE, comme WebLLM), et compte
       combien de moteurs sont chargés EN MÊME TEMPS.

   CE QUE RIEN ICI NE PROUVE : qu'un vrai modèle se charge sur un vrai GPU
   (NOT TESTED GPU), ni dans le vrai WKWebView de REV-EM.app (NOT TESTED
   WKWEBVIEW). Voir AI_AUDIT.md.

   Lancer :  python3 -m http.server 9109   puis
             NODE_PATH=/opt/node22/lib/node_modules node tests/ai-integration.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://localhost:9109";
const APP = BASE + "/index.html";
const WEBLLM_URL_RE = /^https:\/\/esm\.run\/@mlc-ai\/web-llm@0\.2\.85$/;

let pass = 0, fail = 0;
const check = (name, ok, got) => {
  if (ok) { pass++; console.log(`PASS MOCK — ${name}`); }
  else { fail++; console.log(`FAIL — ${name}  ${got !== undefined ? JSON.stringify(got) : ""}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp("^(" + process.env.ONLY + ")\\.").test(name)) return;
  console.log(`\n── ${name} ──`);
  try { await fn(); } catch (e) { check(`« ${name} » s'exécute sans exception`, false, String((e && e.stack) || e).slice(0, 600)); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── Faux GPU (injecté dans la page ET dans le worker) ─────────────────── */
const gpuPrefix = ({ f16 = true, big = true } = {}) => `
(function(){
  const limits = ${big ? "{ maxBufferSize: 4294967296, maxStorageBufferBindingSize: 2147483648, maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 10 }" : "{ maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupStorageSize: 32768, maxStorageBuffersPerShaderStage: 10 }"};
  const adapter = { features: new Set(${f16 ? '["shader-f16"]' : "[]"}), limits, info: { vendor: "fake", architecture: "fake-arch", description: "GPU factice" },
    requestDevice: async () => ({ destroy(){}, lost: new Promise(() => {}) }) };
  Object.defineProperty(navigator, "gpu", { value: { requestAdapter: async () => adapter }, configurable: true });
})();
`;

/* ── Faux WebLLM (servi à la place du CDN) ─────────────────────────────── */
const IDS = ["Llama-3.2-1B-Instruct-q4f16_1-MLC", "Llama-3.2-1B-Instruct-q4f32_1-MLC", "Phi-4-mini-instruct-q4f16_1-MLC", "Phi-4-mini-instruct-q4f32_1-MLC", "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC", "DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC"];
const FAKE_WEBLLM = `
const W = "https://ai-world.test/";
const ping = (p) => fetch(W + p).then(r => r.json()).catch(() => ({}));
export const prebuiltAppConfig = { model_list: ${JSON.stringify(IDS)}.map(model_id => ({ model_id, vram_required_MB: 1000 })), cacheBackend: "cache" };
export class MLCEngine {
  constructor(conf){
    this.conf = conf; this.loaded = false; this.gone = false; this.interrupted = false; this.beh = {};
    this.chat = { completions: { create: (p) => this._create(p) } };
  }
  async reload(id){
    this.id = id;
    this.beh = await ping("behavior?id=" + encodeURIComponent(id) + "&backend=" + (this.conf.appConfig.cacheBackend || ""));
    if(this.beh.throw) throw this.beh.throw;                 // WebLLM rejette avec une CHAÎNE (handleTask → err.toString())
    await ping("loaded?d=1&id=" + encodeURIComponent(id)); this.loaded = true;
    const cb = this.conf.initProgressCallback, step = this.beh.stepMs || 15;
    for(const [p, text] of [[0.2, "Fetching param cache[1/5]: 40MB fetched. 20% completed"], [0.55, "Fetching param cache[3/5]: 110MB fetched. 55% completed"], [0.9, "Loading GPU shader modules[4/5]: 90%"], [1, "Finish loading on WebGPU - GPU factice"]]){
      await new Promise(r => setTimeout(r, step));
      if(this.gone) return;
      cb && cb({ progress: p, text });
    }
  }
  async unload(){ this.gone = true; if(this.loaded){ this.loaded = false; await ping("loaded?d=-1&id=" + encodeURIComponent(this.id)); } }
  interruptGenerate(){ this.interrupted = true; }
  async resetChat(){}
  async _create(p){
    if(!p.stream) return { choices: [{ message: { content: "ok" } }] };
    const gb = await ping("genbehavior?id=" + encodeURIComponent(this.id));
    const beh = Object.assign({}, this.beh, gb);
    const chars = (p.messages || []).reduce((n, m) => n + String(m.content).length, 0);
    await ping("gen?chars=" + chars + "&n=" + (p.messages || []).length + "&max=" + p.max_tokens);
    if(beh.genThrow) throw beh.genThrow;
    const self = this; self.interrupted = false;
    const words = beh.words || ["Voici", " une", " réponse", " en", " flux", "."];
    const tokenMs = beh.tokenMs || 12;
    return (async function*(){
      for(const w of words){
        await new Promise(r => setTimeout(r, tokenMs));
        if(self.interrupted){ yield { choices: [{ delta: {}, finish_reason: "abort" }] }; return; }
        yield { choices: [{ delta: { content: w } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    })();
  }
}
`;

const browser = await chromium.launch();

/* Ouvre un contexte neuf, avec faux GPU / faux WebLLM / faux « monde ». */
async function open({ gpu = {}, noGpu = false, workerGpu = true, ua, workerFile } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: "block", userAgent: ua });
  const world = { loaded: 0, maxLoaded: 0, reloads: [], gens: [], engines: 0, behavior: () => ({}), genBehavior: () => ({}) };
  await ctx.route("https://ai-world.test/**", async (route) => {
    const u = new URL(route.request().url());
    let body = {};
    if (u.pathname === "/behavior") { world.engines++; body = world.behavior(u.searchParams.get("id"), u.searchParams.get("backend")) || {}; }
    if (u.pathname === "/genbehavior") body = world.genBehavior() || {};
    if (u.pathname === "/loaded") {
      world.loaded += Number(u.searchParams.get("d"));
      if (Number(u.searchParams.get("d")) > 0) world.reloads.push(u.searchParams.get("id"));
      world.maxLoaded = Math.max(world.maxLoaded, world.loaded);
    }
    if (u.pathname === "/gen") world.gens.push({ chars: Number(u.searchParams.get("chars")), n: Number(u.searchParams.get("n")), max: Number(u.searchParams.get("max")) });
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  await ctx.route(WEBLLM_URL_RE, (route) => route.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: world.importFail ? "throw new Error('boom')" : FAKE_WEBLLM }));
  if (!noGpu) await ctx.addInitScript(gpuPrefix(gpu));
  const workerSrc = fs.readFileSync(path.join(ROOT, "ai-worker.js"), "utf8");
  await ctx.route("**/ai-worker.js", (route) => {
    if (workerFile === 404) return route.fulfill({ status: 404, body: "not found" });
    const prefix = (!noGpu && workerGpu) ? gpuPrefix(gpu) : "";
    return route.fulfill({ status: 200, contentType: "text/javascript", body: prefix + workerSrc });
  });
  return { ctx, world };
}
async function page(ctx) {
  const p = await ctx.newPage();
  const errors = []; p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(APP);
  await p.waitForFunction(() => typeof state !== "undefined" && typeof aiLoadModel === "function" && !!window.RevemAI);
  p.errors = errors;
  return p;
}
const openAI = async (p) => { await p.evaluate(() => switchTab("ai")); await p.waitForFunction(() => state.aiStatus !== "checking", null, { timeout: 8000 }); };
const waitStatus = (p, st, ms = 8000) => p.waitForFunction((s) => state.aiStatus === s, st, { timeout: ms });
const S = (p, expr) => p.evaluate(expr);
const cardText = (p) => p.$$eval(".ai-tier", els => els.map(e => e.innerText));

/* ═════════════════════════════════════════════════════════════════════ */
await scenario("1. WebGPU absent → message clair, le site fonctionne", async () => {
  const { ctx } = await open({ noGpu: true });
  const p = await page(ctx);
  await openAI(p);
  eq("état nogpu", await S(p, "state.aiStatus"), "nogpu");
  check("message d'indisponibilité affiché", /WebGPU/.test(await p.innerText(".ai-status")));
  check("aucun sélecteur de modèle proposé quand WebGPU manque", (await p.$$(".ai-tier")).length === 0);
  const r = await p.evaluate(async () => { try { await webllmChat([{ role: "user", content: "x" }]); return "no-error"; } catch (e) { return e.message; } });
  check("webllmChat échoue proprement (pas de blocage)", /n'est pas chargé/.test(r), r);
  await p.evaluate(() => switchTab("home"));
  check("le reste de l'application fonctionne (accueil rendu)", (await p.innerText("body")).length > 500);
  check("aucune exception JavaScript", p.errors.length === 0, p.errors);
  await ctx.close();
});

await scenario("2. Rapide fonctionne → génération en flux", async () => {
  const { ctx, world } = await open();
  const p = await page(ctx);
  await openAI(p);
  eq("état idle avec un GPU valide", await S(p, "state.aiStatus"), "idle");
  const names = await p.$$eval(".ai-tier-name", els => els.map(e => e.textContent));
  eq("trois cartes : Rapide / Avancé / Expert", names, ["Rapide", "Avancé", "Expert"]);
  await p.click('[data-aitier="rapide"]');
  await waitStatus(p, "ready");
  eq("palier chargé", await S(p, "state.aiTier"), "rapide");
  eq("identifiant réel (variante f16, le faux GPU l'annonce)", await S(p, "state.aiModelId"), "Llama-3.2-1B-Instruct-q4f16_1-MLC");
  eq("exécution dans un vrai Worker", await S(p, "state.aiEngineMode"), "worker");
  const seen = [];
  await p.exposeFunction("__seen", (t) => seen.push(t));
  const res = await p.evaluate(async () => { let n = 0; const r = await webllmChat([{ role: "user", content: "Bonjour" }], { onText: ({ text }) => { n++; window.__seen(text); } }); return { text: r.text, n }; });
  eq("texte complet reçu", res.text, "Voici une réponse en flux.");
  check("le texte arrive PROGRESSIVEMENT (≥ 3 mises à jour)", res.n >= 3 && seen[0] !== seen[seen.length - 1], res.n);
  const perf = await S(p, "state.aiPerf");
  check("premier jeton et durée totale mesurés", perf && perf.ttftMs > 0 && perf.totalMs >= perf.ttftMs, perf);
  eq("un seul moteur créé, un seul chargé", [world.engines, world.maxLoaded], [1, 1]);
  await ctx.close();
});

await scenario("3. Avancé fonctionne → génération (Phi-4 Mini)", async () => {
  const { ctx } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="avance"]');
  await waitStatus(p, "ready");
  eq("modèle Phi-4 Mini retenu", await S(p, "state.aiModelId"), "Phi-4-mini-instruct-q4f16_1-MLC");
  const res = await p.evaluate(() => webllmChat([{ role: "user", content: "Explique" }]));
  check("génération OK", res.text.length > 5);
  await ctx.close();
});

await scenario("4. Expert échoue → repli automatique sur Avancé", async () => {
  const { ctx, world } = await open();
  world.behavior = (id) => /DeepSeek/.test(id) ? { throw: "Error: Cannot initialize runtime because of requested maxStorageBufferBindingSize exceeds limit. requested=128MB, limit=64MB. " } : {};
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="expert"]');
  await p.click('[data-ds-confirm="yes"]');                                // confirmation Expert
  await waitStatus(p, "ready");
  eq("palier final = Avancé", await S(p, "state.aiTier"), "avance");
  const notice = await p.innerText(".ai-notice-line");
  check("message simple, sans jargon technique", /Expert est trop exigeant/.test(notice) && /Avancé/.test(notice) && !/maxStorage|Error/.test(notice), notice);
  eq("aucun écran d'erreur géant : statut « prêt »", await p.$$eval(".ai-status.ko", e => e.length), 0);
  const mem = await S(p, "aiMem()");
  eq("le repli est mémorisé", [mem.lastFallback.from, mem.lastFallback.to], ["expert", "avance"]);
  eq("l'échec d'Expert est mémorisé avec le code réel", mem.lastFailure.code, "OUT_OF_MEMORY_OR_RESOURCE_LIMIT");
  eq("jamais deux modèles en même temps", world.maxLoaded, 1);
  check("Expert n'est pas relancé à chaque démarrage (pas encore « instable » après 1 échec, mais dernier stable = Avancé)", mem.lastStable.tier === "avance");
  await ctx.close();
});

await scenario("5. Expert ET Avancé échouent → Rapide", async () => {
  const { ctx, world } = await open();
  world.behavior = (id) => /DeepSeek|Phi-4/.test(id) ? { throw: "DeviceLostError: Device was lost during reload. This can happen due to insufficient memory or other GPU constraints." } : {};
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="expert"]'); await p.click('[data-ds-confirm="yes"]');
  await waitStatus(p, "ready");
  eq("palier final = Rapide", await S(p, "state.aiTier"), "rapide");
  check("message « mode Rapide … stabilité »", /mode Rapide pour garantir la stabilité/.test(await p.innerText(".ai-notice-line")));
  eq("essais dans l'ordre Expert → Avancé (échecs) puis Rapide", (await S(p, "aiMem().lastFallback")).to, "rapide");
  eq("un seul moteur chargé à la fois", world.maxLoaded, 1);
  await ctx.close();
});

await scenario("5b. Tous les paliers échouent → UN écran d'erreur clair, cause réelle conservée", async () => {
  const { ctx, world } = await open();
  world.behavior = () => ({ throw: "Error: createBuffer failed: out of memory (jean.dupont@ecole.fr)" });
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="avance"]');
  await waitStatus(p, "error", 10000);
  const box = await p.innerText(".ai-errbox");
  check("l'explication simple s'affiche", /mémoire/.test(box), box);
  check("le message n'est PLUS « Erreur inconnue pendant l'initialisation »", !/Erreur inconnue/.test(await p.innerText("body")));
  await p.click(".ai-errbox summary");
  const tech = await p.innerText(".ai-errbox");
  check("le détail technique RÉEL est disponible (plus de perte du message)", /createBuffer failed/.test(tech) && /OUT_OF_MEMORY_OR_RESOURCE_LIMIT/.test(tech), tech);
  check("… sans e-mail (masqué)", !/dupont@/.test(tech), tech);
  check("le bouton Réessayer existe", (await p.$$("#ai-load-btn")).length === 1);
  await ctx.close();
});

await scenario("6. Périphérique perdu → moteur invalidé, récupération propre", async () => {
  const { ctx, world } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  world.genBehavior = () => ({ genThrow: "ModelNotLoadedError: Model not loaded before calling chatCompletion(). Please ensure you have called `MLCEngine.reload(model)`" });
  const err = await p.evaluate(async () => { try { await webllmChat([{ role: "user", content: "x" }]); return "ok"; } catch (e) { return { code: e.code, msg: e.message }; } });
  eq("la génération échoue avec DEVICE_LOST", err.code, "DEVICE_LOST");
  await waitStatus(p, "error");
  check("l'interface reflète l'invalidation", /interrompue/.test(await p.innerText(".ai-errbox")), await p.innerText(".ai-errbox"));
  eq("moteur libéré côté hôte", world.loaded, 0);
  world.genBehavior = () => ({});
  await p.click("#ai-load-btn");
  await waitStatus(p, "ready");
  const res = await p.evaluate(() => webllmChat([{ role: "user", content: "x" }]));
  check("après « Réessayer » : moteur sain, génération OK", res.text.length > 3);
  eq("le passif DEVICE_LOST est mémorisé", (await S(p, "aiMem().lastFailure.code")), "DEVICE_LOST");
  eq("jamais deux moteurs chargés", world.maxLoaded, 1);
  await ctx.close();
});

await scenario("7. Cache corrompu / plein → erreur identifiée, réinitialisation possible", async () => {
  const { ctx, world } = await open();
  world.behavior = () => ({ throw: "QuotaExceededError: Failed to execute 'put' on 'Cache': Quota exceeded." });
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "error", 10000);
  eq("code identifié", await S(p, "state.aiDiagnostic.code"), "MODEL_CACHE_CORRUPTED");
  check("le conseil cite le bouton de réinitialisation", /Réinitialiser le cache IA/.test(await p.innerText(".ai-errbox")));
  check("une 2e tentative avec le cache IndexedDB a eu lieu avant d'abandonner", world.engines >= 2);
  await ctx.close();
});

await scenario("7b. Réinitialiser le cache IA : UNIQUEMENT l'IA (vrai Cache Storage, vrai IndexedDB)", async () => {
  const { ctx, world } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  await p.evaluate(async () => {
    localStorage.setItem("revisions-etude-marche:u.abc.user-subjects", JSON.stringify([{ id: "s1", name: "Ma matière" }]));
    localStorage.setItem("sb-otlkvlmzakklhugvaxeg-auth-token", JSON.stringify({ access_token: "SESSION-A-CONSERVER" }));
    localStorage.setItem("revisions-etude-marche:ai-history", JSON.stringify([{ text: "historique" }]));
    for (const n of ["webllm/model", "webllm/config", "webllm/wasm", "rev-em-v4-shell", "autre-cache"]) await (await caches.open(n)).put("/x", new Response("data"));
    for (const n of ["webllm/model", "revem-course-files", "autre-db"]) await new Promise((res, rej) => { const r = indexedDB.open(n, 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = rej; });
  });
  await p.click("#ai-reset-cache");
  await p.click('[data-ds-confirm="yes"]');
  await p.waitForFunction(() => !state.aiResetBusy && state.aiCacheResetMsg, null, { timeout: 8000 });
  const after = await p.evaluate(async () => ({
    caches: await caches.keys(),
    dbs: (await indexedDB.databases()).map(d => d.name).sort(),
    subjects: localStorage.getItem("revisions-etude-marche:u.abc.user-subjects"),
    session: localStorage.getItem("sb-otlkvlmzakklhugvaxeg-auth-token"),
    history: localStorage.getItem("revisions-etude-marche:ai-history"),
    status: state.aiStatus, msg: state.aiCacheResetMsg,
  }));
  eq("caches webllm/* supprimés, les autres intacts", after.caches.sort(), ["autre-cache", "rev-em-v4-shell"]);
  eq("base IndexedDB webllm supprimée, les autres intactes", after.dbs, ["autre-db", "revem-course-files"]);
  check("matières de l'utilisateur intactes", /Ma matière/.test(after.subjects || ""));
  check("session d'authentification INTACTE (pas de déconnexion)", /SESSION-A-CONSERVER/.test(after.session || ""));
  check("historique des conversations intact", /historique/.test(after.history || ""));
  eq("retour à l'état « idle » (moteur rechargeable)", after.status, "idle");
  check("message honnête : cours/progression/connexion non touchés", /ne sont pas touchés/.test(after.msg), after.msg);
  eq("moteur déchargé", world.loaded, 0);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  check("le moteur redémarre proprement après le reset", true);
  await ctx.close();
});

await scenario("8. Rapide → Avancé : UN seul moteur", async () => {
  const { ctx, world } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  await p.click('[data-aitier="avance"]');
  await p.waitForFunction(() => state.aiStatus === "ready" && state.aiTier === "avance", null, { timeout: 8000 });
  eq("moteurs chargés simultanément (max)", world.maxLoaded, 1);
  eq("chargements dans l'ordre", world.reloads, ["Llama-3.2-1B-Instruct-q4f16_1-MLC", "Phi-4-mini-instruct-q4f16_1-MLC"]);
  eq("aucun moteur résiduel", world.loaded, 1);
  await ctx.close();
});

await scenario("9. Bascule PENDANT une génération → pas de course GPU", async () => {
  const { ctx, world } = await open();
  world.behavior = () => ({ tokenMs: 25, words: Array.from({ length: 60 }, (_, i) => " mot" + i) });
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  await p.evaluate(() => { window.__gen = webllmChat([{ role: "user", content: "long" }]).then(r => ({ ok: true, aborted: true, n: r.text.split(" ").length })).catch(e => ({ ok: false, msg: e.message })); });
  await sleep(150);
  await p.evaluate(() => { state.aiBusy = true; });                         // ce que fait aiSend pendant un chat
  await p.click('[data-aitier="avance"]');
  await p.waitForFunction(() => state.aiStatus === "ready" && state.aiTier === "avance", null, { timeout: 10000 });
  const g = await p.evaluate(() => window.__gen);
  check("la génération en cours a été terminée proprement (interrompue, pas en erreur)", g.ok === true && g.n < 60, g);
  eq("jamais deux moteurs chargés à la fois", world.maxLoaded, 1);
  await p.evaluate(() => { state.aiBusy = false; });
  const res = await p.evaluate(() => webllmChat([{ role: "user", content: "b" }]));
  check("le nouveau modèle génère", res.text.length > 3);
  await ctx.close();
});

await scenario("10. L'état IA est propre à l'appareil : ni compte, ni synchronisation, ni sauvegarde", async () => {
  const { ctx } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  const r = await p.evaluate(() => {
    const keys = storageNamespacedKeys();
    const inNamespaced = keys.some(k => String(k).indexOf("ai-engine-memory") >= 0);
    const inBackup = backupKeys().some(k => String(k).indexOf("ai-engine-memory") >= 0);
    const memRaw = localStorage.getItem(AI_DEVICE_KEY);
    const before = localStorage.getItem(AI_DEVICE_KEY);
    cloudPurgeCache("u-test");                                               // ce que fait une purge après synchro/déconnexion
    return { inNamespaced, inBackup, hadMemory: !!before, stillThere: localStorage.getItem(AI_DEVICE_KEY) === before, exported: -1 };
  });
  check("la mémoire IA n'est PAS dans les clés du compte", r.inNamespaced === false);
  check("… ni dans la sauvegarde exportée", r.inBackup === false && r.exported === -1, r);
  check("… et survit à la purge du cache d'un compte / à la déconnexion", r.hadMemory && r.stillThere);
  await ctx.close();
});

await scenario("11. WKWebView : détection honnête + mode compatibilité si le worker n'a pas WebGPU", async () => {
  const WK = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  {
    const { ctx } = await open({ ua: WK });
    const p = await page(ctx);
    await openAI(p);
    eq("UA de WKWebView reconnu (simulation par User-Agent, PAS un vrai WKWebView)", await S(p, "aiEnv().browser"), "wkwebview");
    await p.click(".ai-extra summary");
    check("le diagnostic dit « probablement » (aucune certitude inventée)", /probablement/.test(await p.innerText("#ai-diag-panel")));
    await ctx.close();
  }
  {   // le worker n'expose pas WebGPU alors que la page l'a → relance sur le fil principal
    const { ctx, world } = await open({ workerGpu: false, ua: WK });
    const p = await page(ctx);
    await openAI(p);
    await p.click('[data-aitier="rapide"]');
    await waitStatus(p, "ready", 12000);
    eq("moteur exécuté sur le fil principal (preuve : sonde du worker sans WebGPU)", await S(p, "state.aiEngineMode"), "main-thread");
    eq("la sonde du worker est enregistrée comme « sans WebGPU »", await S(p, "state.aiWorkerGpu"), false);
    check("la notice de compatibilité est affichée", /compatibilité/.test(await p.innerText(".ai-notice-line")));
    const res = await p.evaluate(() => webllmChat([{ role: "user", content: "x" }]));
    check("génération OK en mode compatibilité (même protocole)", res.text.length > 3);
    eq("un seul moteur chargé", world.maxLoaded, 1);
    check("l'échec worker n'a PAS été compté comme un échec du modèle", !(await S(p, "aiMem().lastFailure")));
    await ctx.close();
  }
  {   // le worker ne démarre pas du tout
    const { ctx } = await open({ workerFile: 404 });
    const p = await page(ctx);
    await openAI(p);
    await p.click('[data-aitier="rapide"]');
    await waitStatus(p, "ready", 12000);
    eq("worker introuvable → fil principal", await S(p, "state.aiEngineMode"), "main-thread");
    check("l'erreur du worker est conservée pour le diagnostic", !!(await S(p, "state.aiWorkerError")));
    await ctx.close();
  }
});

await scenario("12. Rechargement de la page → dernier palier stable restauré", async () => {
  const { ctx, world } = await open();
  let p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="avance"]'); await waitStatus(p, "ready");
  await p.close();
  world.loaded = 0;                                                           // fermer la page libère le GPU (le faux ne le sait pas)
  p = await page(ctx);                                                       // même contexte : même localStorage
  await p.evaluate(() => switchTab("ai"));
  await p.waitForFunction(() => state.aiStatus === "ready", null, { timeout: 10000 });
  eq("Avancé restauré SANS clic", await S(p, "state.aiTier"), "avance");
  eq("… avec un seul moteur chargé à la fois", world.maxLoaded, 1);
  check("la carte Avancé est marquée active", (await p.$eval('[data-aitier="avance"]', e => e.getAttribute("aria-pressed"))) === "true");
  await ctx.close();
});

await scenario("12b. Un palier jamais essayé n'est JAMAIS chargé tout seul", async () => {
  const { ctx, world } = await open();
  const p = await page(ctx);
  await openAI(p);
  await sleep(600);
  eq("état idle, aucun téléchargement lancé sans clic", [await S(p, "state.aiStatus"), world.engines], ["idle", 0]);
  await ctx.close();
});

await scenario("13. Expert : jamais recommandé d'office, confirmation obligatoire", async () => {
  const { ctx, world } = await open({ gpu: { big: true } });
  const p = await page(ctx);
  await openAI(p);
  const badges = await p.$$eval(".ai-tier", els => els.map(e => [e.dataset.aitier, !!e.querySelector(".ai-tier-badge")]));
  eq("« RECOMMANDÉ » sur Avancé (GPU f16, limites ≥ 1 Gio), pas sur Expert", badges, [["rapide", false], ["avance", true], ["expert", false]]);
  await p.click('[data-aitier="expert"]');
  check("une confirmation s'affiche avant de charger Expert", (await p.$$('[data-ds-confirm="yes"]')).length === 1);
  await p.click('[data-ds-confirm="no"]');
  await sleep(200);
  eq("refus → rien n'est chargé", [world.engines, await S(p, "state.aiStatus")], [0, "idle"]);
  await ctx.close();
  const weak = await open({ gpu: { big: false } });
  const p2 = await page(weak.ctx); await openAI(p2);
  const b2 = await p2.$$eval(".ai-tier", els => els.map(e => [e.dataset.aitier, !!e.querySelector(".ai-tier-badge")]));
  eq("limites GPU modestes → « RECOMMANDÉ » sur Rapide", b2, [["rapide", true], ["avance", false], ["expert", false]]);
  check("Avancé annonce « Non recommandé » avec sa raison", /Non recommandé/.test((await cardText(p2))[1]) && /limites graphiques/.test((await cardText(p2))[1]));
  await weak.ctx.close();
  const nof16 = await open({ gpu: { f16: false } });
  const p3 = await page(nof16.ctx); await openAI(p3);
  await p3.click('[data-aitier="rapide"]'); await waitStatus(p3, "ready");
  eq("sans shader-f16 → variante q4f32_1", await S(p3, "state.aiModelId"), "Llama-3.2-1B-Instruct-q4f32_1-MLC");
  await nof16.ctx.close();
});

await scenario("14. WebLLM injoignable → erreur claire, pas de repli inutile", async () => {
  const { ctx, world } = await open();
  world.importFail = true;
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="avance"]');
  await waitStatus(p, "error", 10000);
  eq("code WEBLLM_IMPORT_FAILED", await S(p, "state.aiDiagnostic.code"), "WEBLLM_IMPORT_FAILED");
  eq("aucun repli tenté (changer de modèle n'y change rien)", await S(p, "aiMem().lastFallback"), null);
  check("message simple et actionnable", /connexion/.test(await p.innerText(".ai-errbox")));
  check("le reste du site reste utilisable", (await p.evaluate(() => { switchTab("home"); return document.body.innerText.length; })) > 500);
  await ctx.close();
});

await scenario("15. Progression : barre réelle → « Initialisation du moteur… » → Prêt", async () => {
  const { ctx, world } = await open();
  world.behavior = () => ({ stepMs: 120 });
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]');
  const widths = [], texts = new Set();
  for (let i = 0; i < 40; i++) {
    const w = await p.evaluate(() => { const f = document.getElementById("ai-loadbar-fill"); const t = document.getElementById("ai-load-text"); return { w: f ? parseInt(f.style.width) : null, t: t ? t.textContent : null, st: state.aiStatus }; });
    if (w.w !== null) widths.push(w.w);
    if (w.t) texts.add(w.t);
    if (w.st === "ready") break;
    await sleep(40);
  }
  check("la barre avance de façon monotone", widths.length >= 3 && widths.every((v, i) => i === 0 || v >= widths[i - 1]), widths);
  check("« Téléchargement du modèle… » puis « Initialisation du moteur… »", texts.has("Téléchargement du modèle…") && texts.has("Initialisation du moteur…"), [...texts]);
  check("la carte du palier passe par « Téléchargement… » / « Initialisation… » puis « Prêt »", (await cardText(p))[0].includes("Prêt"));
  await ctx.close();
});

await scenario("16. Contexte compact : pas 20 000 signes pour une question simple", async () => {
  const { ctx, world } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  await p.evaluate(async () => {
    const turns = [{ role: "user", content: "CONTEXTE " + "c".repeat(20000) }];
    for (let i = 0; i < 12; i++) { turns.push({ role: "assistant", content: "r".repeat(600) }); turns.push({ role: "user", content: "q" + i + " " + "z".repeat(200) }); }
    await webllmChat(turns);
  });
  const g = world.gens[world.gens.length - 1];
  check("le prompt envoyé au modèle est sous le budget (≈2 950 jetons ≈ 9 400 signes)", g.chars < 9600, g);
  check("l'historique ancien est retiré, pas tout le contexte", g.n < 25 && g.n >= 2, g);
  eq("limite de jetons de sortie transmise", g.max, 1000);
  await ctx.close();
});

await scenario("17. Diagnostic copiable : complet, sans secret", async () => {
  const { ctx, world } = await open();
  world.behavior = () => ({ throw: "Error: out of memory for jean.dupont@ecole.fr Bearer abcdefghijklmnopqrstuv" });
  const p = await page(ctx);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "error", 8000);
  await p.click("#ai-diag-panel summary");
  await p.click("#ai-copy-diag-btn");
  await p.waitForFunction(() => state.aiDiagCopied);
  const txt = await p.evaluate(() => navigator.clipboard.readText());
  for (const s of ["WebGPU (page) : oui", "Adaptateur GPU : oui", "Périphérique GPU : oui", "shader-f16 : oui", "Limites : maxBufferSize=4294967296", "WebGPU (worker) : oui", "Mode moteur : worker", "version épinglée 0.2.85", "OUT_OF_MEMORY_OR_RESOURCE_LIMIT"]) check(`le diagnostic contient « ${s} »`, txt.includes(s), txt);
  check("aucun e-mail ni jeton dans le diagnostic", !/dupont@|abcdefghijklmnop/.test(txt), txt);
  check("le panneau affiche « Copier le diagnostic » puis la confirmation", /Diagnostic copié/.test(await p.innerText("#ai-diag-panel")));
  await ctx.close();
});

await scenario("18. Interface : accessibilité clavier, 5 langues, responsive", async () => {
  const { ctx } = await open();
  const p = await page(ctx);
  await openAI(p);
  const roles = await p.$$eval(".ai-tier", els => els.map(e => [e.tagName, e.getAttribute("aria-pressed"), e.disabled]));
  check("cartes = boutons natifs, aria-pressed présent, activables au clavier", roles.every(r => r[0] === "BUTTON" && r[1] !== null && r[2] === false), roles);
  await p.focus('[data-aitier="rapide"]'); await p.keyboard.press("Tab");
  eq("Tab passe à la carte suivante", await p.evaluate(() => document.activeElement && document.activeElement.dataset.aitier), "avance");
  await p.keyboard.press("Enter");
  await waitStatus(p, "ready");
  eq("Entrée sur une carte charge ce palier", await S(p, "state.aiTier"), "avance");
  for (const [lang, word] of [["en", "Fast"], ["es", "Rápido"], ["de", "Schnell"], ["it", "Veloce"]]) {
    await p.evaluate((l) => LyonI18n.setLang(l), lang);
    await p.evaluate(() => render());
    check(`langue ${lang} : « ${word} » affiché`, (await p.$$eval(".ai-tier-name", e => e.map(x => x.textContent))).includes(word));
    check(`langue ${lang} : aucune clé brute « ai.* » visible`, !/\bai\.(tier|state|err|load|diag|reset|notice)\./.test(await p.innerText(".ai-status")));
  }
  await p.evaluate(() => LyonI18n.setLang("fr")); await p.evaluate(() => render());
  await p.setViewportSize({ width: 375, height: 800 });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("mobile 375 px : aucun défilement horizontal", overflow <= 0, overflow);
  const cols = await p.$$eval(".ai-tier", els => new Set(els.map(e => Math.round(e.getBoundingClientRect().left))).size);
  eq("mobile : les cartes s'empilent (une seule colonne)", cols, 1);
  await ctx.close();
});

await scenario("19. Aucune exception JavaScript sur tout le parcours nominal", async () => {
  const { ctx } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click('[data-aitier="rapide"]'); await waitStatus(p, "ready");
  await p.evaluate(() => webllmChat([{ role: "user", content: "x" }]));
  await p.evaluate(() => switchTab("home"));
  check("aucune pageerror", p.errors.length === 0, p.errors);
  await ctx.close();
});

await scenario("20. Test complet (bouton du diagnostic) : chaque étape cochée d'après un fait réel", async () => {
  const { ctx } = await open();
  const p = await page(ctx);
  await openAI(p);
  await p.click("#ai-diag-panel summary");
  await p.click("#ai-full-test-btn");
  await p.waitForFunction(() => !state.aiFullTestBusy && state.aiFullTestResult, null, { timeout: 15000 });
  const steps = await S(p, "state.aiFullTestSteps.map(s => s.status)");
  check("les 11 étapes sont « ok »", steps.length === 11 && steps.every(s => s === "ok"), steps);
  check("le texte réel reçu est affiché avec le palier et le premier jeton", /Test réel réussi/.test(await S(p, "state.aiFullTestResult")) && /premier jeton/.test(await S(p, "state.aiFullTestResult")), await S(p, "state.aiFullTestResult"));
  await ctx.close();
  const bad = await open();
  bad.world.behavior = () => ({ throw: "Error: Cannot initialize runtime because of requested maxStorageBufferBindingSize exceeds limit. requested=128MB, limit=64MB. " });
  const p2 = await page(bad.ctx);
  await openAI(p2);
  await p2.click("#ai-diag-panel summary");
  await p2.click("#ai-full-test-btn");
  await p2.waitForFunction(() => !state.aiFullTestBusy && state.aiFullTestResult, null, { timeout: 20000 });
  const steps2 = await S(p2, "state.aiFullTestSteps.map(s => s.status)");
  check("adaptateur/périphérique OK mais chargement KO : les étapes GPU sont vertes, l'étape de chargement rouge", steps2.slice(0, 5).every(s => s === "ok") && steps2[8] === "fail", steps2);
  check("le résultat cite le code d'erreur réel", /OUT_OF_MEMORY_OR_RESOURCE_LIMIT/.test(await S(p2, "state.aiFullTestResult")), await S(p2, "state.aiFullTestResult"));
  await bad.ctx.close();
});

await browser.close();
console.log(`\n${pass} vérifications réussies (PASS MOCK), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
