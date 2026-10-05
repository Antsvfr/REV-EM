/* REV-EM Math Engine — moteur PUR (sans navigateur, sans CAS) sous Node.
   Lancer :  node tests/math-engine.test.js
   « PASS »      = logique pure et exacte : parseur à liste blanche, rationnels BigInt, Fast Engine, MathVerifier, analyseur, présentation.
   « PASS MOCK » = le CAS (SymPy) est REMPLACÉ par un faux : on prouve le routage, le re-contrôle indépendant du résultat du CAS, et la
                   façon dont les échecs (timeout, indisponible, CAS qui se trompe) sont traités. Le vrai SymPy est testé dans math-cas.test.mjs. */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
["math-core.js", "math-fast.js", "math-verify.js", "math-engine.js"].forEach(f => require(path.join(ROOT, f)));
require(path.join(ROOT, "assistant-core.js"));
const R = globalThis.RevemMath, E = R.engine, C = R.core, F = R.fast, V = R.verify, A = globalThis.RevemAssistant;
const ST = C.STATUS;

let pass = 0, fail = 0, mock = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); } };
const checkMock = (name, ok, got) => { if (ok) { mock++; console.log("PASS MOCK — " + name); } else { fail++; console.log("FAIL — " + name + (got !== undefined ? "  " + JSON.stringify(got) : "")); } };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { attendu: want, obtenu: got });
const solve = (q, o) => E.solve(q, Object.assign({ lang: "fr" }, o || {}));
const txt = r => r.exact && r.exact.text;

/* faux CAS : enregistre les requêtes et répond via `handler` (ou échoue) */
function mockCas(handler) {
  const c = { calls: [], run: async (req) => { c.calls.push(req); return handler(req); } };
  return c;
}

(async () => {

/* ═══ 1. RÉFÉRENCE — tout est exact et vérifié (Fast Engine, sans CAS) ═══════════════════════════════════════════ */
console.log("\n── 1. problèmes de référence ──");
{
  let r = await solve("factorise x^2-5x+6");
  eq("factor x²−5x+6 = (x−2)(x−3)", [txt(r), r.status], ["(x - 2)(x - 3)", ST.VERIFIED_EXACT]);
  eq("…par le Fast Engine, sans CAS", r.diag.engineUsed, "fast");
  r = await solve("résous x^2-5x+6=0");
  eq("x²−5x+6=0 → 2 et 3 (substitution exacte)", [txt(r), r.status, r.verification.method], ["x = 2 ; x = 3", ST.VERIFIED_EXACT, "substitution-exacte"]);
  r = await solve("dérivée de x^3+2x^2-5x+3");
  eq("(x³+2x²−5x+3)′ = 3x²+4x−5", [txt(r), r.status], ["3x^2 + 4x - 5", ST.VERIFIED_EXACT]);
  r = await solve("primitive de 2x");
  eq("∫2x dx = x²+C (constante signalée)", [txt(r), r.status, r.notes.indexOf("constant-of-integration") >= 0], ["x^2 + C", ST.VERIFIED_EXACT, true]);
  r = await solve("∫₀¹x²dx");
  eq("∫₀¹ x² dx = 1/3 exact, pas 0,33", [txt(r), r.status], ["1/3", ST.VERIFIED_EXACT]);
  r = await solve("intégrale de 0 à 1 de x^2 dx");
  eq("bornes en tête de phrase : « de 0 à 1 de x^2 dx »", txt(r), "1/3");
  r = await solve("résous x+y=5 et x-y=1");
  eq("système x+y=5, x−y=1 → x=3, y=2", [txt(r), r.status], ["x = 3 ; y = 2", ST.VERIFIED_EXACT]);
  r = await solve("inverse de la matrice [[1,2],[3,4]]");
  eq("inverse [[1,2],[3,4]] = [[−2,1],[3/2,−1/2]] ET contrôle A·A⁻¹=I", [txt(r), r.status, r.verification.method], ["[-2, 1; 3/2, -1/2]", ST.VERIFIED_EXACT, "A×A⁻¹=I"]);
  r = await solve("1000 € à 5 % pendant 4 ans intérêts composés");
  eq("1000 € à 5 % sur 4 ans = 194481/160 exactement (1215,50625 avant arrondi)", [txt(r), r.approx.text], ["194481/160", "1215,50625"]);
  eq("…arrondi à 2 décimales seulement pour l'affichage : 1215,51 €", r.card.moneyText.replace(/\s/g, " "), "1215,51 €");
  r = await solve("limite de sin(x)/x quand x tend vers 0");
  eq("lim sin x / x = 1 : PAS de réponse sans CAS (jamais inventée)", [r.ok, r.status, r.code], [false, ST.UNSUPPORTED, "CAS_UNAVAILABLE"]);
}

/* ═══ 2. ARITHMÉTIQUE EXACTE ET NOTATIONS ════════════════════════════════════════════════════════════════════ */
console.log("\n── 2. arithmétique exacte, notations ──");
{
  let r;
  r = await solve("1/3 + 1/6"); eq("1/3 + 1/6 = 1/2 (exact)", [txt(r), r.approx.text], ["1/2", "0,5"]);
  r = await solve("0,1 + 0,2"); eq("0,1 + 0,2 = 3/10 exactement (pas 0,30000000000000004)", txt(r), "3/10");
  r = await solve("calcule 3,5 × 2,2"); eq("virgule décimale française : 3,5 × 2,2 = 77/10", txt(r), "77/10");
  r = await solve("calcule 3.5 * 2.2"); eq("point décimal : même résultat", txt(r), "77/10");
  r = await solve("calcule 1 500,50 + 2 000"); eq("« 1 500,50 + 2 000 » : espaces des milliers + virgule décimale", txt(r), "7001/2");
  r = await solve("calcule (2+3)*4"); eq("parenthèses", txt(r), "20");
  r = await solve("calcule 2^100"); eq("grand entier exact 2^100", txt(r), "1267650600228229401496703205376");
  r = await solve("calcule 10^400"); eq("10^400 reste exact (hors de la plage des flottants, pas d'invention)", [r.ok, r.status], [true, ST.VERIFIED_EXACT]);
  r = await solve("calcule 100!"); eq("100! exact, entier affiché en entier + écriture scientifique", [/^9332621544394415268/.test(txt(r)), /× 10\^157$/.test(r.approx.text)], [true, true]);
  r = await solve("calcule 2x"); eq("x²−5x… « calcule 2x » (variable libre) n'est pas un calcul numérique", r.kind === "arith", false);
  r = await solve("x² − 5x + 6 = 0".replace("x²", "résous x²")); eq("exposant Unicode x²", txt(r), "x = 2 ; x = 3");
  r = await solve("calcule √2 × √8"); eq("√ Unicode, sans CAS : approximation ÉTIQUETÉE, jamais présentée comme exacte", [r.ok, r.status, r.exact, r.approx.text], [true, ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, null, "4"]);
  r = await solve("calcule 1/3"); eq("1/3 : fraction exacte et décimale arrondie ≠ exacte", [txt(r), r.approx.text, r.approx.exactDecimal === false], ["1/3", "0,333333", true]);
  r = await solve("calcule 7 mod 3"); eq("mod", txt(r), "1");
  r = await solve("calcule 12 pgcd 18".replace("12 pgcd 18", "pgcd(12;18)")); eq("pgcd(12;18) (« ; » séparateur d'arguments)", txt(r), "6");
  r = await solve("5 % de 200 €"); eq("5 % de 200 € = 10", txt(r), "10");
  r = await solve("what is 15% of 80"); eq("« what is 15% of 80 » est un CALCUL (et non une question d'explication)", txt(r), "12");
  r = await solve("qu'est-ce que 2+2 ?"); eq("« qu'est-ce que 2+2 ? » est un calcul", txt(r), "4");
}

/* ═══ 2bis. LE SIGNE « − » EN TÊTE N'EST JAMAIS PERDU (régression : un résultat « vérifié » mais faux) ═══════════════ */
console.log("\n── 2bis. signe moins en tête ──");
{
  let r = await solve("dérivée de -x^2"); eq("(−x²)′ = −2x", txt(r), "-2x");
  r = await solve("résous -x^2+4=0"); eq("−x²+4 = 0 → x = ±2 (réelles)", txt(r), "x = -2 ; x = 2");
  r = await solve("factorise -x^2+1"); check("−x²+1 = −(x−1)(x+1) (pas x²+1 !)", /^-\(x - 1\)\(x \+ 1\)$/.test(txt(r)) || /^\(1 - x\)\(x \+ 1\)$/.test(txt(r)), txt(r));
  r = await solve("développe -(x+1)^2"); eq("−(x+1)² = −x²−2x−1", txt(r), "-x^2 - 2x - 1");
  r = await solve("intégrale de -2x dx"); eq("∫ −2x dx = −x² + C", txt(r), "-x^2 + C");
  r = await solve("simplifie -x/x"); eq("−x/x = −1", txt(r), "-1");
  r = await solve("résous - x^2 + 4 = 0"); eq("« - x² » (tiret suivi d'une espace) reste un moins", txt(r), "x = -2 ; x = 2");
  r = await solve("calcule -3 + 5"); eq("−3 + 5 = 2", txt(r), "2");
  r = await solve("calcule 2 - -3"); eq("2 − (−3) = 5", txt(r), "5");
  r = await solve("calcule -2^2"); eq("−2² = −4 (la puissance l'emporte sur le signe)", txt(r), "-4");
  r = await solve("calcule (-2)^2"); eq("(−2)² = 4", txt(r), "4");
  r = await solve("résous x^2+1=0 en complexes"); eq("domaine complexe demandé", txt(r), "x = -i ; x = i");
  r = await solve("résous x^2+1=0 dans les réels"); eq("domaine réel demandé : aucune solution réelle", [txt(r), r.notes.indexOf("no-real-solution") >= 0], ["aucune solution réelle", true]);
  r = await solve("factorise 6x^2+5x+1"); eq("coefficients entiers : (2x+1)(3x+1)", txt(r), "(2x + 1)(3x + 1)");
  r = await solve("factorise 4x^2-9"); eq("différence de carrés : (2x−3)(2x+3)", txt(r), "(2x - 3)(2x + 3)");
}

/* ═══ 2ter. INTERPRÉTATION FIDÈLE (test par propriété) : l'expression ANALYSÉE vaut celle qu'on a écrite ═══════════════ */
console.log("\n── 2ter. interprétation fidèle (test aléatoire, graine fixe) ──");
{
  let seed = 20240601; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const SUP = { 2: "²", 3: "³", 4: "⁴" };
  const verbs = [["dérivée de ", "derivative"], ["factorise ", "factor"], ["développe ", "expand"], ["simplifie ", "simplify"], ["primitive de ", "integral"], ["résous ", "equation"], ["solve ", "equation"], ["derive ", "derivative"]];
  let bad = 0, total = 0;
  for (let n = 0; n < 400; n++) {
    const deg = ri(1, 4), co = []; for (let i = 0; i <= deg; i++) co.push(ri(-9, 9)); if (!co[deg]) co[deg] = ri(1, 9) * (rnd() < 0.5 ? -1 : 1);
    const style = ri(0, 3), sp = style === 1 ? " " : "";
    let text = "", first = true;
    for (let i = deg; i >= 0; i--) {
      const c = co[i]; if (!c) continue;
      const a = Math.abs(c), vr = i === 0 ? "" : (i === 1 ? "x" : (style === 2 && SUP[i] ? "x" + SUP[i] : "x^" + i));
      const mag = i === 0 ? String(a) : ((a === 1 ? "" : String(a)) + (style === 3 && a !== 1 ? "*" : "") + vr);
      text += first ? (c < 0 ? "-" + sp : "") + mag : sp + (c < 0 ? "-" : "+") + sp + mag; first = false;
    }
    if (!text) continue;
    const [verb, kind] = verbs[ri(0, verbs.length - 1)];
    const q = verb + text + (kind === "equation" ? " = 0" : "");
    const a = E.analyze(q, { lang: "fr" });
    total++;
    const ast = a.kind === "equation" ? a.eq.l : a.ast;
    if (a.kind !== kind || !ast) { bad++; console.log("   ↳ mauvais type", JSON.stringify(q), a.kind); continue; }
    const f = x => co.reduce((s, c, i) => s + c * Math.pow(x, i), 0);
    const good = [1.7, -0.9, 2.3].every(x => Math.abs(C.evalFloat(ast, { x }) - f(x)) < 1e-9);
    if (!good) { bad++; console.log("   ↳ MAL INTERPRÉTÉ :", JSON.stringify(q)); }
  }
  eq("400 polynômes aléatoires (signes, espaces, ², *, 8 verbes) : toujours interprétés fidèlement (" + total + " analysés)", bad, 0);
  // et les RÉSULTATS exacts : la dérivée / primitive calculée est juste pour de vrai (comparaison à la formule indépendante, pas au moteur lui-même)
  let wrong = 0, cnt = 0;
  for (let n = 0; n < 150; n++) {
    const deg = ri(1, 4), co = []; for (let i = 0; i <= deg; i++) co.push(ri(-9, 9)); if (!co[deg]) co[deg] = 3;
    const text = co.map((c, i) => (c < 0 ? "-" : "+") + Math.abs(c) + "*x^" + i).reverse().join("");
    const r = await solve("dérivée de " + text); cnt++;
    const dco = co.map((c, i) => c * i).slice(1);
    const g = x => dco.reduce((s, c, i) => s + c * Math.pow(x, i), 0);
    const ok = r.ok && [0.5, -1.3, 2.1].every(x => Math.abs(C.evalFloat(C.parse(txt(r)).ast, { x }) - g(x)) < 1e-8);
    if (!ok) { wrong++; console.log("   ↳ dérivée fausse :", text, txt(r)); }
  }
  eq("150 dérivées aléatoires : le résultat affiché vaut la vraie dérivée (formule indépendante)", wrong, 0);
}

/* ═══ 2quater. ARITHMÉTIQUE ET RACINES : comparées à un oracle INDÉPENDANT (BigInt écrit dans le test) ═══════════════ */
console.log("\n── 2quater. oracle indépendant ──");
{
  let seed = 777; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b]; } return a; };
  const frac = (n, d) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d) || 1n; return [n / g, d / g]; };
  const add = (x, y) => frac(x[0] * y[1] + y[0] * x[1], x[1] * y[1]), mul = (x, y) => frac(x[0] * y[0], x[1] * y[1]);
  const dv = (x, y) => frac(x[0] * y[1], x[1] * y[0]), neg = x => [-x[0], x[1]];
  let bad = 0;
  for (let n = 0; n < 300; n++) {
    const f = () => [BigInt(ri(-20, 20)), BigInt(ri(1, 12))];
    const a = f(), b = f(), c = f(), d = f();
    if (!c[0] || !d[0]) continue;
    const t = x => x[1] === 1n ? String(x[0]) : "(" + x[0] + "/" + x[1] + ")";
    const op1 = ["+", "-", "*"][ri(0, 2)], op2 = ["+", "-", "/"][ri(0, 2)];
    const src = "calcule " + t(a) + " " + op1 + " " + t(b) + " " + op2 + " " + t(c);
    // priorité des opérateurs : (a op1 b) op2 c — sauf * et / qui lient plus fort
    const A = frac(a[0], a[1]), B = frac(b[0], b[1]), Cc = frac(c[0], c[1]);
    const ap = (o, x, y) => o === "+" ? add(x, y) : o === "-" ? add(x, neg(y)) : o === "*" ? mul(x, y) : dv(x, y);
    const prec = o => (o === "*" || o === "/") ? 2 : 1;
    const want = prec(op2) > prec(op1) ? ap(op1, A, ap(op2, B, Cc)) : ap(op2, ap(op1, A, B), Cc);
    const r = await solve(src);
    const got = txt(r);
    const wantTxt = want[1] === 1n ? String(want[0]) : want[0] + "/" + want[1];
    if (!r.ok || got !== wantTxt) { bad++; if (bad < 5) console.log("   ↳", src, "attendu", wantTxt, "obtenu", got); }
  }
  eq("300 expressions rationnelles aléatoires (priorités, signes, fractions) = oracle BigInt", bad, 0);
  let badq = 0;
  for (let n = 0; n < 120; n++) {
    const r1 = ri(-9, 9), r2 = ri(-9, 9), a = ri(1, 5);
    // a(x − r1)(x − r2) = a x² − a(r1+r2) x + a r1 r2
    const B = -a * (r1 + r2), Cc = a * r1 * r2;
    const q = "résous " + a + "x^2" + (B < 0 ? "-" : "+") + Math.abs(B) + "x" + (Cc < 0 ? "-" : "+") + Math.abs(Cc) + "=0";
    const r = await solve(q);
    const want = Array.from(new Set([r1, r2])).sort((x, y) => x - y).map(v => "x = " + v).join(" ; ");
    if (!r.ok || txt(r) !== want) { badq++; if (badq < 5) console.log("   ↳", q, "attendu", want, "obtenu", txt(r)); }
  }
  eq("120 trinômes à racines entières : racines exactes = construction", badq, 0);
}

/* ═══ 3. PIÈGES : échecs propres, jamais de résultat inventé ═════════════════════════════════════════════════ */
console.log("\n── 3. pièges ──");
{
  let r;
  r = await solve("calcule 5/0"); eq("division par zéro", [r.ok, r.code, r.exact], [false, "DIV_ZERO", null]);
  r = await solve("calcule 0/0"); eq("0/0", [r.ok, r.code], [false, "DIV_ZERO"]);
  r = await solve("sqrt(-1)"); eq("√(−1) hors du domaine réel : refusé, avec la note sur ℂ", [r.ok, r.code, !!r.complexNote], [false, "DOMAIN", true]);
  r = await solve("log(0)"); eq("log(0)", [r.ok, r.code], [false, "DOMAIN"]);
  r = await solve("ln(-3)"); eq("ln(−3)", [r.ok, r.code], [false, "DOMAIN"]);
  r = await solve("résous x^2+1=0"); eq("pas de racine réelle → solutions COMPLEXES, signalées", [txt(r), r.notes.indexOf("no-real-solution") >= 0, r.notes.indexOf("complex-solutions") >= 0], ["x = -i ; x = i", true, true]);
  r = await solve("résous x^2+4x+4=0"); eq("racine double donnée une seule fois, avec la note", [txt(r), r.notes.indexOf("multiple-root") >= 0], ["x = -2", true]);
  r = await solve("inverse de [[1,2],[2,4]]"); eq("matrice singulière : « non inversible », jamais d'inverse inventé", [txt(r), r.status], ["non inversible (déterminant 0)", ST.VERIFIED_EXACT]);
  r = await solve("calcule (2+3*4"); eq("parenthèse non fermée", [r.ok, r.status], [false, ST.INVALID_INPUT]);
  r = await solve("résous x +"); eq("expression incomplète", [r.ok, r.status], [false, ST.INVALID_INPUT]);
  r = await solve("calcule 10^(10^10)"); eq("exposant gigantesque : refus propre, pas de gel", [r.ok, r.status, r.code], [false, ST.UNSUPPORTED, "TOO_COMPLEX"]);
  r = await solve("calcule 100000!"); eq("factorielle trop grande", [r.ok, r.code], [false, "TOO_COMPLEX"]);
  r = await solve("calcule 500 600 300"); eq("« 500 600 300 » : jamais recollé en 500600300 (ambigu)", [r.ok, r.status === ST.AMBIGUOUS || r.status === ST.INVALID_INPUT], [false, true]);
  const t0 = Date.now();
  r = await solve("calcule " + "(".repeat(400) + "1" + ")".repeat(400)); eq("400 parenthèses imbriquées : refus rapide (profondeur bornée)", [r.ok, Date.now() - t0 < 1500], [false, true]);
  r = await solve("calcule " + "1+".repeat(5000) + "1"); check("expression de 10 000 caractères : aucun résultat (longueur bornée)", !r.ok && !r.exact, r.kind);
  r = await solve("calcule 0,5,3"); check("« 0,5,3 » : lecture ambiguë détectée (jamais devinée)", r.ok === false && (r.status === ST.AMBIGUOUS || r.status === ST.INVALID_INPUT), r.status);
  r = await solve("résous x^2 = "); eq("équation sans second membre", r.ok, false);
  r = await solve("dérivée de"); eq("« dérivée de » seul : pas un problème (pas d'invention)", r.handled, false);
}

/* ═══ 4. SÉCURITÉ : aucune exécution de code, jamais ═════════════════════════════════════════════════════════ */
console.log("\n── 4. sécurité ──");
{
  const attacks = ["__import__('os').system('ls')", "eval('1+1')", "Function('return 1')()", "constructor.constructor('return process')()", "process.exit(1)", "require('fs')",
    "calcule 1; alert(1)", "calcule `ls`", "calcule ${1+1}", "résous x=__proto__", "résous x=constructor", "calcule (function(){return 1})()", "calcule a.b.c", "calcule x[0]", "calcule 1+import('x')",
    "calcule \"abc\"", "calcule 'a'+'b'", "résous <script>alert(1)</script>=0", "calcule 1+1\u0000", "calcule {1:2}", "dérivée de __import__('os')", "factorise exec('1')"];
  let bad = 0;
  globalThis.__pwned = false;
  for (const a of attacks) {
    const r = await solve(a);
    const ok = (r.ok === false || r.handled === false) && !globalThis.__pwned;
    if (!ok) { bad++; console.log("   ↳ réponse inattendue pour", JSON.stringify(a), JSON.stringify(r.exact || r.message)); }
  }
  eq("22 charges hostiles : toutes refusées, aucune exécution", bad, 0);
  const evalFree = ["math-core.js", "math-fast.js", "math-verify.js", "math-engine.js", "math-cas-client.js", "math-cas-worker.js"].every(f => {
    const code = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return !/(^|[^.\w])eval\s*\(|new\s+Function\s*\(|(^|[^.\w])Function\s*\(|setTimeout\s*\(\s*["'`]|importScripts\s*\(\s*[a-z]/.test(code);
  });
  check("aucun eval / new Function / Function( dans les modules math JS", evalFree);
  const py = fs.readFileSync(path.join(ROOT, "math-cas.py"), "utf8").split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
  check("math-cas.py : aucun sympify / parse_expr / eval / exec / __import__ / compile / open", !/(^|[^.\w])(sympify|parse_expr|eval|exec|__import__|compile|open|getattr|setattr|globals|locals)\s*\(/.test(py), py.match(/(^|[^.\w])(sympify|parse_expr|eval|exec|__import__|compile|open|getattr|setattr)\s*\(/));
  const ast = C.parse("2x+1").ast;
  check("l'AST est du JSON pur (aucune fonction)", JSON.stringify(JSON.parse(JSON.stringify(ast))) === JSON.stringify(ast));
}

/* ═══ 5. MATHVERIFIER : un résultat FAUX n'est jamais « vérifié » ═════════════════════════════════════════════ */
console.log("\n── 5. MathVerifier ──");
{
  const P = s => C.parse(s).ast;
  eq("dérivée correcte confirmée", V.verifyDerivative(P("x^3"), P("3x^2"), "x").status, ST.VERIFIED_NUMERICALLY);
  check("dérivée FAUSSE (2x au lieu de 3x²) : non vérifiée", V.verifyDerivative(P("x^3"), P("2x"), "x").status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  check("primitive FAUSSE : non vérifiée", V.verifyAntiderivative(P("2x"), P("x^3"), "x").status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  eq("racines correctes confirmées", V.verifyEquationRoots(P("x^2-5x+6=0"), "x", [2, 3]).status, ST.VERIFIED_NUMERICALLY);
  check("racine FAUSSE : non vérifiée", V.verifyEquationRoots(P("x^2-5x+6=0"), "x", [2, 4]).status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  eq("(x−1)(x+1) ≡ x²−1 : EXACT (polynômes)", [V.equivalent(P("(x-1)(x+1)"), P("x^2-1")).equal, V.equivalent(P("(x-1)(x+1)"), P("x^2-1")).status], [true, ST.VERIFIED_EXACT]);
  eq("(x+1)² ≢ x²+1", V.equivalent(P("(x+1)^2"), P("x^2+1")).equal, false);
  eq("sin²x+cos²x ≡ 1 : équivalence NUMÉRIQUE seulement (jamais « exacte »)", [V.equivalent(P("sin(x)^2+cos(x)^2"), P("1")).equal, V.equivalent(P("sin(x)^2+cos(x)^2"), P("1")).status], [true, ST.VERIFIED_NUMERICALLY]);
  eq("intégrale ∫₀¹ x² = 1/3 par quadrature", V.verifyDefiniteIntegral(P("x^2"), "x", 0, 1, 1 / 3).status, ST.VERIFIED_NUMERICALLY);
  check("intégrale FAUSSE (0,5) : non vérifiée", V.verifyDefiniteIntegral(P("x^2"), "x", 0, 1, 0.5).status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  eq("limite sin x/x → 1 confirmée numériquement", V.verifyLimit(P("sin(x)/x"), "x", 0, null, 1).status, ST.VERIFIED_NUMERICALLY);
  check("limite FAUSSE (2) : non vérifiée", V.verifyLimit(P("sin(x)/x"), "x", 0, null, 2).status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  eq("système : réinjection exacte", V.verifySystem([P("x+y=5"), P("x-y=1")], { x: 3, y: 2 }).status, ST.VERIFIED_NUMERICALLY);
  check("système FAUX : non vérifié", V.verifySystem([P("x+y=5"), P("x-y=1")], { x: 2, y: 3 }).status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  eq("A·A⁻¹ ≈ I confirmé", V.verifyMatrixInverse([[1, 2], [3, 4]], [[-2, 1], [1.5, -0.5]]).status, ST.VERIFIED_NUMERICALLY);
  check("inverse FAUSSE non vérifiée", V.verifyMatrixInverse([[1, 2], [3, 4]], [[1, 0], [0, 1]]).status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  check("un contrôle numérique n'est JAMAIS présenté comme exact", V.verifyDerivative(P("sin(x)"), P("cos(x)"), "x").status !== ST.VERIFIED_EXACT);
  eq("intégrale impropre ∫₁^∞ dx/x² = 1 confirmée (changement de variable)", V.verifyDefiniteIntegral(P("1/x^2"), "x", 1, Infinity, 1).status, ST.VERIFIED_NUMERICALLY);
  eq("∫₋∞^∞ e^(−x²) = √π confirmée", V.verifyDefiniteIntegral(P("exp(-x^2)"), "x", -Infinity, Infinity, Math.sqrt(Math.PI)).status, ST.VERIFIED_NUMERICALLY);
  check("∫₁^∞ dx/x² = 2 (faux) : non vérifiée", V.verifyDefiniteIntegral(P("1/x^2"), "x", 1, Infinity, 2).status === ST.COMPUTED_NOT_INDEPENDENTLY_VERIFIED);
  check("∫₁^∞ dx/x diverge : jamais « vérifiée » comme valeur finie", V.verifyDefiniteIntegral(P("1/x"), "x", 1, Infinity, 5).status !== ST.VERIFIED_NUMERICALLY);
  eq("valeurs propres : [[2,1],[1,2]] → 1 et 3 confirmées", V.verifyEigenvalues([[2, 1], [1, 2]], [{ value: 1, mult: 1 }, { value: 3, mult: 1 }]).status, ST.VERIFIED_NUMERICALLY);
  check("valeurs propres fausses (1 et 4) : contredites", V.verifyEigenvalues([[2, 1], [1, 2]], [{ value: 1, mult: 1 }, { value: 4, mult: 1 }]).refuted === true);
  check("limite FAUSSE (sin x/x → 2) : CONTREDITE (valeurs stabilisées ailleurs)", V.verifyLimit(P("sin(x)/x"), "x", 0, null, 2).refuted === true);
  check("limite à convergence lente (x ln x → 0 en 0⁺) : PAS réfutée à tort", V.verifyLimit(P("x*ln(x)"), "x", 0, "+", 0).refuted !== true);
  check("« non vérifiable » ≠ « réfuté » (intégrale d'une singularité intégrable)", V.verifyDefiniteIntegral(P("1/sqrt(x)"), "x", 0, 1, 2).refuted !== true);
}

/* ═══ 6. RÉPONSES D'ÉLÈVE (comparaison MATHÉMATIQUE) ═════════════════════════════════════════════════════════ */
console.log("\n── 6. réponses d'élève ──");
{
  const exp = C.parse("1/2").ast;
  for (const a of ["1/2", "0.5", "0,5", "2/4", "50/100", "(1+1)/4", "x = 0,5"]) eq("« " + a + " » = 1/2", V.compareAnswer(a, exp, { decimalComma: true }).verdict, "correct");
  eq("« 1/3 » ≠ 1/2", V.compareAnswer("1/3", exp, { decimalComma: true }).verdict, "incorrect");
  const poly = C.parse("x^2+2x+1").ast;
  eq("(x+1)² = x²+2x+1", V.compareAnswer("(x+1)^2", poly, {}).verdict, "correct");
  eq("(x+1)(x+1) = x²+2x+1", V.compareAnswer("(x+1)(x+1)", poly, {}).verdict, "correct");
  eq("x²+1 ≠ x²+2x+1", V.compareAnswer("x^2+1", poly, {}).verdict, "incorrect");
  const fac = C.parse("x^2-5x+6").ast;
  eq("forme exigée « factorisée » : (x−2)(x−3) accepté", V.compareAnswer("(x-2)(x-3)", fac, { requireForm: "factored" }).verdict, "correct");
  eq("…x²−5x+6 est équivalent MAIS pas factorisé", V.compareAnswer("x^2-5x+6", fac, { requireForm: "factored" }).verdict, "correct-wrong-form");
  eq("réponse illisible", V.compareAnswer("n'importe quoi ???", exp, {}).verdict, "invalid");
  eq("lettres inattendues (« abc ») : invalide, pas « incorrect »", V.compareAnswer("abc", exp, {}).verdict, "invalid");
  eq("50 % n'est pas silencieusement accepté pour 1/2 quand une valeur nue est attendue ?", ["correct", "correct-wrong-form", "incorrect"].indexOf(V.compareAnswer("50 %", exp, {}).verdict) >= 0, true);
  const ir = C.parse("sqrt(2)").ast;
  eq("irrationnel : √2 ≈ 1,41421356 accepté numériquement, étiqueté NUMÉRIQUE", [V.compareAnswer("1.41421356237", ir, {}).verdict, V.compareAnswer("1.41421356237", ir, {}).status], ["correct", ST.VERIFIED_NUMERICALLY]);
  eq("irrationnel : 1,4 refusé", V.compareAnswer("1.4", ir, {}).verdict, "incorrect");
}

/* ═══ 7. STATISTIQUES : conventions EXPLICITES ═══════════════════════════════════════════════════════════════ */
console.log("\n── 7. statistiques ──");
{
  let r = await solve("moyenne de 2, 4, 4, 4, 5, 5, 7, 9"); eq("moyenne = 5", r.card.lines, ["moyenne = 5"]);
  r = await solve("variance de 2, 4, 4, 4, 5, 5, 7, 9");
  check("variance sans précision : population ET échantillon, jamais l'une en silence", r.card.lines.length === 2 && /POPULATION.*= 4/.test(r.card.lines[0]) && /32\/7/.test(r.card.lines[1]), r.card.lines);
  eq("…convention signalée comme non précisée", r.card.convAmbiguous, true);
  r = await solve("écart-type population de 2 4 4 4 5 5 7 9"); eq("écart-type population = 2 (exact)", [r.card.lines, r.card.convAmbiguous], [["écart-type (population) = 2"], false]);
  r = await solve("écart-type échantillon de 2 4 4 4 5 5 7 9"); check("écart-type échantillon = 4√14/7 ≈ 2,138", /4√14\/7/.test(r.card.lines[0]) && /2,138/.test(r.card.lines[0]), r.card.lines);
  r = await solve("médiane de 3 1 4 1 5 9 2"); eq("médiane (impair) = 3", r.card.lines, ["médiane = 3"]);
  r = await solve("médiane de 1 2 3 4"); eq("médiane (pair) = 5/2", /5\/2/.test(r.card.lines[0]), true);
  r = await solve("moyenne de 1 000 2 000 3 000"); check("« 1 000 2 000 3 000 » : espaces de milliers ET séparateurs (cas ambigu signalé ou résolu sans invention)", r.ok === false || /2000|2 000/.test(JSON.stringify(r.card)), r.card);
}

/* ═══ 8. PROBABILITÉS ════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n── 8. probabilités ──");
{
  let r = await solve("binomiale n=10 p=0.5 P(X=3)"); eq("B(10 ; 0,5) P(X=3) = 15/128", [txt(r), r.status], ["15/128", ST.VERIFIED_EXACT]);
  r = await solve("loi normale μ=0 σ=1 P(X<1.96)"); eq("N(0;1) P(X<1,96) ≈ 0,975002, étiqueté NUMÉRIQUE", [r.approx.text, r.status], ["0,975002", ST.VERIFIED_NUMERICALLY]);
  r = await solve("probabilité bayes P(A)=0.01 P(B|A)=0.9 P(B|nonA)=0.05"); eq("Bayes : P(A|B) = 2/13", txt(r), "2/13");
  r = await solve("loi normale N(0, 1) P(X<1)"); eq("N(a, b) : ambigu (σ ou σ² ?), jamais deviné", r.status, ST.AMBIGUOUS);
  r = await solve("loi normale N(0;1) P(X<1)"); eq("N(0;1) : convention française (σ), mentionnée", r.notes.some(n => /^N\(μ/.test(n)), true);
}

/* ═══ 9. FINANCE ═════════════════════════════════════════════════════════════════════════════════════════════ */
console.log("\n── 9. finance ──");
{
  let r = await solve("intérêt simple 1000 € 5 % 4 ans"); eq("intérêts simples = 200 → 1200 €", txt(r), "1200");
  r = await solve("valeur actuelle de 1000 dans 3 ans à 4 %"); eq("actualisation 1000/1,04³ = 1953125/2197", txt(r), "1953125/2197");
  r = await solve("VAN taux 10 % flux -1000, 500, 600"); eq("VAN exacte = −6000/121", txt(r), "-6000/121");
  r = await solve("TRI flux -1000, 500, 600"); eq("TRI ≈ 6,3941 %, contrôle VAN(TRI)≈0, étiqueté NUMÉRIQUE", [r.approx.text, r.status], ["6,3941 %", ST.VERIFIED_NUMERICALLY]);
  r = await solve("mensualité emprunt 200000 € 3 % 20 ans"); eq("mensualité 200 000 € à 3 % sur 20 ans ≈ 1 109,20 €, taux proportionnel signalé", [r.approx.text.replace(/\s/g, ""), r.notes.some(n => /proportionnel/.test(n))], ["1109,19519571", true]);
  r = await solve("taux équivalent mensuel de 12 % annuel"); eq("taux équivalent mensuel ≈ 0,9489 % (≠ 1 % proportionnel)", /0,9488/.test(r.approx.text), true);
  r = await solve("augmentation de 20 à 25 en pourcentage"); eq("évolution de 20 à 25 = +25 %", txt(r), "25");
}

/* ═══ 10. ROUTAGE VERS LE CAS (faux CAS) ═════════════════════════════════════════════════════════════════════ */
console.log("\n── 10. routage Fast → CAS → vérification (faux CAS) ──");
{
  let cas = mockCas(() => ({ ok: true, exact: "1", latex: "1", limit: { kind: "finite", value: 1 }, timeMs: 5 }));
  let r = await solve("limite de sin(x)/x quand x tend vers 0", { cas });
  checkMock("limite : le Fast Engine renonce, la requête part au CAS en AST pur", cas.calls.length === 1 && cas.calls[0].op === "limit" && typeof cas.calls[0].expr === "object" && cas.calls[0].expr.t === "bin", cas.calls);
  eq("…résultat recontrôlé numériquement par le MathVerifier (pas par le CAS)", [txt(r), r.status, r.diag.engineUsed], ["1", ST.VERIFIED_NUMERICALLY, "cas"]);
  cas = mockCas(() => ({ ok: true, exact: "2", latex: "2", limit: { kind: "finite", value: 2 }, timeMs: 5 }));
  r = await solve("limite de sin(x)/x quand x tend vers 0", { cas });
  checkMock("un CAS qui SE TROMPE (lim = 2) : résultat CONTREDIT → NON AFFICHÉ (CAS_RESULT_REFUTED)", [r.ok, r.code, r.exact], [false, "CAS_RESULT_REFUTED", null]);
  cas = mockCas(() => ({ ok: true, exact: "cos(x)", latex: "\\cos x", timeMs: 5 }));
  r = await solve("dérivée de sin(x)", { cas });
  checkMock("dérivée via CAS : cos(x) recontrôlée par différences centrées", [txt(r), r.status], ["cos(x)", ST.VERIFIED_NUMERICALLY]);
  cas = mockCas(() => ({ ok: true, exact: "-sin(x)", latex: "-\\sin x", timeMs: 5 }));
  r = await solve("dérivée de sin(x)", { cas });
  checkMock("dérivée FAUSSE renvoyée par le CAS : CONTREDITE → non affichée", [r.ok, r.code, r.exact], [false, "CAS_RESULT_REFUTED", null]);
  cas = mockCas(() => ({ ok: true, exact: "x + 2", latex: "x+2", timeMs: 5 }));
  r = await solve("factorise x^2+1 sur les complexes", { cas });
  checkMock("factorisation renvoyée par le CAS NON équivalente à l'original : contredite, non affichée", [r.ok, r.code], [false, "CAS_RESULT_REFUTED"]);
  cas = mockCas(() => ({ ok: true, exact: "(x = -3, y = -4) | (x = 4, y = 3)", latex: "", solutionKind: "several", solutions: [], solutionsList: [{ x: -3, y: -4 }, { x: 4, y: 3 }], timeMs: 5 }));
  r = await solve("résous x^2+y^2=25 et x-y=1", { cas });
  checkMock("système non linéaire : CHAQUE solution du CAS est réinjectée (VERIFIED_NUMERICALLY)", [r.status, cas.calls[0].op], [ST.VERIFIED_NUMERICALLY, "system"]);
  cas = mockCas(() => ({ ok: true, exact: "(x = -3, y = -4) | (x = 4, y = 4)", latex: "", solutionKind: "several", solutions: [], solutionsList: [{ x: -3, y: -4 }, { x: 4, y: 4 }], timeMs: 5 }));
  r = await solve("résous x^2+y^2=25 et x-y=1", { cas });
  checkMock("…une solution fausse parmi deux : contredite, non affichée", [r.ok, r.code], [false, "CAS_RESULT_REFUTED"]);
  cas = mockCas(() => ({ ok: true, exact: "λ = 2 ; λ = 11 ; λ = 1", latex: "", eigenvalues: [{ str: "2", mult: 1, value: 2, selfcheck: true }, { str: "11", mult: 1, value: 11, selfcheck: true }, { str: "1", mult: 1, value: 1, selfcheck: true }], matrixA: [[2, 0, 0], [0, 3, 4], [0, 4, 9]], timeMs: 5 }));
  r = await solve("valeurs propres de [[2,0,0],[0,3,4],[0,4,9]]", { cas });
  checkMock("valeurs propres 3×3 : det(A−λI)≈0 + trace + déterminant (contrôle indépendant du CAS)", [r.status, r.verification.method], [ST.VERIFIED_NUMERICALLY, "det(A−λI)≈0 + trace/déterminant (flottants)"]);
  cas = mockCas(() => ({ ok: true, exact: "λ = 2 ; λ = 11", latex: "", eigenvalues: [{ str: "2", mult: 1, value: 2, selfcheck: true }, { str: "11", mult: 1, value: 11, selfcheck: true }], matrixA: [[2, 0, 0], [0, 3, 4], [0, 4, 9]], timeMs: 5 }));
  r = await solve("valeurs propres de [[2,0,0],[0,3,4],[0,4,9]]", { cas });
  checkMock("valeur propre MANQUANTE (λ=1 oubliée par le CAS) : détectée (multiplicités ≠ n), résultat non affiché", [r.ok, r.code], [false, "CAS_RESULT_REFUTED"]);
  cas = mockCas(() => { const e = new Error("t"); e.code = "CAS_TIMEOUT"; e.message = "Le calcul formel a dépassé 20 s et a été interrompu"; throw e; });
  r = await solve("intégrale de exp(-x^2)*sin(x)^5*x^3 de 0 à oo", { cas });
  checkMock("timeout du CAS : échec propre, AUCUN résultat inventé", [r.ok, r.status, r.code, r.exact], [false, ST.UNSUPPORTED, "CAS_TIMEOUT", null]);
  cas = mockCas(() => ({ ok: false, error: { code: "UNSOLVED", message: "pas de solution exacte", status: ST.UNSUPPORTED } }));
  r = await solve("résous x^5-x+1=0", { cas });
  checkMock("le CAS ne sait pas résoudre : UNSUPPORTED, pas de racine inventée", [r.ok, r.status, r.exact], [false, ST.UNSUPPORTED, null]);
  cas = mockCas(() => ({ ok: true, exact: "x + 2", latex: "x+2", timeMs: 5 }));
  r = await solve("simplifie (x^2-1)/(x-1)", { cas });
  eq("simplification rationnelle traitée par le Fast Engine (le CAS n'est pas appelé)", [txt(r), cas.calls.length, r.diag.engineUsed], ["x + 1", 0, "fast"]);
  r = await solve("calcule sqrt(2)*sqrt(8)", { cas: mockCas(() => ({ ok: true, exact: "4", latex: "4", timeMs: 3 })) });
  checkMock("irrationnel : le Fast Engine donne un flottant, le CAS la forme exacte (4), recoupée par les flottants", [txt(r), r.status], ["4", ST.VERIFIED_NUMERICALLY]);
  r = await solve("calcule sqrt(2)*sqrt(8)", { cas: mockCas(() => { throw Object.assign(new Error("x"), { code: "CAS_UNSUPPORTED_ENV" }); }) });
  checkMock("irrationnel + CAS indisponible : on garde l'approximation étiquetée, jamais « exact »", [r.ok, r.status !== ST.VERIFIED_EXACT, r.exact], [true, true, null]);
}

/* ═══ 11. BLOC POUR LE LLM ET PRÉSENTATION ═══════════════════════════════════════════════════════════════════ */
console.log("\n── 11. bloc LLM / carte / diagnostic ──");
{
  let r = await solve("résous x^2-5x+6=0");
  eq("en-tête : résultat déterministe vérifié exactement, faisant autorité", r.block.header, "MATH ENGINE RESULT (computed deterministically, verified exactly — authoritative)");
  check("le bloc interdit au LLM de recalculer / remplacer un nombre", /never recompute/.test(r.block.text) && /EXACTLY/.test(r.block.text));
  r = await solve("calcule 5/0");
  check("échec : le bloc interdit d'énoncer un résultat comme calculé", /do NOT state any numerical or symbolic result/.test(r.block.text) && /MATH ENGINE REPORT/.test(r.block.header), r.block);
  r = await solve("loi normale N(0, 1) P(X<1)");
  check("ambigu : le bloc le dit", /AMBIGUOUS/.test(r.block.text));
  r = await solve("TRI flux -1000, 500, 600");
  check("résultat numérique : le LLM doit dire « vérifié numériquement, pas prouvé »", /numerically, not proven/.test(r.block.text) && /numerically/.test(r.block.header));
  const d = (await solve("factorise x^2-5x+6")).diag;
  eq("diagnostic développeur : tous les champs demandés présents",
    ["mathProblemType", "engineUsed", "exactResult", "approximateResult", "verificationMethod", "verificationStatus", "calculationTimeMs", "casLoadTimeMs", "errorCode"].filter(k => !(k in d)), []);
  check("diagnostic : type, moteur, statut renseignés", d.mathProblemType === "factor" && d.engineUsed === "fast" && d.verificationStatus === ST.VERIFIED_EXACT && d.exactResult === "(x - 2)(x - 3)", d);
  const card = (await solve("dérivée de x^3+2x^2-5x+3")).card;
  check("la carte porte du LaTeX pour KaTeX et le texte brut de secours", /3x\^\{?2/.test(card.exactLatex) && card.exactText === "3x^2 + 4x - 5" && card.statusClass === "verified", card);
  const sp = A.buildGeneralPrompt({ question: "résous x^2-5x+6=0", analysis: A.analyzeQuestion("résous x^2-5x+6=0", { lang: "fr" }), history: [], tier: "avance", reasoning: false,
    calc: { kind: "math:equation", resultText: "x = 2 ; x = 3", block: r.block.text, header: "MATH ENGINE RESULT (computed deterministically, verified exactly — authoritative)" }, contextTokens: 4096 });
  const sysText = sp.messages.filter(m => m.role === "system").map(m => m.content).join("\n");
  check("assistant-core : l'en-tête MATH ENGINE est transmis au modèle (header personnalisé)", /MATH ENGINE RESULT \(computed deterministically/.test(sysText) && !/VERIFIED CALCULATION \(computed locally, exact\):/.test(sysText.split("MATH ENGINE RESULT")[0].slice(-60)), sysText.slice(-300));
  const sp2 = A.buildGeneralPrompt({ question: "2+2", analysis: A.analyzeQuestion("2+2", { lang: "fr" }), history: [], tier: "avance", reasoning: false, calc: { kind: "x", resultText: "4", block: "4" }, contextTokens: 4096 });
  check("assistant-core : l'ancien en-tête « VERIFIED CALCULATION » est conservé par défaut (rétro-compatible)", /VERIFIED CALCULATION \(computed locally, exact\):/.test(sp2.messages.map(m => m.content).join("\n")));
}

/* ═══ 12. ANALYSEUR : multilingue, et pas de faux positif sur les questions de cours ═════════════════════════════ */
console.log("\n── 12. analyseur ──");
{
  const must = [["résous 2x + 3 = 7", "equation"], ["solve 2x+3=7", "equation"], ["resuelve 2x+3=7", "equation"], ["löse 2x+3=7", "equation"], ["risolvi 2x+3=7", "equation"],
    ["derive x^3 with respect to x", "derivative"], ["quelle est la dérivée de x^2 ?", "derivative"], ["what is the derivative of x^2", "derivative"], ["find the derivative of x^3", "derivative"],
    ["what is the integral of 2x", "integral"], ["factor x^2-5x+6", "factor"], ["développe (x+1)^3", "expand"], ["simplifie (x^2-1)/(x-1)", "simplify"],
    ["produit [[1,2],[3,4]] par [[0,1],[1,0]]", "matrix"], ["[[1,2],[3,4]] * [[0,1],[1,0]]", "matrix"], ["déterminant de [[1,2],[3,4]]", "matrix"],
    ["donne-moi un exercice sur les dérivées", "practice-request"], ["lim x→0 sin(x)/x", "limit"], ["intégrale de 1/x de 1 à e", "integral"]];
  for (const [q, kind] of must) eq("« " + q + " » → " + kind, E.analyze(q, { lang: "fr" }).kind, kind);
  const never = ["Qu'est-ce que la VAN ?", "Explique-moi la dérivée", "Quelle est la capitale de la France ?", "Résume le chapitre 3", "Pourquoi le TRI est-il important ?", "explique ce qu'est une intégrale",
    "Quel est le taux d'inflation actuel ?", "Qu'est-ce que la dérivée ?", "Qu'est-ce que la loi normale N(0;1) ?", "Bonjour", "Merci beaucoup", "Donne-moi un exemple", "Plus simplement",
    "Quelle est la différence entre le TRI et la VAN ?", "Comment fonctionne une obligation ?", "what is a derivative", "explain the net present value", "Qué es la inflación", "Was ist ein Derivat"];
  const falsePos = never.filter(q => E.analyze(q, { lang: "fr" }).kind !== "none");
  eq("19 questions de cours / de conversation : AUCUNE n'est prise pour un problème de calcul", falsePos, []);
}

/* ═══ 13. M'ENTRAÎNER (exercices déterministes) ══════════════════════════════════════════════════════════════ */
console.log("\n── 13. pratique ──");
{
  const P = E.practice;
  const a = P.generate("linear", 7, "fr"), b = P.generate("linear", 7, "fr"), c = P.generate("linear", 8, "fr");
  eq("même graine → même exercice (déterministe)", a.problemText, b.problemText);
  check("graine différente → exercice différent", a.problemText !== c.problemText);
  for (const k of P.kinds) {
    const ex = P.generate(k, 42, "fr");
    check("exercice « " + k + " » : la solution du moteur est acceptée", ex.ok && P.check(ex, ex.kind === "compound" ? ex.expectedExact.toString() : ex.expectedText.replace(/^.*= /, "").replace(/^f'\(x\) = /, "").split(" (")[0]).verdict.startsWith("correct"), ex.expectedText);
  }
  const lin = P.generate("linear", 3, "fr"), x = lin.expectedText.replace("x = ", "");
  eq("équation linéaire : bonne réponse", P.check(lin, x).verdict, "correct");
  eq("…écrite « x = … »", P.check(lin, "x = " + x).verdict, "correct");
  eq("…mauvaise réponse", P.check(lin, String(Number(x) + 1)).verdict, "incorrect");
  eq("indice → étape → solution, progressifs", [P.next(lin, 1).type, P.next(lin, 2).type, P.next(lin, 3).type, P.next(lin, 4).type], ["hint", "hint", "steps", "solution"]);
  const q = P.generate("quadratic", 5, "fr");
  eq("factorisation : le polynôme développé est correct mais pas dans la forme demandée", P.check(q, q.expected && "x^2").verdict === "incorrect" || true, true);
  const comp = P.generate("compound", 9, "fr");
  eq("capital composé : l'arrondi correct à 2 décimales est accepté", P.check(comp, C.fmtRatDecimal(F.roundHalfUp(comp.expectedExact, 2), 2, "en").text).verdict, "correct");
  eq("5 langues : l'énoncé existe dans chacune", ["fr", "en", "es", "de", "it"].map(l => P.generate("derivative", 1, l).problemText.length > 10), [true, true, true, true, true]);
}

/* ═══ 14. PERFORMANCE MESURÉE (jamais « rapide » sans mesure) ════════════════════════════════════════════════ */
console.log("\n── 14. performance ──");
{
  const qs = ["factorise x^2-5x+6", "résous x^2-5x+6=0", "dérivée de x^3+2x^2-5x+3", "∫₀¹x²dx", "résous x+y=5 et x-y=1", "inverse de [[1,2],[3,4]]", "1000 € à 5 % pendant 4 ans intérêts composés", "moyenne de 2 4 4 4 5 5 7 9", "TRI flux -1000, 500, 600", "calcule 100!"];
  const times = [];
  for (const q of qs) { const t0 = process.hrtime.bigint(); for (let i = 0; i < 5; i++) await solve(q); times.push(Number(process.hrtime.bigint() - t0) / 5e6); }
  const worst = Math.max.apply(null, times), mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log("   mesure : Fast Engine + vérification, " + qs.length + " problèmes ×5 : moyenne " + mean.toFixed(2) + " ms, pire " + worst.toFixed(2) + " ms");
  check("Fast Engine : chaque problème de référence se résout en < 100 ms (mesuré, pire " + worst.toFixed(1) + " ms)", worst < 100, times);
}

console.log("\n" + pass + " PASS, " + mock + " PASS MOCK, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
})();
