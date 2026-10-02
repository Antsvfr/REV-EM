/* ============================================================================
   ai-engine.js — la logique PURE de l'assistant IA local
   ----------------------------------------------------------------------------
   `globalThis.RevemAI` — même patron que smart-revision.js, statistics.js,
   command-center.js, quick-actions.js et subject-search.js : aucune
   dépendance au DOM, à `state`, à `localStorage`, à WebGPU ni à WebLLM.
   Ce fichier reçoit des faits (erreurs, limites GPU, historique) et rend des
   décisions (quel palier, quel code d'erreur, quel repli). Testable sous Node
   en quelques millisecondes : `node tests/ai-engine.test.js`.

   Il est chargé à deux endroits, sans être dupliqué :
     • par la page (<script src="ai-engine.js">),
     • par ai-host.js (dans le Worker), via `import "./ai-engine.js"`.

   Ce que ce fichier NE fait PAS : parler à WebGPU, télécharger un modèle,
   lire/écrire le stockage. Tout ce qui touche au navigateur est injecté
   (caches / indexedDB dans resetAiStorage) ou vit dans ai-host.js / index.html.

   HONNÊTETÉ : les identifiants de modèle ci-dessous ont été relevés dans le
   `prebuiltAppConfig.model_list` de @mlc-ai/web-llm 0.2.85 (voir
   AI_AUDIT.md). Ils ne sont JAMAIS présentés comme « fonctionnant sur ta
   machine » : seule une initialisation réellement réussie le prouve, et elle
   est enregistrée localement (recordSuccess).
   ============================================================================ */
(function(global){
  "use strict";

  /* Version ÉPINGLÉE de WebLLM. Avant : `esm.run/@mlc-ai/web-llm` sans
     version, résolue séparément par la page ET par le worker à chaque
     déploiement du CDN. Un identifiant de modèle valide un jour pouvait ne
     plus l'être le lendemain, sans qu'aucun fichier du dépôt ne change. */
  var WEBLLM_VERSION = "0.2.85";
  var WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@" + WEBLLM_VERSION;

  var MB = 1 << 20, GIB = 1 << 30;

  /* ── 1. PALIERS ─────────────────────────────────────────────────────────
     `ids.f16` / `ids.f32` : les deux quantifications réellement présentes
     dans le model_list (q4f16_1 exige la fonctionnalité WebGPU shader-f16 ;
     q4f32_1 fonctionne sans). `memMB` = `vram_required_MB` publié par WebLLM
     (une ESTIMATION du fabricant du moteur, pas une mesure sur cet appareil).
     Aucune VRAM n'est jamais « détectée » : sur Apple Silicon la mémoire est
     unifiée et WebGPU ne l'expose pas. */
  var TIERS = {
    rapide: {
      key: "rapide", rank: 1,
      family: "Llama 3.2 1B Instruct",
      ids: { f16: "Llama-3.2-1B-Instruct-q4f16_1-MLC", f32: "Llama-3.2-1B-Instruct-q4f32_1-MLC" },
      memMB: { f16: 879, f32: 1129 },
      approxGo: "≈0,9",
      reasoning: false,
    },
    avance: {
      key: "avance", rank: 2,
      family: "Phi-4 Mini Instruct",
      ids: { f16: "Phi-4-mini-instruct-q4f16_1-MLC", f32: "Phi-4-mini-instruct-q4f32_1-MLC" },
      memMB: { f16: 3438, f32: 4221 },
      approxGo: "≈3,4",
      reasoning: false,
    },
    expert: {
      key: "expert", rank: 3,
      family: "DeepSeek-R1 Distill Qwen 7B",
      ids: { f16: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC", f32: "DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC" },
      memMB: { f16: 5107, f32: 5900 },
      approxGo: "≈5,1",
      reasoning: true,
    },
  };
  var TIER_ORDER = ["rapide", "avance", "expert"];
  /* Fenêtre de contexte réelle de ces trois modèles (`overrides` du model_list). */
  var CONTEXT_TOKENS = 4096;

  function isTier(k){ return !!TIERS[k]; }
  function variantFor(features){ return (features && features.shaderF16) ? "f16" : "f32"; }
  function modelIdFor(tier, variant){ return TIERS[tier] ? TIERS[tier].ids[variant === "f16" ? "f16" : "f32"] : null; }
  function tierOfModelId(id){
    for(var i = 0; i < TIER_ORDER.length; i++){
      var t = TIERS[TIER_ORDER[i]];
      if(t.ids.f16 === id || t.ids.f32 === id) return t.key;
    }
    return null;
  }

  /* ── 2. ERREURS ─────────────────────────────────────────────────────────
     WebLLM renvoie les erreurs du worker sous forme de CHAÎNE (`err.toString()`
     dans handleTask, puis `reject(msg.content)` côté page). `raw.message`
     vaut donc `undefined` : l'ancien code affichait « Erreur inconnue » alors
     que le vrai texte était là, dans la chaîne. normalizeError accepte une
     chaîne, un Error, un DOMException, un objet clonable, ou rien. */
  var CODES = [
    "WEBGPU_UNAVAILABLE", "ADAPTER_FAILED", "DEVICE_FAILED", "WORKER_FAILED",
    "WEBLLM_IMPORT_FAILED", "MODEL_NOT_SUPPORTED", "MODEL_DOWNLOAD_FAILED",
    "MODEL_CACHE_CORRUPTED", "ENGINE_INIT_FAILED", "DEVICE_LOST",
    "OUT_OF_MEMORY_OR_RESOURCE_LIMIT", "GENERATION_FAILED", "UNKNOWN",
  ];

  function normalizeError(raw){
    var out = { name: "", message: "", stack: "" };
    if(raw === undefined || raw === null){ return out; }
    if(typeof raw === "string"){
      var m = raw.match(/^((?:[A-Za-z_$][\w$]*)?(?:Error|Exception)):\s*([\s\S]*)$/);
      if(m){ out.name = m[1]; out.message = m[2]; } else { out.message = raw; }
      return out;
    }
    if(typeof raw === "object"){
      out.name = typeof raw.name === "string" ? raw.name : "";
      out.message = typeof raw.message === "string" ? raw.message : "";
      out.stack = typeof raw.stack === "string" ? raw.stack : "";
      if(!out.message && !out.name){
        /* Événement d'erreur de Worker (ErrorEvent) : message/filename/lineno. */
        if(typeof raw.filename === "string" && raw.filename) out.message = "erreur dans " + raw.filename + (raw.lineno ? ":" + raw.lineno : "");
        else { try{ out.message = String(raw); if(out.message === "[object Object]") out.message = safeJson(raw); }catch(e){} }
      }
      return out;
    }
    out.message = String(raw);
    return out;
  }
  function safeJson(o){ try{ return JSON.stringify(o); }catch(e){ return ""; } }

  /* Le motif est testé sur « name: message ». Ordre = priorité. */
  var PATTERNS = [
    ["DEVICE_LOST", /device (was )?lost|devicelost|gpu ?device.*lost|context lost/i],
    ["WEBLLM_IMPORT_FAILED", /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to resolve module specifier/i],
    ["MODEL_NOT_SUPPORTED", /cannot find model record|modelnotfound|missingmodelwasm|model_lib|unknown model|not (found )?in (the )?(model_list|appconfig)|unsupported model/i],
    ["OUT_OF_MEMORY_OR_RESOURCE_LIMIT", /out of memory|\boom\b|allocation failed|failed to allocate|createbuffer|maxbuffersize|maxstoragebufferbindingsize|maxcompute|maxstoragebuffersper|exceeds (the )?limit|requested limit|memory access out of bounds|array buffer allocation|insufficient memory/i],
    ["DEVICE_FAILED", /requestdevice|shader-f16|shaderf16|webgpu extension|feature .* (not|isn't) (enabled|supported)|featuresupport|invalid (device|adapter)/i],
    ["ADAPTER_FAILED", /unable to find a compatible gpu|requestadapter|no (suitable )?adapter|adapter.*(null|unavailable)/i],
    ["WEBGPU_UNAVAILABLE", /webgpu (is )?(not|un)(supported|available)|webgpunotavailable|cannot find webgpu|navigator\.gpu/i],
    ["MODEL_CACHE_CORRUPTED", /quotaexceeded|quota|failed to execute '(put|add|match)' on 'cache'|cache ?(storage)?.*(error|corrupt|invalid)|integrity|checksum|corrupt|unexpected end of|magic word|webassembly\.(compile|instantiate)|compileerror|linkerror/i],
    ["MODEL_DOWNLOAD_FAILED", /failed to fetch|networkerror|network error|load failed|fetch (failed|error)|http error|status code|\b(4|5)\d\d\b.*(huggingface|raw\.githubusercontent)|err_(internet|connection|network|name)|timed out|stalled|abort(ed)?error/i],
  ];

  /* ctx.stage : "import" | "worker" | "init" | "generate" — l'étape où l'erreur
     est apparue, utilisée pour le repli quand aucun motif ne reconnaît le texte.
     ctx.stalled : le garde-fou d'absence de progression a coupé le chargement. */
  function classifyError(raw, ctx){
    ctx = ctx || {};
    var n = normalizeError(raw);
    var text = (n.name ? n.name + ": " : "") + n.message;
    var code = null;
    if(ctx.stalled) code = "MODEL_DOWNLOAD_FAILED";
    else if(ctx.stage === "worker" && !n.message) code = "WORKER_FAILED";
    else {
      for(var i = 0; i < PATTERNS.length; i++){
        if(PATTERNS[i][1].test(text)){ code = PATTERNS[i][0]; break; }
      }
    }
    if(!code){
      if(ctx.stage === "import") code = "WEBLLM_IMPORT_FAILED";
      else if(ctx.stage === "worker") code = "WORKER_FAILED";
      else if(ctx.stage === "generate") code = "GENERATION_FAILED";
      else if(ctx.stage === "init") code = "ENGINE_INIT_FAILED";
      else code = "UNKNOWN";
    }
    /* Une génération qui échoue n'est un vrai « périphérique perdu » que si
       le texte le dit ; un dépassement de contexte reste une erreur de génération. */
    if(ctx.stage === "generate" && code !== "DEVICE_LOST" && code !== "OUT_OF_MEMORY_OR_RESOURCE_LIMIT") code = "GENERATION_FAILED";
    return {
      code: code,
      name: n.name,
      message: n.message || "(aucun message fourni par le moteur)",
      hasMessage: !!n.message,
      contextExceeded: /contextwindowsizeexceeded|context window/i.test(text),
      messageKey: "ai.err." + code,
    };
  }

  /* Codes pour lesquels un palier plus léger a une chance réelle de réussir.
     Un échec RÉSEAU/import/worker/WebGPU-absent ne se règle pas en changeant
     de modèle : on n'enchaîne pas trois téléchargements pour rien. */
  var FALLBACK_CODES = {
    DEVICE_LOST: 1, ENGINE_INIT_FAILED: 1, OUT_OF_MEMORY_OR_RESOURCE_LIMIT: 1, DEVICE_FAILED: 1, UNKNOWN: 1,
  };
  function isFallbackWorthy(code){ return !!FALLBACK_CODES[code]; }
  /* Codes qui comptent contre la stabilité d'un palier sur cet appareil. */
  var INSTABILITY_CODES = { DEVICE_LOST: 1, OUT_OF_MEMORY_OR_RESOURCE_LIMIT: 1, ENGINE_INIT_FAILED: 1, DEVICE_FAILED: 1 };

  /* ── 3. MACHINE D'ÉTATS ─────────────────────────────────────────────────
     IDLE → LOADING → READY ⇄ GENERATING ; READY/GENERATING/ERROR → SWITCHING
     → LOADING ; tout → ERROR ; ERROR/READY → IDLE (déchargement). Une seule
     opération de GPU à la fois : générer exige READY, charger exige IDLE ou
     ERROR (ou READY via SWITCHING). Jamais deux générations, jamais une
     génération pendant un rechargement. */
  var STATES = ["IDLE", "LOADING", "READY", "GENERATING", "SWITCHING", "ERROR"];
  var TRANSITIONS = {
    IDLE:       ["LOADING", "ERROR"],
    LOADING:    ["READY", "ERROR", "IDLE"],
    READY:      ["GENERATING", "SWITCHING", "IDLE", "ERROR"],
    GENERATING: ["READY", "SWITCHING", "ERROR"],
    SWITCHING:  ["LOADING", "ERROR", "IDLE"],
    ERROR:      ["LOADING", "SWITCHING", "IDLE"],
  };
  function createMachine(initial){
    var state = initial || "IDLE";
    var listeners = [];
    return {
      get state(){ return state; },
      can: function(to){ return TRANSITIONS[state].indexOf(to) >= 0; },
      to: function(next){
        if(state === next) return true;
        if(TRANSITIONS[state].indexOf(next) < 0) return false;
        var prev = state; state = next;
        listeners.forEach(function(fn){ try{ fn(next, prev); }catch(e){} });
        return true;
      },
      /* Retour forcé (échec d'appareil détecté hors transition normale). */
      force: function(next){ var prev = state; state = next; listeners.forEach(function(fn){ try{ fn(next, prev); }catch(e){} }); },
      on: function(fn){ listeners.push(fn); },
      canGenerate: function(){ return state === "READY"; },
      canInit: function(){ return state === "IDLE" || state === "ERROR"; },
    };
  }

  /* ── 4. ENVIRONNEMENT (faits réels uniquement) ──────────────────────────── */
  function detectBrowser(ua, hints){
    ua = String(ua || ""); hints = hints || {};
    if(/Edg\//.test(ua)) return "edge";
    if(/OPR\//.test(ua)) return "opera";
    if(/Firefox\//.test(ua)) return "firefox";
    if(/Chrome\/|Chromium\/|CriOS\//.test(ua)) return "chrome";
    if(/AppleWebKit\//.test(ua)){
      /* Safari annonce « Version/x Safari/y ». Un WKWebView par défaut annonce
         AppleWebKit SANS ces jetons (sauf si l'application a réglé
         applicationNameForUserAgent — auquel cas ceci ne peut pas le voir). */
      if(/Safari\//.test(ua) && /Version\//.test(ua) && !hints.webkitBridge) return "safari";
      return "wkwebview";
    }
    return "other";
  }
  function browserLabel(kind){
    return { chrome: "Chrome / Chromium", edge: "Microsoft Edge", opera: "Opera", firefox: "Firefox", safari: "Safari",
             wkwebview: "WebKit intégré (probablement WKWebView)", other: "Navigateur non identifié" }[kind] || "Navigateur non identifié";
  }
  /* Clé d'environnement : ce qui change réellement le comportement d'un modèle.
     Sert à ne réutiliser l'historique que sur un environnement comparable. */
  function envKey(env){
    env = env || {};
    var l = env.limits || {};
    return [env.browser || "?", env.shaderF16 ? "f16" : "nof16", l.maxBufferSize || 0, l.maxStorageBufferBindingSize || 0].join("|");
  }
  /* Palier de départ recommandé, d'après des faits mesurés. « Avancé » n'est
     recommandé que si le GPU offre les 1 Gio de tampon que WebLLM demande
     lui-même (et sait faire du f16) ; sinon « Rapide ». JAMAIS « Expert ». */
  function recommendTier(env){
    env = env || {};
    var l = env.limits || {};
    if(!env.adapter) return "rapide";
    if(env.shaderF16 && (l.maxBufferSize || 0) >= GIB && (l.maxStorageBufferBindingSize || 0) >= GIB) return "avance";
    return "rapide";
  }
  /* Raison d'afficher « Non recommandé » sur un palier — toujours une preuve. */
  function unrecommendedReason(tier, env, mem){
    if(!isTier(tier)) return "";
    if(isUnstable(mem, tier, env)) return "history";
    var l = (env && env.limits) || {};
    if(tier !== "rapide" && env && env.adapter && l.maxStorageBufferBindingSize && l.maxStorageBufferBindingSize < GIB) return "limits";
    if(tier === "expert" && env && typeof env.deviceMemoryGb === "number" && env.deviceMemoryGb > 0 && env.deviceMemoryGb <= 4) return "memory";
    return "";
  }

  /* ── 5. MÉMOIRE LOCALE (dernier modèle stable, échecs, replis) ───────────── */
  var MEMORY_VERSION = 1;
  function emptyMemory(){
    return { v: MEMORY_VERSION, selected: "auto", lastStable: null, lastFailure: null, lastFallback: null, failures: {} };
  }
  function normalizeMemory(m){
    var base = emptyMemory();
    if(!m || typeof m !== "object") return base;
    if(m.selected === "auto" || isTier(m.selected)) base.selected = m.selected;
    if(m.lastStable && isTier(m.lastStable.tier)) base.lastStable = m.lastStable;
    if(m.lastFailure && typeof m.lastFailure === "object") base.lastFailure = m.lastFailure;
    if(m.lastFallback && typeof m.lastFallback === "object") base.lastFallback = m.lastFallback;
    if(m.failures && typeof m.failures === "object") base.failures = m.failures;
    return base;
  }
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function recordSuccess(mem, info){
    var m = normalizeMemory(mem); info = info || {};
    m.lastStable = { tier: info.tier, modelId: info.modelId || null, at: info.now || Date.now(), env: info.envKey || "", browser: info.browser || "", mode: info.mode || "worker" };
    /* Une vraie réussite efface le passif de ce palier sur CET environnement. */
    Object.keys(m.failures).forEach(function(k){
      var f = m.failures[k];
      if(f && f.tier === info.tier && f.env === (info.envKey || "")) delete m.failures[k];
    });
    return m;
  }
  function recordFailure(mem, info){
    var m = normalizeMemory(mem); info = info || {};
    var env = info.envKey || "";
    var key = info.tier + "@" + env;
    var f = m.failures[key] || { tier: info.tier, env: env, count: 0, deviceLost: 0, codes: [] };
    if(INSTABILITY_CODES[info.code]){ f.count += 1; if(info.code === "DEVICE_LOST") f.deviceLost += 1; }
    f.lastCode = info.code; f.lastAt = info.now || Date.now();
    if(f.codes.indexOf(info.code) < 0) f.codes.push(info.code);
    m.failures[key] = f;
    m.lastFailure = { tier: info.tier, modelId: info.modelId || null, code: info.code, at: f.lastAt, env: env, browser: info.browser || "" };
    return m;
  }
  function recordFallback(mem, info){
    var m = normalizeMemory(mem); info = info || {};
    m.lastFallback = { from: info.from, to: info.to, code: info.code, at: info.now || Date.now() };
    return m;
  }
  function withSelection(mem, selected){
    var m = normalizeMemory(mem);
    m.selected = (selected === "auto" || isTier(selected)) ? selected : "auto";
    return m;
  }
  /* Un palier est « instable » sur cet environnement après 2 échecs de
     matériel/mémoire sans réussite depuis (ou un périphérique perdu répété). */
  var UNSTABLE_AFTER = 2;
  function isUnstable(mem, tier, env){
    var m = normalizeMemory(mem);
    var f = m.failures[tier + "@" + envKey(env)];
    return !!f && f.count >= UNSTABLE_AFTER;
  }
  /* Palier à charger AUTOMATIQUEMENT (sans clic sur un palier précis) :
       1. le dernier palier qui a réellement fonctionné sur cet environnement,
       2. sinon le choix explicite de l'utilisateur, s'il n'est pas instable
          — sauf « Expert », qui n'est jamais relancé tout seul tant qu'il n'a
          pas réellement fonctionné sur CET environnement (cas 1),
       3. sinon la recommandation issue des limites GPU mesurées.
     Un palier instable n'est jamais relancé tout seul ; l'utilisateur, lui,
     peut toujours le relancer à la main. */
  function chooseStartTier(env, mem){
    var m = normalizeMemory(mem), key = envKey(env);
    if(m.lastStable && m.lastStable.env === key && !isUnstable(m, m.lastStable.tier, env)) return { tier: m.lastStable.tier, why: "last_stable" };
    if(isTier(m.selected) && m.selected !== "expert" && !isUnstable(m, m.selected, env)) return { tier: m.selected, why: "user_choice" };
    var rec = recommendTier(env);
    while(rec !== "rapide" && isUnstable(m, rec, env)) rec = fallbackChain(rec)[0] || "rapide";
    return { tier: rec, why: "recommended" };
  }
  function fallbackChain(tier){
    var i = TIER_ORDER.indexOf(tier);
    if(i <= 0) return [];
    return TIER_ORDER.slice(0, i).reverse();
  }
  /* Prochain palier d'un échec : le suivant de la chaîne qui n'a pas déjà
     échoué pendant CETTE tentative. `null` = plus de repli possible. */
  function nextFallback(tier, failedNow){
    var chain = fallbackChain(tier);
    for(var i = 0; i < chain.length; i++){ if((failedNow || []).indexOf(chain[i]) < 0) return chain[i]; }
    return null;
  }
  /* Migration de l'ancien réglage synchronisé (ai-model-choice = small|large). */
  function migrateLegacyChoice(legacy){
    return legacy === "small" ? "rapide" : "auto";
  }

  /* ── 6. ÉTAT PAR PALIER (pour l'interface) ──────────────────────────────── */
  function tierStatus(tier, ctx){
    ctx = ctx || {};
    if(ctx.loadingTier === tier) return ctx.phase === "init" ? "initializing" : "downloading";
    if(ctx.readyTier === tier) return (ctx.fallbackFrom ? "fallback" : "ready");
    if(ctx.failed && ctx.failed[tier]) return "failed";
    if(ctx.unrecommended && ctx.unrecommended[tier]) return "unrecommended";
    return "available";
  }

  /* ── 7. PROMPTS : contexte minimal, historique compact, limites ─────────── */
  function estimateTokens(s){ return Math.ceil(String(s || "").length / 3.2); }
  /* Budget de PROMPT : fenêtre − réserve de réponse (plafonnée à 1000) − marge.
     Plafonner la réserve évite de rogner un contexte de cours (≈7 000 signes,
     ≈2 200 jetons) pour garantir une réponse que le modèle n'aurait de toute
     façon pas dépassée : la fenêtre de 4096 jetons reste le vrai plafond. */
  function promptBudgetTokens(maxNewTokens){ return Math.max(600, CONTEXT_TOKENS - Math.min(maxNewTokens || 800, 1000) - 150); }
  var TASK_MAX_TOKENS = { chat: 1000, json: 1600, condense: 700, detect: 400, fiche: 1600, summary: 900 };
  function maxTokensFor(task){ return TASK_MAX_TOKENS[task] || TASK_MAX_TOKENS.chat; }

  /* Garde le premier message (il porte le contexte du cours) tronqué au besoin,
     et les derniers échanges tant que le budget le permet ; retire les
     échanges du milieu plutôt que de dépasser la fenêtre du modèle. Le
     dernier message n'est JAMAIS tronqué ni retiré. */
  function compactHistory(turns, opts){
    opts = opts || {};
    var budget = opts.budgetTokens || promptBudgetTokens(opts.maxNewTokens);
    var list = (turns || []).map(function(t){ return { role: t.role, content: String(t.content || "") }; });
    if(list.length <= 1){
      if(list.length === 1 && estimateTokens(list[0].content) > budget) list[0].content = clipMiddle(list[0].content, budget * 3.2);
      return { turns: list, dropped: 0, tokens: estimateTokens(list.map(function(t){ return t.content; }).join("")) };
    }
    var last = list[list.length - 1];
    var first = list[0];
    var used = estimateTokens(last.content);
    var firstMax = Math.max(400, budget - used - 200);
    if(estimateTokens(first.content) > firstMax) first = { role: first.role, content: clipMiddle(first.content, firstMax * 3.2) };
    used += estimateTokens(first.content);
    var middle = list.slice(1, list.length - 1), keep = [];
    for(var i = middle.length - 1; i >= 0; i--){
      var c = estimateTokens(middle[i].content);
      if(used + c > budget) break;
      keep.unshift(middle[i]); used += c;
    }
    var dropped = middle.length - keep.length;
    return { turns: [first].concat(keep, [last]), dropped: dropped, tokens: used };
  }
  function clipMiddle(s, maxChars){
    s = String(s || ""); maxChars = Math.floor(maxChars);
    if(s.length <= maxChars) return s;
    var head = Math.floor(maxChars * 0.65), tail = maxChars - head - 30;
    return s.slice(0, head) + "\n[…partie centrale omise…]\n" + s.slice(s.length - Math.max(0, tail));
  }

  /* (Le filtre du raisonnement <think> de DeepSeek-R1 n'est plus ici : il vit dans output-processor.js — `RevemOutput` —, qui gère
     aussi la balise ouvrante manquante, les balises coupées entre deux chunks et l'affichage en flux. Voir AI_OUTPUT.md.) */

  /* ── 8. DIAGNOSTIC COPIABLE (aucun secret) ──────────────────────────────── */
  function redact(str){
    var s = String(str == null ? "" : str);
    s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jeton masqué]");
    s = s.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, "Bearer [masqué]");
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail masqué]");
    s = s.replace(/\b(apikey|api_key|access_token|refresh_token|password|mot de passe|secret)\b\s*[:=]\s*\S+/gi, "$1=[masqué]");
    s = s.replace(/sb-[a-z0-9]+-auth-token\S*/gi, "[session masquée]");
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  }
  function yn(v){ return v === true ? "oui" : (v === false ? "non" : "non testé"); }
  /* Liste blanche : seuls ces champs sortent. Rien du compte, du contenu des
     cours ni des conversations n'est jamais lu ici. */
  function buildDiagnosticReport(s){
    s = s || {};
    var L = [];
    var w = s.webgpu || {};
    L.push("Diagnostic assistant IA — REV-EM");
    L.push("Navigateur : " + (s.browserLabel || "?") + (s.userAgent ? " — " + redact(s.userAgent) : ""));
    L.push("WebGPU (page) : " + yn(w.api));
    L.push("Adaptateur GPU : " + yn(w.adapter) + (w.info ? " (" + redact([w.info.vendor, w.info.architecture, w.info.description].filter(Boolean).join(" · ")) + ")" : ""));
    L.push("Périphérique GPU : " + yn(w.device));
    L.push("shader-f16 : " + yn(w.shaderF16) + " · subgroups : " + yn(w.subgroups));
    if(w.limits) L.push("Limites : " + Object.keys(w.limits).map(function(k){ return k + "=" + w.limits[k]; }).join(", "));
    L.push("WebGPU (worker) : " + yn(s.workerWebgpu));
    L.push("Mode moteur : " + (s.mode || "worker"));
    L.push("WebLLM : version épinglée " + (s.webllmVersion || WEBLLM_VERSION) + " · chargé : " + yn(s.webllmLoaded));
    L.push("Palier : " + (s.tier || "—") + " · modèle : " + (s.modelId || "—"));
    L.push("État : " + (s.machineState || "—") + (s.uiStatus ? " (interface : " + s.uiStatus + ")" : ""));
    if(s.error) L.push("Dernière erreur : " + s.error.code + " — " + redact(s.error.message));
    if(s.deviceLost) L.push("Périphérique perdu : " + redact(s.deviceLost.reason || "?") + (s.deviceLost.message ? " — " + redact(s.deviceLost.message) : ""));
    if(s.lastFallback) L.push("Dernier repli : " + s.lastFallback.from + " → " + s.lastFallback.to + " (" + s.lastFallback.code + ")");
    if(s.lastStable) L.push("Dernier palier ayant réellement fonctionné : " + s.lastStable.tier + " (" + (s.lastStable.browser || "?") + ")");
    if(s.perf) L.push("Dernière génération : premier jeton " + (s.perf.ttftMs != null ? Math.round(s.perf.ttftMs) + " ms" : "?") + " · total " + (s.perf.totalMs != null ? Math.round(s.perf.totalMs) + " ms" : "?"));
    L.push("Généré le " + (s.at || new Date().toISOString()));
    return L.join("\n");
  }

  /* ── 9. RÉINITIALISATION DU CACHE IA — UNIQUEMENT les données IA ─────────
     `caches` et `indexedDB` sont injectés (page ou worker, ou faux en test).
     Noms exacts utilisés par WebLLM : « webllm/model », « webllm/config »,
     « webllm/wasm » (Cache API ET bases IndexedDB). On n'efface JAMAIS par
     motif large : ni localStorage, ni la session Supabase, ni les bases de
     documents de REV-EM, ni les caches du service worker. */
  var AI_STORAGE_NAME = /^webllm(\/|$)/;
  async function resetAiStorage(env){
    var report = { cacheNames: [], idbNames: [], errors: [] };
    try{
      if(env && env.caches && env.caches.keys){
        var names = (await env.caches.keys()).filter(function(n){ return AI_STORAGE_NAME.test(n); });
        for(var i = 0; i < names.length; i++){
          try{ if(await env.caches.delete(names[i])) report.cacheNames.push(names[i]); else report.errors.push("cache non supprimé : " + names[i]); }
          catch(e){ report.errors.push("cache " + names[i] + " : " + normalizeError(e).message); }
        }
      }
    }catch(e){ report.errors.push("Cache Storage : " + normalizeError(e).message); }
    try{
      if(env && env.indexedDB && env.indexedDB.databases){
        var dbs = (await env.indexedDB.databases()).filter(function(d){ return d && d.name && AI_STORAGE_NAME.test(d.name); });
        for(var j = 0; j < dbs.length; j++){
          var res = await new Promise(function(resolve){
            var req = env.indexedDB.deleteDatabase(dbs[j].name);
            req.onsuccess = function(){ resolve("ok"); };
            req.onerror = function(){ resolve("error"); };
            /* « blocked » n'est PAS un succès : une connexion reste ouverte. */
            req.onblocked = function(){ resolve("blocked"); };
          });
          if(res === "ok") report.idbNames.push(dbs[j].name); else report.errors.push("base " + dbs[j].name + " : " + res);
        }
      }
    }catch(e){ report.errors.push("IndexedDB : " + normalizeError(e).message); }
    report.ok = report.errors.length === 0;
    return report;
  }

  global.RevemAI = {
    WEBLLM_VERSION: WEBLLM_VERSION, WEBLLM_URL: WEBLLM_URL, CONTEXT_TOKENS: CONTEXT_TOKENS,
    TIERS: TIERS, TIER_ORDER: TIER_ORDER, CODES: CODES, STATES: STATES,
    isTier: isTier, variantFor: variantFor, modelIdFor: modelIdFor, tierOfModelId: tierOfModelId,
    normalizeError: normalizeError, classifyError: classifyError, isFallbackWorthy: isFallbackWorthy,
    createMachine: createMachine,
    detectBrowser: detectBrowser, browserLabel: browserLabel, envKey: envKey,
    recommendTier: recommendTier, unrecommendedReason: unrecommendedReason,
    emptyMemory: emptyMemory, normalizeMemory: normalizeMemory, recordSuccess: recordSuccess,
    recordFailure: recordFailure, recordFallback: recordFallback, withSelection: withSelection,
    isUnstable: isUnstable, chooseStartTier: chooseStartTier, fallbackChain: fallbackChain,
    nextFallback: nextFallback, migrateLegacyChoice: migrateLegacyChoice, UNSTABLE_AFTER: UNSTABLE_AFTER,
    tierStatus: tierStatus,
    estimateTokens: estimateTokens, promptBudgetTokens: promptBudgetTokens, maxTokensFor: maxTokensFor,
    compactHistory: compactHistory, clipMiddle: clipMiddle,
    redact: redact, buildDiagnosticReport: buildDiagnosticReport,
    resetAiStorage: resetAiStorage,
    _clone: clone,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
