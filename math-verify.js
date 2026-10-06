/* ============================================================================
   math-verify.js — le MATH VERIFIER de REV-EM (pur, indépendant du CAS)
   ----------------------------------------------------------------------------
   `globalThis.RevemMath.verify` — dépend de math-core.js (+ math-fast.js pour la quadrature).

   Principe : un résultat n'est pas « bon » parce qu'un moteur l'a produit. Chaque résultat du CAS est
   RE-CONTRÔLÉ ici par une méthode qui n'utilise ni SymPy ni la même route de calcul :

     équation / système  → substitution (flottante ici ; exacte quand le Fast Engine peut la faire)
     dérivée             → différences centrées (Richardson) en plusieurs points
     primitive           → dérivée numérique de la primitive = fonction de départ
     intégrale définie   → quadrature de Gauss-Legendre
     limite              → évaluation de part et d'autre / à grande valeur
     simplification      → égalité en de nombreux points valides (et EXACTE pour les polynômes)
     matrice inverse     → A × A⁻¹ = I (exact si rationnelle)

   HONNÊTETÉ : un contrôle numérique n'est PAS une preuve. Seuls les contrôles par arithmétique exacte
   donnent VERIFIED_EXACT ; les autres donnent VERIFIED_NUMERICALLY. Si on ne sait pas contrôler :
   COMPUTED_NOT_INDEPENDENTLY_VERIFIED — jamais un faux « vérifié ».
   ============================================================================ */
(function(global){
  "use strict";
  var NS = global.RevemMath = global.RevemMath || {};
  var C = NS.core;
  if(!C) throw new Error("math-verify.js : charger math-core.js d'abord");
  var STATUS = C.STATUS, poly = C.poly, rat = C.rat;

  function v(status, method, detail){ return { status: status, method: method, detail: detail || "" }; }
  /* « réfuté » : un contrôle CONCRET a échoué (≠ « je ne sais pas contrôler »). Un résultat réfuté n'est jamais affiché comme résultat. */
  function rf(method, detail){ var o = v(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method, detail); o.refuted = true; return o; }
  function unverified(why){ return v(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "none", why || "aucune méthode de contrôle indépendante disponible pour ce cas"); }

  /* Points d'essai déterministes (non entiers, pour éviter les singularités « évidentes » 0, 1, -1). */
  var POINTS = [0.5, 1.5, -0.7, 2.3, 3.1, -1.9, 0.13, 5.7, 1.01, -3.3, 2.71, 0.9, 4.4, -0.35];
  function envFor(vars, k){
    var env = {}; vars.forEach(function(name, i){ env[name] = POINTS[(k * 3 + i * 5) % POINTS.length]; }); return env;
  }
  function safeEval(ast, env){ try{ return C.evalFloat(ast, env); }catch(e){ return null; } }
  function close(a, b, tol){ tol = tol || 1e-8; return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)); }

  /* ── 1. ÉQUIVALENCE de deux expressions ──────────────────────────────────── */
  function equivalent(a, b, o){
    o = o || {};
    var vars = C.freeVars({ t: "eq", l: a, r: b });
    // polynômes à une variable (ou constantes) : égalité EXACTE des coefficients
    if(vars.length <= 1){
      var vn = vars[0] || "x", pa = poly.fromAst(a, vn), pb = poly.fromAst(b, vn);
      if(pa && pb){
        var eqp = poly.eq(pa, pb);
        return { equal: eqp, status: STATUS.VERIFIED_EXACT, method: "égalité-exacte-des-polynômes", points: 0 };
      }
    }
    // numérique : N points où les DEUX expressions sont définies
    var ok = 0, bad = 0, domainMismatch = 0, k;
    for(k = 0; k < 40 && ok < 8; k++){
      var env = envFor(vars, k), x = safeEval(a, env), y = safeEval(b, env);
      if(x === null && y === null) continue;
      if(x === null || y === null){ domainMismatch++; continue; }
      if(close(x, y, o.tol || 1e-8)) ok++; else bad++;
    }
    if(bad > 0) return { equal: false, status: STATUS.VERIFIED_NUMERICALLY, method: "échantillonnage", points: ok + bad };
    if(ok < 3) return { equal: null, status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "échantillonnage-insuffisant", points: ok };
    return { equal: true, status: STATUS.VERIFIED_NUMERICALLY, method: "échantillonnage", points: ok, domainMismatch: domainMismatch };
  }

  /* ── 2. DÉRIVÉE : différences centrées de Richardson ──────────────────── */
  function numDeriv(f, x){
    var h = 1e-3 * Math.max(1, Math.abs(x));
    function d(hh){ return (f(x + hh) - f(x - hh)) / (2 * hh); }
    return (4 * d(h / 2) - d(h)) / 3;
  }
  function verifyDerivative(fAst, dAst, name){
    var vars = C.freeVars(fAst).filter(function(x){ return x !== name; }), good = 0, bad = 0, k;
    for(k = 0; k < 40 && good + bad < 8; k++){
      var env = envFor(vars.concat([name]), k), x0 = env[name];
      var f = function(x){ var e = Object.assign({}, env); e[name] = x; return C.evalFloat(fAst, e); };
      var nd, ex;
      try{ nd = numDeriv(f, x0); ex = C.evalFloat(dAst, env); }catch(e){ continue; }
      if(!isFinite(nd) || !isFinite(ex)) continue;
      if(close(nd, ex, 1e-5)) good++; else bad++;
    }
    if(bad) return rf("différences-centrées", "écart constaté en " + bad + " point(s) : résultat NON confirmé");
    if(good < 3) return unverified("trop peu de points valides pour contrôler la dérivée");
    return v(STATUS.VERIFIED_NUMERICALLY, "différences-centrées(Richardson)", "dérivée numérique concordante en " + good + " points — vérification numérique, pas une preuve");
  }
  function verifyAntiderivative(fAst, FAst, name){      // F′ = f ?
    var vars = C.freeVars(fAst).filter(function(x){ return x !== name; }), good = 0, bad = 0, k;
    for(k = 0; k < 40 && good + bad < 8; k++){
      var env = envFor(vars.concat([name]), k), x0 = env[name];
      var F = function(x){ var e = Object.assign({}, env); e[name] = x; return C.evalFloat(FAst, e); };
      var nd, ex;
      try{ nd = numDeriv(F, x0); ex = C.evalFloat(fAst, env); }catch(e){ continue; }
      if(!isFinite(nd) || !isFinite(ex)) continue;
      if(close(nd, ex, 1e-5)) good++; else bad++;
    }
    if(bad) return rf("dérivée-de-la-primitive", "F′ ≠ f en " + bad + " point(s) : résultat NON confirmé");
    if(good < 3) return unverified("trop peu de points valides pour contrôler la primitive");
    return v(STATUS.VERIFIED_NUMERICALLY, "dérivée-numérique-de-la-primitive", "F′ = f en " + good + " points — vérification numérique, pas une preuve (la constante C est arbitraire)");
  }

  /* ── 3. INTÉGRALE DÉFINIE : Gauss-Legendre ────────────────────────────── */
  function verifyDefiniteIntegral(fAst, name, a, b, value){
    var F = NS.fast;
    if(!F) return unverified("Fast Engine absent");
    try{
      var f = function(x){ var e = {}; e[name] = x; return C.evalFloat(fAst, e); };
      var q, improper = !isFinite(a) || !isFinite(b);
      if(improper){
        // bornes infinies : changement de variable x = a + t/(1−t) (ou x = b − t/(1−t)) sur t ∈ [0 ; 1[, puis quadrature — aucune borne infinie n'est évaluée
        if(isNaN(a) || isNaN(b) || a === b || (a === Infinity) || (b === -Infinity)) return unverified("intégrale impropre : bornes inattendues");
        var up = function(lo){ return F.gaussLegendre(function(t){ var u = 1 - t; return f(lo + t / u) / (u * u); }, 0, 1); };
        var down = function(hi){ return F.gaussLegendre(function(t){ var u = 1 - t; return f(hi - t / u) / (u * u); }, 0, 1); };
        if(isFinite(a) && b === Infinity) q = up(a);
        else if(a === -Infinity && isFinite(b)) q = down(b);
        else if(a === -Infinity && b === Infinity) q = up(0) + down(0);
        else return unverified("intégrale impropre : bornes inattendues");
        if(!isFinite(q)) return unverified("intégrale impropre : quadrature impossible (singularité ou divergence)");
        return close(q, value, 1e-5) ? v(STATUS.VERIFIED_NUMERICALLY, "Gauss-Legendre (changement de variable x = a + t/(1−t))", "quadrature de l'intégrale impropre = " + q.toPrecision(8) + " — vérification numérique, pas une preuve")
                                     : v(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "Gauss-Legendre (impropre)", "quadrature " + q.toPrecision(8) + " ≠ " + value + " : résultat NON confirmé");
      }
      q = F.gaussLegendre(f, a, b);
      if(!isFinite(q)) return unverified("quadrature impossible (singularité ?)");
      return close(q, value, 1e-7) ? v(STATUS.VERIFIED_NUMERICALLY, "Gauss-Legendre", "quadrature = " + q.toPrecision(10) + " — vérification numérique, pas une preuve")
                                   : v(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "Gauss-Legendre", "quadrature " + q.toPrecision(8) + " ≠ " + value + " : résultat NON confirmé");
    }catch(e){ return unverified("quadrature impossible : " + e.message); }
  }

  /* ── 4. LIMITE ─────────────────────────────────────────────────────────── */
  function verifyLimit(fAst, name, point, side, result){
    // point : nombre fini | "oo" | "-oo" ; result : nombre | "oo" | "-oo" | null (n'existe pas)
    var f = function(x){ var e = {}; e[name] = x; return C.evalFloat(fAst, e); };
    var xs, vals = [], i;
    try{
      if(point === "oo" || point === "-oo"){ var sg = point === "oo" ? 1 : -1; xs = [sg * 10, sg * 100, sg * 1e3, sg * 1e5, sg * 1e7]; }
      else {
        var hs = [1e-2, 1e-3, 1e-4], sides = side === "+" ? [1] : (side === "-" ? [-1] : [1, -1]);
        xs = []; hs.forEach(function(h){ sides.forEach(function(s){ xs.push(point + s * h); }); });
      }
      xs.forEach(function(x){ var y = null; try{ y = f(x); }catch(e){ y = null; } vals.push(y); });
    }catch(e){ return unverified("évaluation impossible"); }
    var valid = vals.filter(function(y){ return y !== null && isFinite(y); });
    if(valid.length < 2) return unverified("fonction non évaluable près du point");
    if(result === "oo" || result === "-oo"){
      var s = result === "oo" ? 1 : -1, fin = vals.filter(function(y){ return y !== null && isFinite(y); }), last = fin[fin.length - 1];
      var grows = fin.length >= 2 && s * last > 100 && fin.every(function(y, j){ return j === 0 || s * y >= s * fin[j - 1]; });
      return grows ? v(STATUS.VERIFIED_NUMERICALLY, "évaluation-près-du-point", "les valeurs divergent vers " + (s > 0 ? "+∞" : "-∞") + " — vérification numérique, pas une preuve")
                   : v(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "évaluation-près-du-point", "divergence NON confirmée numériquement");
    }
    if(typeof result !== "number") return unverified("limite non numérique");
    // chaque côté séparément : l'écart à la limite doit DÉCROÎTRE quand on s'approche, et finir petit
    var nSides = (point === "oo" || point === "-oo") ? 1 : sides.length, perSide = vals.length / nSides, okAll = true, checked = 0, contradicted = false;
    for(var sd = 0; sd < nSides; sd++){
      var errs = [], ys = [];
      for(var k = 0; k < perSide; k++){ var y = (point === "oo" || point === "-oo") ? vals[k] : vals[k * nSides + sd]; if(y !== null && isFinite(y)){ errs.push(Math.abs(y - result)); ys.push(y); } }
      if(errs.length < 2) continue;
      checked++;
      var scale = Math.max(1, Math.abs(result)), last = errs[errs.length - 1];
      var shrinking = errs.every(function(e, j){ return j === 0 || e <= errs[j - 1] + 1e-12 * scale; });
      if(!(shrinking && last <= 5e-3 * scale)) okAll = false;
      // les valeurs se STABILISENT ailleurs que sur la limite annoncée : le résultat est CONTREDIT (≠ « convergence trop lente pour conclure »)
      var yl = ys[ys.length - 1], yp = ys[ys.length - 2];
      if(ys.length >= 3 && Math.abs(yl - yp) <= 1e-4 * Math.max(1, Math.abs(yl)) && last > 1e-2 * scale) contradicted = true;
    }
    if(checked && contradicted) return rf("évaluation-près-du-point", "les valeurs se stabilisent AILLEURS que sur " + result + " : résultat contredit");
    return checked && okAll ? v(STATUS.VERIFIED_NUMERICALLY, "évaluation-près-du-point", "valeurs voisines du point → " + result + " — vérification numérique, pas une preuve")
                 : v(STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, "évaluation-près-du-point", "les valeurs ne convergent pas clairement vers " + result);
  }

  /* ── 5. ÉQUATIONS / SYSTÈMES ──────────────────────────────────────────── */
  function verifyEquationRoots(eqAst, name, roots){      // roots : nombres réels (flottants) ; les complexes sont contrôlés par le CAS
    var lhs = eqAst.t === "eq" ? eqAst.l : eqAst, rhs = eqAst.t === "eq" ? eqAst.r : C.mkq(0);
    if(!roots.length) return unverified("aucune racine réelle à substituer");
    var bad = 0, scaleBad = [];
    roots.forEach(function(r){
      try{
        var env = {}; env[name] = r;
        var a = C.evalFloat(lhs, env), b = C.evalFloat(rhs, env);
        var scale = Math.max(1, Math.abs(a), Math.abs(b));
        if(Math.abs(a - b) > 1e-7 * scale) bad++;
      }catch(e){ bad++; }
    });
    return bad ? rf("substitution", bad + " solution(s) ne vérifient PAS l'équation")
               : v(STATUS.VERIFIED_NUMERICALLY, "substitution-flottante", "chaque solution réelle réinjectée annule l'équation à 1e-7 près — vérification numérique, pas une preuve");
  }
  function verifySystem(eqs, solution){
    var bad = 0;
    eqs.forEach(function(e){ try{ var a = C.evalFloat(e.l, solution), b = C.evalFloat(e.r, solution); if(Math.abs(a - b) > 1e-7 * Math.max(1, Math.abs(a), Math.abs(b))) bad++; }catch(er){ bad++; } });
    return bad ? rf("réinjection", "la solution ne vérifie pas " + bad + " équation(s)") : v(STATUS.VERIFIED_NUMERICALLY, "réinjection-flottante", "la solution vérifie chaque équation à 1e-7 près — vérification numérique");
  }

  /* ── 6. MATRICES ──────────────────────────────────────────────────────── */
  function verifyMatrixInverse(A, Ainv){                  // A, Ainv : tableaux de nombres (flottants) OU de Rat
    var n = A.length, i, j, k, worst = 0, exact = A.every(function(r){ return r.every(function(c){ return c instanceof C.Rat; }); }) && Ainv.every(function(r){ return r.every(function(c){ return c instanceof C.Rat; }); });
    if(exact){
      var F = NS.fast; var P = F.matMul(A, Ainv), ok = true;
      for(i = 0; i < n; i++) for(j = 0; j < n; j++){ var want = i === j ? rat(1) : rat(0); if(!P[i][j].eq(want)) ok = false; }
      return ok ? v(STATUS.VERIFIED_EXACT, "A×A⁻¹=I", "produit exact égal à l'identité") : rf("A×A⁻¹=I", "A·A⁻¹ ≠ I");
    }
    for(i = 0; i < n; i++) for(j = 0; j < n; j++){ var s = 0; for(k = 0; k < n; k++) s += Number(A[i][k]) * Number(Ainv[k][j]); worst = Math.max(worst, Math.abs(s - (i === j ? 1 : 0))); }
    return worst < 1e-9 ? v(STATUS.VERIFIED_NUMERICALLY, "A×A⁻¹≈I", "écart maximal à l'identité : " + worst.toExponential(1) + " — vérification numérique") : rf("A×A⁻¹≈I", "écart à l'identité : " + worst.toExponential(1));
  }

  /* ── 7. RÉPONSE D'UN ÉLÈVE ────────────────────────────────────────────────
     Compare MATHÉMATIQUEMENT (pas les chaînes) : 1/2 = 0,5 = 2/4 ; (x+1)^2 = x²+2x+1.
     Renvoie { verdict:"correct"|"incorrect"|"invalid"|"unsure", status, method, form, message } */
  function compareAnswer(studentText, expectedAst, o){
    o = o || {};
    var parsed;
    try{ parsed = C.parse(studentText, { decimalComma: o.decimalComma }); }
    catch(e){ return { verdict: "invalid", status: STATUS.INVALID_INPUT, method: "parse", message: e.message, code: e.code }; }
    var sAst = parsed.ast;
    if(sAst.t === "eq" && expectedAst.t !== "eq"){
      // « x = 3 » pour une valeur attendue 3 : on accepte l'écriture « variable = valeur »
      if(sAst.l.t === "sym") sAst = sAst.r; else return { verdict: "invalid", status: STATUS.INVALID_INPUT, method: "parse", message: "une valeur ou une expression est attendue, pas une équation" };
    }
    // valeur numérique : égalité EXACTE des rationnels si possible
    var sVars = C.freeVars(sAst), eVars = C.freeVars(expectedAst);
    var stray = sVars.filter(function(x){ return eVars.indexOf(x) < 0; });
    if(stray.length) return { verdict: "invalid", status: STATUS.INVALID_INPUT, method: "variables", message: "lettre(s) inattendue(s) dans la réponse : " + stray.join(", "), code: "STRAY_VARIABLES" };
    if(!sVars.length && !eVars.length){
      try{
        var a = C.evalExact(sAst, {}), b = C.evalExact(expectedAst, {});
        var eqx = a.eq(b);
        // unité : « 50 % » = 1/2 n'est accepté que si la réponse attendue est elle aussi un pourcentage ; sinon on signale la forme
        var pct = parsed.notes.indexOf("percent") >= 0;
        if(!eqx && pct && !(o.expectPercent)){
          try{ var raw = C.evalExact(C.parse(String(studentText).replace(/%/g, ""), { decimalComma: o.decimalComma }).ast, {}); if(raw.eq(b)) return { verdict: "correct", status: STATUS.VERIFIED_EXACT, method: "rationnels-exacts", form: "percent-as-number", message: "valeur correcte (écrite en pourcentage)" }; }catch(e2){}
        }
        return { verdict: eqx ? "correct" : "incorrect", status: STATUS.VERIFIED_EXACT, method: "rationnels-exacts" };
      }catch(e){
        if(!(e && e.name === "MathError" && e.code === "IRRATIONAL")) return { verdict: "invalid", status: STATUS.INVALID_INPUT, method: "eval", message: e.message, code: e.code };
        var fa, fb; try{ fa = C.evalFloat(sAst, {}); fb = C.evalFloat(expectedAst, {}); }catch(e3){ return { verdict: "unsure", status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "float" }; }
        if(close(fa, fb, 1e-9)) return { verdict: "correct", status: STATUS.VERIFIED_NUMERICALLY, method: "flottants", message: "valeurs égales numériquement (pas une preuve d'égalité exacte)" };
        return { verdict: "incorrect", status: STATUS.VERIFIED_NUMERICALLY, method: "flottants" };
      }
    }
    var eq = equivalent(sAst, expectedAst, o);
    if(eq.equal === null) return { verdict: "unsure", status: eq.status, method: eq.method };
    var out = { verdict: eq.equal ? "correct" : "incorrect", status: eq.status, method: eq.method };
    if(eq.equal && o.requireForm === "factored"){ if(!isFactored(sAst)){ out.verdict = "correct-wrong-form"; out.form = "not-factored"; out.message = "valeur équivalente, mais pas sous la forme factorisée demandée"; } }
    if(eq.equal && o.requireForm === "expanded"){ if(hasProductOfSums(sAst)){ out.verdict = "correct-wrong-form"; out.form = "not-expanded"; out.message = "valeur équivalente, mais pas développée"; } }
    return out;
  }
  function isFactored(ast){
    function strip(n){ return n.t === "neg" ? strip(n.a) : n; }
    var n = strip(ast);
    if(n.t === "bin" && n.op === "*") return true;
    if(n.t === "bin" && n.op === "^" && (n.l.t === "bin" && (n.l.op === "+" || n.l.op === "-"))) return true;
    return false;
  }
  function hasProductOfSums(ast){
    var hit = false;
    C.walk(ast, function(n){
      if(n.t === "bin" && n.op === "*" && ((n.l.t === "bin" && (n.l.op === "+" || n.l.op === "-")) || (n.r.t === "bin" && (n.r.op === "+" || n.r.op === "-")))) hit = true;
      if(n.t === "bin" && n.op === "^" && n.l.t === "bin" && (n.l.op === "+" || n.l.op === "-")) hit = true;
    });
    return hit;
  }

  /* ── 4bis. VALEURS PROPRES : det(A − λI) ≈ 0 pour chacune ; somme (avec multiplicités) = trace ; produit = déterminant ── */
  function detFloat(M){
    var n = M.length, a = M.map(function(r){ return r.slice(); }), d = 1, i, j, k;
    for(i = 0; i < n; i++){
      var p = i; for(j = i + 1; j < n; j++) if(Math.abs(a[j][i]) > Math.abs(a[p][i])) p = j;
      if(Math.abs(a[p][i]) < 1e-300) return 0;
      if(p !== i){ var tmp = a[p]; a[p] = a[i]; a[i] = tmp; d = -d; }
      d *= a[i][i];
      for(j = i + 1; j < n; j++){ var fct = a[j][i] / a[i][i]; for(k = i; k < n; k++) a[j][k] -= fct * a[i][k]; }
    }
    return d;
  }
  function verifyEigenvalues(A, eig){                    // eig : [{ value:number|null, mult }]
    try{
      var n = A.length, maxAbs = 1, i, j;
      for(i = 0; i < n; i++) for(j = 0; j < n; j++) maxAbs = Math.max(maxAbs, Math.abs(A[i][j]));
      var real = eig.filter(function(e){ return typeof e.value === "number"; });
      if(!real.length) return unverified("valeurs propres complexes : pas de contrôle réel");
      var bad = 0;
      real.forEach(function(e){
        var M = A.map(function(r, a){ return r.map(function(c, b){ return c - (a === b ? e.value : 0); }); });
        if(Math.abs(detFloat(M)) > 1e-8 * Math.pow(Math.max(maxAbs, Math.abs(e.value)), n)) bad++;
      });
      if(bad) return rf("det(A−λI)", bad + " valeur(s) propre(s) ne vérifient PAS det(A − λI) = 0");
      var detail = "det(A − λI) ≈ 0 pour chaque valeur propre";
      var tot = eig.reduce(function(s, e){ return s + e.mult; }, 0);
      if(tot !== n) return rf("multiplicités", "les valeurs propres annoncées comptent " + tot + " (avec multiplicités) pour une matrice " + n + "×" + n + " : une valeur propre manque");
      if(real.length === eig.length){
        if(tot === n){
          var tr = 0; for(i = 0; i < n; i++) tr += A[i][i];
          var sum = eig.reduce(function(s, e){ return s + e.value * e.mult; }, 0), prod = eig.reduce(function(s, e){ return s * Math.pow(e.value, e.mult); }, 1);
          if(!close(sum, tr, 1e-8) || !close(prod, detFloat(A), 1e-7)) return unverified("somme/produit des valeurs propres ≠ trace/déterminant : valeur propre manquante ou fausse");
          detail += " ; somme = trace et produit = déterminant";
        }
      }
      return v(STATUS.VERIFIED_NUMERICALLY, "det(A−λI)≈0 + trace/déterminant (flottants)", detail + " — vérification numérique, pas une preuve");
    }catch(e){ return unverified("contrôle impossible : " + e.message); }
  }

  NS.verify = {
    equivalent: equivalent, verifyDerivative: verifyDerivative, verifyAntiderivative: verifyAntiderivative, verifyDefiniteIntegral: verifyDefiniteIntegral,
    verifyLimit: verifyLimit, verifyEquationRoots: verifyEquationRoots, verifySystem: verifySystem, verifyMatrixInverse: verifyMatrixInverse,
    verifyEigenvalues: verifyEigenvalues, compareAnswer: compareAnswer, numDeriv: numDeriv, unverified: unverified, isFactored: isFactored
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
