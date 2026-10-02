/* ============================================================================
   REV-EM — le moteur pur de l'assistant IA (ai-engine.js)
   ----------------------------------------------------------------------------
   Exécution :  node tests/ai-engine.test.js
   Aucun navigateur, aucun réseau, aucun GPU : le moteur est pur.

   Étiquettes utilisées dans tout ce lot de tests (voir AI_AUDIT.md) :
     PASS        vérifié pour de vrai dans cet environnement
     PASS MOCK   vérifié contre un faux (faux GPU, faux moteur, faux stockage)
     NOT TESTED  non vérifiable ici (GPU réel, WKWebView, réseau CDN)
   Ici : tout est PASS (logique pure) sauf les lignes marquées « MOCK ».
   ============================================================================ */
"use strict";
const fs = require("fs"), path = require("path");
require("../ai-engine.js");
const AI = globalThis.RevemAI;

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if(ok){ pass++; console.log(`PASS — ${label}`); }
  else { fail++; console.log(`FAIL — ${label}  ${detail !== undefined ? JSON.stringify(detail) : ""}`); }
};
const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const scenario = (n) => console.log(`\n── ${n} ──`);

scenario("Identifiants de modèle : source de vérité = le model_list réel de WebLLM");
{
  const dir = path.join(__dirname, "..", "node_modules", "@mlc-ai", "web-llm", "lib", "index.js");
  if(!fs.existsSync(dir)){
    console.log("NOT TESTED — @mlc-ai/web-llm absent de node_modules (npm i --no-save @mlc-ai/web-llm@" + AI.WEBLLM_VERSION + ")");
  } else {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "node_modules", "@mlc-ai", "web-llm", "package.json"), "utf8"));
    eq("la version installée est bien la version épinglée", pkg.version, AI.WEBLLM_VERSION);
    const src = fs.readFileSync(dir, "utf8");
    const ids = new Set([...src.matchAll(/model_id:\s*"([^"]+)"/g)].map(m => m[1]));
    AI.TIER_ORDER.forEach(k => {
      ["f16", "f32"].forEach(v => check(`${k}/${v} : « ${AI.TIERS[k].ids[v]} » existe dans le model_list ${pkg.version}`, ids.has(AI.TIERS[k].ids[v])));
    });
    /* Constat réel (AI_AUDIT.md) : le model_list ne déclare PAS required_features
       pour ces trois familles. WebLLM ne vérifie donc pas shader-f16 lui-même
       pour elles ; c'est ai-host.js qui choisit la variante d'après l'adaptateur. */
    const entry = (id) => { const i = src.indexOf(`model_id: "${id}"`); const e = src.indexOf("\n        },", i); return src.slice(i, e > 0 ? e : i + 900); };
    check("(constat) q4f16_1 de Llama 1B ne déclare pas required_features → le choix de variante nous revient", !/required_features/.test(entry(AI.TIERS.rapide.ids.f16)));
    check("l'URL épinglée contient la version", AI.WEBLLM_URL.indexOf("@" + AI.WEBLLM_VERSION) > 0 && !/@mlc-ai\/web-llm$/.test(AI.WEBLLM_URL));
  }
  const all = AI.TIER_ORDER.flatMap(k => [AI.TIERS[k].ids.f16, AI.TIERS[k].ids.f32]);
  check("aucun identifiant en double", new Set(all).size === all.length);
  check("tous les identifiants sont des identifiants MLC (jamais une URL HF/CDN)", all.every(i => /-MLC$/.test(i) && !/[\/:]/.test(i)));
  eq("variante sans shader-f16 → f32", AI.modelIdFor("avance", AI.variantFor({ shaderF16: false })), "Phi-4-mini-instruct-q4f32_1-MLC");
  eq("variante avec shader-f16 → f16", AI.modelIdFor("rapide", AI.variantFor({ shaderF16: true })), "Llama-3.2-1B-Instruct-q4f16_1-MLC");
  eq("tierOfModelId", AI.tierOfModelId("DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC"), "expert");
}

scenario("Erreurs : la CAUSE RACINE — WebLLM renvoie une chaîne, pas un Error");
{
  /* Reproduction exacte de ce que la page recevait : reject(msg.content) avec
     content = err.toString() (voir handleTask dans WebLLM). */
  const fromWorker = "Error: Cannot initialize runtime because of requested maxStorageBufferBindingSize exceeds limit. requested=128MB, limit=64MB. ";
  check("(preuve) une chaîne n'a pas de .message — ce qui produisait « Erreur inconnue »", typeof fromWorker === "string" && fromWorker.message === undefined);
  const n = AI.normalizeError(fromWorker);
  eq("normalizeError extrait name", n.name, "Error");
  check("normalizeError extrait le VRAI message", /maxStorageBufferBindingSize/.test(n.message));
  const c = AI.classifyError(fromWorker, { stage: "init" });
  eq("→ OUT_OF_MEMORY_OR_RESOURCE_LIMIT (limite GPU), pas UNKNOWN", c.code, "OUT_OF_MEMORY_OR_RESOURCE_LIMIT");
  check("le message d'origine est conservé pour le diagnostic", /requested=128MB/.test(c.message));
  eq("chaîne vide → message explicite, jamais « inconnue » muette", AI.classifyError("", { stage: "init" }).message, "(aucun message fourni par le moteur)");
  eq("undefined → ENGINE_INIT_FAILED à l'init", AI.classifyError(undefined, { stage: "init" }).code, "ENGINE_INIT_FAILED");
}

scenario("Erreurs : chaque code de la spécification");
{
  const cases = [
    ["WEBGPU_UNAVAILABLE", "WebGPUNotAvailableError: WebGPU is not supported in your current environment", {}],
    ["ADAPTER_FAILED", "Error: Unable to find a compatible GPU. This issue might be...", {}],
    ["DEVICE_FAILED", "TypeError: Failed to execute 'requestDevice' on 'GPUAdapter'", {}],
    ["DEVICE_FAILED", "ShaderF16SupportError: This model requires WebGPU extension shader-f16", {}],
    ["WORKER_FAILED", "", { stage: "worker" }],
    ["WEBLLM_IMPORT_FAILED", "TypeError: Failed to fetch dynamically imported module: https://esm.run/x", {}],
    ["MODEL_NOT_SUPPORTED", "ModelNotFoundError: Cannot find model record in appConfig for Foo", {}],
    ["MODEL_DOWNLOAD_FAILED", "TypeError: Load failed", { stage: "init" }],
    ["MODEL_DOWNLOAD_FAILED", "Error: x", { stalled: true }],
    ["MODEL_CACHE_CORRUPTED", "QuotaExceededError: The quota has been exceeded.", {}],
    ["MODEL_CACHE_CORRUPTED", "CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d", {}],
    ["ENGINE_INIT_FAILED", "Error: quelque chose d'imprévu", { stage: "init" }],
    ["DEVICE_LOST", "DeviceLostError: Device was lost during reload. This can happen due to insufficient memory", {}],
    ["OUT_OF_MEMORY_OR_RESOURCE_LIMIT", "RangeError: Array buffer allocation failed", {}],
    ["GENERATION_FAILED", "Error: quelque chose", { stage: "generate" }],
    ["UNKNOWN", "Error: bizarre", {}],
  ];
  cases.forEach(([want, raw, ctx]) => eq(`${want} ← « ${raw.slice(0, 48)} »`, AI.classifyError(raw, ctx).code, want));
  check("tous les codes de la spécification sont déclarés", ["WEBGPU_UNAVAILABLE","ADAPTER_FAILED","DEVICE_FAILED","WORKER_FAILED","WEBLLM_IMPORT_FAILED","MODEL_NOT_SUPPORTED","MODEL_DOWNLOAD_FAILED","MODEL_CACHE_CORRUPTED","ENGINE_INIT_FAILED","DEVICE_LOST","OUT_OF_MEMORY_OR_RESOURCE_LIMIT","GENERATION_FAILED","UNKNOWN"].every(c => AI.CODES.indexOf(c) >= 0));
  eq("un Error natif est lu comme une chaîne", AI.classifyError(new TypeError("Load failed"), { stage: "init" }).code, "MODEL_DOWNLOAD_FAILED");
  eq("un ErrorEvent de worker vide reste identifiable", AI.classifyError({ filename: "https://x/ai-worker.js", lineno: 3 }, { stage: "worker" }).code, "WORKER_FAILED");
  eq("dépassement de contexte = erreur de génération, pas de moteur", AI.classifyError("ContextWindowSizeExceededError: too long", { stage: "generate" }).code, "GENERATION_FAILED");
  check("… et il est signalé", AI.classifyError("ContextWindowSizeExceededError: too long", { stage: "generate" }).contextExceeded);
}

scenario("Repli : quels codes justifient de changer de palier");
{
  ["DEVICE_LOST", "ENGINE_INIT_FAILED", "OUT_OF_MEMORY_OR_RESOURCE_LIMIT"].forEach(c => check(`${c} → repli autorisé`, AI.isFallbackWorthy(c)));
  ["MODEL_DOWNLOAD_FAILED", "WEBGPU_UNAVAILABLE", "WORKER_FAILED", "WEBLLM_IMPORT_FAILED", "MODEL_CACHE_CORRUPTED", "ADAPTER_FAILED"].forEach(c => check(`${c} → PAS de repli (changer de modèle n'y change rien)`, !AI.isFallbackWorthy(c)));
  eq("chaîne Expert", AI.fallbackChain("expert"), ["avance", "rapide"]);
  eq("chaîne Avancé", AI.fallbackChain("avance"), ["rapide"]);
  eq("chaîne Rapide", AI.fallbackChain("rapide"), []);
  eq("Expert échoue → Avancé", AI.nextFallback("expert", []), "avance");
  eq("Expert puis Avancé échouent → Rapide", AI.nextFallback("expert", ["expert", "avance"]), "rapide");
  eq("Rapide échoue → plus de repli", AI.nextFallback("rapide", ["rapide"]), null);
}

scenario("Machine d'états : une seule opération GPU à la fois");
{
  const m = AI.createMachine();
  eq("départ", m.state, "IDLE");
  check("on ne génère pas avant READY", !m.canGenerate());
  check("IDLE → LOADING", m.to("LOADING"));
  check("pas de 2e chargement pendant LOADING", !m.canInit());
  check("LOADING → GENERATING interdit", !m.to("GENERATING"));
  m.to("READY");
  check("READY → GENERATING", m.to("GENERATING"));
  check("pas de 2e génération simultanée", !m.canGenerate() && !m.to("GENERATING") === false);
  check("GENERATING → LOADING interdit (il faut passer par SWITCHING)", !m.to("LOADING"));
  check("GENERATING → SWITCHING (bascule pendant génération)", m.to("SWITCHING"));
  check("SWITCHING → LOADING", m.to("LOADING"));
  m.to("ERROR");
  check("ERROR autorise un nouveau chargement", m.canInit());
  const seen = []; m.on((n, p) => seen.push(p + ">" + n)); m.to("LOADING"); m.to("READY");
  eq("les transitions sont observables", seen, ["ERROR>LOADING", "LOADING>READY"]);
}

scenario("Environnement : Chrome / Safari / WKWebView — sans deviner ce qu'on ne voit pas");
{
  eq("Chrome", AI.detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"), "chrome");
  eq("Edge", AI.detectBrowser("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0"), "edge");
  eq("Safari", AI.detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"), "safari");
  eq("WKWebView (UA sans « Version/ Safari/ »)", AI.detectBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"), "wkwebview");
  eq("WKWebView avec pont webkit.messageHandlers", AI.detectBrowser("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML) Version/17.5 Safari/605.1.15", { webkitBridge: true }), "wkwebview");
  check("le libellé WKWebView dit « probablement »", /probablement/.test(AI.browserLabel("wkwebview")));
}

scenario("Palier de départ : jamais Expert d'office, jamais de VRAM inventée");
{
  const GO = 1 << 30;
  const strong = { browser: "chrome", adapter: true, shaderF16: true, limits: { maxBufferSize: 4 * GO, maxStorageBufferBindingSize: 2 * GO } };
  const weak = { browser: "wkwebview", adapter: true, shaderF16: true, limits: { maxBufferSize: 256 << 20, maxStorageBufferBindingSize: 128 << 20 } };
  const nof16 = { browser: "safari", adapter: true, shaderF16: false, limits: { maxBufferSize: 4 * GO, maxStorageBufferBindingSize: 2 * GO } };
  eq("machine récente inconnue → Avancé (pas Expert)", AI.chooseStartTier(strong, null).tier, "avance");
  eq("… raison : recommandation issue des limites mesurées", AI.chooseStartTier(strong, null).why, "recommended");
  eq("limites GPU faibles → Rapide", AI.chooseStartTier(weak, null).tier, "rapide");
  eq("pas de shader-f16 → Rapide (prudence)", AI.chooseStartTier(nof16, null).tier, "rapide");
  eq("aucun adaptateur → Rapide", AI.chooseStartTier({ browser: "x" }, null).tier, "rapide");
  ["strong", "weak", "nof16"].forEach(() => 0);
  [strong, weak, nof16, { browser: "x" }].forEach((e, i) => check(`env #${i} : Expert jamais recommandé automatiquement`, AI.recommendTier(e) !== "expert"));
  check("aucune fonction ne renvoie de VRAM détectée", !Object.keys(AI).some(k => /vram(detect|size)|detectVram/i.test(k)));
  eq("Expert reste « non recommandé » si la mémoire signalée est ≤ 4 Go", AI.unrecommendedReason("expert", Object.assign({ deviceMemoryGb: 4 }, strong), null), "memory");
  eq("Rapide n'est jamais « non recommandé » pour ses limites", AI.unrecommendedReason("rapide", weak, null), "");
  eq("Avancé « non recommandé » si tampon max < 1 Gio", AI.unrecommendedReason("avance", weak, null), "limits");
}

scenario("Mémoire locale : dernier modèle stable, échecs, pas de relance automatique");
{
  const GO = 1 << 30;
  const env = { browser: "chrome", adapter: true, shaderF16: true, limits: { maxBufferSize: 4 * GO, maxStorageBufferBindingSize: 2 * GO } };
  const key = AI.envKey(env);
  let m = AI.emptyMemory();
  m = AI.recordSuccess(m, { tier: "avance", modelId: "Phi-4-mini-instruct-q4f16_1-MLC", envKey: key, browser: "chrome", now: 1 });
  eq("Avancé a réellement fonctionné → il est repris au lancement suivant", AI.chooseStartTier(env, m), { tier: "avance", why: "last_stable" });
  m = AI.withSelection(m, "expert");
  m = AI.recordFailure(m, { tier: "expert", envKey: key, code: "DEVICE_LOST", now: 2 });
  check("1 échec : Expert n'est pas encore « instable »", !AI.isUnstable(m, "expert", env));
  m = AI.recordFailure(m, { tier: "expert", envKey: key, code: "DEVICE_LOST", now: 3 });
  check("2 périphériques perdus : Expert est instable sur cet appareil", AI.isUnstable(m, "expert", env));
  eq("… et n'est PAS relancé automatiquement (on reprend le dernier stable)", AI.chooseStartTier(env, m).tier, "avance");
  check("… mais l'utilisateur peut toujours le relancer à la main (rien ne l'interdit côté moteur)", AI.TIERS.expert && AI.isTier("expert"));
  eq("les échecs réseau ne comptent pas comme instabilité", (() => { let x = AI.recordFailure(AI.emptyMemory(), { tier: "avance", envKey: key, code: "MODEL_DOWNLOAD_FAILED" }); x = AI.recordFailure(x, { tier: "avance", envKey: key, code: "MODEL_DOWNLOAD_FAILED" }); return AI.isUnstable(x, "avance", env); })(), false);
  eq("un autre environnement ne subit pas ce passif", AI.isUnstable(m, "expert", { browser: "safari", adapter: true, shaderF16: false, limits: {} }), false);
  m = AI.recordSuccess(m, { tier: "expert", modelId: "x", envKey: key, now: 4 });
  check("une vraie réussite d'Expert efface son passif", !AI.isUnstable(m, "expert", env));
  m = AI.recordFallback(m, { from: "expert", to: "avance", code: "DEVICE_LOST", now: 5 });
  eq("le dernier repli est mémorisé", m.lastFallback.to, "avance");
  eq("mémoire corrompue → mémoire vide, sans exception", AI.normalizeMemory({ lastStable: { tier: "inconnu" }, selected: 42 }), AI.emptyMemory());
  eq("ancien réglage « small » → Rapide", AI.migrateLegacyChoice("small"), "rapide");
  eq("ancien réglage « large » (Llama 3B, plus au catalogue) → auto", AI.migrateLegacyChoice("large"), "auto");
  eq("le stable d'un AUTRE environnement n'est pas réutilisé", AI.chooseStartTier({ browser: "safari", adapter: true, shaderF16: false, limits: {} }, m).tier, "rapide");
}

scenario("États par palier (interface)");
{
  eq("disponible", AI.tierStatus("rapide", {}), "available");
  eq("téléchargement", AI.tierStatus("avance", { loadingTier: "avance", phase: "download" }), "downloading");
  eq("initialisation", AI.tierStatus("avance", { loadingTier: "avance", phase: "init" }), "initializing");
  eq("prêt", AI.tierStatus("rapide", { readyTier: "rapide" }), "ready");
  eq("échec", AI.tierStatus("expert", { failed: { expert: "DEVICE_LOST" } }), "failed");
  eq("non recommandé", AI.tierStatus("expert", { unrecommended: { expert: "memory" } }), "unrecommended");
  eq("fallback utilisé", AI.tierStatus("rapide", { readyTier: "rapide", fallbackFrom: "expert" }), "fallback");
}

scenario("Prompts : contexte minimal, historique compact");
{
  const big = "x".repeat(20000);
  const r = AI.compactHistory([{ role: "user", content: big }], { maxNewTokens: 800 });
  check("un contexte de 20 000 caractères est ramené sous le budget", AI.estimateTokens(r.turns[0].content) <= AI.promptBudgetTokens(800) + 5, AI.estimateTokens(r.turns[0].content));
  check("la coupe garde le début et la fin", /partie centrale omise/.test(r.turns[0].content));
  const turns = [{ role: "user", content: "CONTEXTE " + "c".repeat(3000) }];
  for(let i = 0; i < 30; i++){ turns.push({ role: "assistant", content: "réponse " + i + " " + "a".repeat(400) }); turns.push({ role: "user", content: "question " + i + " " + "q".repeat(200) }); }
  const c = AI.compactHistory(turns, { maxNewTokens: 800 });
  check("l'historique long est réduit", c.turns.length < turns.length && c.dropped > 0, { n: c.turns.length, dropped: c.dropped });
  check("le budget est respecté", c.tokens <= AI.promptBudgetTokens(800));
  eq("le dernier message est INTACT", c.turns[c.turns.length - 1].content, turns[turns.length - 1].content);
  check("le premier message (contexte du cours) est conservé", /^CONTEXTE/.test(c.turns[0].content));
  const small = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
  eq("un court échange n'est pas modifié", AI.compactHistory(small).turns, small);
  check("limites de jetons par tâche définies", AI.maxTokensFor("json") > AI.maxTokensFor("detect") && AI.maxTokensFor("inconnu") === AI.maxTokensFor("chat"));
  check("le filtre du raisonnement a quitté ai-engine.js (désormais RevemOutput, testé dans output-processor.test.js)", AI.stripReasoning === undefined);
}

scenario("Diagnostic copiable : aucun secret");
{
  const leaky = "Erreur pour jean.dupont@ecole.fr avec Bearer abcdefghijklmnopqrstuvwx et " + ["eyJ", "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"].join("") + "." + ["eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"].join("") + ".abcdefghijkl password=hunter2 sb-otlkvlmzakklhugvaxeg-auth-token";
  const report = AI.buildDiagnosticReport({
    userAgent: "Mozilla/5.0 test", browserLabel: "Chrome", webgpu: { api: true, adapter: true, device: true, shaderF16: true, subgroups: false, limits: { maxBufferSize: 4294967296 }, info: { vendor: "apple" } },
    workerWebgpu: true, mode: "worker", webllmLoaded: true, tier: "avance", modelId: "Phi-4-mini-instruct-q4f16_1-MLC", machineState: "ERROR",
    error: { code: "DEVICE_LOST", message: leaky }, deviceLost: { reason: "unknown", message: "x@y.com" }, lastFallback: { from: "expert", to: "avance", code: "DEVICE_LOST" },
  });
  check("aucun e-mail", !/dupont@|x@y\.com/.test(report));
  check("aucun jeton Bearer / JWT", !/Bearer abcdef|eyJhbGci/.test(report));
  check("aucun mot de passe", !/hunter2/.test(report));
  check("aucune clé de session Supabase", !/sb-otlkvlmzakklhugvaxeg-auth-token/.test(report));
  ["WebGPU (page) : oui", "Adaptateur GPU : oui", "Périphérique GPU : oui", "WebLLM : version épinglée " + AI.WEBLLM_VERSION, "Palier : avance", "DEVICE_LOST", "expert → avance"].forEach(s => check("le rapport contient « " + s + " »", report.indexOf(s) >= 0));
  check("un champ non testé est dit « non testé », jamais deviné", /WebGPU \(worker\) : oui/.test(report) && /non testé/.test(AI.buildDiagnosticReport({})));
}

(async () => {
  scenario("Réinitialisation du cache IA : UNIQUEMENT les données IA (faux stockage — PASS MOCK)");
  const mkCaches = (names) => { const s = new Set(names); return { keys: async () => [...s], delete: async (n) => s.delete(n), has: (n) => s.has(n) }; };
  const mkIdb = (names, blocked) => { const s = new Set(names); return { databases: async () => [...s].map(name => ({ name })), deleteDatabase: (n) => { const r = {}; setTimeout(() => { if(blocked && blocked.has(n)) r.onblocked && r.onblocked(); else { s.delete(n); r.onsuccess && r.onsuccess(); } }, 0); return r; }, has: (n) => s.has(n) }; };
  const caches = mkCaches(["webllm/model", "webllm/config", "webllm/wasm", "rev-em-v3-shell", "rev-em-v3-runtime", "workbox-x"]);
  const idb = mkIdb(["webllm/model", "revem-course-files", "sb-auth-store"]);
  const rep = await AI.resetAiStorage({ caches, indexedDB: idb });
  eq("les trois caches WebLLM sont supprimés", rep.cacheNames.sort(), ["webllm/config", "webllm/model", "webllm/wasm"]);
  check("le cache du service worker est intact", caches.has("rev-em-v3-shell") && caches.has("rev-em-v3-runtime") && caches.has("workbox-x"));
  eq("la base IndexedDB de WebLLM est supprimée", rep.idbNames, ["webllm/model"]);
  check("la base des documents de l'utilisateur est intacte", idb.has("revem-course-files"));
  check("la base d'authentification est intacte", idb.has("sb-auth-store"));
  check("rapport ok", rep.ok === true);
  const blockedIdb = mkIdb(["webllm/model"], new Set(["webllm/model"]));
  const rep2 = await AI.resetAiStorage({ caches: mkCaches([]), indexedDB: blockedIdb });
  check("une suppression BLOQUÉE n'est pas déclarée réussie (l'ancien code la comptait)", rep2.ok === false && rep2.idbNames.length === 0 && /blocked/.test(rep2.errors.join()));
  const boom = { keys: async () => { throw new Error("SecurityError"); }, delete: async () => true };
  const rep3 = await AI.resetAiStorage({ caches: boom, indexedDB: null });
  check("une erreur du navigateur est REMONTÉE, pas avalée", rep3.ok === false && /SecurityError/.test(rep3.errors.join()));
  eq("environnement sans stockage : rapport vide et ok", (await AI.resetAiStorage({})).ok, true);

  console.log(`\n${pass} vérifications réussies, ${fail} échec(s).`);
  process.exit(fail ? 1 : 0);
})();
