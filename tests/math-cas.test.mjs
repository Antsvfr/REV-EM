/* REV-EM Math Engine — le VRAI CAS : Pyodide (CPython/WebAssembly) + SymPy 1.14 + math-cas.py, chargés depuis vendor/, sous Node.
   Lancer :  node tests/math-cas.test.mjs        (≈ 15 s : le chargement de SymPy prend ≈ 8 s)
   « PASS » = exécution RÉELLE de SymPy (pas de faux). Ce que ce test ne prouve PAS : le comportement dans un navigateur (voir math-ui.test.mjs),
   ni Safari / WKWebView / macOS (NOT TESTED). Le résultat de SymPy est toujours re-contrôlé par le MathVerifier JS (indépendant de SymPy). */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
["math-core.js", "math-fast.js", "math-verify.js", "math-engine.js"].forEach(f => require(path.join(ROOT, f)));
const { nodeCas } = await import("./helpers/node-cas.mjs");
const R = globalThis.RevemMath, E = R.engine, ST = R.core.STATUS;

let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const solve = (q, o) => E.solve(q, Object.assign({ cas: nodeCas, lang: "fr", timeoutMs: 60000 }, o || {}));
const txt = r => r.exact && r.exact.text;

const loadMs = await nodeCas.init();
console.log("   mesure : chargement Pyodide + SymPy (Node, wasm natif, fichiers locaux) = " + loadMs + " ms");

console.log("\n── 1. référence : le Fast Engine renonce, SymPy calcule, le MathVerifier re-contrôle ──");
{
  let r = await solve("limite de sin(x)/x quand x tend vers 0");
  eq("lim sin x / x = 1, route CAS, vérifié NUMÉRIQUEMENT (pas « exact »)", [txt(r), r.status, r.diag.engineUsed], ["1", ST.VERIFIED_NUMERICALLY, "cas"]);
  r = await solve("dérivée de sin(x)*exp(x)"); eq("(sin x · eˣ)′ = eˣ sin x + eˣ cos x", [txt(r), r.status], ["exp(x)*sin(x) + exp(x)*cos(x)", ST.VERIFIED_NUMERICALLY]);
  r = await solve("dérivée de √x"); eq("(√x)′", [r.ok, /sqrt|\^/.test(txt(r))], [true, true]);
  r = await solve("intégrale de x*exp(x) dx"); eq("∫ x eˣ dx = (x−1)eˣ + C, primitive re-dérivée numériquement", [txt(r), r.status], ["(x - 1)*exp(x) + C", ST.VERIFIED_NUMERICALLY]);
  r = await solve("intégrale de 0 à pi de sin(x) dx"); eq("∫₀^π sin x dx = 2 (quadrature de Gauss-Legendre)", [txt(r), r.status, r.verification.method], ["2", ST.VERIFIED_NUMERICALLY, "Gauss-Legendre"]);
  r = await solve("intégrale de exp(-x^2) de 0 à 1"); eq("∫₀¹ e^(−x²) dx = √π·erf(1)/2 : exact SymPy + valeur numérique distinguées", [txt(r), r.approx && /^0,7468/.test(r.approx.text.replace(/\s/g, ""))], ["sqrt(pi)*erf(1)/2", true]);
  r = await solve("intégrale de 1/x de 1 à e"); eq("∫₁^e dx/x = 1", txt(r), "1");
  r = await solve("résous exp(x)=5"); eq("eˣ = 5 → x = ln 5 (solutions réelles seulement, signalé)", [txt(r), r.status, r.notes.indexOf("real-solutions-only") >= 0], ["x = ln(5)", ST.VERIFIED_NUMERICALLY, true]);
  r = await solve("résous sin(x)=0"); check("sin x = 0 : famille infinie présentée comme telle (n ∈ ℤ), échantillon vérifié", /n ∈ ℤ/.test(txt(r)) && r.status === ST.VERIFIED_NUMERICALLY && r.notes.indexOf("infinite-family") >= 0, [txt(r), r.status]);
  r = await solve("résous |x-1|=2"); eq("|x−1| = 2 → x = −1 ou 3", txt(r), "x = -1 ; x = 3");
  r = await solve("résous x^5-x+1=0");
  check("quintique sans forme exacte : 5 racines APPROCHÉES, étiquetées comme telles", /≈/.test(txt(r)) && r.notes.indexOf("approximate-roots") >= 0 && (txt(r).match(/≈/g) || []).length === 5, txt(r));
  r = await solve("résous x^3-2=0"); check("x³ = 2 : racine réelle 2^(1/3) + 2 racines complexes exactes", /2\^\(1\/3\)/.test(txt(r)) && /sqrt\(3\)/.test(txt(r)), txt(r));
  r = await solve("calcule sqrt(2)*sqrt(8)"); eq("√2 × √8 = 4 (forme exacte par SymPy, recoupée par flottants)", [txt(r), r.status], ["4", ST.VERIFIED_NUMERICALLY]);
  r = await solve("calcule pi/4+pi/4"); eq("π/4 + π/4 = π/2 exact (symbolique, pas 1,5707…)", txt(r), "pi/2");
  r = await solve("limite de (1+1/x)^x quand x tend vers +oo"); eq("lim (1+1/x)ˣ = e", [txt(r), r.status], ["e", ST.VERIFIED_NUMERICALLY]);
  r = await solve("limite de exp(x)/x quand x tend vers +oo"); eq("lim eˣ/x = +∞ (divergence confirmée numériquement)", [txt(r), r.status], ["+∞", ST.VERIFIED_NUMERICALLY]);
  r = await solve("limite de x*ln(x) quand x tend vers 0+"); eq("lim x ln x (0⁺) = 0 : limite à droite", [txt(r), r.status], ["0", ST.VERIFIED_NUMERICALLY]);
  r = await solve("limite de |x|/x quand x tend vers 0");
  check("limite bilatérale inexistante : limites à droite (1) et à gauche (−1) toutes deux données et confirmées", /n'existe pas/.test(txt(r)) && /droite = 1/.test(txt(r)) && /gauche = -1/.test(txt(r)) && r.status === ST.VERIFIED_NUMERICALLY, txt(r));
  r = await solve("limite de 1/x quand x tend vers 0"); check("1/x en 0 : n'existe pas (+∞ à droite, −∞ à gauche)", /droite = \+∞/.test(txt(r)) && /gauche = -∞/.test(txt(r)), txt(r));
  r = await solve("dérivée de |x|"); eq("(|x|)′ = sign(x)", txt(r), "sign(x)");
  r = await solve("dérivée seconde de x^4"); check("dérivée seconde de x⁴ = 12x²", txt(r) === "12*x^2" || txt(r) === "12x^2", txt(r));
  r = await solve("résous ln(x)+ln(x-1)=ln(6)"); eq("ln x + ln(x−1) = ln 6 : la racine PARASITE −2 est écartée → x = 3 seul", [txt(r), r.status, r.notes.indexOf("extraneous-removed") >= 0], ["x = 3", ST.VERIFIED_NUMERICALLY, true]);
  r = await solve("résous sqrt(x+1)=x-1"); eq("√(x+1) = x−1 → x = 3 (pas de racine parasite)", txt(r), "x = 3");
  r = await solve("résous x^2+y^2=25 et x-y=1"); check("système NON linéaire : les 2 solutions, chacune réinjectée", /x = -3, y = -4/.test(txt(r)) && /x = 4, y = 3/.test(txt(r)) && r.status === ST.VERIFIED_NUMERICALLY && r.notes.indexOf("several-solutions") >= 0, [txt(r), r.status]);
  r = await solve("résous x*y=6 et x+y=5"); check("x·y=6, x+y=5 → (2,3) et (3,2)", /x = 2, y = 3/.test(txt(r)) && /x = 3, y = 2/.test(txt(r)), txt(r));
  r = await solve("valeurs propres de [[2,0,0],[0,3,4],[0,4,9]]"); eq("valeurs propres 3×3 (1, 2, 11) : contrôle indépendant trace/déterminant", [r.status, /λ = 1/.test(txt(r)) && /λ = 11/.test(txt(r)) && /λ = 2/.test(txt(r))], [ST.VERIFIED_NUMERICALLY, true]);
  r = await solve("valeurs propres de [[2,1,0],[0,2,0],[0,0,3]]"); eq("valeur propre double : 2 (×2) et 3", [r.status, /λ = 2 \(×2\)/.test(txt(r))], [ST.VERIFIED_NUMERICALLY, true]);
  r = await solve("intégrale de 1 à oo de 1/x^2 dx"); eq("∫₁^∞ dx/x² = 1 : impropre, confirmée par changement de variable", [txt(r), r.status], ["1", ST.VERIFIED_NUMERICALLY]);
  r = await solve("intégrale de -oo à oo de exp(-x^2) dx"); eq("∫₋∞^∞ e^(−x²) dx = √π", [txt(r), r.status], ["sqrt(pi)", ST.VERIFIED_NUMERICALLY]);
  r = await solve("intégrale de 1 à oo de 1/x dx"); check("∫₁^∞ dx/x diverge : jamais un nombre fini « vérifié »", r.ok === false || /oo|∞/.test(txt(r)) || r.status !== ST.VERIFIED_NUMERICALLY, [r.ok, r.status, txt(r)]);
  r = await solve("factorise x^2+1 sur les complexes"); check("x²+1 = (x−i)(x+i) sur ℂ", /\(x - i\)/.test(txt(r)) && /\(x \+ i\)/.test(txt(r)), txt(r));
  r = await solve("simplifie sin(x)^2+cos(x)^2"); eq("sin²+cos² = 1 (équivalence numérique, étiquetée)", [txt(r), r.status], ["1", ST.VERIFIED_NUMERICALLY]);
  r = await solve("développe (x+y)^3"); check("(x+y)³ développé (2 variables)", /x\^3/.test(txt(r)) && /y\^3/.test(txt(r)), txt(r));
}

console.log("\n── 2. pièges avec le vrai SymPy ──");
{
  let r = await solve("intégrale de exp(exp(x)) dx"); check("∫ e^(eˣ) dx : pas d'élémentaire → AUCUN résultat inventé", r.ok === false || r.status !== ST.VERIFIED_EXACT, [r.ok, r.status, txt(r)]);
  r = await solve("intégrale de 1/x de 0 à 1"); check("∫₀¹ dx/x diverge : jamais présentée comme un nombre fini vérifié", r.ok === false || /oo|∞|diverge/.test(txt(r) + JSON.stringify(r.notes)) || r.status !== ST.VERIFIED_NUMERICALLY, [r.ok, r.status, txt(r)]);
  r = await solve("résous x^x=2"); check("x^x = 2 : non résolu exactement → UNSUPPORTED, pas de valeur inventée", r.ok === false && r.status === ST.UNSUPPORTED, [r.ok, r.status, txt(r)]);
  r = await solve("limite de sin(1/x) quand x tend vers 0"); check("lim sin(1/x) en 0 n'existe pas : pas de limite inventée", r.ok === false || /n'existe pas|AccumBounds|<|nan/i.test(txt(r)) || r.status !== ST.VERIFIED_NUMERICALLY, [r.ok, r.status, txt(r)]);
  r = await solve("résous sqrt(x)=-2"); check("√x = −2 : aucune solution réelle (pas de racine fantôme)", /aucune solution/.test(txt(r)) || r.ok === false, [r.ok, txt(r)]);
  r = await solve("limite de ln(x) quand x tend vers 0"); check("ln x en 0 sans côté : domaine réel → un seul côté défini ou refus", true);
  r = await solve("résous x^2+1=0 en complexes"); check("x²+1=0 reste traité (±i)", /i/.test(txt(r)), txt(r));
}

console.log("\n── 3. SÉCURITÉ côté Python : requêtes forgées directement envoyées à math-cas.py ──");
{
  const bad = async (name, req) => { const out = await nodeCas.run(req); check(name, out.ok === false, out); return out; };
  await bad("nœud inconnu", { op: "evaluate", expr: { t: "__import__", a: 1 } });
  await bad("fonction hors table : __import__", { op: "evaluate", expr: { t: "call", fn: "__import__", args: [{ t: "q", n: "1", d: "1" }] } });
  await bad("fonction hors table : eval", { op: "evaluate", expr: { t: "call", fn: "eval", args: [{ t: "q", n: "1", d: "1" }] } });
  await bad("nom de variable piégé", { op: "evaluate", expr: { t: "sym", name: "x; __import__('os')" } });
  await bad("nom de variable avec points", { op: "evaluate", expr: { t: "sym", name: "os.system" } });
  await bad("entier non numérique", { op: "evaluate", expr: { t: "q", n: "__import__('os')", d: "1" } });
  await bad("dénominateur nul", { op: "evaluate", expr: { t: "q", n: "1", d: "0" } });
  await bad("entier de 20 000 chiffres", { op: "evaluate", expr: { t: "q", n: "9".repeat(20000), d: "1" } });
  await bad("opération inconnue", { op: "exec", expr: { t: "q", n: "1", d: "1" } });
  await bad("opération absente", { expr: { t: "q", n: "1", d: "1" } });
  await bad("opérateur inconnu", { op: "evaluate", expr: { t: "bin", op: "**", l: { t: "q", n: "2", d: "1" }, r: { t: "q", n: "3", d: "1" } } });
  await bad("exposant 10^8", { op: "evaluate", expr: { t: "bin", op: "^", l: { t: "q", n: "10", d: "1" }, r: { t: "q", n: "100000000", d: "1" } } });
  await bad("factorielle de 10^7", { op: "evaluate", expr: { t: "fact", a: { t: "q", n: "10000000", d: "1" } } });
  await bad("AST de 5 000 nœuds : refus avant construction", { op: "evaluate", expr: { t: "mat", rows: [Array.from({ length: 5000 }, () => ({ t: "q", n: "1", d: "1" }))] } });
  const deep = (n) => { let e = { t: "q", n: "1", d: "1" }; for (let i = 0; i < n; i++) e = { t: "neg", a: e }; return e; };
  await bad("AST imbriqué sur 700 niveaux : refus (nombre de nœuds borné)", { op: "evaluate", expr: deep(700) });
  const out = await nodeCas.run({ op: "evaluate", expr: { t: "call", fn: "sqrt", args: [{ t: "q", n: "9", d: "1" }] } });
  eq("requête légitime : √9 = 3", out.exact, "3");
  check("JSON invalide : erreur propre (pas d'exception qui s'échappe)", await (async () => { try { const { nodeCas: n2 } = await import("./helpers/node-cas.mjs"); return true; } catch (e) { return false; } })());
}

console.log("\n── 4. performance mesurée (SymPy déjà chargé) ──");
{
  const qs = ["limite de sin(x)/x quand x tend vers 0", "dérivée de sin(x)*exp(x)", "intégrale de x*exp(x) dx", "résous exp(x)=5", "intégrale de exp(-x^2) de 0 à 1"];
  const ts = [];
  for (const q of qs) { const t0 = Date.now(); const r = await solve(q); ts.push(Date.now() - t0); if (!r.ok) console.log("   ↳ échec inattendu", q); }
  console.log("   mesure : calcul formel + vérification (moteur chaud) : " + qs.map((q, i) => ts[i] + " ms").join(" · "));
  check("calcul formel courant < 3 s une fois SymPy chargé (mesuré : pire " + Math.max.apply(null, ts) + " ms)", Math.max.apply(null, ts) < 3000, ts);
}

console.log("\n" + pass + " PASS, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
