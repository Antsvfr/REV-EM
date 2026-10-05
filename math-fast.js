/* ============================================================================
   math-fast.js — le FAST MATH ENGINE de REV-EM (pur, instantané, EXACT)
   ----------------------------------------------------------------------------
   `globalThis.RevemMath.fast` — dépend seulement de math-core.js. Aucun chargement lourd :
   c'est lui qui répond à « 2 + 2 », aux pourcentages, aux statistiques, à la finance, aux
   polynômes à une variable, aux systèmes linéaires et aux petites matrices.

   Tout est calculé en RATIONNELS EXACTS (BigInt) : 1/3 reste 1/3, 1000 × 1,05⁴ = 194481/160 =
   1215,50625 « avant arrondi ». On n'arrondit qu'à l'affichage.

   Chaque fonction renvoie  { ok:true, kind, engine:"fast", exact, approx, verification, steps,
   notes, lines, … }  ou  { ok:false, status, code, message }. Le résultat porte SA vérification :
   une méthode INDÉPENDANTE du calcul lui-même (substitution, produit inverse, formule alternative…).
   Une vérification numérique n'est JAMAIS présentée comme une preuve (statut VERIFIED_NUMERICALLY).

   Ce qui dépasse le Fast Engine (trigonométrie, logarithmes, limites, intégrales non polynomiales,
   plusieurs variables, valeurs propres 3×3…) renvoie { ok:false, code:"NEEDS_CAS" } : l'appelant
   bascule vers le CAS (math-cas-*.js) ; il n'invente JAMAIS un résultat.
   ============================================================================ */
(function(global){
  "use strict";
  var NS = global.RevemMath = global.RevemMath || {};
  var C = NS.core;
  if(!C) throw new Error("math-fast.js : charger math-core.js d'abord");

  var Rat = C.Rat, rat = C.rat, STATUS = C.STATUS, poly = C.poly;
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2);
  var R0 = rat(0), R1 = rat(1);

  /* ── helpers de résultat ────────────────────────────────────────────────── */
  function failRes(status, code, message, extra){ return Object.assign({ ok: false, engine: "fast", status: status, code: code, message: message }, extra || {}); }
  function needsCAS(why){ return failRes(STATUS.UNSUPPORTED, "NEEDS_CAS", why || "hors du Fast Engine"); }
  function fromError(e){
    if(e && e.name === "MathError"){
      if(e.code === "IRRATIONAL" || e.code === "UNBOUND") return needsCAS(e.message);
      var st = e.code === "AMBIGUOUS" ? STATUS.AMBIGUOUS : (e.code === "TOO_COMPLEX" || e.code === "UNSUPPORTED" ? STATUS.UNSUPPORTED : STATUS.INVALID_INPUT);
      return failRes(st, e.code, e.message);
    }
    return failRes(STATUS.INVALID_INPUT, "INTERNAL", String(e && e.message || e));
  }
  function verif(status, method, detail){ return { status: status, method: method, detail: detail || "" }; }
  function ratText(r){ return r.toString(); }
  function latexRat(r){ return C.toLatex(C.qnode(r)); }
  function dec(r, digits, lang){ return C.fmtRatDecimal(r, digits === undefined ? 6 : digits, lang || "fr"); }
  function decStr(r, digits, lang){ return dec(r, digits, lang).text; }
  function roundHalfUp(r, dp){                      // arrondi « moitié vers le haut » EXACT à dp décimales (finance)
    var f = rat(1).mul(new Rat(BigInt(10) ** BigInt(dp)));
    var scaled = r.mul(f), neg = scaled.sign() < 0, a = scaled.abs();
    var q = a.n / a.d, rem = a.n % a.d;
    if(rem * TWO >= a.d) q += ONE;
    var out = new Rat(neg ? -q : q, f.n);
    return out;
  }
  function ratFromNode(n){ return C.evalExact(n, {}); }
  /* Présentation d'un rationnel : exact (fraction ou entier) + décimal localisé. */
  function presentRat(r, o){
    o = o || {};
    var lang = o.lang || "fr", digits = o.digits === undefined ? 6 : o.digits;
    var d = dec(r, digits, lang);
    return { exactText: ratText(r), exactLatex: latexRat(r), decimalText: d.text, decimalExact: d.exact, isInt: r.isInt() };
  }
  function approxOf(r, digits, lang){
    if(r.isInt()) return null;
    var d = dec(r, digits === undefined ? 6 : digits, lang);
    return { text: d.text, exactDecimal: d.exact, value: r.toNumber() };
  }

  /* ═══ 1. ARITHMÉTIQUE EXACTE ═══════════════════════════════════════════════ */
  function arithmetic(ast, o){
    o = o || {};
    try{
      if(C.freeVars(ast).length) return needsCAS("variables libres");
      var exact = null, approxF = null;
      try{ exact = C.evalExact(ast, {}); }
      catch(e){ if(!(e && e.name === "MathError" && e.code === "IRRATIONAL")) throw e; }
      if(exact){
        var f, ef, close, floatSkipped = false;
        try{ f = C.evalFloat(ast, {}); ef = exact.toNumber(); close = Math.abs(f - ef) <= 1e-9 * Math.max(1, Math.abs(ef)); }
        catch(e){ if(!(e && e.name === "MathError" && (e.code === "OVERFLOW" || e.code === "TOO_COMPLEX"))) throw e; close = true; floatSkipped = true; }   // hors de la plage des flottants : l'exact BigInt reste valable
        var p = presentRat(exact, o), ap = approxOf(exact, o.digits, o.lang);
        return { ok: true, kind: "arithmetic", engine: "fast", value: exact, exact: { text: p.exactText, latex: p.exactLatex }, approx: ap,
                 decimal: p.decimalText, decimalExact: p.decimalExact,
                 verification: close ? verif(STATUS.VERIFIED_EXACT, floatSkipped ? "exact-rational" : "exact-rational+float-crosscheck", floatSkipped ? "rationnels BigInt (hors de la plage des flottants : pas de recoupement flottant)" : "rationnels BigInt, recoupés par un second calcul en flottants")
                                     : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "float-crosscheck-failed", "écart entre exact et flottant"),
                 steps: [C.toText(ast) + " = " + p.exactText + (p.isInt ? "" : (p.decimalExact ? " = " : " ≈ ") + p.decimalText)], notes: [] };
      }
      // irrationnel (√2, π, sin 1…) : pas d'exact au Fast Engine ; flottant ÉTIQUETÉ approximatif, et le CAS peut donner l'exact symbolique
      approxF = C.evalFloat(ast, {});
      return { ok: true, kind: "arithmetic", engine: "fast", value: null, exact: null, needsCAS: true,
               approx: { text: C.fmtFloat(approxF, o.digits === undefined ? 10 : o.digits, o.lang || "fr"), value: approxF, exactDecimal: false },
               decimal: C.fmtFloat(approxF, 10, o.lang || "fr"),
               verification: verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "float-only", "valeur irrationnelle : approximation en double précision, forme exacte via le CAS"),
               steps: [C.toText(ast) + " ≈ " + C.fmtFloat(approxF, 10, o.lang || "fr")], notes: ["irrational"] };
    }catch(e){ return fromError(e); }
  }

  /* ═══ 2. POLYNÔMES À UNE VARIABLE ═════════════════════════════════════════ */
  function divisors(nBig){
    nBig = nBig < ZERO ? -nBig : nBig;
    if(nBig === ZERO) return null;
    if(nBig > BigInt("1000000000000")) return null;
    var n = Number(nBig), out = [], i;
    for(i = 1; i * i <= n; i++){ if(n % i === 0){ out.push(BigInt(i)); if(i * i !== n) out.push(BigInt(n / i)); } }
    return out;
  }
  function lcmBig(a, b){ var g = a, h = b, t; while(h !== ZERO){ t = g % h; g = h; h = t; } return a / g * b; }
  function polyScaleToInt(p){                       // → coefficients entiers (BigInt) proportionnels
    var l = ONE; p.forEach(function(c){ l = lcmBig(l, c.d); });
    return p.map(function(c){ return c.n * (l / c.d); });
  }
  function divideByLinear(p, r){                    // p(x) = (x − r) q(x) + reste ; division synthétique exacte
    var n = p.length - 1, q = new Array(n), carry = R0, i;
    for(i = n; i >= 1; i--){ carry = p[i].add(carry.mul(r)); q[i - 1] = carry; }
    return { q: q, rem: p[0].add(carry.mul(r)) };
  }
  /* Racines rationnelles (théorème des racines rationnelles) ; renvoie { roots:[{r, mult}], rest:Poly, complete } */
  function rationalRoots(p){
    p = poly.trim(p);
    var roots = [], rest = p.slice(), complete = true;
    var zeros = 0; while(rest.length > 1 && rest[0].isZero()){ rest.shift(); zeros++; }
    if(zeros) roots.push({ r: R0, mult: zeros });
    var guard = 0;
    while(rest.length > 2 && guard++ < 40){
      var ints = polyScaleToInt(rest), a0 = ints[0], an = ints[ints.length - 1];
      var d0 = divisors(a0), dn = divisors(an);
      if(!d0 || !dn || d0.length * dn.length > 40000){ complete = false; break; }
      var found = null, i, j, sg;
      outer:
      for(i = 0; i < d0.length; i++) for(j = 0; j < dn.length; j++) for(sg = 0; sg < 2; sg++){
        var cand = new Rat(sg ? -d0[i] : d0[i], dn[j]);
        if(poly.eval(rest, cand).isZero()){ found = cand; break outer; }
      }
      if(!found) break;
      var dv = divideByLinear(rest, found);
      rest = poly.trim(dv.q);
      var idx = -1; roots.forEach(function(x, k){ if(x.r.eq(found)) idx = k; });
      if(idx >= 0) roots[idx].mult++; else roots.push({ r: found, mult: 1 });
    }
    return { roots: roots, rest: rest, complete: complete };
  }

  /* Racines d'un trinôme a x² + b x + c : formes EXACTES u + v√rad (ou u + v·i√rad), vérifiées dans Q(√D). */
  function quadraticRoots(a, b, c){
    var D = b.mul(b).sub(rat(4).mul(a).mul(c)), twoA = rat(2).mul(a), u = b.neg().div(twoA);
    if(D.isZero()) return { kind: "double", D: D, roots: [{ u: u, v: R0, rad: ONE, complex: false }] };
    var neg = D.sign() < 0, sr = C.sqrtRat(neg ? D.neg() : D);        // √|D| = coef·√rad
    var v = sr.coef.div(twoA);
    if(sr.rad === ONE && !neg){
      return { kind: "rational", D: D, roots: [{ u: u.sub(v), v: R0, rad: ONE, complex: false }, { u: u.add(v), v: R0, rad: ONE, complex: false }] };
    }
    var t = [{ u: u, v: v.neg(), rad: sr.rad, complex: neg }, { u: u, v: v, rad: sr.rad, complex: neg }];
    // ordre croissant des parties réelles pour les racines réelles
    if(!neg && v.sign() < 0) t.reverse();
    return { kind: neg ? "complex" : "surd", D: D, roots: t };
  }
  /* a r² + b r + c dans Q(s), s² = D (D<0 : s = i√|D|) : renvoie [partie rationnelle, coefficient de s]. */
  function quadResidual(a, b, c, root){
    var s2 = root.complex ? new Rat(-root.rad) : new Rat(root.rad), u = root.u, v = root.v;
    var re = a.mul(u.mul(u).add(v.mul(v).mul(s2))).add(b.mul(u)).add(c);
    var im = rat(2).mul(a).mul(u).mul(v).add(b.mul(v));
    return [re, im];
  }
  function rootDisplay(root, lang){
    var u = root.u, v = root.v, rad = root.rad, cx = root.complex;
    var absV = v.abs(), sign = v.sign();
    if(v.isZero()) return { text: ratText(u), latex: latexRat(u), approx: u.toNumber(), re: u.toNumber(), im: 0 };
    var radTxt = (rad === ONE ? "" : "√" + rad.toString()), radTex = (rad === ONE ? "" : "\\sqrt{" + rad.toString() + "}");
    var unit = cx ? "i" : "";
    var core = (cx ? "i" : "") + radTxt; if(!cx && rad === ONE) core = "";
    var den = lcmBig(u.d, v.d), P = u.n * (den / u.d), Q = absV.n * (den / absV.d);
    var qTxt = (Q === ONE && core !== "") ? "" : Q.toString();
    var coreTex = (cx ? "i" : "") + radTex;
    var sg = sign < 0 ? "-" : "+";
    var numTxt = (P === ZERO ? (sign < 0 ? "-" : "") : P.toString() + " " + sg + " ") + qTxt + core;
    var numTex = (P === ZERO ? (sign < 0 ? "-" : "") : P.toString() + " " + sg + " ") + (Q === ONE && coreTex !== "" ? "" : Q.toString()) + coreTex;
    var text = den === ONE ? numTxt : (P === ZERO ? numTxt : "(" + numTxt + ")") + "/" + den.toString();
    if(den !== ONE && P === ZERO) text = numTxt + "/" + den.toString();
    var latex = den === ONE ? numTex : "\\frac{" + numTex + "}{" + den.toString() + "}";
    var re = u.toNumber(), imag = cx ? sign * absV.toNumber() * Math.sqrt(Number(rad)) : 0;
    var real = cx ? re : re + sign * absV.toNumber() * Math.sqrt(Number(rad));
    return { text: text.replace(/\+ -/g, "- "), latex: latex, approx: cx ? { re: re, im: imag } : real, re: real, im: imag };
  }

  function linesOfEquation(){ return []; }

  /* Équation polynomiale en `v` : degré ≤ 2 (formules exactes) ou racines rationnelles + reste ≤ 2. */
  function solveEquation(eqAst, v, o){
    o = o || {};
    try{
      var lhs, rhs;
      if(eqAst.t === "eq"){ lhs = eqAst.l; rhs = eqAst.r; } else { lhs = eqAst; rhs = C.mkq(0); }
      var vars = C.freeVars({ t: "eq", l: lhs, r: rhs });
      if(!v) v = vars.length === 1 ? vars[0] : (vars.indexOf("x") >= 0 ? "x" : vars[0]);
      if(vars.length > 1 && !(vars.length === 1)) return needsCAS("plusieurs variables");
      if(!v) return failRes(STATUS.INVALID_INPUT, "NO_VARIABLE", "aucune inconnue");
      var pl = poly.fromAst(lhs, v), pr = poly.fromAst(rhs, v);
      if(!pl || !pr) return needsCAS("équation non polynomiale");
      var p = poly.sub(pl, pr), deg = poly.degree(p);
      if(deg === -Infinity) return { ok: true, kind: "equation", engine: "fast", variable: v, solutionKind: "all-reals", solutions: [], exact: { text: "tout réel", latex: "\\mathbb{R}" }, approx: null,
                                   verification: verif(STATUS.VERIFIED_EXACT, "polynomial-identity", "0 = 0 : identité"), steps: ["l'équation se réduit à 0 = 0"], notes: [], poly: p };
      if(deg === 0) return { ok: true, kind: "equation", engine: "fast", variable: v, solutionKind: "none", solutions: [], exact: { text: "aucune solution", latex: "\\varnothing" }, approx: null,
                             verification: verif(STATUS.VERIFIED_EXACT, "polynomial-identity", "constante non nulle = 0 : impossible"), steps: ["l'équation se réduit à " + ratText(p[0]) + " = 0"], notes: [], poly: p };
      var sols = [], steps = [], status = STATUS.VERIFIED_EXACT, method = "substitution-exacte", detail = [], multiple = false;
      var rr = rationalRoots(p), rest = rr.rest, restDeg = poly.degree(rest);
      if(restDeg > 2 || (!rr.complete && restDeg >= 2 && restDeg > 2)) return needsCAS("degré > 2 sans racines rationnelles suffisantes");
      var allRoots = [];
      rr.roots.forEach(function(x){ allRoots.push({ kind: "rational", u: x.r, v: R0, rad: ONE, complex: false, mult: x.mult }); });
      if(restDeg === 2){
        var q = quadraticRoots(rest[2], rest[1], rest[0]);
        q.roots.forEach(function(x){ allRoots.push(Object.assign({ kind: q.kind === "rational" ? "rational" : q.kind, mult: q.kind === "double" ? 2 : 1 }, x)); });
        steps.push("trinôme : Δ = " + ratText(q.D) + (q.D.sign() > 0 ? " > 0" : (q.D.isZero() ? " = 0" : " < 0")));
      } else if(restDeg === 1){
        allRoots.push({ kind: "rational", u: rest[0].neg().div(rest[1]), v: R0, rad: ONE, complex: false, mult: 1 });
      }
      // vérification EXACTE par substitution (dans Q(√D) pour les racines irrationnelles ou complexes)
      var coeffsOK = true;
      allRoots.forEach(function(x){
        var res;
        if(x.v.isZero()) res = poly.eval(p, x.u).isZero();
        else {
          // p(r) calculé coefficient par coefficient dans Q(s)
          var s2 = x.complex ? new Rat(-x.rad) : new Rat(x.rad), accRe = R0, accIm = R0;
          for(var i = p.length - 1; i >= 0; i--){          // Horner dans Q(s)
            var nre = accRe.mul(x.u).add(accIm.mul(x.v).mul(s2)).add(p[i]);
            var nim = accRe.mul(x.v).add(accIm.mul(x.u));
            accRe = nre; accIm = nim;
          }
          res = accRe.isZero() && accIm.isZero();
        }
        if(!res) coeffsOK = false;
      });
      if(!coeffsOK){ status = STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED; method = "substitution-failed"; }
      // doublons (racines multiples) : une seule entrée, multiplicité notée
      var merged = [];
      allRoots.forEach(function(x){
        var same = merged.filter(function(m){ return m.kind === x.kind && m.complex === x.complex && m.u.eq(x.u) && m.v.eq(x.v) && String(m.rad) === String(x.rad); })[0];
        if(same) same.mult = (same.mult || 1) + (x.mult || 1); else merged.push(x);
      });
      allRoots = merged;
      if(allRoots.some(function(x){ return (x.mult || 1) > 1; })) multiple = true;
      allRoots.forEach(function(x){
        var d = rootDisplay(x, o.lang);
        sols.push({ text: d.text, latex: d.latex, approx: d.approx, kind: x.kind, mult: x.mult || 1, real: !x.complex, re: d.re, im: d.im });
      });
      var realSols = sols.filter(function(s){ return s.real; });
      var cplx = sols.filter(function(s){ return !s.real; });
      realSols.sort(function(a, b){ return a.re - b.re; });
      if(o.domain === "real"){                                                           // l'élève a demandé les solutions RÉELLES : on ne montre pas les complexes
        if(!realSols.length) return { ok: true, kind: "equation", engine: "fast", variable: v, degree: deg, solutionKind: "none", solutions: [], exact: { text: "aucune solution réelle", latex: "\\varnothing" }, approx: null,
                                      verification: verif(status, method, "toutes les racines (complexes) ont été réinjectées ; aucune n'est réelle"), steps: steps.concat(["équation ramenée à " + polyToText(p, v) + " = 0"]), notes: ["no-real-solution"], poly: p };
        cplx = [];
      }
      var all = realSols.concat(cplx);
      var text = all.map(function(s){ return v + " = " + s.text; }).join(" ; ");
      var latex = all.map(function(s){ return v + " = " + s.latex; }).join(",\\; ");
      var notes = multiple ? ["multiple-root"] : [];
      if(!realSols.length && cplx.length) notes.push("no-real-solution");
      if(cplx.length) notes.push("complex-solutions");
      var approxTxt = all.filter(function(s){ return s.kind === "surd"; }).map(function(s){ return v + " ≈ " + C.fmtFloat(s.re, 6, o.lang || "fr"); }).join(" ; ");
      return { ok: true, kind: "equation", engine: "fast", variable: v, degree: deg, solutionKind: "points", solutions: all,
               exact: { text: text, latex: latex }, approx: approxTxt ? { text: approxTxt, value: null } : null,
               verification: verif(status, method, "chaque solution est réinjectée dans l'équation, calcul exact" + (coeffsOK ? "" : " : ÉCHEC")),
               steps: steps.concat(["équation ramenée à " + polyToText(p, v) + " = 0"]), notes: notes, poly: p };
    }catch(e){ return fromError(e); }
  }

  /* texte / LaTeX d'un polynôme (coefficients rationnels) */
  function polyToText(p, v){
    var out = "", i, first = true;
    for(i = p.length - 1; i >= 0; i--){
      var c = p[i]; if(c.isZero() && p.length > 1) continue;
      var neg = c.sign() < 0, a = c.abs(), body;
      var cs = a.eq(R1) && i > 0 ? "" : (a.isInt() ? a.toString() : "(" + a.toString() + ")");
      var vs = i === 0 ? "" : (i === 1 ? v : v + "^" + i);
      body = cs + vs; if(!body) body = a.toString();
      if(first){ out += (neg ? "-" : "") + body; first = false; } else out += (neg ? " - " : " + ") + body;
    }
    return out || "0";
  }
  function polyToLatex(p, v){
    var out = "", i, first = true;
    for(i = p.length - 1; i >= 0; i--){
      var c = p[i]; if(c.isZero() && p.length > 1) continue;
      var neg = c.sign() < 0, a = c.abs();
      var cs = a.eq(R1) && i > 0 ? "" : (a.isInt() ? a.toString() : latexRat(a));
      var vs = i === 0 ? "" : (i === 1 ? v : v + "^{" + i + "}");
      var body = cs + vs; if(!body) body = a.toString();
      if(first){ out += (neg ? "-" : "") + body; first = false; } else out += (neg ? " - " : " + ") + body;
    }
    return out || "0";
  }
  function linearFactorTextLatex(r, v){            // (x − r)
    if(r.isZero()) return { t: v, l: v };
    var neg = r.sign() > 0;                         // x − r avec r > 0 ; x + |r| sinon
    var a = r.abs(), at = a.isInt() ? a.toString() : "(" + a.toString() + ")", al = a.isInt() ? a.toString() : latexRat(a);
    return { t: "(" + v + (neg ? " - " : " + ") + at + ")", l: "\\left(" + v + (neg ? " - " : " + ") + al + "\\right)" };
  }

  /* ═══ 3. FACTORISER / DÉVELOPPER / DÉRIVER / INTÉGRER (polynômes) ══════════ */
  function factorPoly(ast, v, o){
    o = o || {};
    try{
      var vars = C.freeVars(ast); v = v || vars[0];
      if(vars.length > 1) return needsCAS("plusieurs variables");
      if(!v) return failRes(STATUS.INVALID_INPUT, "NO_VARIABLE", "pas de variable : rien à factoriser");
      var p = poly.fromAst(ast, v); if(!p) return needsCAS("expression non polynomiale");
      if(poly.degree(p) < 1) return failRes(STATUS.INVALID_INPUT, "NOT_POLYNOMIAL_IN_VAR", "pas de variable à factoriser");
      var lead = p[p.length - 1], rr = rationalRoots(p), rest = rr.rest, restDeg = poly.degree(rest);
      if(restDeg === 1){                                       // le dernier facteur linéaire est une racine rationnelle de plus
        var rl = rest[1], r1x = rest[0].neg().div(rl), dupIdx = -1;
        rr.roots.forEach(function(x, k){ if(x.r.eq(r1x)) dupIdx = k; });
        if(dupIdx >= 0) rr.roots[dupIdx].mult++; else rr.roots.push({ r: r1x, mult: 1 });
        rest = [rl]; restDeg = 0;
      }
      if(!rr.complete && restDeg >= 3) return needsCAS("facteurs rationnels non déterminés");
      if(restDeg >= 4) return needsCAS("facteur irréductible de degré ≥ 4 à examiner");
      var partsT = [], partsL = [], prod = [R1], denProd = R1;
      rr.roots.forEach(function(x){
        var f, lin;
        if(x.r.isInt()){ f = linearFactorTextLatex(x.r, v); lin = [x.r.neg(), R1]; }
        else {                                                    // racine p/q : facteur à coefficients ENTIERS (qx − p), le 1/q passe dans la constante globale
          lin = [new Rat(-x.r.n, ONE), new Rat(x.r.d, ONE)];
          f = { t: "(" + polyToText(lin, v) + ")", l: "\\left(" + polyToLatex(lin, v) + "\\right)" };
        }
        partsT.push(f.t + (x.mult > 1 ? "^" + x.mult : "")); partsL.push(f.l + (x.mult > 1 ? "^{" + x.mult + "}" : ""));
        for(var k = 0; k < x.mult; k++){ prod = poly.mul(prod, lin); if(!x.r.isInt()) denProd = denProd.mul(new Rat(x.r.d, ONE)); }
      });
      var restLead = rest[rest.length - 1], constant = lead.div(restLead.isZero() ? R1 : restLead);
      var restFactorT = null;
      if(restDeg >= 1){
        // facteur résiduel (degré 2 ou 3 sans racine rationnelle : irréductible sur Q) — rendu monique + constante globale
        var monic = rest.map(function(c){ return c.div(restLead); });
        var integral = polyScaleToInt(monic), g = integral.reduce(function(a, b){ var x = a < ZERO ? -a : a, y = b < ZERO ? -b : b; while(y !== ZERO){ var t = x % y; x = y; y = t; } return x; }, ZERO);
        var prim = integral.map(function(c){ return new Rat(c / g); });
        // constante globale = lead(p) / lead(prim) × ... on garde p = lead × Π(x−r) × (rest/restLead)
        restFactorT = "(" + polyToText(monic, v) + ")";
        partsT.push(restFactorT); partsL.push("\\left(" + polyToLatex(monic, v) + "\\right)");
        prod = poly.mul(prod, monic);
        constant = lead.div(denProd);                   // p = (lead / Π q) × Π(qx − p) × monic(rest)
      } else constant = lead.div(denProd);
      // reconstruction EXACTE : constante × produit = p ?
      var rebuilt = prod.map(function(c){ return c.mul(constant); });
      var okExact = poly.eq(rebuilt, p);
      var cT = constant.eq(R1) ? "" : (constant.eq(rat(-1)) ? "-" : (constant.isInt() ? constant.toString() : "(" + constant.toString() + ")"));
      var cL = constant.eq(R1) ? "" : (constant.eq(rat(-1)) ? "-" : (constant.isInt() ? constant.toString() : latexRat(constant)));
      var text = cT + partsT.join(""), latex = cL + partsL.join("");
      if(partsT.length === 1 && restFactorT && cT === "" && !rr.roots.length){ text = restFactorT.slice(1, -1); latex = partsL[0].replace(/^\\left\(/, "").replace(/\\right\)$/, ""); }
      var irreducibleNote = restDeg >= 2 ? ["irreducible-factor-over-Q"] : [];
      return { ok: true, kind: "factor", engine: "fast", variable: v, exact: { text: text, latex: latex }, approx: null,
               verification: okExact ? verif(STATUS.VERIFIED_EXACT, "expansion-exacte", "le produit des facteurs redéveloppé redonne exactement le polynôme de départ")
                                      : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "expansion-failed", "écart après redéveloppement"),
               steps: ["polynôme : " + polyToText(p, v), "racines rationnelles : " + (rr.roots.length ? rr.roots.map(function(x){ return v + " = " + ratText(x.r) + (x.mult > 1 ? " (×" + x.mult + ")" : ""); }).join(", ") : "aucune")],
               notes: irreducibleNote, poly: p };
    }catch(e){ return fromError(e); }
  }

  function expandPoly(ast, v){
    try{
      var vars = C.freeVars(ast); v = v || vars[0];
      if(vars.length > 1) return needsCAS("plusieurs variables");
      if(!v){ return arithmetic(ast); }
      var p = poly.fromAst(ast, v); if(!p) return needsCAS("expression non polynomiale");
      // vérification indépendante : évaluation du polynôme développé = évaluation de l'expression de départ, en 7 points rationnels
      var pts = [rat(0), rat(1), rat(-1), rat(2), rat(-3), rat(1, 2), rat(7, 3)], ok = true, i;
      for(i = 0; i < pts.length; i++){ var env = {}; env[v] = pts[i]; var a; try{ a = C.evalExact(ast, env); }catch(e){ ok = null; break; } if(!a.eq(poly.eval(p, pts[i]))) ok = false; if(!ok) break; }
      return { ok: true, kind: "expand", engine: "fast", variable: v, exact: { text: polyToText(p, v), latex: polyToLatex(p, v) }, approx: null,
               verification: ok === true ? verif(STATUS.VERIFIED_EXACT, "evaluation-exacte-en-7-points", "même valeur exacte en 7 points rationnels (deux polynômes de degré ≤ 6 égaux en 7 points sont identiques)")
                                         : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "evaluation-skipped", "évaluation de contrôle impossible"),
               steps: ["développement : " + polyToText(p, v)], notes: [], poly: p };
    }catch(e){ return fromError(e); }
  }

  function derivativePoly(ast, v){
    try{
      var vars = C.freeVars(ast); v = v || vars[0] || "x";
      if(vars.length > 1) return needsCAS("plusieurs variables");
      var p = poly.fromAst(ast, v); if(!p) return needsCAS("fonction non polynomiale");
      var d = poly.deriv(p);
      // vérification indépendante : l'intégrale de la dérivée retrouve p à la constante près (autre chemin de calcul)
      var back = poly.integral(d); back[0] = p[0];
      var okExact = poly.eq(back, p);
      // + contrôle numérique local par différences centrées
      var numOK = true, h = 1e-6, pts = [-2, -0.5, 0.7, 1.5, 3];
      pts.forEach(function(x0){ var f = function(x){ return poly.eval(p, rat(0).add(ratFromFloat(x))).toNumber(); }; var nd = (f(x0 + h) - f(x0 - h)) / (2 * h), ex = poly.eval(d, ratFromFloat(x0)).toNumber(); if(Math.abs(nd - ex) > 1e-4 * Math.max(1, Math.abs(ex))) numOK = false; });
      return { ok: true, kind: "derivative", engine: "fast", variable: v, exact: { text: polyToText(d, v), latex: polyToLatex(d, v) }, approx: null,
               verification: okExact && numOK ? verif(STATUS.VERIFIED_EXACT, "primitive-de-la-dérivée+différences-centrées", "∫ f′ = f − f(0) exact ; différences centrées concordantes en 5 points")
                                              : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: ["f(" + v + ") = " + polyToText(p, v), "règle : (a·" + v + "ⁿ)′ = n·a·" + v + "ⁿ⁻¹ ; la dérivée d'une constante est 0"], notes: [], poly: d, source: p };
    }catch(e){ return fromError(e); }
  }
  function ratFromFloat(x){                           // pour les points de test seulement (rationnel exact du double)
    var s = x.toString(); if(/e/i.test(s)) return rat(Math.round(x * 1e6), 1000000);
    var m = /^(-?)(\d+)\.?(\d*)$/.exec(s); if(!m) return rat(0);
    var den = BigInt(10) ** BigInt(m[3].length);
    return new Rat(BigInt((m[1] || "") + m[2] + m[3]), den);
  }

  function integralPoly(ast, v, bounds){
    try{
      var vars = C.freeVars(ast).filter(function(x){ return x !== v; }); v = v || C.freeVars(ast)[0] || "x";
      if(vars.length) return needsCAS("paramètres libres");
      var p = poly.fromAst(ast, v); if(!p) return needsCAS("fonction non polynomiale");
      var F = poly.integral(p);
      var checkOK = poly.eq(poly.deriv(F), p);        // F′ = f exactement
      if(!bounds){
        return { ok: true, kind: "integral", engine: "fast", variable: v, definite: false,
                 exact: { text: polyToText(F, v) + " + C", latex: polyToLatex(F, v) + " + C" }, approx: null,
                 verification: checkOK ? verif(STATUS.VERIFIED_EXACT, "dérivation-de-la-primitive", "F′ = f vérifié exactement (coefficient par coefficient)") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
                 steps: ["primitive : " + polyToText(F, v) + " + C", "règle : ∫ " + v + "ⁿ d" + v + " = " + v + "ⁿ⁺¹/(n+1) + C"], notes: ["constant-of-integration"], poly: F };
      }
      var a = C.evalExact(bounds[0], {}), b = C.evalExact(bounds[1], {});
      var val = poly.eval(F, b).sub(poly.eval(F, a));
      // vérification indépendante : quadrature de Gauss-Legendre (flottants) — NUMÉRIQUE, pas une preuve
      var q = gaussLegendre(function(x){ return poly.eval(p, ratFromFloat(x)).toNumber(); }, a.toNumber(), b.toNumber());
      var close = Math.abs(q - val.toNumber()) <= 1e-9 * Math.max(1, Math.abs(val.toNumber()));
      return { ok: true, kind: "integral", engine: "fast", variable: v, definite: true, value: val, exact: { text: ratText(val), latex: latexRat(val) },
               approx: approxOf(val, 8, "fr"),
               verification: checkOK && close ? verif(STATUS.VERIFIED_EXACT, "primitive-exacte+Gauss-Legendre", "F(b) − F(a) exact ; F′ = f exact ; quadrature numérique concordante")
                                              : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: ["F(" + v + ") = " + polyToText(F, v), "F(" + C.toText(bounds[1]) + ") − F(" + C.toText(bounds[0]) + ") = " + ratText(val)], notes: [], poly: F };
    }catch(e){ return fromError(e); }
  }
  /* Gauss-Legendre à 20 points (nœuds calculés par Newton sur P20) — exact pour les polynômes de degré ≤ 39. */
  var GL = null;
  function glNodes(){
    if(GL) return GL;
    var n = 20, xs = [], ws = [], i, j;
    for(i = 0; i < n; i++){
      var x = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), pp, dx = 1;
      for(var it = 0; it < 100 && Math.abs(dx) > 1e-15; it++){
        var p0 = 1, p1 = x;
        for(j = 2; j <= n; j++){ var p2 = ((2 * j - 1) * x * p1 - (j - 1) * p0) / j; p0 = p1; p1 = p2; }
        pp = n * (x * p1 - p0) / (x * x - 1);
        dx = p1 / pp; x -= dx;
      }
      xs.push(x); ws.push(2 / ((1 - x * x) * pp * pp));
    }
    GL = { x: xs, w: ws }; return GL;
  }
  function gaussLegendre(f, a, b){
    var g = glNodes(), c = (a + b) / 2, h = (b - a) / 2, s = 0, i;
    // 8 sous-intervalles pour résister aux fonctions moins régulières
    var parts = 8, total = 0, k;
    for(k = 0; k < parts; k++){
      var a0 = a + (b - a) * k / parts, b0 = a + (b - a) * (k + 1) / parts, cc = (a0 + b0) / 2, hh = (b0 - a0) / 2;
      s = 0; for(i = 0; i < g.x.length; i++) s += g.w[i] * f(cc + hh * g.x[i]);
      total += s * hh;
    }
    return total;
  }

  /* Fraction rationnelle : simplification EXACTE par PGCD de polynômes (algorithme d'Euclide sur Q). */
  function polyDivmod(a, b){
    a = poly.trim(a); b = poly.trim(b);
    var q = [], r = a.slice();
    if(poly.degree(b) === -Infinity) C.fail("DIV_ZERO", "division par le polynôme nul");
    var db = poly.degree(b), lb = b[b.length - 1];
    var out = []; for(var z = 0; z <= Math.max(0, poly.degree(a) - db); z++) out.push(R0);
    while(poly.degree(r) >= db && poly.degree(r) !== -Infinity){
      var dr = poly.degree(r), c = r[r.length - 1].div(lb), shift = dr - db;
      out[shift] = c;
      for(var i = 0; i <= db; i++) r[shift + i] = r[shift + i].sub(c.mul(b[i]));
      r = poly.trim(r);
      if(r.length === 1 && r[0].isZero()) break;
    }
    return { q: poly.trim(out), r: poly.trim(r) };
  }
  function polyGcd(a, b){
    a = poly.trim(a); b = poly.trim(b);
    while(!(b.length === 1 && b[0].isZero())){ var r = polyDivmod(a, b).r; a = b; b = r; }
    var lead = a[a.length - 1]; return a.map(function(c){ return c.div(lead); });
  }
  function simplifyRational(ast, v){
    try{
      var vars = C.freeVars(ast); v = v || vars[0];
      if(vars.length !== 1) return needsCAS("plusieurs variables ou aucune");
      if(ast.t !== "bin" || ast.op !== "/") return needsCAS("pas une fraction rationnelle");
      var N = poly.fromAst(ast.l, v), D = poly.fromAst(ast.r, v); if(!N || !D) return needsCAS("fraction non rationnelle");
      if(poly.degree(D) === -Infinity) return failRes(STATUS.INVALID_INPUT, "DIV_ZERO", "dénominateur nul");
      var g = polyGcd(N, D), n2 = polyDivmod(N, g).q, d2 = polyDivmod(D, g).q;
      // normalisation : dénominateur à coefficient dominant 1
      var ld = d2[d2.length - 1]; n2 = n2.map(function(c){ return c.div(ld); }); d2 = d2.map(function(c){ return c.div(ld); });
      // contrôle EXACT : N·d2 = n2·D (produit en croix)
      var cross = poly.eq(poly.mul(N, d2), poly.mul(n2, D));
      var excl = []; var rrD = rationalRoots(D); rrD.roots.forEach(function(x){ excl.push(x.r); });
      var removed = []; if(poly.degree(g) >= 1) removed = rationalRoots(g).roots.map(function(x){ return x.r; });
      var denIs1 = d2.length === 1 && d2[0].eq(R1);
      var text = denIs1 ? polyToText(n2, v) : "(" + polyToText(n2, v) + ")/(" + polyToText(d2, v) + ")";
      var latex = denIs1 ? polyToLatex(n2, v) : "\\frac{" + polyToLatex(n2, v) + "}{" + polyToLatex(d2, v) + "}";
      var notes = excl.length ? ["domain-excludes:" + excl.map(function(r){ return v + "≠" + ratText(r); }).join(",")] : [];
      return { ok: true, kind: "simplify", engine: "fast", variable: v, exact: { text: text, latex: latex }, approx: null,
               verification: cross ? verif(STATUS.VERIFIED_EXACT, "produit-en-croix-exact", "N·d′ = n′·D vérifié exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: ["facteur commun supprimé : " + (poly.degree(g) >= 1 ? polyToText(g, v) : "aucun")], domainExcluded: excl.map(ratText), notes: notes };
    }catch(e){ return fromError(e); }
  }

  /* ═══ 4. ALGÈBRE LINÉAIRE (rationnels exacts) ══════════════════════════════ */
  function matFromAst(ast){
    if(ast.t !== "mat") return null;
    return ast.rows.map(function(r){ return r.map(function(c){ return C.evalExact(c, {}); }); });
  }
  function matText(M){ return "[" + M.map(function(r){ return r.map(ratText).join(", "); }).join("; ") + "]"; }
  function matLatex(M){ return "\\begin{pmatrix}" + M.map(function(r){ return r.map(latexRat).join(" & "); }).join(" \\\\ ") + "\\end{pmatrix}"; }
  function matMul(A, B){
    if(A[0].length !== B.length) C.fail("INVALID_INPUT", "dimensions incompatibles pour le produit");
    return A.map(function(r){ return B[0].map(function(_, j){ var s = R0; for(var k = 0; k < r.length; k++) s = s.add(r[k].mul(B[k][j])); return s; }); });
  }
  function identity(n){ var I = [], i, j; for(i = 0; i < n; i++){ I.push([]); for(j = 0; j < n; j++) I[i].push(i === j ? R1 : R0); } return I; }
  function matEq(A, B){ if(A.length !== B.length || A[0].length !== B[0].length) return false; return A.every(function(r, i){ return r.every(function(c, j){ return c.eq(B[i][j]); }); }); }
  /* Élimination de Gauss-Jordan EXACTE : forme échelonnée réduite, rang, déterminant. */
  function rref(M){
    var A = M.map(function(r){ return r.slice(); }), rows = A.length, cols = A[0].length, r = 0, pivots = [], det = R1, swaps = 0, c, i, j;
    for(c = 0; c < cols && r < rows; c++){
      var p = -1; for(i = r; i < rows; i++) if(!A[i][c].isZero()){ p = i; break; }
      if(p < 0){ det = R0; continue; }
      if(p !== r){ var t = A[p]; A[p] = A[r]; A[r] = t; swaps++; }
      var pv = A[r][c]; det = det.mul(pv);
      for(j = 0; j < cols; j++) A[r][j] = A[r][j].div(pv);
      for(i = 0; i < rows; i++){ if(i === r) continue; var f = A[i][c]; if(f.isZero()) continue; for(j = 0; j < cols; j++) A[i][j] = A[i][j].sub(f.mul(A[r][j])); }
      pivots.push(c); r++;
    }
    if(swaps % 2) det = det.neg();
    return { A: A, rank: pivots.length, pivots: pivots, det: (rows === cols && pivots.length === rows) ? det : R0 };
  }
  function detLaplace(M){                           // 2ᵉ méthode, INDÉPENDANTE (n ≤ 5) : développement par cofacteurs
    var n = M.length; if(n === 1) return M[0][0];
    if(n === 2) return M[0][0].mul(M[1][1]).sub(M[0][1].mul(M[1][0]));
    var s = R0, j;
    for(j = 0; j < n; j++){
      var minor = M.slice(1).map(function(r){ return r.filter(function(_, c){ return c !== j; }); });
      var t = M[0][j].mul(detLaplace(minor)); s = (j % 2) ? s.sub(t) : s.add(t);
    }
    return s;
  }
  function matrixOp(op, A, B, o){
    try{
      var n = A.length, m = A[0].length;
      if(op === "transpose"){ var T = A[0].map(function(_, j){ return A.map(function(r){ return r[j]; }); }); return matRes("transpose", T, verif(STATUS.VERIFIED_EXACT, "double-transposition", "(Aᵀ)ᵀ = A vérifié"), [], matEq(A, T[0].map(function(_, j){ return T.map(function(r){ return r[j]; }); }))); }
      if(op === "add" || op === "sub"){ if(!B || B.length !== n || B[0].length !== m) return failRes(STATUS.INVALID_INPUT, "DIMENSION", "dimensions différentes"); var S = A.map(function(r, i){ return r.map(function(c, j){ return op === "add" ? c.add(B[i][j]) : c.sub(B[i][j]); }); }); return matRes(op, S, verif(STATUS.VERIFIED_EXACT, "recalcul-élément-par-élément", ""), [], true); }
      if(op === "mul"){ if(!B) return failRes(STATUS.INVALID_INPUT, "NO_B", "deuxième matrice manquante"); var P = matMul(A, B); return matRes("mul", P, verif(STATUS.VERIFIED_EXACT, "produit-par-colonnes", "chaque colonne de AB = A × colonne de B"), [], matEq(P, B[0].map(function(_, j){ var col = A.map(function(r){ var s = R0; for(var k = 0; k < r.length; k++) s = s.add(r[k].mul(B[k][j])); return s; }); return col; }).reduce(function(acc, col){ col.forEach(function(v, i){ (acc[i] = acc[i] || []).push(v); }); return acc; }, []))); }
      if(n > 8 || m > 8) return needsCAS("matrice trop grande");
      var rr = rref(A);
      if(op === "rank") return { ok: true, kind: "matrix-rank", engine: "fast", value: rat(rr.rank), exact: { text: String(rr.rank), latex: String(rr.rank) }, approx: null, verification: verif(STATUS.VERIFIED_EXACT, "rang-par-lignes-et-colonnes", "rang(A) = rang(Aᵀ)"), steps: [], notes: [], pass: rref(A[0].map(function(_, j){ return A.map(function(r){ return r[j]; }); })).rank === rr.rank };
      if(n !== m) return failRes(STATUS.INVALID_INPUT, "NOT_SQUARE", "la matrice doit être carrée");
      if(op === "det"){
        var d1 = rr.det, d2 = n <= 6 ? detLaplace(A) : d1, same = d1.eq(d2);
        return { ok: true, kind: "matrix-det", engine: "fast", value: d1, exact: { text: ratText(d1), latex: latexRat(d1) }, approx: approxOf(d1, 6, (o || {}).lang), verification: same ? verif(STATUS.VERIFIED_EXACT, "gauss+cofacteurs", "deux méthodes exactes concordantes") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "mismatch", ""), steps: [], notes: [] };
      }
      if(op === "inverse"){
        if(rr.rank < n) return { ok: true, kind: "matrix-inverse", engine: "fast", singular: true, exact: { text: "non inversible (déterminant 0)", latex: "\\text{non inversible}" }, approx: null, verification: verif(STATUS.VERIFIED_EXACT, "determinant-nul", "rang " + rr.rank + " < " + n), steps: [], notes: ["singular"] };
        var aug = A.map(function(r, i){ return r.concat(identity(n)[i]); }), red = rref(aug).A, inv = red.map(function(r){ return r.slice(n); });
        var okInv = matEq(matMul(A, inv), identity(n)) && matEq(matMul(inv, A), identity(n));
        return { ok: true, kind: "matrix-inverse", engine: "fast", matrix: inv, exact: { text: matText(inv), latex: matLatex(inv) }, approx: null,
                 verification: okInv ? verif(STATUS.VERIFIED_EXACT, "A×A⁻¹=I", "A·A⁻¹ = A⁻¹·A = I vérifié exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""), steps: [], notes: [] };
      }
      if(op === "eigen"){
        if(n !== 2) return needsCAS("valeurs propres : taille ≠ 2×2");
        var tr = A[0][0].add(A[1][1]), dt = A[0][0].mul(A[1][1]).sub(A[0][1].mul(A[1][0]));
        var q = quadraticRoots(R1, tr.neg(), dt), ev = q.roots.map(function(x){ return rootDisplay(x, (o || {}).lang); });
        var okE = q.roots.every(function(x){ var res = quadResidual(R1, tr.neg(), dt, x); return res[0].isZero() && res[1].isZero(); });
        return { ok: true, kind: "matrix-eigen", engine: "fast", exact: { text: ev.map(function(e){ return "λ = " + e.text; }).join(" ; "), latex: ev.map(function(e){ return "\\lambda = " + e.latex; }).join(",\\; ") }, approx: null,
                 verification: okE ? verif(STATUS.VERIFIED_EXACT, "substitution-dans-det(A−λI)", "det(A − λI) = λ² − tr·λ + det annulé exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""), steps: ["polynôme caractéristique : λ² − " + ratText(tr) + "λ + " + ratText(dt)], notes: [] };
      }
      return failRes(STATUS.UNSUPPORTED, "UNKNOWN_OP", "opération matricielle inconnue : " + op);
    }catch(e){ return fromError(e); }
  }
  function matRes(kind, M, v, steps, okExact){
    return { ok: true, kind: "matrix-" + kind, engine: "fast", matrix: M, exact: { text: matText(M), latex: matLatex(M) }, approx: null,
             verification: okExact === false ? verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") : v, steps: steps || [], notes: [] };
  }

  /* Système linéaire : équations (AST) en `vars`. Forme linéaire extraite par évaluations exactes. */
  function linearForm(ast, vars){
    var zero = {}; vars.forEach(function(x){ zero[x] = R0; });
    var f0 = C.evalExact(ast, zero), coeffs = [];
    vars.forEach(function(x){ var e = Object.assign({}, zero); e[x] = R1; coeffs.push(C.evalExact(ast, e).sub(f0)); });
    // contrôle de linéarité : en un point « irrégulier » la forme doit se retrouver exactement
    var pt = {}, pred = f0; vars.forEach(function(x, i){ var val = rat(3 + 2 * i, 7); pt[x] = val; pred = pred.add(coeffs[i].mul(val)); });
    if(!C.evalExact(ast, pt).eq(pred)) return null;
    return { c: coeffs, k: f0 };
  }
  function solveSystem(eqs, vars, o){
    try{
      var free = {}; eqs.forEach(function(e){ C.freeVars(e).forEach(function(x){ free[x] = 1; }); });
      vars = vars && vars.length ? vars : Object.keys(free).sort();
      if(!vars.length) return failRes(STATUS.INVALID_INPUT, "NO_VARIABLE", "aucune inconnue");
      if(vars.length > 8 || eqs.length > 8) return needsCAS("système trop grand");
      var rows = [];
      for(var i = 0; i < eqs.length; i++){
        var e = eqs[i]; if(e.t !== "eq") return failRes(STATUS.INVALID_INPUT, "NOT_EQUATION", "une équation (avec « = ») est attendue");
        var lf; try{ lf = linearForm({ t: "bin", op: "-", l: e.l, r: e.r }, vars); }catch(er){ if(er && er.name === "MathError" && er.code === "UNBOUND") return needsCAS("variable hors liste"); throw er; }
        if(!lf) return needsCAS("système non linéaire");
        rows.push(lf.c.concat([lf.k.neg()]));                 // Σ cᵢ xᵢ = −k
      }
      var red = rref(rows), A = red.A, n = vars.length;
      // incohérence : une ligne [0 … 0 | b≠0]
      var incons = A.some(function(r){ return r.slice(0, n).every(function(c){ return c.isZero(); }) && !r[n].isZero(); });
      if(incons) return { ok: true, kind: "system", engine: "fast", solutionKind: "none", exact: { text: "aucune solution (système incompatible)", latex: "\\varnothing" }, approx: null,
                          verification: verif(STATUS.VERIFIED_EXACT, "ligne-incohérente", "l'élimination aboutit à 0 = c ≠ 0"), steps: [], notes: [], variables: vars };
      var rank = red.pivots.length;
      if(rank < n){
        // une infinité de solutions : paramétrage par les inconnues libres
        var freeIdx = []; for(var k = 0; k < n; k++) if(red.pivots.indexOf(k) < 0) freeIdx.push(k);
        var lines = [];
        red.pivots.forEach(function(pc, ri){
          var out = vars[pc] + " = ", first = true, kc = A[ri][n];
          if(!kc.isZero() || freeIdx.every(function(fi){ return A[ri][fi].isZero(); })){ out += ratText(kc); first = false; }
          freeIdx.forEach(function(fi){
            var c = A[ri][fi].neg(); if(c.isZero()) return;
            var a = c.abs(), body = (a.eq(R1) ? "" : (a.isInt() ? a.toString() : "(" + a.toString() + ")")) + vars[fi];
            out += first ? (c.sign() < 0 ? "-" : "") + body : (c.sign() < 0 ? " - " : " + ") + body; first = false;
          });
          lines.push(out);
        });
        return { ok: true, kind: "system", engine: "fast", solutionKind: "infinite", exact: { text: lines.join(" ; ") + " (" + freeIdx.map(function(fi){ return vars[fi]; }).join(", ") + " libre(s))", latex: "" }, approx: null,
                 verification: verif(STATUS.VERIFIED_EXACT, "rang<n", "rang " + rank + " < " + n + " inconnues"), steps: [], notes: ["infinite-solutions"], variables: vars };
      }
      var sol = {}; vars.forEach(function(x, j){ sol[x] = A[j][n]; });
      // vérification EXACTE par réinjection dans chaque équation d'origine
      var allOK = eqs.every(function(e){ var env = {}; vars.forEach(function(x){ env[x] = sol[x]; }); return C.evalExact(e.l, env).eq(C.evalExact(e.r, env)); });
      var text = vars.map(function(x){ return x + " = " + ratText(sol[x]); }).join(" ; ");
      return { ok: true, kind: "system", engine: "fast", solutionKind: "unique", solution: sol, variables: vars,
               exact: { text: text, latex: vars.map(function(x){ return x + " = " + latexRat(sol[x]); }).join(",\\; ") },
               approx: vars.some(function(x){ return !sol[x].isInt(); }) ? { text: vars.map(function(x){ return x + " ≈ " + decStr(sol[x], 6, (o || {}).lang); }).join(" ; "), value: null } : null,
               verification: allOK ? verif(STATUS.VERIFIED_EXACT, "réinjection-exacte", "la solution vérifie chaque équation, calcul exact") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: [], notes: [] };
    }catch(e){ return fromError(e); }
  }
  /* Ax = b : la même chose depuis des matrices. */
  function solveLinearMatrix(A, b){
    var n = A.length, vars = A[0].map(function(_, i){ return "x" + (i + 1); });
    var eqs = A.map(function(row, i){
      var l = null; row.forEach(function(c, j){ var term = C.bin("*", C.qnode(c), C.sym(vars[j])); l = l ? C.bin("+", l, term) : term; });
      return { t: "eq", l: l, r: C.qnode(b[i]) };
    });
    return solveSystem(eqs, vars);
  }

  /* ═══ 5. STATISTIQUES (conventions EXPLICITES) ═════════════════════════════ */
  function sortRats(a){ return a.slice().sort(function(x, y){ return x.cmp(y); }); }
  function sumRats(a){ return a.reduce(function(s, x){ return s.add(x); }, R0); }
  function quantile(sorted, p, method){            // inc : R7 (Excel QUARTILE.INC) ; exc : R6 (QUARTILE.EXC) ; renvoie null si indéfini
    var n = sorted.length, h, lo, frac;
    if(method === "exc"){ h = p.mul(rat(n + 1)).sub(R1); if(h.sign() < 0 || h.cmp(rat(n - 1)) > 0) return null; }
    else h = p.mul(rat(n - 1));
    lo = Number(h.n / h.d); frac = h.sub(rat(lo));
    if(lo >= n - 1) return sorted[n - 1];
    return sorted[lo].add(frac.mul(sorted[lo + 1].sub(sorted[lo])));
  }
  function varianceOf(data, mean, denom){ var ss = R0; data.forEach(function(x){ var d = x.sub(mean); ss = ss.add(d.mul(d)); }); return ss.div(rat(denom)); }
  function sdPresent(variance, lang){
    var sr = C.sqrtRat(variance), s = C.surdText(sr.coef, sr.rad), f = Math.sqrt(variance.toNumber());
    return { exact: s.text, latex: s.latex, value: f, text: C.fmtFloat(f, 6, lang || "fr"), exactIsRational: sr.rad === ONE };
  }
  function descriptive(data, o){
    o = o || {}; var lang = o.lang || "fr";
    try{
      if(!data || data.length < 1) return failRes(STATUS.INVALID_INPUT, "NO_DATA", "aucune donnée");
      if(data.length > 5000) return failRes(STATUS.UNSUPPORTED, "TOO_MANY", "trop de valeurs");
      var n = data.length, sorted = sortRats(data), sum = sumRats(data), mean = sum.div(rat(n));
      var med = n % 2 ? sorted[(n - 1) / 2] : sorted[n / 2 - 1].add(sorted[n / 2]).div(rat(2));
      var freq = {}, best = 0; data.forEach(function(x){ var k = ratText(x); freq[k] = (freq[k] || 0) + 1; if(freq[k] > best) best = freq[k]; });
      var modes = best > 1 ? Object.keys(freq).filter(function(k){ return freq[k] === best; }) : [];
      var q = { inc: { q1: quantile(sorted, rat(1, 4), "inc"), q2: quantile(sorted, rat(1, 2), "inc"), q3: quantile(sorted, rat(3, 4), "inc") },
                exc: n >= 3 ? { q1: quantile(sorted, rat(1, 4), "exc"), q2: quantile(sorted, rat(1, 2), "exc"), q3: quantile(sorted, rat(3, 4), "exc") } : null };
      var varPop = varianceOf(data, mean, n), varSam = n >= 2 ? varianceOf(data, mean, n - 1) : null;
      // vérification INDÉPENDANTE : Var = E[x²] − (E[x])² (autre formule, exacte)
      var meanSq = sumRats(data.map(function(x){ return x.mul(x); })).div(rat(n)), varPop2 = meanSq.sub(mean.mul(mean));
      var okVar = varPop.eq(varPop2);
      var okMean = sum.eq(mean.mul(rat(n)));
      var res = { ok: true, kind: "descriptive", engine: "fast", n: n, sum: sum, mean: mean, median: med, modes: modes, min: sorted[0], max: sorted[n - 1], range: sorted[n - 1].sub(sorted[0]),
                  varPop: varPop, varSample: varSam, sdPop: sdPresent(varPop, lang), sdSample: varSam ? sdPresent(varSam, lang) : null, quartiles: q,
                  verification: okVar && okMean ? verif(STATUS.VERIFIED_EXACT, "formule-alternative", "variance = E[x²] − (E[x])² concorde exactement ; somme = n × moyenne")
                                                : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
                  notes: [], exact: null, approx: null, steps: [] };
      return res;
    }catch(e){ return fromError(e); }
  }
  function zScore(x, mean, sd){ if(sd.isZero()) return failRes(STATUS.INVALID_INPUT, "SD_ZERO", "écart-type nul : z-score indéfini"); var z = x.sub(mean).div(sd); return { ok: true, kind: "zscore", engine: "fast", value: z, exact: { text: ratText(z), latex: latexRat(z) }, approx: approxOf(z, 6, "fr"), verification: verif(STATUS.VERIFIED_EXACT, "reconstruction", "x = μ + z·σ vérifié exactement: " + (mean.add(z.mul(sd)).eq(x))), steps: ["z = (x − μ) / σ"], notes: [] }; }
  function covariance(xs, ys, o){
    try{
      if(xs.length !== ys.length || xs.length < 2) return failRes(STATUS.INVALID_INPUT, "LENGTHS", "deux séries de même longueur (≥ 2) sont nécessaires");
      var n = xs.length, mx = sumRats(xs).div(rat(n)), my = sumRats(ys).div(rat(n)), s = R0, sxx = R0, syy = R0;
      xs.forEach(function(x, i){ var dx = x.sub(mx), dy = ys[i].sub(my); s = s.add(dx.mul(dy)); sxx = sxx.add(dx.mul(dx)); syy = syy.add(dy.mul(dy)); });
      var covPop = s.div(rat(n)), covSam = s.div(rat(n - 1));
      // vérification : Cov = E[xy] − E[x]E[y]
      var exy = sumRats(xs.map(function(x, i){ return x.mul(ys[i]); })).div(rat(n)), covPop2 = exy.sub(mx.mul(my));
      var r2 = (sxx.isZero() || syy.isZero()) ? null : s.mul(s).div(sxx.mul(syy));
      var r = r2 ? (s.sign() < 0 ? -1 : 1) * Math.sqrt(r2.toNumber()) : null;
      var slope = sxx.isZero() ? null : s.div(sxx), icpt = slope ? my.sub(slope.mul(mx)) : null;
      return { ok: true, kind: "covariance", engine: "fast", n: n, meanX: mx, meanY: my, covPop: covPop, covSample: covSam, r2: r2, r: r, slope: slope, intercept: icpt,
               verification: covPop.eq(covPop2) ? verif(STATUS.VERIFIED_EXACT, "formule-alternative", "Cov = E[xy] − E[x]E[y] concorde exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""), notes: [], steps: [] };
    }catch(e){ return fromError(e); }
  }

  /* ═══ 6. PROBABILITÉS ══════════════════════════════════════════════════════ */
  function binomialPmf(n, p, k){ var q = R1.sub(p); return new Rat(C.binomBig(n, k)).mul(p.pow(k)).mul(q.pow(n - k)); }
  function binomial(n, p, spec, o){
    o = o || {};
    try{
      if(!Number.isInteger(n) || n < 0 || n > 2000) return failRes(STATUS.INVALID_INPUT, "BAD_N", "n doit être un entier entre 0 et 2000");
      if(p.sign() < 0 || p.cmp(R1) > 0) return failRes(STATUS.INVALID_INPUT, "BAD_P", "p doit être dans [0 ; 1]");
      var q = R1.sub(p), pmf = [], i; for(i = 0; i <= n; i++) pmf.push(binomialPmf(n, p, i));
      var total = sumRats(pmf);
      // vérification indépendante : récurrence P(k+1)/P(k) = ((n−k)/(k+1))·(p/q), et somme = 1
      var okSum = total.eq(R1), okRec = true;
      if(!q.isZero() && !p.isZero()) for(i = 0; i < n; i++){ if(!pmf[i + 1].eq(pmf[i].mul(rat(n - i, i + 1)).mul(p.div(q)))){ okRec = false; break; } }
      var val, label;
      var k = spec.k;
      if(spec.kind === "eq"){ val = pmf[k] || R0; label = "P(X = " + k + ")"; }
      else if(spec.kind === "le"){ val = sumRats(pmf.slice(0, Math.min(k, n) + 1)); if(k < 0) val = R0; label = "P(X ≤ " + k + ")"; }
      else if(spec.kind === "lt"){ val = k <= 0 ? R0 : sumRats(pmf.slice(0, Math.min(k - 1, n) + 1)); label = "P(X < " + k + ")"; }
      else if(spec.kind === "ge"){ val = k > n ? R0 : sumRats(pmf.slice(Math.max(k, 0))); label = "P(X ≥ " + k + ")"; }
      else if(spec.kind === "gt"){ val = k + 1 > n ? R0 : sumRats(pmf.slice(Math.max(k + 1, 0))); label = "P(X > " + k + ")"; }
      else return failRes(STATUS.UNSUPPORTED, "BAD_SPEC", "événement non supporté");
      var mean = rat(n).mul(p), varr = rat(n).mul(p).mul(q);
      return { ok: true, kind: "binomial", engine: "fast", value: val, label: label, n: n, p: p, mean: mean, variance: varr, sd: sdPresent(varr, o.lang),
               exact: { text: ratText(val), latex: latexRat(val) }, approx: approxOf(val, 8, o.lang),
               verification: okSum && okRec ? verif(STATUS.VERIFIED_EXACT, "somme=1+récurrence", "Σ P(X=k) = 1 et P(k+1)/P(k) = ((n−k)/(k+1))·p/q vérifiés exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: ["X ~ B(" + n + ", " + ratText(p) + ")", "P(X = k) = C(n,k)·p^k·(1−p)^(n−k)", label + " = " + ratText(val)], notes: [] };
    }catch(e){ return fromError(e); }
  }

  /* Loi normale : erf à ~1e-15 (série de Taylor pour |x| < 3, fraction continue au-delà). */
  function erf(x){
    var ax = Math.abs(x), s;
    if(ax < 3){
      var term = ax, sum = ax, n = 0;
      for(n = 1; n < 200; n++){ term = -term * ax * ax / n; var add = term / (2 * n + 1); sum += add; if(Math.abs(add) < 1e-17 * Math.abs(sum)) break; }
      s = 2 / Math.sqrt(Math.PI) * sum;
    } else {
      // erfc par fraction continue (Lentz)
      var tiny = 1e-300, f = tiny, Cc = f, D = 0, i, a, b = ax;
      f = ax; Cc = f; D = 0;
      for(i = 1; i < 300; i++){ a = i / 2; D = ax + a * D; if(D === 0) D = tiny; Cc = ax + a / Cc; if(Cc === 0) Cc = tiny; D = 1 / D; var delta = Cc * D; f *= delta; if(Math.abs(delta - 1) < 1e-16) break; }
      s = 1 - Math.exp(-ax * ax) / (f * Math.sqrt(Math.PI));
    }
    return x < 0 ? -s : s;
  }
  function normalCdfFloat(z){ return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function normalPdfFloat(z){ return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI); }
  function normalInvFloat(p){
    if(!(p > 0 && p < 1)) C.fail("DOMAIN", "p doit être dans ]0 ; 1[");
    // Acklam puis raffinement de Halley sur la fonction de répartition
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00],
        b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01],
        c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00],
        d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00], x, q, r;
    if(p < 0.02425){ q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    else if(p > 1 - 0.02425){ q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    else { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    for(var i = 0; i < 3; i++){ var e = normalCdfFloat(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2); x = x - u / (1 + x * u / 2); }
    return x;
  }
  function simpson(f, a, b, n){ var h = (b - a) / n, s = f(a) + f(b), i; for(i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2); return s * h / 3; }
  function normal(spec, mu, sigma, o){
    o = o || {}; var lang = o.lang || "fr";
    try{
      if(!(sigma > 0)) return failRes(STATUS.INVALID_INPUT, "BAD_SIGMA", "σ doit être strictement positif");
      var cdf = function(x){ return normalCdfFloat((x - mu) / sigma); };
      var val, label, check;
      var numeric = function(x){                                // intégrale numérique INDÉPENDANTE de la densité (Simpson)
        var lo = mu - 12 * sigma, f = function(t){ return normalPdfFloat((t - mu) / sigma) / sigma; };
        return x <= lo ? 0 : simpson(f, lo, x, 4000);
      };
      if(spec.kind === "le" || spec.kind === "lt"){ val = cdf(spec.x); check = numeric(spec.x); label = "P(X " + (spec.kind === "le" ? "≤" : "<") + " " + spec.x + ")"; }
      else if(spec.kind === "ge" || spec.kind === "gt"){ val = 1 - cdf(spec.x); check = 1 - numeric(spec.x); label = "P(X " + (spec.kind === "ge" ? "≥" : ">") + " " + spec.x + ")"; }
      else if(spec.kind === "between"){ val = cdf(spec.b) - cdf(spec.a); check = numeric(spec.b) - numeric(spec.a); label = "P(" + spec.a + " ≤ X ≤ " + spec.b + ")"; }
      else if(spec.kind === "inverse"){
        var x = normalInvFloat(spec.p) * sigma + mu, back = cdf(x);
        return { ok: true, kind: "normal-inverse", engine: "fast", value: x, exact: null, approx: { text: C.fmtFloat(x, 6, lang), value: x }, z: normalInvFloat(spec.p),
                 verification: Math.abs(back - spec.p) < 1e-12 ? verif(STATUS.VERIFIED_NUMERICALLY, "Φ(x)=p", "la fonction de répartition en x redonne p à 1e-12 près — vérification numérique, pas une preuve") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
                 steps: ["x = μ + σ·Φ⁻¹(p)"], notes: [], label: "x tel que P(X ≤ x) = " + spec.p };
      }
      else return failRes(STATUS.UNSUPPORTED, "BAD_SPEC", "événement non supporté");
      var ok = Math.abs(val - check) < 1e-9;
      return { ok: true, kind: "normal", engine: "fast", value: val, label: label, mu: mu, sigma: sigma, exact: null, approx: { text: C.fmtFloat(val, 6, lang), value: val },
               verification: ok ? verif(STATUS.VERIFIED_NUMERICALLY, "intégrale-numérique-de-la-densité", "Simpson sur la densité concorde à 1e-9 près — vérification numérique, pas une preuve") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: ["Z = (X − μ)/σ ~ N(0 ; 1)", label + " ≈ " + C.fmtFloat(val, 6, lang)], notes: [] };
    }catch(e){ return fromError(e); }
  }
  function bayes(pA, pBgA, o){                       // o : { pBgNotA } ou { pB }
    try{
      var pNotA = R1.sub(pA), pB;
      if(o.pB) pB = o.pB; else pB = pA.mul(pBgA).add(pNotA.mul(o.pBgNotA));
      if(pB.isZero()) return failRes(STATUS.INVALID_INPUT, "PB_ZERO", "P(B) = 0 : probabilité conditionnelle indéfinie");
      var post = pA.mul(pBgA).div(pB);
      // vérification : table de probabilités conjointes cohérente (P(A∩B) + P(Aᶜ∩B) = P(B)) et post ∈ [0,1]
      var joint = pA.mul(pBgA), jointN = o.pBgNotA ? pNotA.mul(o.pBgNotA) : pB.sub(joint);
      var okTable = joint.add(jointN).eq(pB) && post.sign() >= 0 && post.cmp(R1) <= 0;
      return { ok: true, kind: "bayes", engine: "fast", value: post, exact: { text: ratText(post), latex: latexRat(post) }, approx: approxOf(post, 6, (o || {}).lang), pB: pB,
               verification: okTable ? verif(STATUS.VERIFIED_EXACT, "table-des-probabilités-conjointes", "P(A∩B) + P(Aᶜ∩B) = P(B) vérifié exactement, résultat dans [0 ; 1]") : verif(STATUS.INVALID_INPUT, "incoherent", "probabilités incohérentes (résultat hors de [0 ; 1])"),
               steps: ["P(A|B) = P(B|A)·P(A) / P(B)", "P(B) = " + ratText(pB)], notes: [] };
    }catch(e){ return fromError(e); }
  }

  /* ═══ 7. MATHS FINANCIÈRES (déterministes, exactes) ════════════════════════ */
  function money(r, lang, unit){ var d = decStr(roundHalfUp(r, 2), 2, lang); var t = d.indexOf(",") < 0 && d.indexOf(".") < 0 ? d + (lang === "en" ? ".00" : ",00") : d; return unit ? t + " " + unit : t; }
  function mkFin(kind, value, extra){
    return Object.assign({ ok: true, kind: kind, engine: "fast", value: value, exact: { text: ratText(value), latex: latexRat(value) }, approx: approxOf(value, 8, extra && extra.lang), notes: [] }, extra || {});
  }
  function percentOf(p, base){ var v = base.mul(p).div(rat(100)); return mkFin("percent-of", v, { steps: [ratText(p) + " % × " + ratText(base) + " = " + ratText(v)], verification: verif(STATUS.VERIFIED_EXACT, "inverse", "résultat ÷ base × 100 = p : " + v.div(base.isZero() ? R1 : base).mul(rat(100)).eq(p)) }); }
  function percentChange(oldV, newV){
    if(oldV.isZero()) return failRes(STATUS.INVALID_INPUT, "OLD_ZERO", "valeur de départ nulle : variation en % indéfinie");
    var ch = newV.sub(oldV).div(oldV.abs()).mul(rat(100));
    var back = oldV.mul(R1.add(ch.div(rat(100)).mul(oldV.sign() < 0 ? rat(-1) : R1)));
    return mkFin("percent-change", ch, { steps: ["(nouveau − ancien) / |ancien| × 100"], verification: back.eq(newV) ? verif(STATUS.VERIFIED_EXACT, "application-inverse", "ancien × (1 + variation) retrouve le nouveau exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") });
  }
  function compound(C0, r, years, perYear, o){
    o = o || {};
    try{
      perYear = perYear || 1;
      var expo = years.mul(rat(perYear)), rate = r.div(rat(perYear)), growthBase = R1.add(rate);
      if(!expo.isInt()){ var f = C0.toNumber() * Math.pow(growthBase.toNumber(), expo.toNumber()); return { ok: true, kind: "compound", engine: "fast", value: null, exact: null, approx: { text: C.fmtFloat(f, 6, o.lang), value: f }, notes: ["non-integer-periods"], verification: verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "float-only", "nombre de périodes non entier : puissance fractionnaire en flottant"), steps: [] }; }
      var k = Number(expo.n), fv = C0.mul(growthBase.pow(k));
      // vérification INDÉPENDANTE : capitalisation période par période (multiplications successives), puis actualisation inverse
      var it = C0, i; for(i = 0; i < Math.min(k, 3000); i++) it = it.mul(growthBase);
      var back = fv.div(growthBase.pow(k));
      var okIt = k <= 3000 ? it.eq(fv) : true, okBack = back.eq(C0);
      var gain = fv.sub(C0);
      return mkFin("compound", fv, { lang: o.lang, years: years, rate: r, periods: perYear, gain: gain, growthFactor: growthBase.pow(k), rounded: roundHalfUp(fv, 2),
               steps: ["VF = C × (1 + r" + (perYear > 1 ? "/" + perYear : "") + ")^" + k + " = " + ratText(C0) + " × (" + ratText(growthBase) + ")^" + k + " = " + ratText(fv)],
               verification: okIt && okBack ? verif(STATUS.VERIFIED_EXACT, "capitalisation-itérée+actualisation-inverse", "multiplications successives identiques ; VF actualisée = C exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") });
    }catch(e){ return fromError(e); }
  }
  function simpleInterest(C0, r, years, o){
    var fv = C0.mul(R1.add(r.mul(years))), gain = fv.sub(C0);
    return mkFin("simple-interest", fv, { lang: (o || {}).lang, gain: gain, rounded: roundHalfUp(fv, 2), steps: ["VF = C × (1 + r × t) = " + ratText(fv)], verification: gain.eq(C0.mul(r).mul(years)) ? verif(STATUS.VERIFIED_EXACT, "intérêts=C·r·t", "VF − C = C·r·t exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") });
  }
  function discount(FV, r, years, o){
    try{
      if(!years.isInt()) return failRes(STATUS.UNSUPPORTED, "NON_INTEGER_YEARS", "durée non entière : calcul exact impossible, utiliser le CAS ou un flottant");
      var k = Number(years.n), pv = FV.div(R1.add(r).pow(k));
      return mkFin("present-value", pv, { lang: (o || {}).lang, rounded: roundHalfUp(pv, 2), steps: ["VA = VF / (1 + r)^t = " + ratText(pv)], verification: pv.mul(R1.add(r).pow(k)).eq(FV) ? verif(STATUS.VERIFIED_EXACT, "capitalisation-inverse", "VA × (1+r)^t = VF exactement") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") });
    }catch(e){ return fromError(e); }
  }
  function npvRat(rate, flows){ var s = R0, f = R1.add(rate), i; for(i = 0; i < flows.length; i++) s = s.add(flows[i].div(f.pow(i))); return s; }   // flows[0] à t = 0
  function npv(rate, flows, o){
    try{
      if(!flows.length) return failRes(STATUS.INVALID_INPUT, "NO_FLOWS", "aucun flux");
      if(R1.add(rate).isZero()) return failRes(STATUS.INVALID_INPUT, "RATE_MINUS_ONE", "taux = −100 % : actualisation impossible");
      var v = npvRat(rate, flows);
      // vérification : Horner (autre ordre de calcul) + valeur flottante
      var h = R0, f = R1.add(rate), i; for(i = flows.length - 1; i >= 0; i--) h = h.add(flows[i]).div(i === 0 ? R1 : f);
      var fl = 0; flows.forEach(function(c, t){ fl += c.toNumber() / Math.pow(f.toNumber(), t); });
      var ok = h.eq(v) && Math.abs(fl - v.toNumber()) <= 1e-9 * Math.max(1, Math.abs(fl));
      return mkFin("npv", v, { lang: (o || {}).lang, rounded: roundHalfUp(v, 2), steps: ["VAN = Σ CFₜ / (1 + r)ᵗ", flows.map(function(c, t){ return ratText(c) + (t ? "/(" + ratText(f) + ")^" + t : ""); }).join(" + ") + " = " + ratText(v)],
               verification: ok ? verif(STATUS.VERIFIED_EXACT, "Horner+flottants", "schéma de Horner exact identique ; recoupé par un calcul en flottants") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") });
    }catch(e){ return fromError(e); }
  }
  function irr(flows, o){
    try{
      if(flows.length < 2) return failRes(STATUS.INVALID_INPUT, "FEW_FLOWS", "au moins deux flux");
      var signs = 0, prev = 0; flows.forEach(function(c){ var s = c.sign(); if(s !== 0){ if(prev !== 0 && s !== prev) signs++; prev = s; } });
      if(signs === 0) return failRes(STATUS.INVALID_INPUT, "NO_SIGN_CHANGE", "les flux ont tous le même signe : pas de TRI");
      var f = function(r){ var s = 0, t; for(t = 0; t < flows.length; t++) s += flows[t].toNumber() / Math.pow(1 + r, t); return s; };
      var lo = -0.9999, hi = 10, flo = f(lo), fhi = f(hi);
      if(flo * fhi > 0){ hi = 1000; fhi = f(hi); }
      if(flo * fhi > 0) return failRes(STATUS.UNSUPPORTED, "NO_BRACKET", "TRI introuvable dans ]−100 % ; 100000 %]");
      var mid, it; for(it = 0; it < 200; it++){ mid = (lo + hi) / 2; var fm = f(mid); if(fm === 0) break; if(flo * fm < 0){ hi = mid; fhi = fm; } else { lo = mid; flo = fm; } }
      var r = (lo + hi) / 2, resid = Math.abs(f(r)), scale = flows.reduce(function(a, c){ return a + Math.abs(c.toNumber()); }, 0);
      var okR = resid <= 1e-9 * Math.max(1, scale);
      return { ok: true, kind: "irr", engine: "fast", value: null, exact: null, approx: { text: C.fmtFloat(r * 100, 4, (o || {}).lang) + " %", value: r },
               verification: okR ? verif(STATUS.VERIFIED_NUMERICALLY, "VAN(TRI)≈0", "VAN au TRI trouvé = " + resid.toExponential(1) + " (≈ 0) — vérification numérique, pas une preuve") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""),
               steps: ["TRI : taux r tel que VAN(r) = 0, trouvé par dichotomie"], notes: signs > 1 ? ["multiple-irr-possible"] : [] };
    }catch(e){ return fromError(e); }
  }
  function annuityPayment(P, r, n, o){            // mensualité constante : P r / (1 − (1+r)^−n)
    try{
      if(!Number.isInteger(n) || n < 1 || n > 1200) return failRes(STATUS.INVALID_INPUT, "BAD_N", "nombre de périodes invalide");
      var f = R1.add(r), pm;
      if(r.isZero()) pm = P.div(rat(n)); else pm = P.mul(r).div(R1.sub(f.pow(-n)));
      // vérification : amortissement période par période → capital restant dû nul (exact)
      var bal = P, i; for(i = 0; i < n; i++) bal = bal.mul(f).sub(pm);
      return mkFin("annuity-payment", pm, { lang: (o || {}).lang, rounded: roundHalfUp(pm, 2), total: pm.mul(rat(n)), steps: ["M = P·r / (1 − (1+r)^−n)"], verification: bal.isZero() ? verif(STATUS.VERIFIED_EXACT, "amortissement-complet", "après " + n + " versements le capital restant dû est exactement 0") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", "") });
    }catch(e){ return fromError(e); }
  }
  function proportionalRate(r, m){ return mkFin("proportional-rate", r.div(rat(m)), { steps: ["taux proportionnel = r / m"], verification: verif(STATUS.VERIFIED_EXACT, "produit-inverse", "taux × m = r exactement") }); }
  function effectiveRate(r, m){ var v = R1.add(r.div(rat(m))).pow(m).sub(R1); return mkFin("effective-rate", v, { steps: ["taux effectif = (1 + r/m)^m − 1"], verification: verif(STATUS.VERIFIED_EXACT, "capitalisation-itérée", "m capitalisations successives donnent le même facteur") }); }
  function equivalentRate(r, fromPer, toPer, o){   // (1+r)^(fromPer/toPer) − 1 : en général irrationnel
    try{
      var expo = rat(fromPer, toPer), base = R1.add(r), exact = null;
      try{ exact = C.evalExact({ t: "bin", op: "^", l: C.qnode(base), r: C.qnode(expo) }, {}).sub(R1); }catch(e){ if(!(e && e.name === "MathError" && e.code === "IRRATIONAL")) throw e; }
      if(exact) return mkFin("equivalent-rate", exact, { steps: ["taux équivalent = (1+r)^(p₁/p₂) − 1"], verification: verif(STATUS.VERIFIED_EXACT, "puissance-inverse", "(1 + taux équivalent)^(p₂/p₁) = 1 + r : " + R1.add(exact).pow(toPer).eq(R1.add(r).pow(fromPer)) ) });
      var v = Math.pow(base.toNumber(), fromPer / toPer) - 1, back = Math.pow(1 + v, toPer / fromPer) - 1;
      return { ok: true, kind: "equivalent-rate", engine: "fast", value: null, exact: null, approx: { text: C.fmtFloat(v * 100, 6, (o || {}).lang) + " %", value: v }, needsCAS: false,
               verification: Math.abs(back - r.toNumber()) < 1e-12 ? verif(STATUS.VERIFIED_NUMERICALLY, "relation-inverse", "(1 + taux)^(p₂/p₁) − 1 retrouve r à 1e-12 près — vérification numérique") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""), steps: ["taux équivalent = (1+r)^(p₁/p₂) − 1 (irrationnel : valeur approchée)"], notes: ["irrational"] };
    }catch(e){ return fromError(e); }
  }
  function cagr(v0, v1, years, o){
    try{
      if(v0.sign() <= 0 || v1.sign() <= 0 || years.sign() <= 0) return failRes(STATUS.INVALID_INPUT, "BAD_VALUES", "valeurs et durée strictement positives requises");
      var ratio = v1.div(v0), exact = null;
      try{ exact = C.evalExact({ t: "bin", op: "^", l: C.qnode(ratio), r: C.qnode(R1.div(years)) }, {}).sub(R1); }catch(e){ if(!(e && e.name === "MathError" && e.code === "IRRATIONAL")) throw e; }
      if(exact) return mkFin("cagr", exact, { steps: ["TCAM = (V₁/V₀)^(1/n) − 1"], verification: verif(STATUS.VERIFIED_EXACT, "puissance-inverse", "V₀ × (1 + TCAM)^n = V₁ : " + (years.isInt() ? v0.mul(R1.add(exact).pow(Number(years.n))).eq(v1) : "n non entier") ) });
      var g = Math.pow(ratio.toNumber(), 1 / years.toNumber()) - 1, back = v0.toNumber() * Math.pow(1 + g, years.toNumber());
      return { ok: true, kind: "cagr", engine: "fast", value: null, exact: null, approx: { text: C.fmtFloat(g * 100, 4, (o || {}).lang) + " %", value: g },
               verification: Math.abs(back - v1.toNumber()) <= 1e-9 * v1.toNumber() ? verif(STATUS.VERIFIED_NUMERICALLY, "V₀(1+g)^n=V₁", "reconstitue V₁ à 1e-9 près — vérification numérique") : verif(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "check-failed", ""), steps: ["TCAM = (V₁/V₀)^(1/n) − 1"], notes: ["irrational"] };
    }catch(e){ return fromError(e); }
  }

  NS.fast = {
    arithmetic: arithmetic, solveEquation: solveEquation, factorPoly: factorPoly, expandPoly: expandPoly, derivativePoly: derivativePoly, integralPoly: integralPoly,
    simplifyRational: simplifyRational, matrixOp: matrixOp, matFromAst: matFromAst, matText: matText, solveSystem: solveSystem, solveLinearMatrix: solveLinearMatrix,
    descriptive: descriptive, zScore: zScore, covariance: covariance, quantile: quantile,
    binomial: binomial, normal: normal, bayes: bayes, erf: erf, normalCdf: normalCdfFloat, normalInv: normalInvFloat,
    percentOf: percentOf, percentChange: percentChange, compound: compound, simpleInterest: simpleInterest, discount: discount, npv: npv, irr: irr,
    annuityPayment: annuityPayment, proportionalRate: proportionalRate, effectiveRate: effectiveRate, equivalentRate: equivalentRate, cagr: cagr,
    rationalRoots: rationalRoots, quadraticRoots: quadraticRoots, polyToText: polyToText, polyToLatex: polyToLatex, polyGcd: polyGcd, polyDivmod: polyDivmod,
    gaussLegendre: gaussLegendre, roundHalfUp: roundHalfUp, money: money, presentRat: presentRat, needsCAS: needsCAS, failRes: failRes, fromError: fromError,
    rref: rref, matMul: matMul, detLaplace: detLaplace
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
