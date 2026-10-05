/* Adaptateur Node du CAS : charge le MÊME Pyodide + SymPy + math-cas.py que le worker navigateur, depuis vendor/.
   Interface identique à RevemMath.cas : run(req) → résultat JSON. Sert aux tests ; jamais chargé par l'application. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let runReq = null, loadMs = 0, loading = null;
async function init() {
  if (runReq) return;
  if (loading) return loading;
  loading = (async () => {
    const t0 = Date.now();
    const { loadPyodide } = await import(pathToFileURL(path.join(ROOT, "vendor/pyodide/pyodide.mjs")).href);
    const py = await loadPyodide({ indexURL: path.join(ROOT, "vendor/pyodide") + "/", lockFileURL: path.join(ROOT, "vendor/pyodide/pyodide-lock.json") });
    for (const w of ["mpmath-1.4.1-py3-none-any.whl", "sympy-1.14.0-py3-none-any.whl"]) {
      await py.unpackArchive(new Uint8Array(fs.readFileSync(path.join(ROOT, "vendor/py", w))), "wheel");
    }
    py.runPython(fs.readFileSync(path.join(ROOT, "math-cas.py"), "utf8"));
    runReq = py.globals.get("run_request");
    loadMs = Date.now() - t0;
  })();
  return loading;
}
export const nodeCas = {
  async run(req) { const fresh = !runReq; await init(); const out = JSON.parse(runReq(JSON.stringify(req))); if (fresh) out.loadMs = loadMs; return out; },
  async init() { await init(); return loadMs; },
  get loadMs() { return loadMs; },
};
