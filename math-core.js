/* ============================================================================
   math-core.js — le SOCLE du moteur mathématique REV-EM (pur, sans DOM, sans réseau)
   ----------------------------------------------------------------------------
   `globalThis.RevemMath.core` — même patron que ai-engine.js, assistant-core.js…
   Testable sous Node : `node tests/math-engine.test.js`.

   Ce fichier est la SEULE chose que le Fast Engine et le CAS partagent :

     texte ─▶ normalize ─▶ parse ─▶ AST (JSON)  ─┬▶ evalExact   (rationnels BigInt, exact)
                                                 ├▶ evalFloat   (double, domaine vérifié)
                                                 ├▶ toText / toLatex
                                                 └▶ (vers le worker CAS : l'AST, JAMAIS du code)

   SÉCURITÉ : aucun eval, aucun Function, aucune exécution de code fourni par
   l'utilisateur. Le texte est réduit à un AST par un analyseur à liste blanche ;
   seul l'AST (nombres, symboles, opérateurs, fonctions connues) est ensuite
   interprété — ici, et côté CAS par une table de construction, pas par du code.

   EXACTITUDE : les nombres sont des rationnels (BigInt). « 1/3 » reste 1/3 ;
   on n'arrondit qu'à l'affichage.

   Compatibilité : BigInt (Safari ≥ 14), aucune regex à lookbehind.
   ============================================================================ */
(function(global){
  "use strict";

  var NS = global.RevemMath = global.RevemMath || {};

  /* ── 0. STATUTS ET ERREURS ──────────────────────────────────────────────────
     Statuts de confiance INTERNES (jamais affichés tels quels à l'élève). */
  var STATUS = {
    VERIFIED_EXACT: "VERIFIED_EXACT",                       // vérifié par une méthode exacte indépendante
    VERIFIED_NUMERICALLY: "VERIFIED_NUMERICALLY",           // vérifié numériquement : PAS une preuve
    COMPUTED_NOT_INDEPENDENTLY_VERIFIED: "COMPUTED_NOT_INDEPENDENTLY_VERIFIED",
    UNSUPPORTED: "UNSUPPORTED",
    INVALID_INPUT: "INVALID_INPUT",
    AMBIGUOUS: "AMBIGUOUS"
  };

  function MathError(code, message, extra){
    this.name = "MathError"; this.code = code; this.message = message || code;
    if(Error.captureStackTrace) Error.captureStackTrace(this, MathError);
    if(extra) for(var k in extra) if(Object.prototype.hasOwnProperty.call(extra, k)) this[k] = extra[k];
  }
  MathError.prototype = Object.create(Error.prototype);
  MathError.prototype.constructor = MathError;
  function fail(code, msg, extra){ throw new MathError(code, msg, extra); }

  /* ── 1. RATIONNELS EXACTS (BigInt) ──────────────────────────────────────── */
  var ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), TEN = BigInt(10);
  var MAX_DIGITS = 6000;            // au-delà : « calcul trop volumineux », pas de blocage silencieux
  var MAX_EXP = 4000;

  function babs(a){ return a < ZERO ? -a : a; }
  function bgcd(a, b){ a = babs(a); b = babs(b); while(b !== ZERO){ var t = a % b; a = b; b = t; } return a; }
  function digitsOf(b){ return babs(b).toString().length; }

  function Rat(n, d){
    if(d === undefined) d = ONE;
    if(d === ZERO) fail("DIV_ZERO", "division par zéro");
    if(d < ZERO){ n = -n; d = -d; }
    var g = bgcd(n, d);
    if(g > ONE){ n = n / g; d = d / g; }
    if(digitsOf(n) > MAX_DIGITS || digitsOf(d) > MAX_DIGITS) fail("TOO_COMPLEX", "nombre trop volumineux");
    this.n = n; this.d = d;
  }
  Rat.prototype.add = function(o){ return new Rat(this.n * o.d + o.n * this.d, this.d * o.d); };
  Rat.prototype.sub = function(o){ return new Rat(this.n * o.d - o.n * this.d, this.d * o.d); };
  Rat.prototype.mul = function(o){ return new Rat(this.n * o.n, this.d * o.d); };
  Rat.prototype.div = function(o){ if(o.n === ZERO) fail("DIV_ZERO", "division par zéro"); return new Rat(this.n * o.d, this.d * o.n); };
  Rat.prototype.neg = function(){ return new Rat(-this.n, this.d); };
  Rat.prototype.abs = function(){ return new Rat(babs(this.n), this.d); };
  Rat.prototype.isZero = function(){ return this.n === ZERO; };
  Rat.prototype.isInt = function(){ return this.d === ONE; };
  Rat.prototype.sign = function(){ return this.n === ZERO ? 0 : (this.n < ZERO ? -1 : 1); };
  Rat.prototype.cmp = function(o){ var a = this.n * o.d, b = o.n * this.d; return a < b ? -1 : (a > b ? 1 : 0); };
  Rat.prototype.eq = function(o){ return this.n === o.n && this.d === o.d; };
  Rat.prototype.pow = function(k){
    if(typeof k !== "number" || Math.floor(k) !== k) fail("UNSUPPORTED", "exposant non entier");
    if(Math.abs(k) > MAX_EXP) fail("TOO_COMPLEX", "exposant trop grand");
    if(k === 0){ if(this.n === ZERO) fail("INVALID_INPUT", "0^0 indéterminé"); return new Rat(ONE); }
    var base = k < 0 ? new Rat(this.d, this.n) : this, e = Math.abs(k), r = new Rat(ONE);
    if(this.n === ZERO && k < 0) fail("DIV_ZERO", "division par zéro");
    // exponentiation rapide ; la taille est contrôlée à chaque produit (constructeur)
    var b = base;
    while(e > 0){ if(e & 1) r = r.mul(b); e = Math.floor(e / 2); if(e > 0) b = b.mul(b); }
    return r;
  };
  Rat.prototype.toNumber = function(){
    var a = babs(this.n), d = this.d, sgn = this.n < ZERO ? -1 : 1;
    if(digitsOf(a) < 300 && digitsOf(d) < 300) return sgn * Number(a) / Number(d);
    // très grand : on met à l'échelle pour éviter Infinity/Infinity
    var shift = Math.max(digitsOf(a), digitsOf(d)) - 300;
    var s = BigInt(10) ** BigInt(shift);
    return sgn * Number(a / s) / Number(d / s);
  };
  Rat.prototype.toString = function(){ return this.d === ONE ? this.n.toString() : this.n.toString() + "/" + this.d.toString(); };
  function rat(n, d){ return new Rat(BigInt(n), d === undefined ? ONE : BigInt(d)); }

  /* Décimal EXACT d'un rationnel (division longue). Renvoie { text, exact } : `exact` = vrai si le développement
     décimal s'arrête (1/8 → 0.125) ; sinon arrondi « moitié vers le haut » à `digits` décimales. */
  function ratToDecimal(r, digits){
    digits = digits === undefined ? 6 : digits;
    var neg = r.n < ZERO, n = babs(r.n), d = r.d;
    var ip = n / d, rem = n % d, frac = "", exact = false, i;
    if(rem === ZERO) exact = true;
    for(i = 0; i < digits && rem !== ZERO; i++){ rem *= TEN; frac += (rem / d).toString(); rem = rem % d; }
    if(rem === ZERO) exact = true;
    else {
      // arrondi au dernier chiffre : on regarde le chiffre suivant
      var nextDigit = (rem * TEN) / d;
      if(nextDigit >= BigInt(5)){
        var all = ip.toString() + frac, up = (BigInt(all) + ONE).toString();
        while(up.length < all.length) up = "0" + up;
        ip = BigInt(up.slice(0, up.length - frac.length) || "0");
        frac = frac.length ? up.slice(up.length - frac.length) : "";
      }
    }
    if(exact) frac = frac.replace(/0+$/, "");
    var text = ip.toString() + (frac.length ? "." + frac : "");
    if(!exact) text = text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    if(neg && /[1-9]/.test(text)) text = "-" + text;
    return { text: text, exact: exact };
  }

  /* Racine carrée d'un rationnel positif → { coef: Rat, rad: BigInt } avec sqrt(r) = coef × √rad, rad sans facteur carré
     (quand c'est faisable). Si rad = 1 : la racine est exacte. */
  function isqrt(n){
    if(n < ZERO) fail("DOMAIN", "racine d'un négatif");
    if(n < TWO) return n;
    var x = ONE << BigInt(Math.ceil(n.toString(2).length / 2));       // départ ≥ √n, puis Newton décroissant
    for(;;){ var y = (x + n / x) >> ONE; if(y >= x) break; x = y; }
    return x;
  }
  function squareFreePart(n){          // n = s² × m, m sans facteur carré → [s, m] (n limité pour rester instantané)
    var s = ONE, m = n, p;
    if(digitsOf(n) > 15) return [ONE, n];
    var N = Number(n);
    for(p = 2; p * p <= N; p++){
      var P = BigInt(p);
      while(m % (P * P) === ZERO){ m = m / (P * P); s = s * P; }
      if(m === ONE) break;
      N = Number(m);
    }
    return [s, m];
  }
  function sqrtRat(r){
    if(r.sign() < 0) fail("DOMAIN", "racine d'un négatif");
    var nd = r.n * r.d, root = isqrt(nd);
    if(root * root === nd) return { coef: new Rat(root, r.d), rad: ONE };      // √(n/d) = √(nd)/d
    var sf = squareFreePart(nd);
    return { coef: new Rat(sf[0], r.d), rad: sf[1] };
  }

  /* ── 2. NORMALISATION DE LA NOTATION ────────────────────────────────────────
     Comprend x², x^2, √x, ×, ÷, π, 0,5 / 0.5 (selon la langue), « 1 000 »… sans casser les séparateurs. */
  var SUP = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };
  var MULTIARG = /\b(binom|choose|nCr|ncr|log|root|mod|gcd|lcm|norm|normcdf)\s*\(/i;

  function normalize(text, opts){
    opts = opts || {};
    var s = String(text == null ? "" : text);
    s = s.replace(/[    ​]/g, " ");
    s = s.replace(/[−–—]/g, "-").replace(/[×·⋅∙]/g, "*").replace(/[÷]/g, "/").replace(/\*\*/g, "^");
    s = s.replace(/π/g, "pi").replace(/∞/g, "oo");
    // exposants Unicode : x² → x^2, x⁻¹ → x^-1, x¹⁰ → x^10
    s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, function(m){ var out = ""; for(var i = 0; i < m.length; i++) out += SUP[m.charAt(i)] || ""; return "^(" + out + ")"; });
    // |x| → abs(x) (nombre pair de barres seulement ; sinon on laisse « | » être refusé par le parseur)
    if(/\|/.test(s) && (s.match(/\|/g) || []).length % 2 === 0){ for(var pg = 0; pg < 10 && /\|[^|]*\|/.test(s); pg++) s = s.replace(/\|([^|]*)\|/, "abs($1)"); }
    // √x, √2, √(…) → sqrt(…)
    s = s.replace(/√\s*\(/g, "sqrt(");
    s = s.replace(/√\s*([A-Za-z0-9_.]+)/g, "sqrt($1)");
    s = s.replace(/∛\s*\(/g, "cbrt(").replace(/∛\s*([A-Za-z0-9_.]+)/g, "cbrt($1)");
    // « 1 000 » (milliers par espace) → 1000. RÈGLE : on ne recolle que si c'est sans ambiguïté — groupe de tête de 1 à 2 chiffres
    // (« 1 000 », « 12 500 »), espace insécable (typographie), ou groupe suivant commençant par 0 (« 200 000 »). Sinon « 500 600 »
    // reste deux nombres : l'analyseur dira « opérateur manquant » au lieu de fabriquer 500600.
    for(var guard = 0; guard < 6 && /(\d)[ \u00a0\u202f](\d{3})(?!\d)/.test(s); guard++){
      var before = s;
      s = s.replace(/(^|[^\d.,])(\d{1,3})((?:[ \u00a0\u202f]\d{3})+)(?!\d)/g, function(all, pre, lead, rest){
        var groups = rest.split(/[ \u00a0\u202f]/).slice(1), hasNb = /[\u00a0\u202f]/.test(rest);
        var ok = hasNb || lead.length <= 2 || groups.some(function(g){ return g.charAt(0) === "0"; });
        return ok ? pre + lead + groups.join("") : all;
      });
      if(s === before) break;
    }
    // virgule : décimale (« 0,5 » → 0.5) ou séparateur d'arguments/éléments. Le choix est fait par parse() (voir plus bas) :
    // ici on applique seulement le mode demandé. Anglais : « 1,500 » = milliers.
    if(/\d,\d/.test(s)){
      if(opts.decimalComma === false) s = s.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
      else if(opts.commaMode !== "sep") s = s.replace(/(\d),(\d)/g, "$1.$2");
    }
    return s.trim();
  }

  /* ── 3. ANALYSEUR (liste blanche) → AST ─────────────────────────────────────
     AST (JSON pur) :
       {t:"q", n:"3", d:"2"}          rationnel exact              {t:"sym", name:"x"}
       {t:"const", name:"pi"|"e"|"i"|"oo"}                         {t:"neg", a}
       {t:"bin", op:"+"|"-"|"*"|"/"|"^", l, r}                     {t:"call", fn, args:[…]}
       {t:"fact", a}                {t:"eq", l, r}                 {t:"mat", rows:[[…]]} */
  var FUNCS = { sqrt: 1, cbrt: 1, root: 2, abs: 1, exp: 1, ln: 1, log: [1, 2], log10: 1, log2: 1, sin: 1, cos: 1, tan: 1, asin: 1, acos: 1, atan: 1,
                sinh: 1, cosh: 1, tanh: 1, binom: 2, fact: 1, floor: 1, ceil: 1, sign: 1, mod: 2, gcd: 2, lcm: 2 };
  var FUNC_ALIAS = { pgcd: "gcd", ppcm: "lcm", modulo: "mod", arcsin: "asin", arccos: "acos", arctan: "atan", lg: "log10", sgn: "sign", ctg: "cot", choose: "binom", nCr: "binom", ncr: "binom", factorial: "fact", racine: "sqrt", exp_: "exp" };
  var CONSTS = { pi: 1, e: 1, i: 1, oo: 1, inf: 1 };
  var MAX_TOKENS = 400, MAX_DEPTH = 60, MAX_LEN = 1200;

  function tokenize(s){
    var toks = [], i = 0, n = s.length, c, m;
    while(i < n){
      c = s.charAt(i);
      if(c === " " || c === "\t" || c === "\n"){ i++; continue; }
      if(/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s.charAt(i + 1)))){
        m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
        var txt = m[0];
        // « 2e » (Euler) : l'exposant scientifique exige des chiffres, sinon on s'arrête avant le « e »
        toks.push({ k: "num", v: txt }); i += txt.length; continue;
      }
      if(/[A-Za-z_]/.test(c)){
        m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        toks.push({ k: "id", v: m[0] }); i += m[0].length; continue;
      }
      if("+-*/^()[],;=!%".indexOf(c) >= 0){ toks.push({ k: c }); i++; continue; }
      fail("INVALID_INPUT", "caractère non autorisé : « " + c + " »", { char: c });
    }
    if(toks.length > MAX_TOKENS) fail("TOO_COMPLEX", "expression trop longue");
    return toks;
  }

  function decimalToRat(txt){
    var m = /^(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(txt);
    if(!m) fail("INVALID_INPUT", "nombre invalide : " + txt);
    var ip = m[1] || "0", fp = m[2] || "", ex = m[3] ? parseInt(m[3], 10) : 0;
    if(Math.abs(ex) > MAX_EXP) fail("TOO_COMPLEX", "exposant trop grand");
    var num = BigInt(ip + fp), den = TEN ** BigInt(fp.length);
    if(ex > 0) num = num * (TEN ** BigInt(ex)); else if(ex < 0) den = den * (TEN ** BigInt(-ex));
    return new Rat(num, den);
  }
  function qnode(r){ return { t: "q", n: r.n.toString(), d: r.d.toString() }; }
  function qval(node){ return new Rat(BigInt(node.n), BigInt(node.d)); }

  function parseOnce(text, opts){
    opts = opts || {};
    var src = String(text == null ? "" : text);
    if(src.length > MAX_LEN) fail("TOO_COMPLEX", "expression trop longue");
    var s = normalize(src, opts);
    if(!s) fail("INVALID_INPUT", "expression vide");
    var toks = tokenize(s), pos = 0, notes = [], depth = 0, flatMatrix = false;

    function peek(){ return toks[pos]; }
    function next(){ return toks[pos++]; }
    function expect(k){ var t = next(); if(!t || t.k !== k) fail("INVALID_INPUT", "« " + k + " » attendu", { at: pos }); return t; }
    function enter(){ if(++depth > MAX_DEPTH) fail("TOO_COMPLEX", "expression trop imbriquée"); }
    function leave(){ depth--; }

    function startsPrimary(t){ return !!t && (t.k === "num" || t.k === "id" || t.k === "(" || t.k === "["); }

    function parseTop(){
      var l = parseSum(), t = peek();
      if(t && t.k === "="){ next(); var r = parseSum(); l = { t: "eq", l: l, r: r }; t = peek(); }
      if(t) fail("INVALID_INPUT", "expression invalide près de « " + (t.v || t.k) + " »", { at: pos });
      return l;
    }
    function parseSum(){
      enter();
      var l = parseTerm(), t;
      while((t = peek()) && (t.k === "+" || t.k === "-")){ next(); var r = parseTerm(); l = { t: "bin", op: t.k, l: l, r: r }; }
      leave(); return l;
    }
    function parseTerm(){
      var l = parseUnary(), t, afterDiv = false;
      for(;;){
        t = peek();
        if(t && (t.k === "*" || t.k === "/")){ next(); var r = parseUnary(); l = { t: "bin", op: t.k, l: l, r: r }; afterDiv = t.k === "/"; continue; }
        // multiplication IMPLICITE : 2x, 3(x+1), (a)(b), xy ; jamais « … 3 » (un nombre ne se colle jamais après un terme)
        if(startsPrimary(t) && !flatMatrix){
          if(t.k === "num") fail("INVALID_INPUT", "opérateur manquant avant le nombre " + t.v, { at: pos });
          var r2 = parseUnaryNoSign();
          if(afterDiv) notes.push("implicit-mult-after-division");
          l = { t: "bin", op: "*", l: l, r: r2, implicit: true };
          continue;
        }
        break;
      }
      return l;
    }
    function parseUnary(){
      var t = peek();
      if(t && (t.k === "-" || t.k === "+")){
        next(); enter(); var a = parseUnary(); leave();
        return t.k === "-" ? negate(a) : a;
      }
      return parsePower();
    }
    function parseUnaryNoSign(){ return parsePower(); }
    function negate(a){ return a.t === "q" ? qnode(qval(a).neg()) : { t: "neg", a: a }; }
    function parsePower(){
      var b = parsePostfix(), t = peek();
      if(t && t.k === "^"){ next(); enter(); var e = parseUnary(); leave(); return { t: "bin", op: "^", l: b, r: e }; }
      return b;
    }
    function parsePostfix(){
      var a = parsePrimary(), t;
      while((t = peek()) && (t.k === "!" || t.k === "%")){
        next();
        if(t.k === "!") a = { t: "fact", a: a };
        else { a = { t: "bin", op: "/", l: a, r: qnode(rat(100)) }; notes.push("percent"); }
      }
      return a;
    }
    function parsePrimary(){
      var t = next();
      if(!t) fail("INVALID_INPUT", "expression incomplète");
      if(t.k === "num") return qnode(decimalToRat(t.v));
      if(t.k === "("){ enter(); var e = parseSum(); leave(); expect(")"); return e; }
      if(t.k === "["){ return parseMatrix(); }
      if(t.k === "id"){
        var name = t.v, low = name.toLowerCase(), nx = peek();
        var fname = FUNC_ALIAS[name] || FUNC_ALIAS[low] || (FUNCS[low] ? low : null);
        if(fname && FUNCS[fname] !== undefined && nx && nx.k === "("){
          next(); var args = [];
          if(peek() && peek().k === ")") fail("INVALID_INPUT", "fonction sans argument : " + fname);
          for(;;){
            enter(); args.push(parseSum()); leave();
            var sep = peek();
            if(sep && (sep.k === "," || sep.k === ";")){ next(); continue; }
            break;
          }
          expect(")");
          var ar = FUNCS[fname];
          if(Array.isArray(ar) ? ar.indexOf(args.length) < 0 : ar !== args.length) fail("INVALID_INPUT", "nombre d'arguments invalide pour " + fname);
          if(fname === "log" && args.length === 1) notes.push("log-base-10");
          return { t: "call", fn: fname, args: args };
        }
        if(CONSTS[low] && name === low) return { t: "const", name: low === "inf" ? "oo" : low };
        if(name === "E" ) return { t: "const", name: "e" };
        // identifiant inconnu : variable. Un mot de plusieurs lettres (« xy ») est un PRODUIT de variables à une lettre ;
        // un nom avec « _ » ou un chiffre (x_1, x2) reste une seule variable.
        if(/^[A-Za-z]+$/.test(name) && name.length > 1 && !FUNCS[low] && !FUNC_ALIAS[name]){
          if(name.length > 4) fail("INVALID_INPUT", "mot non reconnu : « " + name + " »", { word: name });
          var parts = [];
          for(var i = 0; i < name.length; i++){ var ch = name.charAt(i); parts.push(ch === "e" && false ? { t: "const", name: "e" } : { t: "sym", name: ch }); }
          var acc = parts[0];
          for(var j = 1; j < parts.length; j++) acc = { t: "bin", op: "*", l: acc, r: parts[j], implicit: true };
          notes.push("split-word:" + name);
          return acc;
        }
        if(FUNCS[low] !== undefined || FUNC_ALIAS[name]) fail("INVALID_INPUT", "fonction « " + name + " » sans parenthèses");
        return { t: "sym", name: name };
      }
      fail("INVALID_INPUT", "symbole inattendu : « " + (t.v || t.k) + " »", { at: pos });
    }
    function parseMatrix(){
      // « [[1,2],[3,4]] » ou « [1 2; 3 4] » ; on a déjà consommé le premier « [ »
      var rows = [], row = [];
      function closeRow(){ if(row.length){ rows.push(row); row = []; } }
      if(peek() && peek().k === "["){
        for(;;){
          expect("["); row = [];
          for(;;){ enter(); row.push(parseSum()); leave(); if(peek() && (peek().k === "," || peek().k === ";")){ next(); continue; } break; }
          expect("]"); closeRow();
          if(peek() && (peek().k === "," || peek().k === ";")){ next(); continue; }
          break;
        }
        expect("]");
      } else {
        flatMatrix = true;          // « [1 2; 3 4] » : l'espace sépare les éléments (pas de multiplication implicite ici)
        for(;;){
          enter(); row.push(parseSum()); leave();
          var t = peek();
          if(t && t.k === ","){ next(); continue; }
          if(t && t.k === ";"){ next(); closeRow(); continue; }
          if(t && t.k === "]"){ closeRow(); next(); break; }
          if(startsPrimary(t) || (t && (t.k === "-" || t.k === "+"))) continue;     // « 1 2 » : séparateur = espace
          fail("INVALID_INPUT", "matrice invalide");
        }
        flatMatrix = false;
      }
      var w = rows[0] ? rows[0].length : 0;
      if(!rows.length || rows.some(function(r){ return r.length !== w; })) fail("INVALID_INPUT", "matrice : lignes de longueurs différentes");
      if(rows.length > 8 || w > 8) fail("TOO_COMPLEX", "matrice trop grande (8×8 maximum)");
      return { t: "mat", rows: rows };
    }

    var ast = parseTop();
    return { ast: ast, notes: notes, normalized: s };
  }


  /* parse(text, opts) → { ast, notes, normalized }.
     VIRGULE : « 0,5 » est décimale en français ; mais dans binom(10,3), log(2,5) ou [1,2],[3,4] elle peut séparer des arguments.
     - crochets (matrices) : la virgule SÉPARE (décimales avec un point) ;
     - fonction à plusieurs arguments : on essaie les DEUX lectures ; une seule valide → on la prend ; les deux valides → AMBIGUOUS
       (jamais un choix silencieux). Le séparateur « ; » est toujours sans ambiguïté. */
  function parse(text, opts){
    opts = opts || {};
    var raw = String(text == null ? "" : text);
    if(opts.decimalComma === false || !/\d,\d/.test(raw.replace(/\s/g, " "))) return parseOnce(raw, opts);
    if(/\[/.test(raw)) return parseOnce(raw, Object.assign({}, opts, { commaMode: "sep" }));
    if(!MULTIARG.test(raw)) return parseOnce(raw, opts);
    var asDecimal = null, asSep = null, e1 = null, e2 = null;
    try{ asDecimal = parseOnce(raw, Object.assign({}, opts, { commaMode: "decimal" })); }catch(e){ e1 = e; }
    try{ asSep = parseOnce(raw, Object.assign({}, opts, { commaMode: "sep" })); }catch(e){ e2 = e; }
    if(asDecimal && asSep) fail("AMBIGUOUS", "virgule ambiguë : décimale ou séparateur d'arguments ? (écris « ; » pour séparer, « . » pour les décimales)", { reason: "comma" });
    if(asDecimal) return asDecimal;
    if(asSep) return asSep;
    throw e1 || e2;
  }

  /* ── 4. UTILITAIRES SUR L'AST ───────────────────────────────────────────── */
  function walk(ast, f){
    if(!ast) return;
    f(ast);
    switch(ast.t){
      case "neg": case "fact": walk(ast.a, f); break;
      case "bin": case "eq": walk(ast.l, f); walk(ast.r, f); break;
      case "call": ast.args.forEach(function(a){ walk(a, f); }); break;
      case "mat": ast.rows.forEach(function(r){ r.forEach(function(a){ walk(a, f); }); }); break;
    }
  }
  function freeVars(ast){ var out = {}; walk(ast, function(n){ if(n.t === "sym") out[n.name] = 1; }); return Object.keys(out).sort(); }
  function hasNode(ast, pred){ var hit = false; walk(ast, function(n){ if(pred(n)) hit = true; }); return hit; }
  function nodeCount(ast){ var c = 0; walk(ast, function(){ c++; }); return c; }
  function mkq(n, d){ return qnode(rat(n, d === undefined ? 1 : d)); }
  function bin(op, l, r){ return { t: "bin", op: op, l: l, r: r }; }
  function sym(name){ return { t: "sym", name: name }; }
  function call(fn, args){ return { t: "call", fn: fn, args: args }; }
  function substitute(ast, name, value){          // remplace le symbole `name` par le nœud `value`
    return (function sub(n){
      switch(n.t){
        case "sym": return n.name === name ? value : n;
        case "neg": return { t: "neg", a: sub(n.a) };
        case "fact": return { t: "fact", a: sub(n.a) };
        case "bin": return { t: "bin", op: n.op, l: sub(n.l), r: sub(n.r) };
        case "eq": return { t: "eq", l: sub(n.l), r: sub(n.r) };
        case "call": return { t: "call", fn: n.fn, args: n.args.map(sub) };
        case "mat": return { t: "mat", rows: n.rows.map(function(r){ return r.map(sub); }) };
        default: return n;
      }
    })(ast);
  }

  /* ── 5. ÉVALUATION EXACTE (rationnels) ──────────────────────────────────────
     Lance MathError("IRRATIONAL") quand le résultat n'est pas rationnel (√2, π, sin 1…) : l'appelant bascule alors vers le
     CAS (exact symbolique) ou vers le flottant (approximation étiquetée). */
  function factorialBig(n){
    if(n > 3000) fail("TOO_COMPLEX", "factorielle trop grande");
    var r = ONE; for(var i = 2; i <= n; i++) r *= BigInt(i); return r;
  }
  function binomBig(n, k){
    if(k < 0 || k > n) return ZERO;
    if(k > n - k) k = n - k;
    if(n > 5000) fail("TOO_COMPLEX", "coefficient binomial trop grand");
    var r = ONE; for(var i = 1; i <= k; i++){ r = r * BigInt(n - k + i) / BigInt(i); } return r;
  }
  function smallInt(r, what){
    if(!r.isInt()) fail("DOMAIN", what + " doit être un entier");
    var v = Number(r.n); if(!isFinite(v) || Math.abs(v) > 1e9) fail("TOO_COMPLEX", what + " trop grand");
    return v;
  }
  function ratRoot(r, k){          // racine k-ième EXACTE si elle existe, sinon null
    if(k === 1) return r;
    if(r.sign() < 0){ if(k % 2 === 0) fail("DOMAIN", "racine paire d'un négatif"); var p = ratRoot(r.neg(), k); return p ? p.neg() : null; }
    function iroot(n){
      if(n < TWO) return n;
      var lo = ZERO, hi = ONE, K = BigInt(k);
      while(hi ** K <= n) hi = hi * TWO;
      while(lo < hi){ var mid = (lo + hi + ONE) >> ONE; if(mid ** K <= n) lo = mid; else hi = mid - ONE; }
      return lo;
    }
    var a = iroot(r.n), b = iroot(r.d);
    if(a ** BigInt(k) === r.n && b ** BigInt(k) === r.d) return new Rat(a, b);
    return null;
  }

  function evalExact(ast, env){
    env = env || {};
    switch(ast.t){
      case "q": return qval(ast);
      case "sym": if(env[ast.name] !== undefined) return env[ast.name]; fail("UNBOUND", "variable libre : " + ast.name, { name: ast.name });
      case "const": fail("IRRATIONAL", "constante : " + ast.name);
      case "neg": return evalExact(ast.a, env).neg();
      case "fact": { var f = evalExact(ast.a, env); var fi = smallInt(f, "n"); if(fi < 0) fail("DOMAIN", "factorielle d'un négatif"); return new Rat(factorialBig(fi)); }
      case "bin": {
        var l = evalExact(ast.l, env), r = evalExact(ast.r, env);
        switch(ast.op){
          case "+": return l.add(r); case "-": return l.sub(r); case "*": return l.mul(r);
          case "/": return l.div(r);
          case "^": {
            if(r.isInt()) return l.pow(smallInt(r, "exposant"));
            // exposant fractionnaire p/q : racine q-ième exacte, puis puissance p
            var q = smallInt(new Rat(r.d), "dénominateur"), p = smallInt(new Rat(r.n), "numérateur");
            if(q > 64) fail("TOO_COMPLEX", "racine d'indice trop grand");
            var rt = ratRoot(l, q);
            if(rt === null) fail("IRRATIONAL", "racine non exacte");
            return rt.pow(p);
          }
        }
        break;
      }
      case "call": {
        var a = ast.args.map(function(x){ return evalExact(x, env); });
        switch(ast.fn){
          case "abs": return a[0].abs();
          case "sqrt": { var s = ratRoot(a[0], 2); if(s === null) fail("IRRATIONAL", "racine non exacte"); return s; }
          case "cbrt": { var c3 = ratRoot(a[0], 3); if(c3 === null) fail("IRRATIONAL", "racine non exacte"); return c3; }
          case "root": { var rk = smallInt(a[1], "indice"); if(rk < 1 || rk > 64) fail("DOMAIN", "indice invalide"); var rr = ratRoot(a[0], rk); if(rr === null) fail("IRRATIONAL", "racine non exacte"); return rr; }
          case "mod": { if(!a[0].isInt() || !a[1].isInt()) fail("DOMAIN", "mod : entiers attendus"); if(a[1].isZero()) fail("DIV_ZERO", "modulo 0"); var mb = babs(a[1].n), mr = a[0].n % mb; if(mr < ZERO) mr += mb; return new Rat(mr); }
          case "gcd": { if(!a[0].isInt() || !a[1].isInt()) fail("DOMAIN", "pgcd : entiers attendus"); return new Rat(bgcd(a[0].n, a[1].n)); }
          case "lcm": { if(!a[0].isInt() || !a[1].isInt()) fail("DOMAIN", "ppcm : entiers attendus"); if(a[0].isZero() || a[1].isZero()) return new Rat(ZERO); return new Rat(babs(a[0].n * a[1].n) / bgcd(a[0].n, a[1].n)); }
          case "fact": { var n0 = smallInt(a[0], "n"); if(n0 < 0) fail("DOMAIN", "factorielle d'un négatif"); return new Rat(factorialBig(n0)); }
          case "binom": { var nn = smallInt(a[0], "n"), kk = smallInt(a[1], "k"); if(nn < 0) fail("DOMAIN", "n négatif"); return new Rat(binomBig(nn, kk)); }
          case "sign": return new Rat(BigInt(a[0].sign()));
          case "floor": { var fl = a[0].n / a[0].d; if(a[0].n < ZERO && a[0].n % a[0].d !== ZERO) fl -= ONE; return new Rat(fl); }
          case "ceil": { var ce = a[0].n / a[0].d; if(a[0].n > ZERO && a[0].n % a[0].d !== ZERO) ce += ONE; return new Rat(ce); }
          case "exp": if(a[0].isZero()) return new Rat(ONE); fail("IRRATIONAL", "exp");
          case "ln": if(a[0].sign() <= 0) fail("DOMAIN", "ln défini seulement pour x > 0"); if(a[0].eq(new Rat(ONE))) return new Rat(ZERO); fail("IRRATIONAL", "ln");
          case "log": case "log10": case "log2": {
            if(a[0].sign() <= 0) fail("DOMAIN", "logarithme défini seulement pour x > 0");
            var base = ast.fn === "log10" ? rat(10) : ast.fn === "log2" ? rat(2) : (a.length === 2 ? a[1] : rat(10));
            if(base.sign() <= 0 || base.eq(rat(1))) fail("DOMAIN", "base invalide");
            if(a[0].eq(rat(1))) return rat(0);
            if(a[0].eq(base)) return rat(1);
            // log_b(x) rationnel seulement si x = b^k (k entier)
            for(var k = 2; k <= 64; k++){ if(base.pow(k).eq(a[0])) return rat(k); if(base.pow(-k).eq(a[0])) return rat(-k); }
            if(base.pow(-1).eq(a[0])) return rat(-1);
            fail("IRRATIONAL", "logarithme");
          }
          case "sin": case "tan": case "asin": case "atan": case "sinh": case "tanh": if(a[0].isZero()) return rat(0); fail("IRRATIONAL", ast.fn);
          case "cos": case "cosh": if(a[0].isZero()) return rat(1); fail("IRRATIONAL", ast.fn);
          case "acos": if(a[0].eq(rat(1))) return rat(0); fail("IRRATIONAL", ast.fn);
        }
        break;
      }
      case "eq": fail("INVALID_INPUT", "une équation n'est pas une valeur");
      case "mat": fail("INVALID_INPUT", "une matrice n'est pas un nombre");
    }
    fail("UNSUPPORTED", "nœud non évaluable : " + ast.t);
  }

  /* ── 6. ÉVALUATION FLOTTANTE (domaine vérifié) ──────────────────────────────
     Réelle : sqrt(-1), log(0), division par zéro → MathError (jamais NaN/Infinity silencieux). */
  function evalFloat(ast, env){
    env = env || {};
    function ev(n){
      switch(n.t){
        case "q": return Number(BigInt(n.n)) / Number(BigInt(n.d));
        case "sym": { var v = env[n.name]; if(v === undefined) fail("UNBOUND", "variable libre : " + n.name, { name: n.name }); return typeof v === "number" ? v : v.toNumber(); }
        case "const": if(n.name === "pi") return Math.PI; if(n.name === "e") return Math.E; if(n.name === "oo") return Infinity; fail("DOMAIN", "constante complexe non évaluable en réel : " + n.name);
        case "neg": return -ev(n.a);
        case "fact": { var f = ev(n.a); if(f < 0 || Math.floor(f) !== f) fail("DOMAIN", "factorielle : entier ≥ 0 attendu"); if(f > 170) fail("OVERFLOW", "factorielle trop grande"); var r = 1; for(var i = 2; i <= f; i++) r *= i; return r; }
        case "bin": {
          var a = ev(n.l), b = ev(n.r), x;
          switch(n.op){
            case "+": x = a + b; break; case "-": x = a - b; break; case "*": x = a * b; break;
            case "/": if(b === 0) fail("DIV_ZERO", "division par zéro"); x = a / b; break;
            case "^":
              if(a === 0 && b === 0) fail("INVALID_INPUT", "0^0 indéterminé");
              if(a === 0 && b < 0) fail("DIV_ZERO", "division par zéro");
              if(a < 0 && Math.floor(b) !== b){
                // racine impaire d'un négatif (x^(1/3)) : réel ; sinon hors domaine réel
                var inv = 1 / b;
                if(Math.abs(inv - Math.round(inv)) < 1e-12 && Math.round(inv) % 2 !== 0) x = -Math.pow(-a, b); else fail("DOMAIN", "puissance non entière d'un négatif : pas de résultat réel");
              } else x = Math.pow(a, b);
              break;
          }
          if(!isFinite(x) && isFinite(a) && isFinite(b)) fail("OVERFLOW", "résultat hors limites");
          return x;
        }
        case "call": {
          var q = n.args.map(ev), y;
          switch(n.fn){
            case "abs": y = Math.abs(q[0]); break;
            case "sqrt": if(q[0] < 0) fail("DOMAIN", "racine carrée d'un négatif : pas de résultat réel"); y = Math.sqrt(q[0]); break;
            case "cbrt": y = Math.cbrt(q[0]); break;
            case "root": { var k = q[1]; if(Math.floor(k) !== k || k < 1) fail("DOMAIN", "indice invalide"); if(q[0] < 0 && k % 2 === 0) fail("DOMAIN", "racine paire d'un négatif"); y = q[0] < 0 ? -Math.pow(-q[0], 1 / k) : Math.pow(q[0], 1 / k); break; }
            case "exp": y = Math.exp(q[0]); break;
            case "ln": if(q[0] <= 0) fail("DOMAIN", "ln défini seulement pour x > 0"); y = Math.log(q[0]); break;
            case "log": if(q[0] <= 0) fail("DOMAIN", "logarithme défini seulement pour x > 0"); if(q.length === 2){ if(q[1] <= 0 || q[1] === 1) fail("DOMAIN", "base invalide"); y = Math.log(q[0]) / Math.log(q[1]); } else y = Math.log10(q[0]); break;
            case "log10": if(q[0] <= 0) fail("DOMAIN", "logarithme défini seulement pour x > 0"); y = Math.log10(q[0]); break;
            case "log2": if(q[0] <= 0) fail("DOMAIN", "logarithme défini seulement pour x > 0"); y = Math.log2(q[0]); break;
            case "sin": y = Math.sin(q[0]); break; case "cos": y = Math.cos(q[0]); break;
            case "tan": if(Math.abs(Math.cos(q[0])) < 1e-15) fail("DOMAIN", "tan non défini"); y = Math.tan(q[0]); break;
            case "asin": if(Math.abs(q[0]) > 1) fail("DOMAIN", "asin défini sur [-1 ; 1]"); y = Math.asin(q[0]); break;
            case "acos": if(Math.abs(q[0]) > 1) fail("DOMAIN", "acos défini sur [-1 ; 1]"); y = Math.acos(q[0]); break;
            case "atan": y = Math.atan(q[0]); break;
            case "sinh": y = Math.sinh(q[0]); break; case "cosh": y = Math.cosh(q[0]); break; case "tanh": y = Math.tanh(q[0]); break;
            case "fact": return ev({ t: "fact", a: n.args[0] });
            case "binom": { var nn = q[0], kk = q[1]; if(Math.floor(nn) !== nn || Math.floor(kk) !== kk || nn < 0) fail("DOMAIN", "binom : entiers attendus"); if(kk < 0 || kk > nn) return 0; var rr = 1; kk = Math.min(kk, nn - kk); for(var j = 1; j <= kk; j++) rr = rr * (nn - kk + j) / j; y = Math.round(rr); break; }
            case "sign": y = Math.sign(q[0]); break; case "floor": y = Math.floor(q[0]); break; case "ceil": y = Math.ceil(q[0]); break;
            case "mod": { if(q[1] === 0) fail("DIV_ZERO", "modulo 0"); if(Math.floor(q[0]) !== q[0] || Math.floor(q[1]) !== q[1]) fail("DOMAIN", "mod : entiers attendus"); y = ((q[0] % Math.abs(q[1])) + Math.abs(q[1])) % Math.abs(q[1]); break; }
            case "gcd": { var ga = Math.abs(q[0]), gb = Math.abs(q[1]); while(gb){ var gt = ga % gb; ga = gb; gb = gt; } y = ga; break; }
            case "lcm": { var la = Math.abs(q[0]), lb = Math.abs(q[1]), gg = la, hh = lb; while(hh){ var tt = gg % hh; gg = hh; hh = tt; } y = gg === 0 ? 0 : la / gg * lb; break; }
            default: fail("UNSUPPORTED", "fonction non supportée : " + n.fn);
          }
          if(!isFinite(y)) fail("OVERFLOW", "résultat hors limites");
          return y;
        }
        case "eq": fail("INVALID_INPUT", "une équation n'est pas une valeur");
        case "mat": fail("INVALID_INPUT", "une matrice n'est pas un nombre");
      }
      fail("UNSUPPORTED", "nœud non évaluable : " + n.t);
    }
    return ev(ast);
  }

  /* ── 7. POLYNÔMES À COEFFICIENTS RATIONNELS (exact, une variable) ───────────
     Sert de vérification EXACTE indépendante du CAS : développer, dériver, comparer, évaluer. coeffs[i] = coefficient de x^i. */
  var poly = {};
  poly.trim = function(p){ p = p.slice(); while(p.length > 1 && p[p.length - 1].isZero()) p.pop(); return p; };
  poly.add = function(a, b){ var n = Math.max(a.length, b.length), out = [], i; for(i = 0; i < n; i++) out.push((a[i] || new Rat(ZERO)).add(b[i] || new Rat(ZERO))); return poly.trim(out); };
  poly.neg = function(a){ return a.map(function(c){ return c.neg(); }); };
  poly.sub = function(a, b){ return poly.add(a, poly.neg(b)); };
  poly.mul = function(a, b){
    if(a.length + b.length > 400) fail("TOO_COMPLEX", "polynôme trop grand");
    var out = [], i, j; for(i = 0; i < a.length + b.length - 1; i++) out.push(new Rat(ZERO));
    for(i = 0; i < a.length; i++) for(j = 0; j < b.length; j++) out[i + j] = out[i + j].add(a[i].mul(b[j]));
    return poly.trim(out);
  };
  poly.pow = function(a, k){ var r = [new Rat(ONE)]; for(var i = 0; i < k; i++) r = poly.mul(r, a); return r; };
  poly.deriv = function(a){ if(a.length <= 1) return [new Rat(ZERO)]; var out = [], i; for(i = 1; i < a.length; i++) out.push(a[i].mul(new Rat(BigInt(i)))); return poly.trim(out); };
  poly.integral = function(a){ var out = [new Rat(ZERO)], i; for(i = 0; i < a.length; i++) out.push(a[i].div(new Rat(BigInt(i + 1)))); return poly.trim(out); };
  poly.eval = function(a, x){ var r = new Rat(ZERO), i; for(i = a.length - 1; i >= 0; i--) r = r.mul(x).add(a[i]); return r; };
  poly.degree = function(a){ a = poly.trim(a); return a.length === 1 && a[0].isZero() ? -Infinity : a.length - 1; };
  poly.eq = function(a, b){ a = poly.trim(a); b = poly.trim(b); if(a.length !== b.length) return false; for(var i = 0; i < a.length; i++) if(!a[i].eq(b[i])) return false; return true; };
  /* AST → coefficients, ou null si l'expression n'est pas un polynôme en `v` à coefficients rationnels. */
  poly.fromAst = function(ast, v){
    function go(n){
      switch(n.t){
        case "q": return [qval(n)];
        case "sym": if(n.name === v) return [new Rat(ZERO), new Rat(ONE)]; return null;
        case "neg": { var a = go(n.a); return a && poly.neg(a); }
        case "bin": {
          if(n.op === "^"){
            var base = go(n.l); if(!base) return null;
            var ex; try{ ex = evalExact(n.r, {}); }catch(e){ return null; }
            if(!ex.isInt() || ex.sign() < 0 || ex.n > BigInt(60)) return null;
            return poly.pow(base, Number(ex.n));
          }
          var l = go(n.l), r = go(n.r); if(!l || !r) return null;
          if(n.op === "+") return poly.add(l, r);
          if(n.op === "-") return poly.sub(l, r);
          if(n.op === "*") return poly.mul(l, r);
          if(n.op === "/"){ if(r.length !== 1 || r[0].isZero()) return null; return l.map(function(c){ return c.div(r[0]); }); }
          return null;
        }
        default: return null;
      }
    }
    try{ var p = go(ast); return p && poly.trim(p); }catch(e){ return null; }
  };

  /* ── 8. FORMATS D'AFFICHAGE ─────────────────────────────────────────────── */
  var LOCALE = {
    fr: { dec: ",", grp: " " },     // espace fine insécable
    en: { dec: ".", grp: "," },
    es: { dec: ",", grp: "." }, de: { dec: ",", grp: "." }, it: { dec: ",", grp: "." }
  };
  function localeOf(lang){ return LOCALE[lang] || LOCALE.fr; }
  function groupInt(s, grp){ var neg = s.charAt(0) === "-"; if(neg) s = s.slice(1); var out = s.replace(/\B(?=(\d{3})+(?!\d))/g, grp); return (neg ? "-" : "") + out; }
  /* Décimal localisé d'un RATIONNEL (aucune perte : jamais via un flottant). */
  function fmtRatDecimal(r, digits, lang, opts){
    opts = opts || {};
    var d = ratToDecimal(r, digits), loc = localeOf(lang), parts = d.text.split(".");
    var ip = opts.group === false || Math.abs(parseFloat(parts[0])) < 10000 ? parts[0] : groupInt(parts[0], loc.grp);
    return { text: ip + (parts[1] ? loc.dec + parts[1] : ""), exact: d.exact };
  }
  /* Rationnel « humain » : entier, ou fraction n/d. */
  function fmtRat(r){ return r.toString(); }
  function fmtFloat(x, digits, lang){
    if(!isFinite(x)) return String(x);
    var loc = localeOf(lang), s = x.toFixed(digits === undefined ? 6 : digits);
    if(s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    if(s === "-0") s = "0";
    var parts = s.split(".");
    return groupInt(parts[0], loc.grp) + (parts[1] ? loc.dec + parts[1] : "");
  }
  function sigDigits(x, sig){ if(x === 0 || !isFinite(x)) return String(x); return Number(x.toPrecision(sig || 12)).toString(); }

  /* Texte infixe lisible d'un AST (pour l'élève et le prompt). */
  var PREC = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 4 };
  function toText(ast){
    function wrap(n, minPrec){ var s = go(n), p = precOf(n); return p < minPrec ? "(" + s + ")" : s; }
    function precOf(n){ if(n.t === "bin") return PREC[n.op]; if(n.t === "neg") return 3; if(n.t === "q" && n.d !== "1") return 2; if(n.t === "q" && n.n[0] === "-") return 3; return 9; }
    function go(n){
      switch(n.t){
        case "q": return n.d === "1" ? n.n : n.n + "/" + n.d;
        case "sym": return n.name;
        case "const": return n.name === "pi" ? "π" : n.name === "oo" ? "∞" : n.name;
        case "neg": return "-" + wrap(n.a, 3);
        case "fact": return wrap(n.a, 9) + "!";
        case "bin": {
          var p = PREC[n.op];
          if(n.op === "^") return wrap(n.l, 5) + "^" + wrap(n.r, 5);
          if(n.op === "*"){
            var ls = wrap(n.l, 2), rs = wrap(n.r, 3);
            // 3x, 2(x+1) : multiplication implicite lisible
            if(n.l.t === "q" && (n.r.t === "sym" || n.r.t === "const" || n.r.t === "call" || (n.r.t === "bin" && n.r.op === "^"))) return ls + rs;
            return ls + "·" + rs;
          }
          if(n.op === "/") return wrap(n.l, 2) + "/" + wrap(n.r, 3);
          if(n.op === "-") return wrap(n.l, 1) + " - " + wrap(n.r, 2);
          return wrap(n.l, 1) + " + " + wrap(n.r, 1);
        }
        case "call": return n.fn + "(" + n.args.map(go).join("; ") + ")";
        case "eq": return go(n.l) + " = " + go(n.r);
        case "mat": return "[" + n.rows.map(function(r){ return r.map(go).join(", "); }).join("; ") + "]";
      }
      return "?";
    }
    return go(ast);
  }

  /* LaTeX (rendu KaTeX côté page). Pur texte ; jamais exécuté. */
  var LATEX_FN = { sin: "\\sin", cos: "\\cos", tan: "\\tan", asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan", sinh: "\\sinh", cosh: "\\cosh", tanh: "\\tanh", ln: "\\ln", exp: "\\exp", log10: "\\log_{10}", log2: "\\log_{2}" };
  function toLatex(ast){
    function wrap(n, minPrec){ var s = go(n); return precOf(n) < minPrec ? "\\left(" + s + "\\right)" : s; }
    function precOf(n){ if(n.t === "bin"){ return n.op === "/" ? 9 : PREC[n.op]; } if(n.t === "neg") return 3; if(n.t === "q" && n.d !== "1") return 9; if(n.t === "q" && n.n[0] === "-") return 3; return 9; }
    function go(n){
      switch(n.t){
        case "q": return n.d === "1" ? n.n : (n.n[0] === "-" ? "-\\frac{" + n.n.slice(1) + "}{" + n.d + "}" : "\\frac{" + n.n + "}{" + n.d + "}");
        case "sym": return n.name.length > 1 && /_/.test(n.name) ? n.name.replace(/_(\w+)/, "_{$1}") : n.name;
        case "const": return n.name === "pi" ? "\\pi" : n.name === "oo" ? "\\infty" : n.name === "e" ? "e" : n.name;
        case "neg": return "-" + wrap(n.a, 3);
        case "fact": return wrap(n.a, 9) + "!";
        case "bin": {
          if(n.op === "/") return "\\frac{" + go(n.l) + "}{" + go(n.r) + "}";
          if(n.op === "^") return wrap(n.l, 5) + "^{" + go(n.r) + "}";
          if(n.op === "*"){
            var ls = wrap(n.l, 2), rs = wrap(n.r, 3);
            if(n.implicit || (n.l.t === "q" && n.l.d === "1" && (n.r.t === "sym" || n.r.t === "call" || n.r.t === "const" || (n.r.t === "bin" && n.r.op === "^")))) return ls + rs;
            return ls + " \\cdot " + rs;
          }
          if(n.op === "-") return wrap(n.l, 1) + " - " + wrap(n.r, 2);
          return wrap(n.l, 1) + " + " + wrap(n.r, 1);
        }
        case "call": {
          if(n.fn === "sqrt") return "\\sqrt{" + go(n.args[0]) + "}";
          if(n.fn === "cbrt") return "\\sqrt[3]{" + go(n.args[0]) + "}";
          if(n.fn === "root") return "\\sqrt[" + go(n.args[1]) + "]{" + go(n.args[0]) + "}";
          if(n.fn === "abs") return "\\left|" + go(n.args[0]) + "\\right|";
          if(n.fn === "binom") return "\\binom{" + go(n.args[0]) + "}{" + go(n.args[1]) + "}";
          if(n.fn === "log" && n.args.length === 2) return "\\log_{" + go(n.args[1]) + "}\\left(" + go(n.args[0]) + "\\right)";
          if(n.fn === "log") return "\\log_{10}\\left(" + go(n.args[0]) + "\\right)";
          var nm = LATEX_FN[n.fn] || ("\\operatorname{" + n.fn + "}");
          return nm + "\\left(" + n.args.map(go).join(", ") + "\\right)";
        }
        case "eq": return go(n.l) + " = " + go(n.r);
        case "mat": return "\\begin{pmatrix}" + n.rows.map(function(r){ return r.map(go).join(" & "); }).join(" \\\\ ") + "\\end{pmatrix}";
      }
      return "";
    }
    return go(ast);
  }
  function latexOfRat(r){ return qnodeLatex(r); }
  function qnodeLatex(r){ return toLatex(qnode(r)); }

  /* Le résultat exact d'une racine : « 2√2 », « 3/2 », « √5/2 » → texte + LaTeX. */
  function surdText(coef, rad){
    if(rad === ONE) return { text: coef.toString(), latex: toLatex(qnode(coef)) };
    var cn = coef.n, cd = coef.d, r = "√" + rad.toString(), lr = "\\sqrt{" + rad.toString() + "}";
    var txt = (cn === ONE ? "" : (cn === -ONE ? "-" : cn.toString())) + r + (cd === ONE ? "" : "/" + cd.toString());
    var neg = cn < ZERO, an = babs(cn);
    var tex = (neg ? "-" : "") + (cd === ONE ? (an === ONE ? "" : an.toString()) + lr : "\\frac{" + (an === ONE ? "" : an.toString()) + lr + "}{" + cd.toString() + "}");
    return { text: txt, latex: tex };
  }

  function isNumeric(ast){ return freeVars(ast).length === 0 && !hasNode(ast, function(n){ return n.t === "eq" || n.t === "mat"; }); }

  NS.core = {
    STATUS: STATUS, MathError: MathError, fail: fail,
    Rat: Rat, rat: rat, ratToDecimal: ratToDecimal, isqrt: isqrt, sqrtRat: sqrtRat, ratRoot: ratRoot,
    normalize: normalize, tokenize: tokenize, parse: parse,
    walk: walk, freeVars: freeVars, hasNode: hasNode, nodeCount: nodeCount, isNumeric: isNumeric, substitute: substitute,
    qnode: qnode, qval: qval, mkq: mkq, bin: bin, sym: sym, call: call,
    evalExact: evalExact, evalFloat: evalFloat, poly: poly,
    fmtRatDecimal: fmtRatDecimal, fmtRat: fmtRat, fmtFloat: fmtFloat, sigDigits: sigDigits, localeOf: localeOf,
    toText: toText, toLatex: toLatex, surdText: surdText, latexOfRat: latexOfRat,
    factorialBig: factorialBig, binomBig: binomBig,
    FUNCS: FUNCS, LIMITS: { MAX_DIGITS: MAX_DIGITS, MAX_EXP: MAX_EXP, MAX_TOKENS: MAX_TOKENS, MAX_LEN: MAX_LEN, MAX_DEPTH: MAX_DEPTH }
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
