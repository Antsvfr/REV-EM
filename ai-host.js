/* ============================================================================
   ai-host.js — l'hôte du moteur WebLLM (UN moteur, UN modèle, UN protocole)
   ----------------------------------------------------------------------------
   Tourne normalement dans un Web Worker (voir ai-worker.js). La page peut
   aussi le faire tourner sur le fil principal, UNIQUEMENT quand une preuve
   mesurée montre que le worker ne peut pas accueillir WebGPU (voir
   AI_AUDIT.md §Stratégie WKWebView) : le protocole est identique dans les
   deux cas, seul le transport change.

   Pourquoi ne plus utiliser WebWorkerMLCEngineHandler ?
     Son `handleTask` transforme toute erreur en CHAÎNE (`err.toString()`) ;
     côté page la promesse était rejetée avec cette chaîne, et l'ancien code
     lisait `raw.message` — donc « Erreur inconnue pendant l'initialisation »,
     alors que le vrai motif était dans la chaîne. Ici chaque erreur est
     classée (RevemAI.classifyError) et renvoyée structurée.

   PROTOCOLE — page → hôte
     INIT_MODEL     { id, tier }           charger un palier (rapide|avance|expert)
     SWITCH_MODEL   { id, tier }           idem ; annule d'abord toute génération
     GENERATE       { id, messages, temperature, topP?, maxTokens }
     ABORT          { id? }                interrompt la génération (ou le chargement)
     RESET_AI_CACHE { id }                 décharge le moteur puis efface le cache IA
     GET_STATUS     { id, probe? }         état + (option) sonde WebGPU de CE contexte
   hôte → page (chacun porte `state`, l'état de la machine)
     WORKER_READY, MODEL_DOWNLOAD_PROGRESS, MODEL_INITIALIZING, MODEL_READY,
     MODEL_ERROR, GENERATION_TOKEN, GENERATION_COMPLETE, GENERATION_ERROR,
     DEVICE_LOST, STATUS, CACHE_RESET_DONE, WORKER_ERROR

   Invariants : un seul MLCEngine vivant ; les opérations de chargement sont
   sérialisées ; une génération exige l'état READY ; un changement de modèle
   attend la fin propre de la génération en cours avant de toucher au GPU.
   ============================================================================ */
import "./ai-engine.js";

const AI = globalThis.RevemAI;
const now = () => (globalThis.performance && performance.now) ? performance.now() : Date.now();

let webllmPromise = null;
function loadWebLLM(){
  if(!webllmPromise){
    /* import() dynamique : un échec réseau devient une erreur ATTRAPABLE
       (WEBLLM_IMPORT_FAILED). Avec un `import … from` statique en tête de
       worker, il tuait le worker entier sans le moindre message exploitable. */
    webllmPromise = import(AI.WEBLLM_URL).catch(function(e){ webllmPromise = null; throw e; });
  }
  return webllmPromise;
}

/* ── Sonde WebGPU du contexte COURANT (worker ou page) ──────────────────── */
const LIMIT_KEYS = ["maxBufferSize", "maxStorageBufferBindingSize", "maxComputeInvocationsPerWorkgroup",
                    "maxComputeWorkgroupStorageSize", "maxStorageBuffersPerShaderStage"];
let suppressLostHook = false;

export async function probeGpu(context){
  const r = { context: context || "worker", api: false, adapter: false, device: false,
              shaderF16: false, subgroups: false, limits: null, info: null, error: null };
  const nav = globalThis.navigator;
  if(!nav || !nav.gpu){ r.error = "navigator.gpu est absent dans ce contexte (" + r.context + ")."; return r; }
  r.api = true;
  let adapter = null;
  try{
    adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if(!adapter) adapter = await nav.gpu.requestAdapter();
  }catch(e){ r.error = "requestAdapter : " + AI.normalizeError(e).message; return r; }
  if(!adapter){ r.error = "requestAdapter() n'a renvoyé aucun adaptateur."; return r; }
  r.adapter = true;
  try{
    r.shaderF16 = !!(adapter.features && adapter.features.has && adapter.features.has("shader-f16"));
    r.subgroups = !!(adapter.features && adapter.features.has && adapter.features.has("subgroups"));
    if(adapter.limits){ r.limits = {}; LIMIT_KEYS.forEach(k => { if(typeof adapter.limits[k] === "number") r.limits[k] = adapter.limits[k]; }); }
    let info = adapter.info || null;
    if(!info && typeof adapter.requestAdapterInfo === "function") info = await adapter.requestAdapterInfo();
    if(info){ r.info = {}; ["vendor", "architecture", "description"].forEach(k => { if(info[k]) r.info[k] = String(info[k]); }); }
  }catch(e){ /* les infos d'adaptateur sont facultatives */ }
  try{
    suppressLostHook = true;
    const d = await adapter.requestDevice();
    r.device = true;
    try{ d.destroy(); }catch(e){}   // ne pas laisser un périphérique inutilisé ouvert
  }catch(e){ r.error = "requestDevice : " + AI.normalizeError(e).message; }
  finally{ suppressLostHook = false; }
  return r;
}

/* Écoute RÉELLE de la perte de périphérique (raison fournie par le navigateur),
   posée une fois sur GPUAdapter.prototype.requestDevice. Les périphériques
   détruits volontairement (reason "destroyed") ne sont pas des pertes. */
let hookInstalled = false;
const lostHandlers = new Set();
function installDeviceLostHook(onLost){
  lostHandlers.add(onLost);
  if(hookInstalled) return;
  const Adapter = globalThis.GPUAdapter;
  if(!Adapter || !Adapter.prototype || typeof Adapter.prototype.requestDevice !== "function") return;
  hookInstalled = true;
  const original = Adapter.prototype.requestDevice;
  Adapter.prototype.requestDevice = async function(){
    const device = await original.apply(this, arguments);
    if(!suppressLostHook && device && device.lost && device.lost.then){
      device.lost.then(function(info){
        if(info && info.reason === "destroyed") return;
        const detail = { reason: (info && info.reason) || "unknown", message: (info && info.message) || "" };
        lostHandlers.forEach(function(fn){ try{ fn(detail); }catch(e){} });
      });
    }
    return device;
  };
}

function phaseOf(text){
  const s = String(text || "");
  if(/from cache/i.test(s)) return "cache";
  if(/fetching|fetched/i.test(s)) return "download";
  if(/shader|compil/i.test(s)) return "compile";
  if(/finish|ready/i.test(s)) return "init";
  return "prepare";
}

/* ── L'hôte ─────────────────────────────────────────────────────────────── */
export function createAiHost(post, opts){
  opts = opts || {};
  const context = opts.context || "worker";
  const stallMs = opts.stallMs || 90000;
  /* opts.loadWebLLM / opts.probe : points d'injection pour les tests (faux moteur, faux GPU). */
  const machine = AI.createMachine();

  let webllm = null;
  let engine = null;           // LE moteur — jamais plus d'un
  let current = null;          // { tier, modelId, variant, vramMB }
  let gen = null;              // { id, aborted, done }
  let queue = Promise.resolve();
  let epoch = 0;
  let cancelRequested = false;
  let stalled = false;
  let cacheBackend = (typeof caches === "undefined") ? "indexeddb" : "cache";
  let lastProbe = null, lastError = null, lastDeviceLost = null;

  function emit(type, id, data){
    try{ post(Object.assign({ type: type, id: id === undefined ? null : id, state: machine.state }, data || {})); }catch(e){}
  }
  function enqueue(fn){ queue = queue.then(fn, fn).catch(function(){}); return queue; }

  installDeviceLostHook(function(info){
    lastDeviceLost = Object.assign({ at: Date.now() }, info);
    if(machine.state === "READY" || machine.state === "GENERATING" || machine.state === "LOADING"){
      machine.force("ERROR");
      emit("DEVICE_LOST", null, { reason: info.reason, message: AI.redact(info.message), tier: current && current.tier, modelId: current && current.modelId });
    }
  });

  async function disposeEngine(){
    const e = engine; engine = null; current = null;
    if(e){ try{ await e.unload(); }catch(err){ /* déjà déchargé ou périphérique perdu */ } }
  }

  function fail(code, message){ const e = new Error(message); e.revemCode = code; return e; }

  async function initModel(msg, myEpoch){
    const id = msg.id, tier = msg.tier;
    let stage = "import", triedIdb = false, info = null;
    cancelRequested = false; stalled = false;
    const cancelNow = async () => {
      await disposeEngine(); machine.force("IDLE");
      emit("MODEL_ERROR", id, { cancelled: true, tier, code: "CANCELLED", message: "Chargement annulé." });
    };
    const t0 = now();
    let watchdog = null, announcedInit = false, lastProgress = 0;
    const armWatchdog = () => {
      if(watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; if(engine) engine.unload().catch(function(){}); }, stallMs);
    };
    try{
      if(!AI.isTier(tier)) throw fail("MODEL_NOT_SUPPORTED", "Palier inconnu : " + String(tier).slice(0, 30));
      emit("MODEL_DOWNLOAD_PROGRESS", id, { tier, progress: 0, phase: "prepare", text: "Chargement du moteur WebLLM " + AI.WEBLLM_VERSION + "…" });
      webllm = await (opts.loadWebLLM || loadWebLLM)();
      if(myEpoch !== epoch){ await cancelNow(); return; }

      stage = "probe";
      const probe = lastProbe = await (opts.probe || probeGpu)(context);
      if(!probe.api) throw fail("WEBGPU_UNAVAILABLE", probe.error);
      if(!probe.adapter) throw fail("ADAPTER_FAILED", probe.error);
      if(!probe.device) throw fail("DEVICE_FAILED", probe.error);
      if(myEpoch !== epoch){ await cancelNow(); return; }

      /* Identifiant : jamais construit à la main. Le tableau de RevemAI donne
         les deux variantes ; on choisit celle que le GPU sait exécuter, puis on
         VÉRIFIE qu'elle existe dans le model_list de CETTE version de WebLLM. */
      const variant = AI.variantFor({ shaderF16: probe.shaderF16 });
      const modelId = AI.modelIdFor(tier, variant);
      const list = (webllm.prebuiltAppConfig && webllm.prebuiltAppConfig.model_list) || [];
      const record = list.find(m => m.model_id === modelId);
      if(!record) throw fail("MODEL_NOT_SUPPORTED", "« " + modelId + " » est absent du model_list de WebLLM " + AI.WEBLLM_VERSION + ".");
      if(record.required_features && record.required_features.indexOf("shader-f16") >= 0 && !probe.shaderF16){
        throw fail("DEVICE_FAILED", "Ce modèle exige shader-f16, absent de cet adaptateur.");
      }

      await disposeEngine();
      if(myEpoch !== epoch){ await cancelNow(); return; }
      stage = "init";
      info = current = { tier, modelId, variant, vramMB: record.vram_required_MB || null };

      const buildEngine = () => {
        const appConfig = Object.assign({}, webllm.prebuiltAppConfig, { cacheBackend });
        return new webllm.MLCEngine({
          appConfig,
          initProgressCallback: (report) => {
            if(myEpoch !== epoch) return;
            armWatchdog();
            const text = (report && report.text) || "";
            const phase = phaseOf(text);
            lastProgress = Math.max(lastProgress, (report && report.progress) || 0);
            const fetched = text.match(/([\d.]+)\s*MB fetched/i);
            if((phase === "compile" || phase === "init") && !announcedInit){
              announcedInit = true;
              emit("MODEL_INITIALIZING", id, { tier, modelId });
            }
            emit("MODEL_DOWNLOAD_PROGRESS", id, { tier, modelId, progress: lastProgress, phase, text, fetchedMB: fetched ? parseFloat(fetched[1]) : null });
          },
        });
      };

      for(;;){
        engine = buildEngine();
        armWatchdog();
        try{
          await engine.reload(modelId);
          /* engine.reload() RETOURNE SANS ERREUR quand le chargement a été
             interrompu (unload pendant le téléchargement) : on ne peut donc
             pas déduire « prêt » de « la promesse s'est résolue ». */
          if(stalled) throw fail("MODEL_DOWNLOAD_FAILED", "Aucune progression depuis " + Math.round(stallMs / 1000) + " s : téléchargement interrompu.");
          if(cancelRequested || myEpoch !== epoch){ await cancelNow(); return; }
          break;
        }catch(err){
          const c = AI.classifyError(err && err.revemCode ? { name: "", message: err.message } : err, { stage: "init", stalled });
          const isCache = c.code === "MODEL_CACHE_CORRUPTED" && cacheBackend === "cache" && /cache/i.test(c.message);
          if(!triedIdb && isCache && !stalled && !cancelRequested){
            /* Le Cache API du navigateur refuse d'écrire (quota, contexte
               restreint…) : seconde chance avec le cache IndexedDB de WebLLM. */
            triedIdb = true; cacheBackend = "indexeddb";
            await disposeEngine(); current = info;
            emit("MODEL_DOWNLOAD_PROGRESS", id, { tier, modelId, progress: 0, phase: "prepare", text: "Cache du navigateur indisponible : nouvel essai avec IndexedDB…", cacheFallback: true });
            continue;
          }
          throw err;
        }
      }
      if(watchdog){ clearTimeout(watchdog); watchdog = null; }

      /* Dernier maillon de la chaîne : générer VRAIMENT un premier jeton. Les
         échecs WebGPU paresseux (shaders, pipeline) n'apparaissent souvent
         qu'ici, pas dans reload(). */
      stage = "warmup";
      const w0 = now();
      await engine.chat.completions.create({ messages: [{ role: "user", content: "ok" }], max_tokens: 1, temperature: 0, stream: false });
      try{ await engine.resetChat(); }catch(e){}
      const warmupMs = now() - w0;

      if(cancelRequested || myEpoch !== epoch){ await cancelNow(); return; }
      current = info;
      /* Un périphérique perdu PENDANT le chargement a forcé l'état ERROR : ne pas annoncer « prêt ». */
      if(!machine.to("READY")) throw fail("DEVICE_LOST", "Le périphérique GPU a été perdu pendant le chargement.");
      lastError = null;
      emit("MODEL_READY", id, { tier, modelId, variant, vramMB: info.vramMB, cacheBackend, probe, initMs: Math.round(now() - t0), warmupMs: Math.round(warmupMs) });
    }catch(err){
      if(watchdog) clearTimeout(watchdog);
      if(cancelRequested){ await cancelNow(); return; }
      const cls = err && err.revemCode
        ? { code: err.revemCode, name: "", message: err.message, messageKey: "ai.err." + err.revemCode, hasMessage: true }
        : AI.classifyError(err, { stage: stage === "probe" ? "init" : (stage === "warmup" ? "init" : stage), stalled });
      lastError = { code: cls.code, message: cls.message, name: cls.name, stage, tier, at: Date.now() };
      const failedModel = info && info.modelId;
      await disposeEngine();
      machine.force("ERROR");
      emit("MODEL_ERROR", id, { tier, modelId: failedModel || null, code: cls.code, name: cls.name, message: AI.redact(cls.message), stage, stalled, cacheBackend, probe: lastProbe });
    }
  }

  function requestInit(msg){
    const id = msg.id;
    if(machine.state === "LOADING" || machine.state === "SWITCHING"){
      emit("MODEL_ERROR", id, { code: "BUSY", busy: true, tier: msg.tier, message: "Un chargement est déjà en cours." });
      return;
    }
    /* Même palier déjà prêt : rien à recharger (jamais de rechargement inutile). */
    if(machine.state === "READY" && current && current.tier === msg.tier){
      emit("MODEL_READY", id, { tier: current.tier, modelId: current.modelId, variant: current.variant, vramMB: current.vramMB, cacheBackend, probe: lastProbe, reused: true });
      return;
    }
    const wasGenerating = machine.state === "GENERATING";
    const previous = machine.state;
    if(previous === "IDLE") machine.to("LOADING");                 // synchrone : un 2e INIT_MODEL verra LOADING
    else machine.to("SWITCHING");                                  // READY / GENERATING / ERROR
    const myEpoch = ++epoch;
    enqueue(async () => {
      if(wasGenerating && gen){ gen.aborted = true; try{ engine && engine.interruptGenerate(); }catch(e){} await gen.done; }
      if(machine.state !== "LOADING") machine.force("LOADING");
      await initModel(msg, myEpoch);
    });
  }

  function startGenerate(msg){
    const id = msg.id;
    if(!machine.canGenerate() || !engine){
      emit("GENERATION_ERROR", id, { code: machine.state === "GENERATING" ? "BUSY" : "NOT_READY", message: machine.state === "GENERATING" ? "Une génération est déjà en cours." : "Le modèle n'est pas prêt (état : " + machine.state + ")." });
      return;
    }
    machine.to("GENERATING");
    const g = gen = { id, aborted: false, done: null };
    const eng = engine;
    g.done = (async () => {
      const t0 = now();
      let ttft = null, chars = 0, usage = null, finish = null;
      const tierNow = current && current.tier;
      try{
        const req = {
          messages: msg.messages, stream: true, stream_options: { include_usage: true },
          temperature: typeof msg.temperature === "number" ? msg.temperature : 0.6,
          max_tokens: msg.maxTokens || AI.maxTokensFor("chat"),
        };
        /* top_p : paramètre OpenAI-compatible réellement présent dans WebLLM 0.2.85 (chat_completion.d.ts) ; absent de la
           requête s'il n'est pas fourni — les appels existants (cours, quiz…) ne changent pas. */
        if(typeof msg.topP === "number" && msg.topP > 0 && msg.topP <= 1) req.top_p = msg.topP;
        const stream = await eng.chat.completions.create(req);
        for await (const chunk of stream){
          if(chunk && chunk.usage) usage = chunk.usage;
          const choice = chunk && chunk.choices && chunk.choices[0];
          if(choice && choice.finish_reason) finish = choice.finish_reason;
          const delta = choice && choice.delta && choice.delta.content;
          if(delta){
            if(ttft === null) ttft = now() - t0;
            chars += delta.length;
            emit("GENERATION_TOKEN", id, { delta });
          }
          if(g.aborted) break;
        }
        if(machine.state === "GENERATING") machine.to("READY");
        emit("GENERATION_COMPLETE", id, { aborted: g.aborted, chars, ttftMs: ttft, totalMs: Math.round(now() - t0), finishReason: finish, usage, tier: tierNow });
      }catch(err){
        /* Un modèle « non chargé » après un READY = WebLLM a déchargé le moteur
           de lui-même (perte de périphérique) : on le déduit, et on le DIT. */
        const text = (AI.normalizeError(err).name || "") + " " + (AI.normalizeError(err).message || "");
        const inferredLost = /modelnotloaded|not loaded before/i.test(text);
        const c = inferredLost ? { code: "DEVICE_LOST", message: "Le moteur a été déchargé pendant la génération (périphérique GPU probablement perdu).", name: "" } : AI.classifyError(err, { stage: "generate" });
        lastError = { code: c.code, message: c.message, name: c.name, stage: "generate", tier: current && current.tier, at: Date.now() };
        const invalid = c.code === "DEVICE_LOST" || c.code === "OUT_OF_MEMORY_OR_RESOURCE_LIMIT";
        if(invalid){ await disposeEngine(); machine.force("ERROR"); }
        else if(machine.state === "GENERATING") machine.to("READY");
        emit("GENERATION_ERROR", id, { code: c.code, message: AI.redact(c.message), name: c.name, contextExceeded: !!c.contextExceeded, engineInvalidated: invalid, inferred: inferredLost });
        if(invalid) emit("DEVICE_LOST", null, { reason: lastDeviceLost ? lastDeviceLost.reason : "inferred", message: AI.redact(c.message), tier: tierNow });
      }finally{
        if(gen === g) gen = null;
      }
    })();
  }

  function abort(id){
    if(gen && (!id || gen.id === id)){
      gen.aborted = true;
      try{ engine && engine.interruptGenerate(); }catch(e){}
      return;
    }
    if(machine.state === "LOADING" || machine.state === "SWITCHING"){
      cancelRequested = true; epoch++;
      if(engine) engine.unload().catch(function(){});
    }
  }

  async function resetCache(msg){
    cancelRequested = true; epoch++;
    if(gen){ gen.aborted = true; try{ engine && engine.interruptGenerate(); }catch(e){} await gen.done; }
    await disposeEngine();
    machine.force("IDLE");
    const report = await AI.resetAiStorage({ caches: globalThis.caches, indexedDB: globalThis.indexedDB });
    emit("CACHE_RESET_DONE", msg.id, { report });
  }

  async function getStatus(msg){
    let probe = lastProbe;
    if(msg.probe) probe = lastProbe = await (opts.probe || probeGpu)(context);
    emit("STATUS", msg.id, {
      context, tier: current && current.tier, modelId: current && current.modelId, variant: current && current.variant,
      webllmLoaded: !!webllm, webllmVersion: AI.WEBLLM_VERSION, cacheBackend,
      probe, lastError, deviceLost: lastDeviceLost,
    });
  }

  return {
    get state(){ return machine.state; },
    handle(msg){
      if(!msg || typeof msg.type !== "string"){
        emit("MODEL_ERROR", msg && msg.id, { code: "UNKNOWN", message: "Message invalide reçu par le moteur IA.", stage: "protocol" });
        return;
      }
      switch(msg.type){
        case "INIT_MODEL": case "SWITCH_MODEL": requestInit(msg); break;
        case "GENERATE": startGenerate(msg); break;
        case "ABORT": abort(msg.id); break;
        case "RESET_AI_CACHE": enqueue(() => resetCache(msg)); break;
        case "GET_STATUS": getStatus(msg); break;
        default: emit("MODEL_ERROR", msg.id, { code: "UNKNOWN", message: "Type de message inconnu : " + String(msg.type).slice(0, 40), stage: "protocol" });
      }
    },
  };
}
