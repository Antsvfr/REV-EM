/* ============================================================================
   REV-EM — l'hôte du moteur IA (ai-host.js) contre un FAUX WebLLM
   ----------------------------------------------------------------------------
   Exécution :  node tests/ai-host.test.mjs
   Tout ce qui est ici est « PASS MOCK » : le vrai protocole, la vraie machine
   d'états et la vraie logique d'hôte tournent, mais le moteur WebLLM et le GPU
   sont des doubles. Ce fichier ne prouve PAS qu'un modèle se charge sur un vrai
   GPU (NOT TESTED GPU) ni dans un vrai WKWebView (NOT TESTED WKWEBVIEW).
   ============================================================================ */
import { createAiHost } from "../ai-host.js";

const AI = globalThis.RevemAI;
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if(ok){ pass++; console.log(`PASS MOCK — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const scenario = (n) => console.log(`\n── ${n} ──`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ALL_IDS = AI.TIER_ORDER.flatMap(k => [AI.TIERS[k].ids.f16, AI.TIERS[k].ids.f32]);

/* Faux WebLLM : compte les moteurs, et surtout combien sont CHARGÉS en même temps. */
function fakeWebLLM(cfg = {}){
  const world = { created: 0, loaded: 0, maxLoaded: 0, reloads: [], unloads: 0, backends: [], generations: 0 };
  class MLCEngine {
    constructor(conf){
      world.created++; this.conf = conf; this.isLoaded = false; this.interrupted = false; this.gone = false;
      world.backends.push(conf && conf.appConfig && conf.appConfig.cacheBackend);
      this.chat = { completions: { create: (p) => this._create(p) } };
    }
    async reload(id){
      world.reloads.push(id);
      if(cfg.reloadThrow && cfg.reloadThrow(id, this)) throw cfg.reloadThrow(id, this);
      if(cfg.reloadHang) { await new Promise(r => { this._release = r; }); return; }   // aucune progression
      world.loaded++; this.isLoaded = true; world.maxLoaded = Math.max(world.maxLoaded, world.loaded);
      const cb = this.conf.initProgressCallback;
      const steps = [[0.3, "Fetching param cache[1/3]: 10MB fetched. 30% completed"], [0.85, "Loading GPU shader modules[1/2]: 50%"], [1, "Finish loading on WebGPU"]];
      for(const [p, text] of steps){
        await sleep(cfg.stepMs || 2);
        if(this.gone){ return; }   // interrompu : WebLLM retourne SANS erreur
        cb && cb({ progress: p, text });
      }
    }
    async unload(){
      this.gone = true; if(this._release) this._release();
      if(this.isLoaded){ this.isLoaded = false; world.loaded--; }
      world.unloads++;
    }
    interruptGenerate(){ this.interrupted = true; }
    async resetChat(){}
    _create(p){
      if(cfg.warmupThrow && !p.stream && cfg.warmupThrow()) return Promise.reject(cfg.warmupThrow());
      if(!p.stream) return Promise.resolve({ choices: [{ message: { content: "ok" } }] });
      world.generations++;
      const self = this; self.interrupted = false;
      if(cfg.genThrow && cfg.genThrow()) return Promise.reject(cfg.genThrow());
      return Promise.resolve((async function*(){
        const words = cfg.words || ["Bonjour", " le", " monde", " !"];
        for(const w of words){
          await sleep(cfg.tokenMs || 3);
          if(self.interrupted){ yield { choices: [{ delta: {}, finish_reason: "abort" }] }; return; }
          yield { choices: [{ delta: { content: w } }] };
        }
        yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: words.length } };
      })());
    }
  }
  const model_list = ALL_IDS.filter(id => !(cfg.missing || []).includes(id)).map(model_id => ({ model_id, vram_required_MB: 1000 }));
  return { world, module: { MLCEngine, prebuiltAppConfig: { model_list, cacheBackend: "cache" } } };
}
const okProbe = (over) => async () => Object.assign({ context: "worker", api: true, adapter: true, device: true, shaderF16: true, subgroups: false, limits: { maxBufferSize: 4294967296, maxStorageBufferBindingSize: 2147483648 }, info: { vendor: "fake" }, error: null }, over || {});

function mk(webCfg, hostOpts){
  const fw = fakeWebLLM(webCfg);
  const msgs = [];
  const host = createAiHost((m) => msgs.push(m), Object.assign({ loadWebLLM: async () => fw.module, probe: okProbe(), stallMs: 60 }, hostOpts || {}));
  const of = (type, id) => msgs.filter(m => m.type === type && (id === undefined || m.id === id));
  const waitFor = async (type, id, ms = 2000) => { const t0 = Date.now(); for(;;){ const f = of(type, id); if(f.length) return f[f.length - 1]; if(Date.now() - t0 > ms) throw new Error("timeout en attendant " + type + " " + id + " ; reçu : " + msgs.map(m => m.type).join(",")); await sleep(2); } };
  return { fw, msgs, host, of, waitFor, send: (m) => host.handle(m) };
}

/* Faux Cache Storage / IndexedDB pour RESET_AI_CACHE. */
const cacheSet = new Set(["webllm/model", "webllm/wasm", "rev-em-v3-shell"]);
globalThis.caches = { keys: async () => [...cacheSet], delete: async (n) => cacheSet.delete(n) };

(async () => {
  scenario("Init d'un palier : progression → initialisation → prêt, UN moteur");
  {
    const h = mk();
    h.send({ type: "INIT_MODEL", id: "i1", tier: "rapide" });
    const ready = await h.waitFor("MODEL_READY", "i1");
    check("MODEL_DOWNLOAD_PROGRESS reçu", h.of("MODEL_DOWNLOAD_PROGRESS", "i1").length >= 2);
    check("la progression est monotone et finit à 1", (() => { const p = h.of("MODEL_DOWNLOAD_PROGRESS", "i1").map(m => m.progress); return p.every((v, i) => i === 0 || v >= p[i - 1]) && p[p.length - 1] === 1; })());
    check("MODEL_INITIALIZING annoncé une seule fois, avant MODEL_READY", h.of("MODEL_INITIALIZING").length === 1 && h.msgs.indexOf(h.of("MODEL_INITIALIZING")[0]) < h.msgs.indexOf(ready));
    eq("modèle retenu = variante f16 (le GPU l'annonce)", ready.modelId, "Llama-3.2-1B-Instruct-q4f16_1-MLC");
    eq("état prêt", ready.state, "READY");
    eq("un seul moteur créé", h.fw.world.created, 1);
    check("le premier jeton a été réellement généré (échauffement) avant READY", ready.warmupMs >= 0 && h.fw.world.generations === 0);
    h.send({ type: "INIT_MODEL", id: "i2", tier: "rapide" });
    const again = await h.waitFor("MODEL_READY", "i2");
    check("même palier déjà prêt → aucun rechargement", again.reused === true && h.fw.world.created === 1 && h.fw.world.reloads.length === 1);
  }

  scenario("Sans shader-f16 → variante q4f32_1 ; identifiant absent → MODEL_NOT_SUPPORTED");
  {
    const h = mk({}, { probe: okProbe({ shaderF16: false }) });
    h.send({ type: "INIT_MODEL", id: "a", tier: "avance" });
    eq("Phi-4 Mini en f32", (await h.waitFor("MODEL_READY", "a")).modelId, "Phi-4-mini-instruct-q4f32_1-MLC");
    const h2 = mk({ missing: ["Phi-4-mini-instruct-q4f16_1-MLC"] });
    h2.send({ type: "INIT_MODEL", id: "b", tier: "avance" });
    const e = await h2.waitFor("MODEL_ERROR", "b");
    eq("→ MODEL_NOT_SUPPORTED", e.code, "MODEL_NOT_SUPPORTED");
    check("aucun moteur créé, aucun téléchargement tenté", h2.fw.world.created === 0 && h2.fw.world.reloads.length === 0);
    const h3 = mk();
    h3.send({ type: "INIT_MODEL", id: "c", tier: "inconnu" });
    eq("palier inventé refusé", (await h3.waitFor("MODEL_ERROR", "c")).code, "MODEL_NOT_SUPPORTED");
  }

  scenario("WebGPU absent / adaptateur / périphérique : arrêt AVANT tout téléchargement");
  {
    for(const [over, want] of [[{ api: false, adapter: false, device: false, error: "navigator.gpu absent" }, "WEBGPU_UNAVAILABLE"], [{ adapter: false, device: false, error: "aucun adaptateur" }, "ADAPTER_FAILED"], [{ device: false, error: "requestDevice : boom" }, "DEVICE_FAILED"]]){
      const h = mk({}, { probe: okProbe(over) });
      h.send({ type: "INIT_MODEL", id: "p", tier: "rapide" });
      const e = await h.waitFor("MODEL_ERROR", "p");
      check(`${want} et aucun moteur créé`, e.code === want && h.fw.world.created === 0, e.code);
      eq("état ERROR", e.state, "ERROR");
    }
  }

  scenario("Échec d'initialisation : la CAUSE RÉELLE remonte (plus « Erreur inconnue »)");
  {
    const h = mk({ reloadThrow: () => "Error: Cannot initialize runtime because of requested maxStorageBufferBindingSize exceeds limit. requested=128MB, limit=64MB. " });
    h.send({ type: "INIT_MODEL", id: "x", tier: "expert" });
    const e = await h.waitFor("MODEL_ERROR", "x");
    eq("code", e.code, "OUT_OF_MEMORY_OR_RESOURCE_LIMIT");
    check("le vrai message est transmis", /maxStorageBufferBindingSize/.test(e.message));
    check("aucune mention « inconnue »", !/inconnue/i.test(e.message));
    eq("moteur déchargé après l'échec", h.fw.world.loaded, 0);
    check("un échec matériel est éligible au repli", AI.isFallbackWorthy(e.code));
    h.send({ type: "INIT_MODEL", id: "y", tier: "rapide" });
    // le faux lance pour tout id : on vérifie surtout que l'hôte accepte un nouvel INIT après ERROR
    const e2 = await h.waitFor("MODEL_ERROR", "y");
    check("un nouvel INIT est accepté après ERROR (pas de blocage)", e2.busy !== true);
  }

  scenario("Échauffement : un échec au PREMIER JETON est un échec d'init");
  {
    const h = mk({ warmupThrow: () => "Error: GPUPipelineError: shader compilation failed" });
    h.send({ type: "INIT_MODEL", id: "w", tier: "rapide" });
    const e = await h.waitFor("MODEL_ERROR", "w");
    check("MODEL_ERROR au lieu d'un faux « prêt »", e.code !== undefined && h.of("MODEL_READY").length === 0, e.code);
    eq("moteur libéré", h.fw.world.loaded, 0);
  }

  scenario("Concurrence : deux INIT simultanés → un seul moteur");
  {
    const h = mk({ stepMs: 15 });
    h.send({ type: "INIT_MODEL", id: "c1", tier: "avance" });
    h.send({ type: "INIT_MODEL", id: "c2", tier: "rapide" });
    h.send({ type: "SWITCH_MODEL", id: "c3", tier: "expert" });
    const busy2 = await h.waitFor("MODEL_ERROR", "c2");
    const busy3 = await h.waitFor("MODEL_ERROR", "c3");
    check("le 2e et le 3e reçoivent « occupé » (pas d'échec)", busy2.busy && busy3.busy && busy2.code === "BUSY");
    await h.waitFor("MODEL_READY", "c1");
    eq("un seul moteur créé, un seul rechargement", [h.fw.world.created, h.fw.world.reloads.length], [1, 1]);
    eq("jamais plus d'un modèle chargé", h.fw.world.maxLoaded, 1);
  }

  scenario("Génération en flux + mesure du premier jeton");
  {
    const h = mk();
    h.send({ type: "INIT_MODEL", id: "g0", tier: "rapide" }); await h.waitFor("MODEL_READY", "g0");
    h.send({ type: "GENERATE", id: "g1", messages: [{ role: "user", content: "salut" }], temperature: 0.6, maxTokens: 100 });
    const done = await h.waitFor("GENERATION_COMPLETE", "g1");
    eq("jetons dans l'ordre", h.of("GENERATION_TOKEN", "g1").map(m => m.delta).join(""), "Bonjour le monde !");
    check("premier jeton mesuré", typeof done.ttftMs === "number" && done.ttftMs > 0 && done.totalMs >= done.ttftMs);
    eq("retour à READY", done.state, "READY");
    h.send({ type: "GENERATE", id: "g2", messages: [{ role: "user", content: "a" }] });
    h.send({ type: "GENERATE", id: "g3", messages: [{ role: "user", content: "b" }] });
    const busy = await h.waitFor("GENERATION_ERROR", "g3");
    eq("2 générations simultanées : la 2e est refusée", busy.code, "BUSY");
    await h.waitFor("GENERATION_COMPLETE", "g2");
    const h2 = mk();
    h2.send({ type: "GENERATE", id: "n", messages: [] });
    eq("génération avant chargement → NOT_READY", (await h2.waitFor("GENERATION_ERROR", "n")).code, "NOT_READY");
  }

  scenario("ABORT : génération interrompue proprement");
  {
    const h = mk({ tokenMs: 15, words: Array.from({ length: 40 }, (_, i) => " m" + i) });
    h.send({ type: "INIT_MODEL", id: "a0", tier: "rapide" }); await h.waitFor("MODEL_READY", "a0");
    h.send({ type: "GENERATE", id: "a1", messages: [{ role: "user", content: "long" }] });
    await sleep(40);
    h.send({ type: "ABORT", id: "a1" });
    const done = await h.waitFor("GENERATION_COMPLETE", "a1");
    check("terminée avec aborted=true, bien avant les 40 mots", done.aborted === true && h.of("GENERATION_TOKEN", "a1").length < 30, h.of("GENERATION_TOKEN", "a1").length);
    eq("le moteur reste prêt", done.state, "READY");
  }

  scenario("Changement Rapide → Avancé : UN moteur, jamais deux en mémoire");
  {
    const h = mk();
    h.send({ type: "INIT_MODEL", id: "s0", tier: "rapide" }); await h.waitFor("MODEL_READY", "s0");
    h.send({ type: "SWITCH_MODEL", id: "s1", tier: "avance" });
    const r = await h.waitFor("MODEL_READY", "s1");
    eq("le nouveau modèle est chargé", r.modelId, "Phi-4-mini-instruct-q4f16_1-MLC");
    eq("jamais plus d'un modèle chargé simultanément", h.fw.world.maxLoaded, 1);
    eq("l'ancien moteur est déchargé (2 créés, 1 déchargé, 1 chargé)", [h.fw.world.created, h.fw.world.unloads, h.fw.world.loaded], [2, 1, 1]);
  }

  scenario("Changement PENDANT une génération : pas de course sur le GPU");
  {
    const h = mk({ tokenMs: 15, words: Array.from({ length: 40 }, (_, i) => " m" + i) });
    h.send({ type: "INIT_MODEL", id: "r0", tier: "rapide" }); await h.waitFor("MODEL_READY", "r0");
    h.send({ type: "GENERATE", id: "r1", messages: [{ role: "user", content: "long" }] });
    await sleep(40);
    h.send({ type: "SWITCH_MODEL", id: "r2", tier: "avance" });
    const gDone = await h.waitFor("GENERATION_COMPLETE", "r1");
    const ready = await h.waitFor("MODEL_READY", "r2");
    check("la génération est annulée proprement (aborted)", gDone.aborted === true);
    check("la génération s'est terminée AVANT que le nouveau modèle soit prêt", h.msgs.indexOf(gDone) < h.msgs.indexOf(ready));
    eq("jamais deux modèles chargés", h.fw.world.maxLoaded, 1);
    h.send({ type: "GENERATE", id: "r3", messages: [{ role: "user", content: "b" }] });
    check("la génération suivante tourne sur le nouveau modèle", (await h.waitFor("GENERATION_COMPLETE", "r3")).tier === "avance");
  }

  scenario("Périphérique perdu : moteur invalidé, récupération propre");
  {
    let lost = false;
    const h = mk({ genThrow: () => lost ? "ModelNotLoadedError: Model not loaded before calling chatCompletion(). Please ensure you have called `MLCEngine.reload(model)`" : null });
    h.send({ type: "INIT_MODEL", id: "d0", tier: "rapide" }); await h.waitFor("MODEL_READY", "d0");
    lost = true;
    h.send({ type: "GENERATE", id: "d1", messages: [{ role: "user", content: "x" }] });
    const err = await h.waitFor("GENERATION_ERROR", "d1");
    check("« modèle non chargé » après un READY = DEVICE_LOST (inféré, et dit tel)", err.code === "DEVICE_LOST" && err.inferred === true && err.engineInvalidated === true, err);
    check("événement DEVICE_LOST émis", h.of("DEVICE_LOST").length === 1);
    eq("état ERROR, moteur libéré", [h.host.state, h.fw.world.loaded], ["ERROR", 0]);
    h.send({ type: "GENERATE", id: "d2", messages: [{ role: "user", content: "x" }] });
    eq("aucune génération sur un moteur invalidé", (await h.waitFor("GENERATION_ERROR", "d2")).code, "NOT_READY");
    lost = false;
    h.send({ type: "INIT_MODEL", id: "d3", tier: "rapide" });
    check("récupération : un nouvel INIT relance un moteur sain", (await h.waitFor("MODEL_READY", "d3")).state === "READY");
  }

  scenario("Perte de périphérique RÉELLE (faux GPUAdapter, raison fournie par le navigateur)");
  {
    let resolveLost;
    globalThis.GPUAdapter = class { async requestDevice(){ return { lost: new Promise(r => { resolveLost = r; }), destroy(){} }; } };
    const h = mk();     // installe le crochet sur le faux GPUAdapter
    h.send({ type: "INIT_MODEL", id: "l0", tier: "rapide" }); await h.waitFor("MODEL_READY", "l0");
    await new GPUAdapter().requestDevice();       // ce que ferait WebLLM
    resolveLost({ reason: "unknown", message: "GPU hang" });
    await sleep(10);
    const ev = h.of("DEVICE_LOST").pop();
    check("DEVICE_LOST avec la raison du navigateur", ev && ev.reason === "unknown" && /GPU hang/.test(ev.message), ev);
    eq("état ERROR", h.host.state, "ERROR");
    resolveLost = null;
    const h2 = mk(); h2.send({ type: "INIT_MODEL", id: "l1", tier: "rapide" }); await h2.waitFor("MODEL_READY", "l1");
    let resolveDestroyed; const dev = { lost: new Promise(r => { resolveDestroyed = r; }) };
    globalThis.GPUAdapter.prototype.requestDevice = async function(){ return dev; };
    await new GPUAdapter().requestDevice();
    const before = h2.of("DEVICE_LOST").length;
    resolveDestroyed({ reason: "destroyed", message: "" }); await sleep(10);
    check("un périphérique détruit VOLONTAIREMENT n'est pas une perte", h2.of("DEVICE_LOST").length === before && h2.host.state === "READY");
    delete globalThis.GPUAdapter;
  }

  scenario("Annulation d'un chargement (ABORT pendant LOADING)");
  {
    const h = mk({ stepMs: 30 });
    h.send({ type: "INIT_MODEL", id: "k0", tier: "avance" });
    await sleep(45);
    h.send({ type: "ABORT" });
    const e = await h.waitFor("MODEL_ERROR", "k0");
    check("MODEL_ERROR marqué cancelled (WebLLM retourne sans erreur : on ne le prend PAS pour un succès)", e.cancelled === true && h.of("MODEL_READY").length === 0, e);
    eq("état IDLE, rien de chargé", [h.host.state, h.fw.world.loaded], ["IDLE", 0]);
  }

  scenario("Garde-fou : plus aucune progression → MODEL_DOWNLOAD_FAILED (pas un blocage éternel)");
  {
    const h = mk({ reloadHang: true }, { stallMs: 40 });
    h.send({ type: "INIT_MODEL", id: "t0", tier: "rapide" });
    const e = await h.waitFor("MODEL_ERROR", "t0");
    check("code MODEL_DOWNLOAD_FAILED, stalled=true", e.code === "MODEL_DOWNLOAD_FAILED" && e.stalled === true, e);
    check("un blocage réseau n'est PAS éligible au repli", !AI.isFallbackWorthy(e.code));
  }

  scenario("Cache API refusé → seconde chance avec le cache IndexedDB de WebLLM");
  {
    const h = mk({ reloadThrow: (id, eng) => (eng.conf.appConfig.cacheBackend === "cache") ? "QuotaExceededError: Failed to execute 'put' on 'Cache': Quota exceeded." : null });
    h.send({ type: "INIT_MODEL", id: "q0", tier: "rapide" });
    const r = await h.waitFor("MODEL_READY", "q0");
    eq("chargé avec le backend indexeddb", [r.cacheBackend, h.fw.world.backends], ["indexeddb", ["cache", "indexeddb"]]);
    check("les deux tentatives : un seul moteur chargé à la fois", h.fw.world.maxLoaded === 1);
    check("le repli de cache est annoncé à l'interface", h.of("MODEL_DOWNLOAD_PROGRESS").some(m => m.cacheFallback));
  }

  scenario("RESET_AI_CACHE : décharge le moteur puis n'efface QUE le cache IA");
  {
    const h = mk();
    h.send({ type: "INIT_MODEL", id: "z0", tier: "rapide" }); await h.waitFor("MODEL_READY", "z0");
    h.send({ type: "RESET_AI_CACHE", id: "z1" });
    const done = await h.waitFor("CACHE_RESET_DONE", "z1");
    eq("moteur déchargé, état IDLE", [h.fw.world.loaded, done.state], [0, "IDLE"]);
    check("caches webllm/* supprimés", done.report.cacheNames.includes("webllm/model") && done.report.cacheNames.includes("webllm/wasm"));
    check("cache du service worker intact", cacheSet.has("rev-em-v3-shell"));
  }

  scenario("GET_STATUS et messages invalides");
  {
    const h = mk({}, { probe: okProbe({ shaderF16: true }) });
    h.send({ type: "GET_STATUS", id: "st", probe: true });
    const st = await h.waitFor("STATUS", "st");
    check("STATUS transporte la sonde de CE contexte", st.probe && st.probe.api === true && st.context === "worker");
    eq("version WebLLM annoncée", st.webllmVersion, AI.WEBLLM_VERSION);
    h.send({ type: "N'IMPORTE_QUOI", id: "bad" });
    eq("type inconnu → erreur claire, pas de silence", (await h.waitFor("MODEL_ERROR", "bad")).stage, "protocol");
    h.send(null);
    check("message nul → erreur claire, pas d'exception", h.of("MODEL_ERROR").length >= 2);
    check("le message d'erreur du protocole ne contient jamais de secret", !h.msgs.some(m => /eyJ|@/.test(JSON.stringify(m))));
  }

  console.log(`\n${pass} vérifications réussies (PASS MOCK), ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERREUR DE TEST :", e); process.exit(1); });
