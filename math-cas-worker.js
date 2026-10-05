/* ============================================================================
   math-cas-worker.js — Web Worker (MODULE) du CAS de REV-EM : Pyodide + SymPy
   ----------------------------------------------------------------------------
   Lancé à la demande par math-cas-client.js via
       new Worker("math-cas-worker.js", { type: "module" })
   Un worker de module (et non classique) car pyodide.mjs/pyodide.asm.mjs sont
   des modules ES. Isolé d'ai-worker.js : le moteur IA (WebLLM) et le CAS n'ont
   aucune raison de partager un fil d'exécution ni de s'attendre l'un l'autre.

   Protocole (page → worker) :  { id, type:"init" } | { id, type:"run", req }
   Protocole (worker → page) :  { id, type:"progress", stage, pct? }
                                { id, type:"ready", loadMs }
                                { id, type:"result", out, loadMs? }
                                { id, type:"error", code, message }
   Le worker n'exécute JAMAIS autre chose que `run_request(json)` de math-cas.py :
   la requête est un AST validé, jamais du code (voir math-cas.py).
   Le temps de calcul est borné par la page : worker.terminate() (SymPy n'est pas
   interruptible ; un calcul pathologique est tué, pas attendu).
   ========================================================================== */
const BASE = new URL("./", import.meta.url).href;
const PYODIDE_DIR = BASE + "vendor/pyodide/";
const WHEELS = ["vendor/py/mpmath-1.4.1-py3-none-any.whl", "vendor/py/sympy-1.14.0-py3-none-any.whl"];
const CAS_PY = BASE + "math-cas.py";

let pyodide = null, runRequest = null, initPromise = null, loadMs = 0;

function post(m) { self.postMessage(m); }

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw Object.assign(new Error("HTTP " + r.status + " : " + url), { code: "CAS_ASSET_MISSING" });
  return r;
}

async function init(id) {
  if (runRequest) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const t0 = Date.now();
    post({ id, type: "progress", stage: "core" });
    const { loadPyodide } = await import(PYODIDE_DIR + "pyodide.mjs");
    pyodide = await loadPyodide({ indexURL: PYODIDE_DIR, lockFileURL: PYODIDE_DIR + "pyodide-lock.json", fullStdLib: false });
    post({ id, type: "progress", stage: "sympy" });
    for (const w of WHEELS) {
      const r = await fetchBytes(BASE + w);
      await pyodide.unpackArchive(new Uint8Array(await r.arrayBuffer()), "wheel");
    }
    post({ id, type: "progress", stage: "import" });
    const src = await (await fetchBytes(CAS_PY)).text();
    pyodide.runPython(src);
    runRequest = pyodide.globals.get("run_request");
    loadMs = Date.now() - t0;
  })();
  try { await initPromise; } catch (e) { initPromise = null; throw e; }
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === "init") {
      await init(m.id);
      post({ id: m.id, type: "ready", loadMs });
    } else if (m.type === "run") {
      const fresh = !runRequest;
      await init(m.id);
      const out = runRequest(JSON.stringify(m.req));
      post({ id: m.id, type: "result", out, loadMs: fresh ? loadMs : 0 });
    }
  } catch (e) {
    post({ id: m.id, type: "error", code: (e && e.code) || "CAS_WORKER_ERROR", message: String((e && e.message) || e).slice(0, 300) });
  }
};
