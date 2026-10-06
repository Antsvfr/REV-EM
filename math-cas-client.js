/* ============================================================================
   math-cas-client.js — client du CAS avancé (SymPy/Pyodide) pour la page
   ----------------------------------------------------------------------------
   `globalThis.RevemMath.cas` — interface attendue par math-engine.js (opts.cas) :
       run(req, { timeoutMs })  →  Promise<résultat JSON du CAS>   (rejette avec { code, message })
   Ne touche ni au DOM ni à `state` : il crée un Worker de module À LA DEMANDE
   (jamais au démarrage de l'application) et rend compte via onStatus().

   Garanties :
     * chargement paresseux : rien n'est téléchargé tant qu'aucun calcul formel n'est demandé ;
     * un seul calcul à la fois (file) ; l'initialisation a son propre délai (réseau lent ≠ calcul trop long) ;
     * délai de calcul dur : à l'expiration le worker est TUÉ (terminate) — SymPy n'est pas interruptible —
       et sera recréé au prochain besoin (les fichiers sont alors déjà en cache : pas de re-téléchargement) ;
     * cancel() tue aussi le worker ; aucune erreur n'est avalée, aucune valeur n'est inventée ;
     * `workerFactory` injectable (tests) ; rien de plus n'est exécuté que `run_request(json)`.
   Codes d'erreur : CAS_TIMEOUT, CAS_INIT_TIMEOUT, CAS_CANCELLED, CAS_WORKER_CRASH, CAS_ASSET_MISSING,
                    CAS_UNSUPPORTED_ENV, CAS_BAD_RESPONSE, CAS_WORKER_ERROR.
   ============================================================================ */
(function(global){
  "use strict";
  var NS = global.RevemMath = global.RevemMath || {};

  var DEFAULTS = { computeTimeoutMs: 20000, initTimeoutMs: 120000, workerUrl: "math-cas-worker.js" };

  function CasClient(options){
    var o = options || {};
    var self = this;
    this.opts = { computeTimeoutMs: o.computeTimeoutMs || DEFAULTS.computeTimeoutMs, initTimeoutMs: o.initTimeoutMs || DEFAULTS.initTimeoutMs, workerUrl: o.workerUrl || DEFAULTS.workerUrl };
    this.workerFactory = o.workerFactory || null;
    this.worker = null;
    this.state = "idle";          // idle | loading | ready | error
    this.stage = null;            // core | sympy | import
    this.lastLoadMs = null;
    this.listeners = [];
    this._seq = 0;
    this._pending = null;         // { id, resolve, reject, timer }
    this._chain = Promise.resolve();
    this._ready = null;
  }

  CasClient.prototype.onStatus = function(fn){
    this.listeners.push(fn);
    var self = this;
    return function(){ self.listeners = self.listeners.filter(function(f){ return f !== fn; }); };
  };
  CasClient.prototype._emit = function(patch){
    for(var k in patch) this[k] = patch[k];
    var snap = { state: this.state, stage: this.stage, loadMs: this.lastLoadMs };
    this.listeners.slice().forEach(function(fn){ try{ fn(snap); }catch(e){} });
  };

  CasClient.prototype._spawn = function(){
    var self = this, w;
    try{
      if(this.workerFactory) w = this.workerFactory(this.opts.workerUrl);
      else {
        if(typeof Worker === "undefined") throw new Error("Worker indisponible");
        var base = (typeof document !== "undefined" && document.baseURI) || (typeof location !== "undefined" && location.href) || undefined;
        w = new Worker(base ? new URL(this.opts.workerUrl, base).href : this.opts.workerUrl, { type: "module" });
      }
    }catch(e){ throw { code: "CAS_UNSUPPORTED_ENV", message: "Le calcul formel n'est pas disponible dans ce navigateur (" + ((e && e.message) || "worker de module") + ")" }; }
    w.onmessage = function(ev){ self._onMessage(ev.data || {}); };
    w.onerror = function(ev){
      var msg = (ev && (ev.message || (ev.error && ev.error.message))) || "erreur du worker";
      self._failPending({ code: "CAS_WORKER_CRASH", message: msg });
      self._kill();
    };
    this.worker = w;
  };

  CasClient.prototype._kill = function(){
    if(this.worker){ try{ this.worker.terminate(); }catch(e){} }
    this.worker = null; this._ready = null;
    this._emit({ state: "idle", stage: null });
  };

  CasClient.prototype._failPending = function(err){
    var p = this._pending; if(!p) return;
    this._pending = null; clearTimeout(p.timer); p.reject(err);
  };

  CasClient.prototype._onMessage = function(m){
    var p = this._pending; if(!p || m.id !== p.id) return;
    if(m.type === "progress"){ this._emit({ state: "loading", stage: m.stage }); return; }
    if(m.type === "ready"){ this.lastLoadMs = m.loadMs; this._emit({ state: "ready", stage: null }); this._pending = null; clearTimeout(p.timer); p.resolve(m); return; }
    if(m.type === "result"){
      this._pending = null; clearTimeout(p.timer);
      if(m.loadMs){ this.lastLoadMs = m.loadMs; this._emit({ state: "ready", stage: null }); }
      var out; try{ out = JSON.parse(m.out); }catch(e){ p.reject({ code: "CAS_BAD_RESPONSE", message: "réponse illisible du moteur avancé" }); return; }
      p.resolve(out); return;
    }
    if(m.type === "error"){
      this._pending = null; clearTimeout(p.timer);
      if(this.state === "loading"){ this._kill(); this._emit({ state: "error" }); }
      p.reject({ code: m.code || "CAS_WORKER_ERROR", message: m.message || "erreur du moteur avancé" });
    }
  };

  CasClient.prototype._send = function(msg, timeoutMs, timeoutCode, timeoutMsg){
    var self = this;
    return new Promise(function(resolve, reject){
      var id = ++self._seq;
      var timer = setTimeout(function(){
        self._pending = null; self._kill();
        reject({ code: timeoutCode, message: timeoutMsg });
      }, timeoutMs);
      self._pending = { id: id, resolve: resolve, reject: reject, timer: timer };
      msg.id = id;
      try{ self.worker.postMessage(msg); }catch(e){ clearTimeout(timer); self._pending = null; reject({ code: "CAS_WORKER_ERROR", message: (e && e.message) || "envoi impossible" }); }
    });
  };

  /* Charge le moteur (idempotent). Résout quand le CAS est prêt. */
  CasClient.prototype.init = function(){
    var self = this;
    if(this.state === "ready" && this.worker) return Promise.resolve({ loadMs: this.lastLoadMs });
    if(this._ready) return this._ready;
    this._ready = new Promise(function(resolve, reject){
      try{ self._spawn(); }catch(e){ self._ready = null; self._emit({ state: "error" }); return reject(e); }
      self._emit({ state: "loading", stage: "core" });
      self._send({ type: "init" }, self.opts.initTimeoutMs, "CAS_INIT_TIMEOUT", "Le chargement du moteur mathématique a pris trop de temps")
        .then(resolve, function(e){ self._ready = null; if(self.state === "loading") self._emit({ state: "error" }); reject(e); });
    });
    return this._ready;
  };

  /* Un calcul. Les appels sont mis en file : un seul calcul actif à la fois. */
  CasClient.prototype.run = function(req, options){
    var self = this, timeoutMs = (options && options.timeoutMs) || this.opts.computeTimeoutMs;
    var job = this._chain.then(function(){
      var fresh = !self.isReady();
      return self.init().then(function(info){
        return self._send({ type: "run", req: req }, timeoutMs, "CAS_TIMEOUT", "Le calcul formel a dépassé " + Math.round(timeoutMs / 1000) + " s et a été interrompu")
          .then(function(out){ if(fresh && info && info.loadMs) out.loadMs = info.loadMs; return out; });
      });
    });
    this._chain = job.then(function(){}, function(){});
    return job;
  };

  CasClient.prototype.cancel = function(){
    if(!this._pending) return false;                       // rien en cours : on ne tue pas un moteur prêt pour rien
    this._failPending({ code: "CAS_CANCELLED", message: "calcul annulé" });
    this._kill();
    return true;
  };

  CasClient.prototype.isReady = function(){ return this.state === "ready" && !!this.worker; };

  NS.CasClient = CasClient;
  NS.cas = new CasClient();
  NS.createCasClient = function(options){ return new CasClient(options); };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
