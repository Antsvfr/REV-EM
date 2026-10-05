/* ============================================================================
   math-engine.js — MathAnalyzer + orchestrateur du REV-EM ADVANCED MATH ENGINE
   ----------------------------------------------------------------------------
   `globalThis.RevemMath.engine` — pur (aucun DOM, aucun réseau, aucun WebLLM). Dépend de
   math-core.js, math-fast.js, math-verify.js. Le CAS (SymPy/Pyodide) est INJECTÉ par l'appelant
   (`opts.cas`) : ce fichier ne sait pas comment il tourne.

       QUESTION ─▶ analyze ─▶ PROBLÈME (représentation)
                     │            │
                     │       Fast Engine (exact, instantané) ──┐
                     │            └ « NEEDS_CAS » ─▶ CAS (SymPy) ─▶ MathVerifier ─┤
                     └─ pas un problème de calcul → { kind:"none" } (le LLM répond seul)
                                                                                   ▼
                          RÉSULTAT { exact, approx, verification, statut, card, block }
                                                                                   ▼
                                  WebLLM : explique, N'EST PAS la source du résultat

   RÈGLES : jamais d'eval ; jamais de résultat inventé (non supporté → UNSUPPORTED, le LLM peut
   EXPLIQUER la méthode mais pas annoncer un résultat) ; le résultat du moteur prévaut sur tout
   nombre que le LLM écrirait ensuite ; aucune « deuxième opinion » du LLM n'est un contrôle.
   ============================================================================ */
(function(global){
  "use strict";
  var NS = global.RevemMath = global.RevemMath || {};
  var C = NS.core, F = NS.fast, V = NS.verify;
  if(!C || !F || !V) throw new Error("math-engine.js : charger math-core, math-fast et math-verify d'abord");
  var STATUS = C.STATUS, rat = C.rat, Rat = C.Rat;
  var VERSION = "1.0.0";

  /* ── 0. TEXTE ─────────────────────────────────────────────────────────────── */
  function fold(s){
    s = String(s == null ? "" : s);
    var out = "";
    for(var i = 0; i < s.length; i++){
      var ch = s.charAt(i).toLowerCase();
      if(ch === "’" || ch === "‘" || ch === "`") ch = "'";
      else if(ch.charCodeAt(0) > 127 && ch.normalize){ var d = ch.normalize("NFD").charAt(0); ch = /[a-z]/.test(d) ? d : ch; }
      out += ch;
    }
    return out;
  }
  /* Sans accents mais SANS changer la casse ni la longueur (les indices restent valides). */
  function stripAcc(s){
    s = String(s == null ? "" : s); var out = "";
    for(var i = 0; i < s.length; i++){ var ch = s.charAt(i); if(ch.charCodeAt(0) > 127 && ch.normalize){ var d = ch.normalize("NFD").charAt(0); if(/[A-Za-z]/.test(d)) ch = d; } out += ch; }
    return out;
  }
  function toRat(str, lang){
    var t = String(str).replace(/[   ]/g, "").replace(/^\+/, "");
    var neg = t.charAt(0) === "-"; if(neg) t = t.slice(1);
    if(/^\d{1,3}([.,]\d{3})+$/.test(t)){
      if(lang === "en") t = t.replace(/,/g, ""); else if(t.indexOf(".") >= 0) t = t.replace(/\./g, ""); else t = t.replace(",", ".");
    } else t = t.replace(",", ".");
    var m = /^(\d*)\.?(\d*)$/.exec(t); if(!m || (!m[1] && !m[2])) return null;
    var den = BigInt(10) ** BigInt((m[2] || "").length), r = new Rat(BigInt((m[1] || "0") + (m[2] || "")), den);
    return neg ? r.neg() : r;
  }
  /* Nombres d'un texte → [{ value:Rat, raw, index, end, percent, money }]. « 1 000 », « 1,5 », « 5 % ».
     ESPACES : « 1 000 », « 12 500 », « 200 000 » sont des milliers ; « 500 600 300 » est une LISTE de trois nombres.
     Le cas vraiment ambigu (« 100 500 ») est traité comme une liste ET signalé : out.ambiguousSpace = true. */
  function extractNumbers(text, lang){
    var s = String(text || ""), out = [], m;
    var re = /(-?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?)(\s*(?:%|pour ?cent|percent))?/gi;
    out.ambiguousSpace = false;
    while((m = re.exec(s))){
      var rawNum = m[1], pct = !!m[2], hasSpace = /[ \u00a0\u202f]/.test(rawNum);
      var after = s.slice(m.index + m[0].length, m.index + m[0].length + 12), before = s.slice(Math.max(0, m.index - 2), m.index);
      var money = /^\s*(?:€|eur\b|euros?|\$|usd|dollars?|£|gbp|k€)/i.test(after) || /[€$£]\s*$/.test(before);
      if(hasSpace){
        var dec = /[.,]\d+$/.exec(rawNum), core = dec ? rawNum.slice(0, dec.index) : rawNum, parts = core.replace(/^-/, "").split(/[ \u00a0\u202f]/);
        var hasNb = /[\u00a0\u202f]/.test(core), lead = parts[0].length;
        var thousands = hasNb || lead <= 2 || parts.slice(1).some(function(g){ return g.charAt(0) === "0"; });
        if(!thousands){
          out.ambiguousSpace = true; var cursor = m.index;
          parts.forEach(function(pt, i){
            var v = toRat((i === 0 && rawNum.charAt(0) === "-" ? "-" : "") + pt + (i === parts.length - 1 && dec ? dec[0] : ""), lang); if(!v) return;
            var idx = s.indexOf(pt, cursor); cursor = idx + pt.length;
            out.push({ value: v, raw: pt, index: idx, end: cursor, percent: i === parts.length - 1 && pct, money: i === parts.length - 1 && money });
          });
          continue;
        }
      }
      var v2 = toRat(rawNum, lang); if(!v2) continue;
      out.push({ value: v2, raw: m[0], index: m.index, end: m.index + m[0].length, percent: pct, money: money });
    }
    return out;
  }
  function pctToRat(n){ return n.value.div(rat(100)); }
  var DUR = /(\d+(?:[.,]\d+)?)\s*(ans?|annees?|années?|years?|anos?|años?|jahre?n?|anni|mois|months?|meses|monate?n?|mesi|trimestres?|quarters?|semestres?)\b/i;
  function durationYears(f){
    var m = DUR.exec(f); if(!m) return null;
    var v = toRat(m[1], "fr"), unit = fold(m[2]), years;
    if(/^(mois|month|mes|monat|mesi)/.test(unit)) years = v.div(rat(12));
    else if(/^trimestre|^quarter/.test(unit)) years = v.div(rat(4));
    else if(/^semestre/.test(unit)) years = v.div(rat(2));
    else years = v;
    return { years: years, raw: m[0], index: m.index, end: m.index + m[0].length, months: /^(mois|month|mes|monat|mesi)/.test(unit) ? v : null, value: v, unit: unit };
  }
  function notInSpan(n, span){ return !span || n.index >= span.end || n.end <= span.index; }

  /* ── 1. MOTS-CLÉS (fr, en, es, de, it) ───────────────────────────────────── */
  var KW = {
    factor:   /\b(factoris\w*|factor(?:ize|ise|ing)?|factoriz\w*|faktorisier\w*|fattorizz\w*|scompon\w*)\b/,
    expand:   /\b(developp\w*|expand\w*|desarroll\w*|ausmultiplizier\w*|sviluppa\w*)\b/,
    simplify: /\b(simplifi\w*|simplify|simplific\w*|vereinfach\w*|semplific\w*)\b/,
    solve:    /\b(resou\w*|resolv\w*|resolu\w*|solv\w*|resuelv\w*|resuelve|loes\w*|los\w*|risolv\w*|trouve\w*|trouver|find|racines?|zeros?|roots?|solutions? de|solutions? of)\b/,
    deriv:    /(\bderiv\w*|\bdifferenti\w*|\bd\s*\/\s*d[a-z]\b|\bdiff\b|\bableit\w*|\bderivad\w*|\bderivat\w*|f\s*'\s*\()/,
    integral: /(∫|\bprimitiv\w*|\bintegr\w*|\bintegral\w*|\bantideriv\w*|\bstammfunktion\w*|\bintegra\w*)/,
    limit:    /(\blim\b|\blimit\w*|\blimite\w*|\bgrenzwert\w*|→|->)/,
    matrix:   /(\bmatri[cx]\w*|\bdeterminant\w*|\bdeterminante\w*|\binverse\b|\binvers\w*|\btranspos\w*|\brang\b|\brank\b|\beigen\w*|\bvaleurs? propres?|\bvecteurs? propres?|\bautovalor\w*|\bautovett\w*)/,
    stats:    /\b(moyenne|mean|average|promedio|mittelwert|durchschnitt|media|mediane|median|mediana|mode|modal|variance|varianza|varianz|ecart[- ]?type|standard deviation|desviacion|standardabweichung|deviazione standard|quartiles?|etendue|range|statistiques? descriptives?|descriptive statistics)\b/,
    zscore:   /\b(z[- ]?score|score z|cote z|z-wert|puntaje z|valore z)\b/,
    corr:     /\b(correlation|correlacion|korrelation|correlazione|covariance|covarianza|kovarianz|regression|regresion|regressione|droite de regression)\b/,
    binom:    /\b(binomial\w*|binomiale|binomialverteilung|loi b\b|b\s*\(\s*\d)/,
    normal:   /\b(loi normale|normal distribution|normale|gaussienne|gaussian|distribucion normal|normalverteilung|distribuzione normale|n\s*\(\s*[-+]?\d)/,
    bayes:    /\b(bayes|probabilite conditionnelle|conditional probability|p\s*\(\s*a\s*\|\s*b\s*\))/,
    ci:       /\b(intervalle de confiance|confidence interval|intervalo de confianza|konfidenzintervall|intervallo di confidenza)\b/,
    npv:      /\b(van\b|npv|valeur actuelle nette|net present value|valor actual neto|kapitalwert|valore attuale netto)\b/,
    irr:      /\b(tri\b|irr\b|taux de rendement interne|internal rate of return|tasa interna de retorno|interner zinsfuss|tasso interno di rendimento)\b/,
    payment:  /\b(mensualite\w*|monthly payment|loan payment|payment on a loan|annuite\w*|echeance\w*|cuota|monatliche rate|rata mensile|emprunt|pret\b|credit\b|loan|mortgage|hypotheque|prestamo)\b/,
    equivRate:/\b(taux\s+\w*\s*equivalent\w*|equivalent\s+(monthly|annual|quarterly|rate)\w*|taux equivalent\w*|tasa equivalente|aquivalenter zins|tasso equivalente)\b/,
    propRate: /\b(taux proportionnel\w*|proportional rate|tasa proporcional|proportionaler zins|tasso proporzionale)\b/,
    cagr:     /\b(tcam|cagr|taux de croissance annuel(?:le)? moyen|compound annual growth|average annual growth|tasa de crecimiento anual compuesta)\b/,
    discount: /\b(actualis\w*|valeur actuelle|present value|valeur presente|escompt\w*|discount\w*|valor presente|barwert|valore attuale)\b/,
    simpleInt:/\b(interets? simples?|simple interest|interes simple|einfache zinsen|interesse semplice)\b/,
    compoundInt:/\b(interets? composes?|compound\w*|capitalis\w*|interes compuesto|zinseszins|interesse composto)\b/,
    explain:  /^\s*(pourquoi|why|por que|por qu[eé]|warum|perche|perch[eé]|explique\w*|explain\w*|explica\w*|erklaer\w*|erkl[aä]r\w*|spiega\w*|qu'est[- ]ce (?:que|qu')|c'est quoi|what is|what are|que es|que son|was ist|cos'e|comment fonctionne|how does|difference entre|what's the difference)/
  };

  /* ── 2. ANALYSEUR ─────────────────────────────────────────────────────────── */
  var FILL = /^(?:\s*[:\-–—]\s*|\s*(?:de|d'|du|des|la|le|les|l'|une?|expression|polynome|fonction|equation|equations|the|of|expression|polynomial|function|equation|el|los|las|del|der|die|das|di|il|lo|pour|for|para|fur|per|suivante?|suivant|ci-dessous|below|following|\(|ce|cette|this)\s+)+/i;
  function cleanExpr(s){
    s = String(s || "").trim();
    var prev;
    do{ prev = s; s = s.replace(/^(?:\s|:|[–—](?=\s))+/, "").replace(/^(?:de |d'|du |des |la |le |les |l'|l’|une? |the |of |el |los |las |del |der |die |das |di |il |lo |pour |for |para |per |expression |polyn[oô]me |fonction |function |equation |équation |polynomial |suivante? |following )/i, ""); }while(s !== prev);
    s = s.replace(/[?!]+\s*$/, "").replace(/\.\s*$/, "");
    s = s.replace(/\s*(?:par rapport [àa] |with respect to |en fonction de |respecto a |nach |rispetto a )([a-z])\s*$/i, "");
    s = s.replace(/^[a-zA-Z]\s*\(\s*[a-zA-Z]\s*\)\s*=\s*/, "");        // f(x) = …
    return s.trim();
  }
  var SUB = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9", "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "₋": "-", "⁻": "-" };
  function mapSub(s){ return s.replace(/[₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹₋⁻]/g, function(c){ return SUB[c] || c; }); }

  function noneResult(why){ return { kind: "none", reason: why || "pas un problème de calcul" }; }
  function invalidExpr(src, e){
    var amb = e && /^AMBIGUOUS/.test(e.code || "");
    return { kind: "invalid", src: src, code: e && e.code, message: e && e.message ? e.message : "expression invalide", status: amb ? STATUS.AMBIGUOUS : (e && /^(TOO_COMPLEX|OVERFLOW|TOO_LONG|TOO_DEEP)/.test(e.code || "") ? STATUS.UNSUPPORTED : STATUS.INVALID_INPUT) };
  }
  function tryParse(src, lang){
    try{ var p = C.parse(src, { decimalComma: lang !== "en" }); return { ok: true, ast: p.ast, notes: p.notes, normalized: p.normalized }; }
    catch(e){ return { ok: false, error: e }; }
  }
  function looksMathy(s){ return /[0-9]/.test(s) || /[+\-*/^=]/.test(s) || /\b[a-z]\b/i.test(s); }
  function mainVar(ast, hint){
    var vs = C.freeVars(ast); if(hint && vs.indexOf(hint) >= 0) return hint;
    if(vs.indexOf("x") >= 0) return "x";
    return vs[0] || hint || "x";
  }
  function splitEquations(s){
    var parts = s.split(/\s*(?:\n|;|\s+et\s+|\s+and\s+|\s+und\s+)\s*/i).map(function(x){ return x.trim(); }).filter(Boolean);
    if(parts.length === 1 && /,/.test(parts[0]) && (parts[0].match(/=/g) || []).length >= 2) parts = parts[0].split(/\s*,\s*(?=[^,]*=)/).map(function(x){ return x.trim(); }).filter(Boolean);
    return parts;
  }

  function analyze(text, opts){
    try{ return analyzeInner(String(text == null ? "" : text), opts || {}); }
    catch(e){ return noneResult("erreur d'analyse : " + (e && e.message)); }
  }

  function analyzeInner(raw, opts){
    var lang = opts.lang || "fr";
    var original = raw.trim();
    var src = stripAcc(original);                       // même longueur, sans accents : les regex ci-dessous s'appliquent à src
    if(!src || src.length > 1500) return noneResult("vide ou trop long");
    var f = fold(src);
    var base = { src: original, lang: lang, mode: "solve", notes: [] };
    /* « Qu'est-ce que la dérivée ? » = explication. Mais « what is 2+2 », « qu'est-ce que 15 % de 80 », « what is the derivative of x^2 » demandent un CALCUL. */
    function explainIsCalc(){
      var m = /^\s*(?:qu'est[- ]ce (?:que|qu')|c'est quoi|what is|what's|what are|que es|que son|was ist|cos'e)\s*(.*)$/.exec(f);
      if(!m) return false;
      var rest = m[1];
      if(/^[\s(\-+]*\d/.test(rest) && /[+\-*\/^×÷%]/.test(rest)) return true;
      return /^(?:la |le |les |l'|the |a |an |el |der |die |das |il |lo )?(?:derivee|derivative|integrale|integral|primitive|limite|limit|valeur|value|solution|resultat|result|determinant|inverse|somme|sum|produit|product|moyenne|mean|median)\b.*(?:\bde\b|\bof\b|\bd'|\bdu\b|\bdes\b|\bvon\b|\bdi\b)\s*.*[\d^]/.test(rest);
    }
    var isExplain = KW.explain.test(f) && !explainIsCalc();

    // ── mode M'ENTRAÎNER (exercice) : géré par Practice, pas par un calcul de la question
    if(/^\s*(donne[- ]moi un exercice|propose[- ]moi un exercice|je veux m'entrainer|entraine[- ]moi|give me an exercise|practice|quiz me on|dame un ejercicio|gib mir eine aufgabe|dammi un esercizio)/.test(f))
      return Object.assign(base, { kind: "practice-request", mode: "practice" });

    // ── 2.1 intégrale (avant « dérivée » : « primitive » contient d'autres motifs) ───────────────
    var m;
    if(KW.integral.test(f) || /∫/.test(src)){
      var bounds = null, body = null, dvar = null;
      var NUM = "(-?(?:[\\d.,/]+|\\bpi\\b|π|\\be\\b)|[-+]?\\s*(?:oo|inf\\w*|infini\\w*|infinity|∞))";
      var iStart = src.indexOf("∫");
      if(iStart >= 0){
        var tail = src.slice(iStart + 1);
        var ub = /^\s*([₀₁₂₃₄₅₆₇₈₉₋]+)\s*([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)/.exec(tail);                                       // ∫₀¹
        var ua = /^\s*_\s*\{?\s*(-?[\w.,/]+)\s*\}?\s*\^\s*\{?\s*(-?[\w.,/]+|∞|\+∞|-∞)\s*\}?/.exec(tail);   // ∫_0^1
        if(ub){ bounds = [mapSub(ub[1]), mapSub(ub[2])]; body = tail.slice(ub[0].length); }
        else if(ua){ bounds = [ua[1], ua[2]]; body = tail.slice(ua[0].length); }
        else body = tail;
      } else {
        var mw = /(?:integr\w*|primitiv\w*|antideriv\w*)\s*(.*)$/i.exec(src);
        body = mw ? mw[1] : null;
      }
      if(body !== null && !bounds){
        var mb = new RegExp("^(.*?)\\s*(?:\\bde\\b|\\bfrom\\b|\\bentre\\b|\\bbetween\\b|\\bvon\\b|\\bda\\b)\\s*" + NUM + "\\s*(?:\\ba\\b|\\bto\\b|\\bet\\b|\\band\\b|\\bbis\\b)\\s*" + NUM + "\\s*[?.]?\\s*$", "i").exec(body);
        if(mb){ body = mb[1]; bounds = [mb[2], mb[3]]; }
        else {                                                                            // « de 0 à 1 de x^2 dx » : bornes en tête
          var ml = new RegExp("^\\s*(?:\\bde\\b|\\bfrom\\b|\\bentre\\b|\\bbetween\\b|\\bvon\\b|\\bda\\b)\\s*" + NUM + "\\s*(?:\\ba\\b|\\bto\\b|\\bet\\b|\\band\\b|\\bbis\\b)\\s*" + NUM + "\\s+(?:\\bde\\b|\\bd'|\\bof\\b|\\bvon\\b|\\bdi\\b|\\bdel\\b|\\bdella\\b|\\bdes\\b)\\s*(.+)$", "i").exec(body);
          if(ml){ bounds = [ml[1], ml[2]]; body = ml[3]; }
        }
      }
      if(body === null || !body.trim()) return isExplain ? noneResult("explication") : noneResult("intégrale sans expression");
      var dm = /\s*d([a-z])\s*[?.]?\s*$/.exec(body);
      if(dm){ dvar = dm[1]; body = body.slice(0, dm.index); }
      else { var dm2 = /^(.+?)\s+d([xyztuvns])\b(.*)$/.exec(body); if(dm2){ dvar = dm2[2]; body = dm2[1]; } }
      body = cleanExpr(body.replace(/^\s*[-–]?\s*(?:de|d')\s+/i, ""));
      if(isExplain && !looksMathy(body)) return noneResult("explication");
      if(!body) return noneResult("intégrale sans expression");
      var pe = tryParse(body, lang);
      if(!pe.ok) return looksMathy(body) && /[0-9^+*/()]/.test(body) ? Object.assign(base, invalidExpr(body, pe.error)) : noneResult("expression non reconnue");
      var bAst = null;
      if(bounds){
        var cb = function(x){ return String(x).replace(/∞/g, "oo").replace(/\s+/g, ""); };
        var pa = tryParse(cb(bounds[0]), lang), pb = tryParse(cb(bounds[1]), lang);
        if(!pa.ok || !pb.ok) return Object.assign(base, invalidExpr(bounds.join(" … "), pa.ok ? pb.error : pa.error));
        bAst = [pa.ast, pb.ast];
      }
      return Object.assign(base, { kind: "integral", ast: pe.ast, var: dvar || mainVar(pe.ast, "x"), bounds: bAst, notes: pe.notes });
    }

    // ── 2.2 limite ─────────────────────────────────────────────────────────────────────────────────
    if(KW.limit.test(f) && /\b(lim\w*|grenzwert)\b|→|->/.test(f)){
      var ls = mapSub(src.replace(/∞/g, "oo").replace(/→/g, "->")), lm;
      var side = null;
      lm = /(?:lim\w*|limit\w*|grenzwert\w*)\s*(?:de |of |der |di )?\s*(?:\(\s*)?([a-z])\s*(?:->|tend vers|tends to|approaches|gegen|tiende a|tende a)\s*([-+]?\s*(?:oo|infini\w*|infinity|[\d.,/]+)(?:\s*\^?\s*[+-])?)\s*\)?\s*[:,;]?\s*(.+?)\s*[?.]?\s*$/i.exec(ls);
      var expr, pointStr, v;
      if(lm){ v = lm[1]; pointStr = lm[2]; expr = lm[3]; }
      else {
        var lm2 = /(?:limit\w*|limite|lim\w*|grenzwert)\s*(?:de |of |der |di )?\s*(.+?)\s*(?:quand|when|as|wenn|cuando|per|lorsque)\s+([a-z])\s*(?:->|tend vers|tends to|approaches|gegen|tiende a|tende a)\s*([-+]?\s*(?:oo|infini\w*|infinity|[\d.,/]+)(?:\s*\^?\s*[+-])?)\s*[?.]?\s*$/i.exec(ls);
        if(lm2){ expr = lm2[1]; v = lm2[2]; pointStr = lm2[3]; }
      }
      if(expr && v && pointStr){
        var ps = pointStr.replace(/\s+/g, ""), sm = /^(.*?)\^?([+-])$/.exec(ps);
        if(sm && /[\d]|oo/.test(sm[1]) && sm[1] !== "" && !/^[-+]$/.test(sm[1])){ side = sm[2]; ps = sm[1]; }
        if(/à droite|from the right|von rechts|por la derecha|da destra|right/.test(f) && !side) side = "+";
        if(/à gauche|from the left|von links|por la izquierda|da sinistra|left/.test(f) && !side) side = "-";
        var point;
        if(/^[-+]?(oo|infini\w*|infinity)$/i.test(ps)) point = /^-/.test(ps) ? "-oo" : "oo";
        else { var pp = tryParse(ps, lang); if(!pp.ok) return Object.assign(base, invalidExpr(ps, pp.error)); point = pp.ast; }
        expr = cleanExpr(expr);
        var pl = tryParse(expr, lang);
        if(!pl.ok) return Object.assign(base, invalidExpr(expr, pl.error));
        return Object.assign(base, { kind: "limit", ast: pl.ast, var: v, point: point, side: side, notes: pl.notes });
      }
      if(!isExplain) return Object.assign(base, { kind: "invalid", src: src, message: "limite non reconnue : précise la variable et le point, par exemple « lim x→0 sin(x)/x »", code: "LIMIT_FORM", status: STATUS.INVALID_INPUT });
    }

    // ── 2.3 dérivée ─────────────────────────────────────────────────────────────────────────────────
    if(KW.deriv.test(f) && !isExplain || /\bd\s*\/\s*d[a-z]\b/.test(f)){
      var dv = null, dexpr = null, order = 1;
      var dm1 = /d\s*\/\s*d([a-z])\s*(?:\(|\[|\s)\s*(.+?)\s*[)\]]?\s*[?.]?\s*$/i.exec(src);
      if(dm1){ dv = dm1[1]; dexpr = dm1[2]; }
      if(!dexpr){
        var fdef = /([a-zA-Z])\s*\(\s*([a-z])\s*\)\s*=\s*([^,;?\n]+?)\s*(?:[,;.]|\s+(?:calcule|compute|find|trouve|donne|give|determine)|$)/i.exec(src);
        if(fdef && /f\s*'|deriv|derivat|differenti/i.test(f)){ dexpr = fdef[3]; dv = fdef[2]; }
      }
      if(!dexpr){
        var dm2 = /(?:derivee?s?|derive[rz]?|derivative|differentiate|diff|ableit\w*|derivad\w*|derivat\w*)\s*(?:seconde|second|deuxieme)?\s*(?:de |of |d'|du |der |von |di )?\s*(?:la fonction |the function |f\(x\)\s*=\s*)?(.+?)\s*[?.]?\s*$/i.exec(fold(src).length === src.length ? src : src);
        if(dm2) dexpr = dm2[1];
      }
      if(dexpr){
        if(/\b(seconde|second|deuxieme|2nd|zweite)\b/i.test(f)) order = 2;
        var wr = /\s*(?:par rapport [àa]|with respect to|respecto a|nach|rispetto a)\s+([a-z])\s*$/i.exec(dexpr);
        if(wr){ dv = wr[1]; dexpr = dexpr.slice(0, wr.index); }
        dexpr = cleanExpr(dexpr);
        if(/^(de|of|du|des|der|von|di|la|le|les|the|d'|l'|f)$/i.test(String(dexpr).trim())) return noneResult("aucune expression à dériver");
        var pd = tryParse(dexpr, lang);
        if(!pd.ok) return looksMathy(dexpr) && /[0-9^+*/()]/.test(dexpr) ? Object.assign(base, invalidExpr(dexpr, pd.error)) : noneResult("expression non reconnue");
        return Object.assign(base, { kind: "derivative", ast: pd.ast, var: dv || mainVar(pd.ast, "x"), order: order, notes: pd.notes });
      }
    }

    // ── 2.4 matrices ───────────────────────────────────────────────────────────────────────────────
    if((KW.matrix.test(f) || /\[\s*\[/.test(src)) && /\[/.test(src)){
      var lits = src.match(/\[\s*\[[^\]]*\](?:\s*,\s*\[[^\]]*\])*\s*\]|\[[^\[\]]*;[^\[\]]*\]/g) || [];
      var mats = [];
      for(var li = 0; li < lits.length; li++){ var pm = tryParse(lits[li], lang); if(!pm.ok) return Object.assign(base, invalidExpr(lits[li], pm.error)); mats.push(pm.ast); }
      var op = null;
      if(/\b(determinant\w*|determinante\w*|det\b)/.test(f)) op = "det";
      else if(/\b(valeurs? propres?|eigenval\w*|autovalor\w*|autovalori|eigenwert\w*)/.test(f)) op = "eigen";
      else if(/\b(vecteurs? propres?|eigenvect\w*|autovett\w*)/.test(f)) op = "eigenvects";
      else if(/\btranspos\w*/.test(f)) op = "transpose";
      else if(/\b(rang|rank)\b/.test(f)) op = "rank";
      else if(/\binvers\w*|\binvert\w*/.test(f)) op = "inverse";
      else if(mats.length === 2 && (/[*×]/.test(src) || /\b(produit|multipli\w*|product|multiply|prodotto|producto|produkt)\b/.test(f))) op = "mul";
      else if(mats.length === 2 && (/\+/.test(src) || /\b(somme|sum|addition\w*|add|addiere\w*|suma|sommare|somma)\b/.test(f))) op = "add";
      if(!op || !mats.length) return isExplain ? noneResult("explication") : Object.assign(base, { kind: "invalid", src: src, message: "opération matricielle non reconnue", code: "MATRIX_OP", status: STATUS.INVALID_INPUT });
      if((op === "mul" || op === "add") && mats.length < 2) return Object.assign(base, { kind: "invalid", src: src, message: "deux matrices sont nécessaires", code: "MATRIX_B", status: STATUS.INVALID_INPUT });
      return Object.assign(base, { kind: "matrix", op: op, A: mats[0], B: mats[1] || null });
    }

    // ── 2.5 système / équation / factoriser / développer / simplifier ───────────────────────────
    var kwSolve = KW.solve.test(f), kwFactor = KW.factor.test(f), kwExpand = KW.expand.test(f), kwSimplify = KW.simplify.test(f);
    if((kwSolve || kwFactor || kwExpand || kwSimplify) && !(isExplain && !/[=0-9^]/.test(src))){
      var kwRe = kwFactor ? KW.factor : kwExpand ? KW.expand : kwSimplify ? KW.simplify : KW.solve;
      var kind = kwFactor ? "factor" : kwExpand ? "expand" : kwSimplify ? "simplify" : "equation";
      var rest;
      var ff = fold(src), mk = kwRe.exec(ff);
      if(mk){ rest = src.slice(mk.index + mk[0].length); }
      else rest = src;
      rest = rest.replace(/^\s*(?:le |la |les |l'|l’|the |the following |ce |cette |this )?(?:systeme|system|sistema|equations?|polynome|expression|fonction|function|racines?|roots?|zeros?|solutions?)\s*(?:de |d'|du |of |:)?\s*/i, "");
      var isSystem = /\bsyst[eè]me\b|\bsystem\b|\bsistema\b/i.test(src) || (rest.match(/=/g) || []).length >= 2;
      rest = rest.replace(/^\s*(?:[:–—])\s*/, "").replace(/^\s*(?:de |d'|du |of |:)\s*/i, "");
      if(kind === "equation" && isSystem){
        var parts = splitEquations(rest.replace(/[?.]\s*$/, ""));
        if(parts.length >= 2){
          var eqs = [];
          for(var i = 0; i < parts.length; i++){ var pe2 = tryParse(parts[i], lang); if(!pe2.ok) return Object.assign(base, invalidExpr(parts[i], pe2.error)); if(pe2.ast.t !== "eq") return Object.assign(base, invalidExpr(parts[i], { message: "équation attendue (avec « = »)", code: "NOT_EQUATION" })); eqs.push(pe2.ast); }
          return Object.assign(base, { kind: "system", eqs: eqs });
        }
      }
      var domain = null;
      var dmDom = /\s*(?:\b(?:en|dans|in|over|sur|im|nei|nel|en los|sobre)\s+(?:l'ensemble des |les |the |los |die |i |il |el |der )?(?:nombres? |numbers? |n[uú]meros? |zahlen |numeri )?|\s)(?:(complexes?|complex|complejos?|komplex\w*|complessi)|(r[ée]els?|reals?|reales?|reell\w*|reali))\s*[?.]?\s*$/i.exec(rest);
      if(dmDom && kind === "equation"){ domain = dmDom[1] ? "complex" : "real"; rest = rest.slice(0, dmDom.index); }
      var dm3 = /\s*(?:dans |in |over |sur |en )?(ℂ|ℝ)\s*[?.]?\s*$/.exec(rest);
      if(dm3 && kind === "equation"){ domain = dm3[1] === "ℂ" ? "complex" : "real"; rest = rest.slice(0, dm3.index); }
      var exprS = cleanExpr(rest);
      if(!exprS) return noneResult("pas d'expression");
      if(isExplain && !looksMathy(exprS)) return noneResult("explication");
      if(/\b(mon|ma|mes|notre|the|a|un|une)\b\s+\w+/i.test(exprS) && !/[0-9=^+*\/]/.test(exprS)) return noneResult("expression non mathématique");
      var pe3 = tryParse(exprS, lang);
      if(!pe3.ok){
        // un texte courant (« un trinôme du second degré ») n'est pas une expression : on laisse le LLM répondre
        if(!/[0-9^=+*/()]/.test(exprS)) return noneResult("pas d'expression");
        return Object.assign(base, invalidExpr(exprS, pe3.error));
      }
      if(pe3.notes.some(function(n){ return n.indexOf("split-word") === 0; }) && !/[0-9=^+*\/]/.test(exprS)) return noneResult("mots, pas une expression");
      var ast3 = pe3.ast;
      if(kind === "equation"){
        if(ast3.t !== "eq"){ base.notes.push("equation-without-equals"); ast3 = { t: "eq", l: ast3, r: C.mkq(0) }; }
        return Object.assign(base, { kind: "equation", eq: ast3, var: mainVar(ast3), domain: domain, notes: base.notes.concat(pe3.notes) });
      }
      if(ast3.t === "eq") return Object.assign(base, invalidExpr(exprS, { message: "une expression est attendue, pas une équation", code: "EQUATION_GIVEN" }));
      return Object.assign(base, { kind: kind, ast: ast3, var: mainVar(ast3), notes: pe3.notes });
    }

    if(isExplain) return noneResult("explication demandée");
    // Probabilités, statistiques, finance, arithmétique : tout cela exige des NOMBRES. Sans aucun chiffre (« comment calculer la VAN ? »,
    // « la différence entre le TRI et la VAN »), c'est une question de cours : le moteur ne se déclenche pas et le modèle explique.
    if(!/\d/.test(src)) return noneResult("aucun nombre : question conceptuelle");

    // ── 2.6 probabilités ──────────────────────────────────────────────────────────────────────────
    var nums = extractNumbers(src, lang);
    var named = function(re, mapper){ var mm = re.exec(src); return mm ? mapper(mm) : null; };
    var numTok = "(-?\\d[\\d  ]*(?:[.,]\\d+)?(?:\\s*/\\s*\\d+)?\\s*%?)";
    function valOf(s){ s = String(s).trim(); var pct = /%$/.test(s); s = s.replace(/%$/, "").trim(); var fr = /^(-?[\d ]+(?:[.,]\d+)?)\s*\/\s*(\d+)$/.exec(s); var r = fr ? toRat(fr[1], lang).div(rat(Number(fr[2]))) : toRat(s, lang); if(!r) return null; return pct ? r.div(rat(100)) : r; }

    if(KW.bayes.test(f) || /p\s*\(\s*[a-z]\s*\|\s*[a-z]\s*\)/i.test(src) && /p\s*\(\s*[a-z]\s*\)\s*=/i.test(src)){
      var pA = named(new RegExp("P\\s*\\(\\s*A\\s*\\)\\s*=\\s*" + numTok, "i"), function(mm){ return valOf(mm[1]); });
      var pBgA = named(new RegExp("P\\s*\\(\\s*B\\s*\\|\\s*A\\s*\\)\\s*=\\s*" + numTok, "i"), function(mm){ return valOf(mm[1]); });
      var pBgNA = named(new RegExp("P\\s*\\(\\s*B\\s*\\|\\s*(?:¬\\s*A|non\\s*A|not\\s*A|Ā|A\\^?c|A'|\\\\bar\\{?A\\}?)\\s*\\)\\s*=\\s*" + numTok, "i"), function(mm){ return valOf(mm[1]); });
      var pB = named(new RegExp("P\\s*\\(\\s*B\\s*\\)\\s*=\\s*" + numTok, "i"), function(mm){ return valOf(mm[1]); });
      if(pA && pBgA && (pBgNA || pB)) return Object.assign(base, { kind: "bayes", pA: pA, pBgA: pBgA, pBgNA: pBgNA, pB: pB });
      return Object.assign(base, { kind: "invalid", src: src, code: "BAYES_PARAMS", status: STATUS.INVALID_INPUT, message: "pour Bayes, donne P(A), P(B|A) et P(B|non A) (ou P(B))" });
    }
    if(KW.binom.test(f)){
      var n = named(/(?:\bn\b|B\s*\()\s*[=(]?\s*(\d+)/i, function(mm){ return parseInt(mm[1], 10); });
      var pBin = named(new RegExp("(?:\\bp\\b\\s*=|B\\s*\\(\\s*\\d+\\s*[;,]|probabilit[eé] (?:de succ[eè]s )?(?:de|=|est)\\s*)\\s*" + numTok.replace("(-?", "(") , "i"), function(mm){ return valOf(mm[1]); });
      if(!pBin){ var pm1 = /\bp\s*=\s*([\d.,/]+\s*%?)/i.exec(src); if(pm1) pBin = valOf(pm1[1]); }
      var spec = null, em;
      if((em = /P\s*\(\s*X\s*(=|==|<=|≤|>=|≥|<|>)\s*(\d+)\s*\)/i.exec(src))){ spec = { kind: { "=": "eq", "==": "eq", "<=": "le", "≤": "le", ">=": "ge", "≥": "ge", "<": "lt", ">": "gt" }[em[1]], k: parseInt(em[2], 10) }; }
      else if((em = /(exactement|exactly|exactamente|genau|esattamente)\s+(\d+)/i.exec(f))){ spec = { kind: "eq", k: parseInt(em[2], 10) }; }
      else if((em = /(au plus|at most|como maximo|hochstens|al massimo)\s+(\d+)/i.exec(f))){ spec = { kind: "le", k: parseInt(em[2], 10) }; }
      else if((em = /(au moins|at least|al menos|mindestens|almeno)\s+(\d+)/i.exec(f))){ spec = { kind: "ge", k: parseInt(em[2], 10) }; }
      if(n !== null && pBin && spec) return Object.assign(base, { kind: "binomial", n: n, p: pBin, spec: spec });
      return Object.assign(base, { kind: "invalid", src: src, code: "BINOMIAL_PARAMS", status: STATUS.INVALID_INPUT, message: "pour une loi binomiale, donne n, p et l'événement, par exemple « B(10 ; 0,5), P(X = 3) »" });
    }
    if(KW.normal.test(f) || /\bz\b.*\b(critique|critical)\b/.test(f)){
      var mu = named(/(?:μ|mu|moyenne|mean|media|mittelwert)\s*=?\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      var sg = named(/(?:σ|sigma|ecart[- ]?type|écart[- ]?type|std|sd|standard deviation|desviacion|standardabweichung)\s*=?\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      var nn = /N\s*\(\s*(-?[\d.,]+)\s*;\s*(-?[\d.,]+)\s*\)/i.exec(src);
      if(nn && !mu && !sg){ mu = toRat(nn[1], lang); sg = toRat(nn[2], lang); base.notes.push("N(μ ; σ) : convention française, le 2ᵉ paramètre est l'écart-type σ (pas la variance)"); }
      else if(/N\s*\(\s*-?[\d.,]+\s*,\s*-?[\d.,]+\s*\)/.test(src) && !mu && !sg) return Object.assign(base, { kind: "invalid", src: src, code: "NORMAL_AMBIGUOUS", status: STATUS.AMBIGUOUS, message: "N(a, b) est ambigu : b est-il l'écart-type σ ou la variance σ² ? Écris « μ = … et σ = … » ou N(μ ; σ)." });
      if(!mu) mu = rat(0); if(!sg && /\bz\b|standard|centr/.test(f) && !mu) sg = rat(1);
      var nspec = null, nm;
      if((nm = /P\s*\(\s*(-?[\d.,]+)\s*(?:<=|≤|<)\s*X\s*(?:<=|≤|<)\s*(-?[\d.,]+)\s*\)/i.exec(src))){ nspec = { kind: "between", a: toRat(nm[1], lang), b: toRat(nm[2], lang) }; }
      else if((nm = /P\s*\(\s*X\s*(<=|≤|<|>=|≥|>)\s*(-?[\d.,]+)\s*\)/i.exec(src))){ nspec = { kind: { "<=": "le", "≤": "le", "<": "lt", ">=": "ge", "≥": "ge", ">": "gt" }[nm[1]], x: toRat(nm[2], lang) }; }
      else if((nm = /(?:quantile|percentile|valeur de x telle que|x tel que|inverse)[^\d]*(\d+(?:[.,]\d+)?)\s*%?/i.exec(src))){ var pv = toRat(nm[1], lang); if(/%/.test(nm[0]) || pv.cmp(rat(1)) > 0) pv = pv.div(rat(100)); nspec = { kind: "inverse", p: pv }; }
      else if(/\bz\b.*\b(critique|critical)\b/.test(f)){ var lvl = nums.filter(function(x){ return x.percent; })[0]; if(lvl){ nspec = { kind: "inverse", p: rat(1).add(lvl.value.div(rat(100))).div(rat(2)) }; mu = rat(0); sg = rat(1); base.notes.push("z critique bilatéral : Φ⁻¹((1 + niveau)/2)"); } }
      if(sg && nspec) return Object.assign(base, { kind: "normal", mu: mu, sigma: sg, spec: nspec });
      return Object.assign(base, { kind: "invalid", src: src, code: "NORMAL_PARAMS", status: STATUS.INVALID_INPUT, message: "pour une loi normale, donne μ, σ et l'événement, par exemple « μ = 100, σ = 15, P(X ≤ 120) »" });
    }
    if(KW.ci.test(f)){
      var xbar = named(/(?:moyenne|mean|x̄|x̄|xbar|media)\s*(?:de l'echantillon|empirique|observee|observée)?\s*=?\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      var sigma = named(/(?:σ|sigma)\s*=?\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      var nSamp = named(/\bn\s*=\s*(\d+)/i, function(mm){ return parseInt(mm[1], 10); });
      var lev = nums.filter(function(x){ return x.percent; })[0];
      if(xbar && sigma && nSamp && lev) return Object.assign(base, { kind: "ci", mean: xbar, sigma: sigma, n: nSamp, level: lev.value.div(rat(100)) });
      if(xbar && nSamp && lev && !sigma) return Object.assign(base, { kind: "invalid", src: src, code: "CI_T", status: STATUS.UNSUPPORTED, message: "σ inconnu : l'intervalle exact utilise la loi de Student (t), que ce moteur ne calcule pas encore. Donne σ (connu) pour un intervalle z." });
      return Object.assign(base, { kind: "invalid", src: src, code: "CI_PARAMS", status: STATUS.INVALID_INPUT, message: "pour un intervalle de confiance z, donne la moyenne, σ (connu), n et le niveau (ex. 95 %)" });
    }
    if(KW.zscore.test(f)){
      var xv = named(/\bx\s*=\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      var mz = named(/(?:μ|mu|moyenne|mean|media)\s*=?\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      var sz = named(/(?:σ|sigma|ecart[- ]?type|std|sd|standard deviation)\s*=?\s*(-?[\d.,]+)/i, function(mm){ return toRat(mm[1], lang); });
      if(xv && mz && sz) return Object.assign(base, { kind: "zscore", x: xv, mean: mz, sd: sz });
      return Object.assign(base, { kind: "invalid", src: src, code: "ZSCORE_PARAMS", status: STATUS.INVALID_INPUT, message: "pour un z-score, donne x, la moyenne μ et l'écart-type σ" });
    }
    if(KW.corr.test(f)){
      var groups = src.match(/\[[^\]]+\]|\([^)]*\d[^)]*\)/g) || [];
      if(groups.length >= 2){
        var xs = extractNumbers(groups[0].replace(/[\[\]()]/g, " "), lang).map(function(z){ return z.value; }), ys = extractNumbers(groups[1].replace(/[\[\]()]/g, " "), lang).map(function(z){ return z.value; });
        if(xs.length >= 2 && xs.length === ys.length) return Object.assign(base, { kind: "covariance", xs: xs, ys: ys });
      }
      return Object.assign(base, { kind: "invalid", src: src, code: "CORR_PARAMS", status: STATUS.INVALID_INPUT, message: "pour une corrélation/régression, donne deux séries de même longueur entre crochets : x = [1 2 3], y = [2 4 5]" });
    }

    // ── 2.7 statistiques descriptives ───────────────────────────────────────────────────────────
    if(KW.stats.test(f)){
      var data = nums.filter(function(x){ return !x.percent; });
      // « 5 données », « n = 8 » : on ignore les nombres qui décrivent la taille
      if(data.length >= 2){
        var asked = [];
        if(/\b(moyenne|mean|average|promedio|mittelwert|durchschnitt|media)\b/.test(f)) asked.push("mean");
        if(/\b(mediane|median|mediana)\b/.test(f)) asked.push("median");
        if(/\b(mode|modal|moda)\b/.test(f)) asked.push("mode");
        if(/\bvariance|varianza|varianz/.test(f)) asked.push("variance");
        if(/\becart[- ]?type|standard deviation|desviacion|standardabweichung|deviazione standard/.test(f)) asked.push("sd");
        if(/\bquartiles?\b/.test(f)) asked.push("quartiles");
        if(/\betendue|range\b/.test(f)) asked.push("range");
        var conv = /\b(echantillon|sample|muestra|stichprobe|campione|corrigee?|sans biais|unbiased|\(n\s*-\s*1\)|n-1)\b/.test(f) ? "sample" : (/\b(population|poblacion|grundgesamtheit|popolazione|\(n\)|empirique)\b/.test(f) ? "population" : null);
        var qm = /\b(exclusive|exclusif|quartile\.exc|exc)\b/.test(f) ? "exc" : "inc";
        return Object.assign(base, { kind: "stats", data: data.map(function(x){ return x.value; }), asked: asked.length ? asked : ["mean"], convention: conv, quartileMethod: qm });
      }
    }

    // ── 2.8 finance ──────────────────────────────────────────────────────────────────────────────────
    var pct = nums.filter(function(x){ return x.percent; });
    var dur = durationYears(f);
    var financeWords = KW.cagr.test(f) || KW.irr.test(f) || KW.npv.test(f) || KW.propRate.test(f) || KW.equivRate.test(f) || KW.payment.test(f) || /%/.test(src);
    if(nums.ambiguousSpace && financeWords && !KW.npv.test(f) && !KW.irr.test(f))
      return Object.assign(base, { kind: "invalid", src: src, code: "AMBIGUOUS_SPACE", status: STATUS.AMBIGUOUS, message: "un espace entre groupes de 3 chiffres est ambigu (milliers ou valeurs séparées ?) : écris le nombre d'un bloc (100500) ou sépare les valeurs par « ; »" });
    var plain = nums.filter(function(x){ return !x.percent && notInSpan(x, dur); });
    if(KW.cagr.test(f)){
      if(plain.length >= 2 && dur) return Object.assign(base, { kind: "finance", fn: "cagr", v0: plain[0].value, v1: plain[1].value, years: dur.years });
      return Object.assign(base, { kind: "invalid", src: src, code: "CAGR_PARAMS", status: STATUS.INVALID_INPUT, message: "pour un TCAM, donne la valeur initiale, la valeur finale et la durée" });
    }
    if(KW.irr.test(f)){
      var flowsI = plain.map(function(x){ return x.value; });
      if(flowsI.length >= 2) return Object.assign(base, { kind: "finance", fn: "irr", flows: flowsI });
    }
    if(KW.npv.test(f)){
      if(pct.length){
        var rN = pctToRat(pct[0]), flowsN = plain.slice();
        var init = /(?:investissement(?: initial)?|initial investment|outlay|cout initial|coût initial|inversion inicial|anfangsinvestition|investimento iniziale|capex|i0|cf0)\D{0,14}?(-?\d[\d  .,]*)/i.exec(src), cf0 = null;
        if(init){ var iv = extractNumbers(init[1], lang)[0]; if(iv){ cf0 = iv.value.sign() > 0 ? iv.value.neg() : iv.value; flowsN = flowsN.filter(function(x){ return !(x.index >= init.index && x.index < init.index + init[0].length); }); } }
        else if(flowsN.length && flowsN[0].value.sign() < 0){ cf0 = flowsN[0].value; flowsN = flowsN.slice(1); }
        if(cf0 !== null && flowsN.length) return Object.assign(base, { kind: "finance", fn: "npv", rate: rN, flows: [cf0].concat(flowsN.map(function(x){ return x.value; })) });
      }
      return Object.assign(base, { kind: "invalid", src: src, code: "NPV_PARAMS", status: STATUS.INVALID_INPUT, message: "pour une VAN, donne le taux, l'investissement initial et les flux annuels" });
    }
    if(KW.propRate.test(f) || KW.equivRate.test(f)){
      if(pct.length){
        var PW = { annuel: 1, annual: 1, yearly: 1, anual: 1, jahrlich: 1, annuale: 1, mensuel: 12, monthly: 12, mensual: 12, monatlich: 12, mensile: 12, trimestriel: 4, quarterly: 4, trimestral: 4, vierteljahrlich: 4, trimestrale: 4, semestriel: 2, semiannual: 2, semestral: 2, halbjahrlich: 2, semestrale: 2 };
        var found = [], pwre = /(annuel\w*|annual\w*|yearly|anual\w*|jahrlich\w*|mensuel\w*|monthly|mensual\w*|monatlich\w*|mensile|trimestr\w*|quarterly|vierteljahrlich\w*|semestr\w*|semiannual\w*|halbjahrlich\w*)/g, pw;
        while((pw = pwre.exec(f))){ var key = pw[1].replace(/(le|les|s|e)?$/, ""); var per = null; for(var k in PW){ if(pw[1].indexOf(k.slice(0, 5)) === 0){ per = PW[k]; break; } } if(per) found.push({ per: per, idx: pw.index }); }
        var distinct = found.filter(function(x, i){ return found.findIndex(function(y){ return y.per === x.per; }) === i; });
        if(distinct.length >= 2){
          var pidx = pct[0].index, given = distinct.slice().sort(function(a, b){ return Math.abs(a.idx - pidx) - Math.abs(b.idx - pidx); })[0], target = distinct.filter(function(x){ return x.per !== given.per; })[0];
          return Object.assign(base, { kind: "finance", fn: KW.propRate.test(f) ? "prop-rate" : "equiv-rate", rate: pctToRat(pct[0]), fromPer: given.per, toPer: target.per });
        }
      }
      return Object.assign(base, { kind: "invalid", src: src, code: "RATE_PARAMS", status: STATUS.AMBIGUOUS, message: "précise le taux et les deux périodes (par exemple « taux mensuel équivalent à un taux annuel de 5 % »)" });
    }
    if(KW.payment.test(f) && pct.length && dur){
      var Pn = plain.filter(function(x){ return x.value.sign() > 0; })[0];
      if(Pn){
        var monthlyPay = !/\bannuite\w*|\banual\w*|per year|annual payment|yearly payment/.test(f);
        var nPer = monthlyPay ? (dur.months ? Number(dur.months.n) : Number(dur.years.mul(rat(12)).n)) : Number(dur.years.n);
        return Object.assign(base, { kind: "finance", fn: "payment", principal: Pn.value, annualRate: pctToRat(pct[0]), periods: nPer, monthly: monthlyPay, money: Pn.money, notes: ["taux périodique proportionnel : taux annuel ÷ 12 pour des mensualités"].filter(function(){ return monthlyPay; }) });
      }
    }
    // pourcentage d'un nombre / variation / pourcentage inverse
    var mpo = /(\d+(?:[.,]\d+)?)\s*(?:%|pour ?cent|percent)\s*(?:de|of|d'|du|des|von|di|del)\s*(-?\d[\d  .,]*)/.exec(f);
    if(mpo && nums.length >= 2){
      var pbase = nums.filter(function(x){ return !x.percent; })[0];
      if(pbase) return Object.assign(base, { kind: "finance", fn: "percent-of", pct: toRat(mpo[1], lang), base: pbase.value, money: pbase.money });
    }
    var mrev = /(prix|montant|valeur|price|amount|value)\s+(?:initial|de depart|original|avant)|avant\s+(?:la |une |le |l')?(?:hausse|baisse|remise|reduction|augmentation|increase|discount)|before\s+(?:the\s+)?(?:increase|discount|markup)/.exec(f);
    if(mrev && pct.length && plain.length){
      var up = /\b(hausse|augmentation|increase|markup|majoration|aumento|erhohung|aumento)\b/.test(f), down = /\b(baisse|remise|reduction|diminution|discount|decrease|rebaja|rabatt|sconto)\b/.test(f);
      if(up !== down){ var fin = plain[0].value, pp2 = pctToRat(pct[0]), factor = up ? rat(1).add(pp2) : rat(1).sub(pp2); return Object.assign(base, { kind: "finance", fn: "reverse-percent", final: fin, pct: pp2, up: up, factor: factor, money: plain[0].money }); }
    }
    var mv = /(?:de|from|von|da|desde)\s*(-?\d[\d  .,]*)\s*(?:a|à|to|auf|bis|->|→)\s*(-?\d[\d  .,]*)/.exec(f);
    if(mv && /\b(variation|evolution|augmentation|hausse|baisse|diminution|croissance|passe|passer|increase|decrease|change|growth|grew|rose|fell|aumento|veranderung|variazione)\b/.test(f)){
      var nn2 = nums.filter(function(x){ return !x.percent; });
      if(nn2.length >= 2) return Object.assign(base, { kind: "finance", fn: "percent-change", from: nn2[0].value, to: nn2[1].value });
    }
    // intérêts : capital + taux + durée
    if(pct.length && dur){
      var cap = plain.filter(function(x){ return x.value.sign() > 0; })[0];
      if(cap){
        var type = KW.discount.test(f) ? "discount" : KW.simpleInt.test(f) ? "simple" : "compound";
        var perYear = /\b(mensuel\w*|monthly|par mois|mensual\w*|monatlich\w*|mensile)\b/.test(f) ? 12 : /\b(trimestriel\w*|quarterly|trimestral\w*|vierteljahr\w*|trimestrale)\b/.test(f) ? 4 : /\b(semestriel\w*|semi[- ]?annual\w*|semestral\w*|halbjahr\w*|semestrale)\b/.test(f) ? 2 : 1;
        var nts = [];
        if(type === "compound" && !KW.compoundInt.test(f) && !/\b(place|investi|epargn|depos|saving|invest|deposit|capital|rapporte|valeur future|future value|vaut|worth|obtient|obtain|grows?|devient)\b/.test(f)) { /* aucun mot : par défaut composé */ }
        if(type === "compound" && !KW.compoundInt.test(f)) nts.push("intérêts composés (capitalisation annuelle) par défaut : précise « intérêts simples » si tu les veux simples");
        return Object.assign(base, { kind: "finance", fn: type, capital: cap.value, rate: pctToRat(pct[0]), years: dur.years, perYear: perYear, money: cap.money, notes: nts });
      }
    }

    // ── 2.9 arithmétique pure ───────────────────────────────────────────────────────────────────
    var exprA = src.replace(/^\s*(?:calcule\w*|calculer|quelle est la valeur de|quelle est|combien (?:font|fait|vaut|valent)|qu'est[- ]ce (?:que|qu')|c'est quoi|how much is|what is the value of|what is|what's|cuanto es|cu[aá]nto es|que es|wieviel ist|was ist|quanto fa|quanto fa|cos'[eè]|compute|evaluate|evalue\w*)\s*/i, "").replace(/\s*[?=]\s*$/, "").trim();
    exprA = exprA.replace(/^(.+?)\s+mod(?:ulo)?\s+(.+)$/i, "mod(($1);($2))");
    exprA = exprA.replace(/(\d)\s*[xX]\s*(?=[\d(])/g, "$1*");
    var explicitCmd = /^\s*(?:calcule\w*|calculer|compute|evaluate|evalue\w*|calcula\w*|berechne\w*|calcola\w*)\b/i.test(src);   // un verbe de calcul explicite : tout échec de lecture doit être DIT, pas ignoré
    if(explicitCmd && exprA && /[0-9]/.test(exprA) && exprA.length > 300) return Object.assign(base, { kind: "invalid", src: src.slice(0, 80), code: "TOO_COMPLEX", message: "expression trop longue", status: STATUS.UNSUPPORTED });
    if(exprA && exprA.length <= 300 && /[0-9]/.test(exprA) && (explicitCmd || /[+\-*/^×÷√!%]|\b(sqrt|ln|log|exp|sin|cos|tan|abs|binom|root|cbrt|mod|gcd|lcm|pgcd|ppcm)\s*\(/i.test(exprA))){
      if(!/[A-Za-z]{3,}/.test(exprA.replace(/\b(sqrt|ln|log\d*|exp|sin|cos|tan|asin|acos|atan|abs|binom|root|cbrt|fact|pi|oo|mod|gcd|lcm|pgcd|ppcm)\b/gi, ""))){
        var pa2 = tryParse(exprA, lang);
        if(pa2.ok && C.freeVars(pa2.ast).length === 0 && pa2.ast.t !== "eq" && !pa2.notes.some(function(n){ return n.indexOf("split-word") === 0; })) return Object.assign(base, { kind: "arith", ast: pa2.ast, notes: pa2.notes });
        if(!pa2.ok && /^[\d\s+\-*/^().,×÷√!%a-z]+$/i.test(exprA) && /^\s*[\d(√-]/.test(exprA) && (explicitCmd || ((exprA.match(/[+\-*/^×÷]/g) || []).length >= 1 && !/\s[a-z]{4,}\s/i.test(exprA))))
          return Object.assign(base, invalidExpr(exprA, pa2.error));
        if(!pa2.ok && explicitCmd) return Object.assign(base, invalidExpr(exprA, pa2.error));
      }
    }
    return noneResult("aucun problème mathématique reconnu");
  }

  /* ── 3. EXÉCUTION FAST ───────────────────────────────────────────────────── */
  function money(r, lang, unit){ return F.money(r, lang, unit || "€"); }

  function runFast(p){
    var lang = p.lang;
    switch(p.kind){
      case "arith": {
        var a = p.ast, ar = F.arithmetic(a, { lang: lang });
        // racine carrée d'un rationnel : forme exacte « 2√2 »
        if(ar.ok && ar.needsCAS && a.t === "call" && a.fn === "sqrt"){
          try{ var q = C.evalExact(a.args[0], {}); var sr = C.sqrtRat(q); var st = C.surdText(sr.coef, sr.rad); ar.exact = { text: st.text, latex: st.latex }; ar.needsCAS = false;
               ar.verification = { status: STATUS.VERIFIED_EXACT, method: "carré-de-la-racine", detail: "(coef·√rad)² = argument, vérifié exactement" };
               if(!sr.coef.mul(sr.coef).mul(new Rat(sr.rad)).eq(q)) ar.verification = { status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "check-failed", detail: "" }; }catch(e){ /* reste approximatif */ }
        }
        return ar;
      }
      case "factor": return F.factorPoly(p.ast, p.var, { lang: lang });
      case "expand": return F.expandPoly(p.ast, p.var);
      case "simplify": {
        var r1 = F.simplifyRational(p.ast, p.var);
        if(r1.ok) return r1;
        var r2 = F.expandPoly(p.ast, p.var); // un polynôme à simplifier = le développer
        return r2.ok ? r2 : r1;
      }
      case "equation": return F.solveEquation(p.eq, p.var, { lang: lang, domain: p.domain || null });
      case "system": return F.solveSystem(p.eqs, null, { lang: lang });
      case "derivative": {
        var cur = p.ast, res = null;
        for(var k = 0; k < (p.order || 1); k++){
          res = F.derivativePoly(cur, p.var); if(!res.ok) return res;
          cur = polyAst(res.poly, p.var);
        }
        return res;
      }
      case "integral": return F.integralPoly(p.ast, p.var, p.bounds);
      case "limit": return F.needsCAS("limite : calcul formel nécessaire");
      case "matrix": {
        try{
          var A = F.matFromAst(p.A), B = p.B ? F.matFromAst(p.B) : null;
          if(p.op === "eigenvects") return F.needsCAS("vecteurs propres : calcul formel");
          return F.matrixOp(p.op, A, B, { lang: lang });
        }catch(e){ return e && e.name === "MathError" && (e.code === "IRRATIONAL" || e.code === "UNBOUND") ? F.needsCAS("matrice non rationnelle") : F.fromError(e); }
      }
      case "stats": return runStats(p);
      case "covariance": return F.covariance(p.xs, p.ys, { lang: lang });
      case "zscore": return F.zScore(p.x, p.mean, p.sd);
      case "binomial": return F.binomial(p.n, p.p, p.spec, { lang: lang });
      case "normal": {
        var spec = p.spec, s2 = {};
        if(spec.kind === "between"){ s2 = { kind: "between", a: spec.a.toNumber(), b: spec.b.toNumber() }; }
        else if(spec.kind === "inverse") s2 = { kind: "inverse", p: spec.p.toNumber() };
        else s2 = { kind: spec.kind, x: spec.x.toNumber() };
        return F.normal(s2, p.mu.toNumber(), p.sigma.toNumber(), { lang: lang });
      }
      case "bayes": return F.bayes(p.pA, p.pBgA, { pBgNotA: p.pBgNA, pB: p.pB && !p.pBgNA ? p.pB : null });
      case "ci": return runCI(p);
      case "finance": return runFinance(p);
    }
    return F.needsCAS("type de problème inconnu");
  }
  function polyAst(pl, v){            // polynôme → AST (pour réutiliser dans une 2ᵉ dérivation)
    var node = null;
    for(var i = pl.length - 1; i >= 0; i--){
      if(pl[i].isZero() && pl.length > 1) continue;
      var term = i === 0 ? C.qnode(pl[i]) : C.bin("*", C.qnode(pl[i]), i === 1 ? C.sym(v) : C.bin("^", C.sym(v), C.mkq(i)));
      node = node ? C.bin("+", node, term) : term;
    }
    return node || C.mkq(0);
  }
  function runStats(p){
    var d = F.descriptive(p.data, { lang: p.lang }); if(!d.ok) return d;
    var lang = p.lang, L = [], asked = p.asked, steps = [];
    var dtxt = function(r){ var x = F.presentRat(r, { lang: lang, digits: 6 }); return x.isInt ? x.exactText : x.exactText + (x.decimalExact ? " = " : " ≈ ") + x.decimalText; };
    var convAmb = false;
    function varLine(){ var pop = dtxt(d.varPop), sam = d.varSample ? dtxt(d.varSample) : null;
      if(p.convention === "population") return ["variance (population, ÷ n) = " + pop];
      if(p.convention === "sample") return sam ? ["variance (échantillon, ÷ (n−1)) = " + sam] : ["variance d'échantillon indéfinie pour n = 1"];
      convAmb = true; return ["variance de la POPULATION (÷ n) = " + pop, sam ? "variance de l'ÉCHANTILLON (÷ (n−1)) = " + sam : "variance d'échantillon indéfinie pour n = 1"]; }
    function sdLine(){ var sp = d.sdPop, ss = d.sdSample, t = function(s){ return s.exactIsRational ? s.exact : s.exact + " ≈ " + s.text; };
      if(p.convention === "population") return ["écart-type (population) = " + t(sp)];
      if(p.convention === "sample") return ss ? ["écart-type (échantillon) = " + t(ss)] : ["écart-type d'échantillon indéfini pour n = 1"];
      convAmb = true; return ["écart-type de la POPULATION = " + t(sp), ss ? "écart-type de l'ÉCHANTILLON = " + t(ss) : "écart-type d'échantillon indéfini pour n = 1"]; }
    asked.forEach(function(k){
      if(k === "mean") L.push("moyenne = " + dtxt(d.mean));
      if(k === "median") L.push("médiane = " + dtxt(d.median));
      if(k === "mode") L.push(d.modes.length ? "mode(s) = " + d.modes.join(", ") : "pas de mode (toutes les valeurs apparaissent une seule fois)");
      if(k === "variance") varLine().forEach(function(x){ L.push(x); });
      if(k === "sd") sdLine().forEach(function(x){ L.push(x); });
      if(k === "range") L.push("étendue = " + dtxt(d.range));
      if(k === "quartiles"){
        var qi = d.quartiles.inc, qe = d.quartiles.exc;
        if(p.quartileMethod === "exc" && qe && qe.q1 && qe.q3) L.push("quartiles (méthode exclusive, Excel QUARTILE.EXC) : Q1 = " + dtxt(qe.q1) + " ; Q2 = " + dtxt(qe.q2) + " ; Q3 = " + dtxt(qe.q3));
        else { L.push("quartiles (méthode inclusive, interpolation linéaire, Excel QUARTILE.INC) : Q1 = " + dtxt(qi.q1) + " ; Q2 = " + dtxt(qi.q2) + " ; Q3 = " + dtxt(qi.q3) + " ; IQR = " + dtxt(qi.q3.sub(qi.q1)));
          if(qe && qe.q1 && qe.q3) L.push("(méthode exclusive : Q1 = " + dtxt(qe.q1) + ", Q3 = " + dtxt(qe.q3) + ")"); }
      }
    });
    var notes = []; if(convAmb) notes.push("convention non précisée : population ET échantillon sont donnés — précise laquelle utiliser");
    d.exact = { text: L.join(" ; "), latex: "" }; d.lines = L; d.kind = "descriptive"; d.notes = notes; d.convAmbiguous = convAmb;
    d.steps = ["n = " + d.n, "somme = " + dtxt(d.sum)];
    return d;
  }
  function runCI(p){
    try{
      if(p.n < 1 || p.sigma.sign() <= 0) return F.failRes(STATUS.INVALID_INPUT, "BAD_CI", "σ > 0 et n ≥ 1 requis");
      var z = F.normalInv(rat(1).add(p.level).div(rat(2)).toNumber()), half = z * p.sigma.toNumber() / Math.sqrt(p.n), m = p.mean.toNumber();
      var lo = m - half, hi = m + half, ok = Math.abs(F.normalCdf(z) - (1 + p.level.toNumber()) / 2) < 1e-12;
      return { ok: true, kind: "ci", engine: "fast", exact: null, approx: { text: "[" + C.fmtFloat(lo, 4, p.lang) + " ; " + C.fmtFloat(hi, 4, p.lang) + "]", value: null }, z: z, halfWidth: half,
               verification: ok ? { status: STATUS.VERIFIED_NUMERICALLY, method: "Φ(z)=(1+niveau)/2", detail: "z critique recoupé par la fonction de répartition — vérification numérique" } : { status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "check-failed", detail: "" },
               steps: ["IC = x̄ ± z·σ/√n", "z = " + C.fmtFloat(z, 4, p.lang)], notes: ["intervalle z : σ supposé CONNU"] };
    }catch(e){ return F.fromError(e); }
  }
  function runFinance(p){
    var lang = p.lang, r;
    switch(p.fn){
      case "compound": r = F.compound(p.capital, p.rate, p.years, p.perYear, { lang: lang }); break;
      case "simple": r = F.simpleInterest(p.capital, p.rate, p.years, { lang: lang }); break;
      case "discount": r = F.discount(p.capital, p.rate, p.years, { lang: lang }); break;
      case "npv": r = F.npv(p.rate, p.flows, { lang: lang }); break;
      case "irr": r = F.irr(p.flows, { lang: lang }); break;
      case "payment": r = F.annuityPayment(p.principal, p.monthly ? p.annualRate.div(rat(12)) : p.annualRate, p.periods, { lang: lang }); break;
      case "equiv-rate": r = F.equivalentRate(p.rate, p.fromPer, p.toPer, { lang: lang }); break;
      case "prop-rate": r = F.proportionalRate(p.rate, p.toPer / p.fromPer === Math.floor(p.toPer / p.fromPer) ? p.toPer / p.fromPer : 1); break;
      case "cagr": r = F.cagr(p.v0, p.v1, p.years, { lang: lang }); break;
      case "percent-of": r = F.percentOf(p.pct, p.base); break;
      case "percent-change": r = F.percentChange(p.from, p.to); break;
      case "reverse-percent": {
        var init = p.final.div(p.factor), back = init.mul(p.factor);
        r = { ok: true, kind: "reverse-percent", engine: "fast", value: init, exact: { text: init.toString(), latex: C.toLatex(C.qnode(init)) }, approx: init.isInt() ? null : { text: C.fmtRatDecimal(init, 6, lang).text, value: init.toNumber() },
              steps: ["initial = final / (1 " + (p.up ? "+" : "−") + " " + p.pct.toString() + ")"], notes: [], rounded: F.roundHalfUp(init, 2),
              verification: back.eq(p.final) ? { status: STATUS.VERIFIED_EXACT, method: "application-directe", detail: "initial × (1 ± p) retrouve la valeur finale exactement" } : { status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "check-failed", detail: "" } };
        break;
      }
      default: return F.needsCAS("calcul financier inconnu");
    }
    if(r && r.ok){ r.money = !!p.money; r.fn = p.fn; }
    return r;
  }

  /* ── 4. REQUÊTE CAS ───────────────────────────────────────────────────────── */
  function casRequest(p){
    switch(p.kind){
      case "arith": return { op: "evaluate", expr: p.ast };
      case "factor": return { op: "factor", expr: p.ast };
      case "expand": return { op: "expand", expr: p.ast };
      case "simplify": return { op: "simplify", expr: p.ast };
      case "equation": return { op: "solve", eq: p.eq, var: p.var, domain: p.domain || null };
      case "system": return { op: "system", eqs: p.eqs };
      case "derivative": return { op: "diff", expr: p.ast, var: p.var, order: p.order || 1 };
      case "integral": return { op: "integrate", expr: p.ast, var: p.var, bounds: p.bounds };
      case "limit": return { op: "limit", expr: p.ast, var: p.var, point: p.point, side: p.side };
      case "matrix": return { op: "matrix", fn: p.op, A: p.A, B: p.B };
    }
    return null;
  }
  function parseCasText(s, lang){ try{ return C.parse(s, { decimalComma: false }).ast; }catch(e){ return null; } }

  /* Après réponse du CAS : on RE-CONTRÔLE avec le MathVerifier (indépendant de SymPy). */
  function verifyCas(p, cr){
    var vf;
    try{
      switch(p.kind){
        case "derivative": {
          var cur = p.ast, dAst = parseCasText(cr.exact, p.lang);
          if(!dAst) return V.unverified("résultat du CAS non relu");
          if((p.order || 1) === 1) return V.verifyDerivative(p.ast, dAst, p.var);
          return V.unverified("dérivée d'ordre > 1 : contrôle numérique non implémenté");
        }
        case "integral": {
          var res = parseCasText(p.bounds ? cr.exact : (cr.exactNoConst || cr.exact), p.lang);
          if(!res) return V.unverified("résultat du CAS non relu");
          if(!p.bounds){ return V.verifyAntiderivative(p.ast, res, p.var); }
          if(cr.numeric !== undefined && cr.numeric !== null){
            var a = C.evalFloat(p.bounds[0], {}), b = C.evalFloat(p.bounds[1], {});
            return V.verifyDefiniteIntegral(p.ast, p.var, a, b, cr.numeric);
          }
          return V.unverified("valeur numérique de l'intégrale non fournie");
        }
        case "limit": {
          var pt = p.point === "oo" || p.point === "-oo" ? p.point : C.evalFloat(p.point, {});
          var lim = cr.limit; // { kind:"finite"|"oo"|"-oo"|"none", value }
          if(!lim) return V.unverified("limite non fournie");
          if(lim.kind === "none"){
            if(!lim.sides) return V.unverified("limite inexistante : aucun contrôle numérique d'une non-existence");
            var vR = V.verifyLimit(p.ast, p.var, pt, "+", lim.sides["+"].kind === "finite" ? lim.sides["+"].value : lim.sides["+"].kind);
            var vL = V.verifyLimit(p.ast, p.var, pt, "-", lim.sides["-"].kind === "finite" ? lim.sides["-"].value : lim.sides["-"].kind);
            return vR.status === STATUS.VERIFIED_NUMERICALLY && vL.status === STATUS.VERIFIED_NUMERICALLY
              ? { status: STATUS.VERIFIED_NUMERICALLY, method: "limites-unilatérales", detail: "les deux limites unilatérales sont confirmées numériquement et sont différentes — vérification numérique, pas une preuve" }
              : V.unverified("limites unilatérales non confirmées numériquement");
          }
          return V.verifyLimit(p.ast, p.var, pt, p.side, lim.kind === "finite" ? lim.value : lim.kind);
        }
        case "equation": {
          var reals = (cr.solutions || []).filter(function(s){ return s.real && typeof s.value === "number"; }).map(function(s){ return s.value; });
          var cplx = (cr.solutions || []).filter(function(s){ return !s.real; });
          var vr = reals.length ? V.verifyEquationRoots(p.eq, p.var, reals) : null;
          if(cplx.length){
            var allSelf = cplx.every(function(s){ return s.selfcheck === true; });
            if(vr && vr.status === STATUS.VERIFIED_NUMERICALLY && allSelf) return { status: STATUS.VERIFIED_NUMERICALLY, method: "substitution (réelles : flottante ; complexes : symbolique par le CAS)", detail: "les solutions complexes sont réinjectées par le CAS lui-même (opération différente de la résolution, mais même moteur)" };
            if(!vr && allSelf) return { status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "substitution-par-le-CAS", detail: "solutions complexes réinjectées par le CAS lui-même : pas de contrôle indépendant" };
          }
          return vr || V.unverified("aucune solution à réinjecter");
        }
        case "system": {
          var sol = cr.solution; if(!sol) return V.unverified("solution non fournie");
          return V.verifySystem(p.eqs, sol);
        }
        case "factor": case "expand": case "simplify": {
          var out = parseCasText(cr.exact, p.lang); if(!out) return V.unverified("résultat du CAS non relu");
          var eq = V.equivalent(p.ast, out);
          if(eq.equal === true) return { status: eq.status, method: eq.method + " (original ≡ résultat)", detail: eq.status === STATUS.VERIFIED_EXACT ? "égalité exacte" : "égalité numérique en " + eq.points + " points — vérification numérique, pas une preuve" };
          if(eq.equal === false) return { status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "équivalence", detail: "le résultat du CAS n'est PAS équivalent à l'expression d'origine : NON confirmé" };
          return V.unverified("équivalence non décidable numériquement");
        }
        case "arith": {
          var ex = parseCasText(cr.exact, p.lang);
          if(ex){ var fa = C.evalFloat(p.ast, {}), fb = C.evalFloat(ex, {}); if(Math.abs(fa - fb) <= 1e-9 * Math.max(1, Math.abs(fa))) return { status: STATUS.VERIFIED_NUMERICALLY, method: "flottants vs forme exacte", detail: "la forme exacte du CAS et l'évaluation en flottants concordent — vérification numérique" }; return V.unverified("forme exacte et flottants discordent"); }
          return V.unverified("résultat du CAS non relu");
        }
        case "matrix": {
          if(p.op === "inverse" && cr.matrix && cr.matrixA){ return V.verifyMatrixInverse(cr.matrixA, cr.matrix); }
          if(p.op === "eigen" && cr.eigenvalues){
            var okE = cr.eigenvalues.every(function(l){ return l.selfcheck === true; });
            return okE ? { status: STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED, method: "det(A−λI)=0 par le CAS", detail: "contrôle effectué par le CAS lui-même : pas indépendant" } : V.unverified("valeurs propres non confirmées");
          }
          return V.unverified("contrôle non disponible pour cette opération matricielle");
        }
      }
    }catch(e){ return V.unverified("contrôle impossible : " + (e && e.message)); }
    return V.unverified("");
  }

  async function runCas(p, opts){
    var cas = opts.cas;
    if(!cas) return F.failRes(STATUS.UNSUPPORTED, "CAS_UNAVAILABLE", "le moteur avancé (calcul formel) n'est pas disponible dans cet environnement");
    var req = casRequest(p);
    if(!req) return F.failRes(STATUS.UNSUPPORTED, "NO_CAS_ROUTE", "ce type de problème n'a pas de route CAS");
    var t0 = Date.now(), cr;
    try{ cr = await cas.run(req, { timeoutMs: opts.timeoutMs }); }
    catch(e){ return F.failRes(STATUS.UNSUPPORTED, (e && e.code) || "CAS_FAILED", (e && e.message) || "le moteur avancé a échoué", { casLoadMs: e && e.loadMs, timedOut: e && e.code === "CAS_TIMEOUT" }); }
    if(!cr || cr.ok === false) return F.failRes(cr && cr.error && cr.error.status || STATUS.UNSUPPORTED, (cr && cr.error && cr.error.code) || "CAS_ERROR", (cr && cr.error && cr.error.message) || "le CAS n'a pas pu résoudre ce problème", { casMs: cr && cr.timeMs });
    var verification = verifyCas(p, cr);
    var res = { ok: true, kind: p.kind, engine: "cas", exact: { text: cr.exact, latex: cr.latex || "" }, approx: typeof cr.approxValue === "number" ? { text: C.fmtFloat(cr.approxValue, 10, p.lang), value: cr.approxValue } : (cr.approx ? { text: cr.approx, value: null } : null), verification: verification,
                steps: cr.steps || [], notes: cr.notes || [], casMs: cr.timeMs, casLoadMs: cr.loadMs, solutions: cr.solutions, setLatex: cr.setLatex, raw: cr, domainNote: cr.domainNote || null };
    return res;
  }

  /* ── 5. SOLVE (orchestrateur) ──────────────────────────────────────────── */
  var KIND_LABEL = { arith: "calcul", factor: "factorisation", expand: "développement", simplify: "simplification", equation: "équation", system: "système", derivative: "dérivée", integral: "intégrale", limit: "limite", matrix: "matrice",
                     stats: "statistiques", covariance: "corrélation/régression", zscore: "z-score", binomial: "loi binomiale", normal: "loi normale", bayes: "Bayes", ci: "intervalle de confiance", finance: "finance" };
  function problemText(p){
    switch(p.kind){
      case "arith": return C.toText(p.ast);
      case "factor": case "expand": case "simplify": return KIND_LABEL[p.kind] + " de " + C.toText(p.ast);
      case "equation": return C.toText(p.eq);
      case "system": return p.eqs.map(C.toText).join(" ; ");
      case "derivative": return "d" + (p.order > 1 ? "^" + p.order : "") + "/d" + p.var + (p.order > 1 ? "^" + p.order : "") + " [" + C.toText(p.ast) + "]";
      case "integral": return "∫" + (p.bounds ? "[" + C.toText(p.bounds[0]) + " ; " + C.toText(p.bounds[1]) + "]" : "") + " " + C.toText(p.ast) + " d" + p.var;
      case "limit": return "lim " + p.var + "→" + (typeof p.point === "string" ? (p.point === "oo" ? "+∞" : "-∞") : C.toText(p.point)) + (p.side ? p.side : "") + " " + C.toText(p.ast);
      case "matrix": return p.op + " " + C.toText(p.A) + (p.B ? " , " + C.toText(p.B) : "");
      default: return p.src;
    }
  }
  function problemLatex(p){
    try{
      switch(p.kind){
        case "arith": return C.toLatex(p.ast);
        case "factor": case "expand": case "simplify": return C.toLatex(p.ast);
        case "equation": return C.toLatex(p.eq);
        case "system": return "\\begin{cases}" + p.eqs.map(C.toLatex).join(" \\\\ ") + "\\end{cases}";
        case "derivative": return "\\frac{d" + (p.order > 1 ? "^{" + p.order + "}" : "") + "}{d" + p.var + (p.order > 1 ? "^{" + p.order + "}" : "") + "}\\left[" + C.toLatex(p.ast) + "\\right]";
        case "integral": return p.bounds ? "\\int_{" + C.toLatex(p.bounds[0]) + "}^{" + C.toLatex(p.bounds[1]) + "} " + C.toLatex(p.ast) + "\\,d" + p.var : "\\int " + C.toLatex(p.ast) + "\\,d" + p.var;
        case "limit": return "\\lim_{" + p.var + " \\to " + (typeof p.point === "string" ? (p.point === "oo" ? "+\\infty" : "-\\infty") : C.toLatex(p.point)) + (p.side ? "^{" + p.side + "}" : "") + "} " + C.toLatex(p.ast);
        case "matrix": return C.toLatex(p.A) + (p.B ? " , " + C.toLatex(p.B) : "");
      }
    }catch(e){}
    return "";
  }

  async function solve(input, opts){
    opts = opts || {};
    var t0 = Date.now(), p = typeof input === "string" ? analyze(input, opts) : input;
    var diag = { mathProblemType: p.kind, engineUsed: null, exactResult: null, approximateResult: null, verificationMethod: null, verificationStatus: null, calculationTimeMs: null, casLoadTimeMs: null, verificationTimeMs: null, errorCode: null, fastMs: null, casMs: null };
    if(p.kind === "none") return { handled: false, kind: "none", reason: p.reason, diag: diag };
    if(p.kind === "practice-request") return { handled: true, kind: "practice-request", problem: p, diag: diag };
    if(p.kind === "invalid"){
      diag.errorCode = p.code || "INVALID"; diag.verificationStatus = p.status;
      return finish(p, { ok: false, status: p.status || STATUS.INVALID_INPUT, code: p.code || "INVALID_INPUT", message: p.message, engine: "none" }, diag, t0, opts);
    }
    var tf = Date.now(), res = runFast(p); diag.fastMs = Date.now() - tf;
    if(res.ok === true && res.needsCAS && opts.cas){          // valeur irrationnelle : le Fast Engine n'a qu'un flottant, le CAS donne la forme exacte
      var fastApprox = res, rc = await runCas(p, opts);
      if(rc.ok){ res = rc; diag.engineUsed = "cas"; diag.casMs = rc.casMs; diag.casLoadTimeMs = rc.casLoadMs; if(!rc.approx && fastApprox.approx) rc.approx = fastApprox.approx; }
      else { res = fastApprox; diag.engineUsed = "fast"; diag.casFailed = rc.code; }
    } else if(res.ok === false && res.code === "NEEDS_CAS"){
      diag.engineUsed = "cas";
      res = await runCas(p, opts);
      if(res.casLoadMs !== undefined) diag.casLoadTimeMs = res.casLoadMs;
      if(res.casMs !== undefined) diag.casMs = res.casMs;
      if(res.ok === false && res.code !== "CAS_UNAVAILABLE") diag.casFailed = res.code;
    } else diag.engineUsed = "fast";
    return finish(p, res, diag, t0, opts);
  }

  function statusClass(st){
    return { VERIFIED_EXACT: "verified", VERIFIED_NUMERICALLY: "verified-numeric", COMPUTED_NOT_INDEPENDENTLY_VERIFIED: "unverified", UNSUPPORTED: "unsupported", INVALID_INPUT: "invalid", AMBIGUOUS: "ambiguous" }[st] || "unverified";
  }
  function bigExact(t){ return t && t.length > 48 && !/^-?\d{1,400}$/.test(t); }       // un entier (≤ 400 chiffres) est affiché EN ENTIER ; une fraction énorme est résumée
  function sciOf(intText){                                                                   // 1,267651×10^30 pour un entier à 16 chiffres et plus
    var neg = intText.charAt(0) === "-", d = neg ? intText.slice(1) : intText;
    if(d.length < 16) return null;
    return (neg ? "-" : "") + d.charAt(0) + "," + d.slice(1, 7) + " × 10^" + (d.length - 1);
  }

  function finish(p, res, diag, t0, opts){
    var lang = p.lang || "fr";
    diag.calculationTimeMs = Date.now() - t0;
    var out = { handled: true, kind: p.kind, problem: p, ok: !!res.ok, engine: res.engine || diag.engineUsed, diag: diag };
    out.problemText = problemText(p); out.problemLatex = problemLatex(p);
    if(!res.ok){
      out.status = res.status || STATUS.UNSUPPORTED; out.statusClass = statusClass(out.status); out.code = res.code; out.message = res.message;
      diag.errorCode = res.code; diag.verificationStatus = out.status;
      out.exact = null; out.approx = null; out.verification = { status: out.status, method: "none", detail: res.message || "" };
      // domaine réel : sqrt(-1), log(0)… message utile à l'élève
      if(res.code === "DOMAIN" && /racine|sqrt/i.test(res.message || "")) out.complexNote = "dans les réels cette racine n'est pas définie ; dans les nombres complexes, √(-1) = i";
      out.notes = (p.notes || []).slice();
      out.block = blockOf(out, lang); out.card = cardOf(out, lang);
      return out;
    }
    out.status = res.verification ? res.verification.status : STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED;
    out.statusClass = statusClass(out.status);
    out.verification = res.verification || { status: out.status, method: "none", detail: "" };
    out.exact = res.exact || null; out.approx = res.approx || null; out.steps = res.steps || [];
    if(!out.approx && res.exact && /^-?\d{16,400}$/.test(res.exact.text)){ var sc = sciOf(res.exact.text); if(sc) out.approx = { text: "≈ " + sc, value: null, sci: true }; }
    out.notes = (p.notes || []).concat(res.notes || []);
    out.raw = res; out.value = res.value; out.lines = res.lines; out.money = !!res.money || !!p.money; out.rounded = res.rounded || null; out.domainNote = res.domainNote || null;
    if(res.exact && bigExact(res.exact.text) && res.value instanceof Rat){ out.exactFull = res.exact; out.exact = { text: "(fraction exacte de " + (res.exact.text.length) + " caractères)", latex: "" }; out.exactIsHuge = true; }
    diag.exactResult = out.exactIsHuge ? "(huge exact, " + res.exact.text.length + " chars)" : (res.exact && res.exact.text) || null;
    diag.approximateResult = (res.approx && res.approx.text) || null;
    diag.verificationMethod = out.verification.method; diag.verificationStatus = out.status;
    out.block = blockOf(out, lang); out.card = cardOf(out, lang);
    return out;
  }

  /* Texte des devises : un résultat financier porte son unité (€) quand l'énoncé en avait une. */
  function moneyFmt(out, r, lang){ return out.money ? F.money(r, lang, "€") : C.fmtRatDecimal(r, 6, lang).text; }
  function resultLines(out, lang){
    var L = [];
    var r = out.raw || {};
    if(out.kind === "finance" && r.value instanceof Rat){
      var unit = out.money ? " €" : (r.kind && /rate|cagr|percent/.test(r.kind) ? " %" : "");
      if(r.kind === "percent-change" || r.kind === "cagr" || r.kind === "equivalent-rate" || r.kind === "proportional-rate" || r.kind === "effective-rate"){ var pctv = r.value.mul(rat(100)); L.push("exact result: " + C.fmtRatDecimal(pctv, 8, "en").text + " %" + (pctv.isInt() ? "" : " (= " + pctv.toString() + " %)")); }
      else {
        L.push("exact result: " + (out.exactIsHuge ? "(exact fraction omitted: too long)" : r.value.toString()) + (out.money ? " €" : ""));
        var d = C.fmtRatDecimal(r.value, 10, lang); L.push("decimal expansion" + (d.exact ? "" : " (rounded)") + ": " + d.text + unit);
        if(out.rounded) L.push("rounded to 2 decimals (presentation only): " + F.money(out.rounded, lang, out.money ? "€" : ""));
      }
      if(r.gain instanceof Rat) L.push("interest earned: " + C.fmtRatDecimal(r.gain, 8, lang).text + (out.money ? " €" : ""));
      if(r.total instanceof Rat) L.push("total paid over the whole duration: " + F.money(r.total, lang, out.money ? "€" : ""));
    } else if(out.kind === "stats" && out.lines){ out.lines.forEach(function(x){ L.push(x); }); L.push("n = " + r.n); }
    else if(out.kind === "binomial"){ L.push(r.label + " = " + (out.exact && out.exact.text) + (out.approx ? " ≈ " + out.approx.text : "")); L.push("mean np = " + r.mean.toString() + ", variance np(1−p) = " + r.variance.toString()); }
    else if(out.kind === "normal"){ L.push(r.label + " ≈ " + (out.approx && out.approx.text)); }
    else {
      if(out.exact && out.exact.text) L.push("exact result: " + out.exact.text);
      if(out.approx && out.approx.text) L.push("approximate result: " + out.approx.text);
    }
    return L;
  }

  var STATUS_PHRASE = {
    VERIFIED_EXACT: "VERIFIED (exact method)", VERIFIED_NUMERICALLY: "VERIFIED NUMERICALLY ONLY (numerical check, not a mathematical proof)",
    COMPUTED_NOT_INDEPENDENTLY_VERIFIED: "COMPUTED BUT NOT INDEPENDENTLY VERIFIED", UNSUPPORTED: "UNSUPPORTED", INVALID_INPUT: "INVALID INPUT", AMBIGUOUS: "AMBIGUOUS"
  };
  /* Le bloc injecté dans le prompt du LLM : il EXPLIQUE, il ne recalcule pas. */
  function blockOf(out, lang){
    var L = [], p = out.problem;
    if(!out.ok){
      L.push("MATH ENGINE: " + (out.status === STATUS.UNSUPPORTED ? "this problem could NOT be solved or verified by the deterministic engine." : out.status === STATUS.AMBIGUOUS ? "the problem is AMBIGUOUS as written." : "the input could not be used as written."));
      L.push("problem: " + out.problemText);
      L.push("reason: " + (out.message || out.code));
      if(out.complexNote) L.push("note: " + out.complexNote);
      L.push("rules: do NOT state any numerical or symbolic result for this problem as if it were computed or verified; do not guess it. You may explain the general method, point out what is missing or ambiguous, and ask the student to rephrase.");
      return { header: "MATH ENGINE REPORT (authoritative)", text: L.join("\n") };
    }
    L.push("problem: " + out.problemText + "  [" + (KIND_LABEL[out.kind] || out.kind) + "]");
    L.push("engine: " + (out.engine === "cas" ? "advanced CAS (SymPy), result re-checked by an independent verifier" : "fast exact engine (exact rational arithmetic)"));
    resultLines(out, lang).forEach(function(x){ L.push(x); });
    L.push("verification: " + (STATUS_PHRASE[out.status] || out.status) + " — " + (out.verification.method || "") + (out.verification.detail ? " (" + out.verification.detail + ")" : ""));
    if(out.domainNote) L.push("domain note: " + out.domainNote);
    (out.notes || []).forEach(function(n){ if(n && !/^(percent|log-base-10|implicit-mult-after-division|split-word|irrational|constant-of-integration|no-real-solution|complex-solutions|infinite-solutions|singular|non-integer-periods|irreducible-factor-over-Q|multiple-irr-possible|domain-excludes|multiple-root|real-solutions-only|approximate-roots|infinite-family|equation-without-equals)/.test(n)) L.push("note: " + n); });
    var nset = out.notes || [];
    if(nset.indexOf("log-base-10") >= 0) L.push("note: log(x) was read as the base-10 logarithm; ln(x) is the natural logarithm");
    if(nset.indexOf("constant-of-integration") >= 0) L.push("note: an antiderivative is defined up to an arbitrary constant C");
    if(nset.indexOf("no-real-solution") >= 0) L.push("note: there is no REAL solution; the solutions shown are complex");
    if(nset.some(function(n){ return n.indexOf("domain-excludes") === 0; })) L.push("note: " + nset.filter(function(n){ return n.indexOf("domain-excludes") === 0; })[0].replace("domain-excludes:", "the simplification is valid only for ") );
    if(nset.indexOf("implicit-mult-after-division") >= 0) L.push("note: an implicit product after a division (a/bc) was read as (a/b)·c — say so if the student meant a/(bc)");
    if(nset.indexOf("multiple-irr-possible") >= 0) L.push("note: the cash flows change sign several times; more than one IRR may exist");
    if(nset.indexOf("multiple-root") >= 0) L.push("note: a repeated root is listed once (it is a double/multiple root)");
    if(nset.indexOf("real-solutions-only") >= 0) L.push("note: only the REAL solutions are given; the equation also has complex solutions");
    if(nset.indexOf("approximate-roots") >= 0) L.push("note: some roots have no simple exact form and are given as decimal approximations (exact value unavailable)");
    if(nset.indexOf("infinite-family") >= 0) L.push("note: infinitely many solutions, written with an integer parameter n");
    if(nset.indexOf("equation-without-equals") >= 0) L.push("note: no '=' sign was written; the expression was assumed equal to 0");
    if(nset.indexOf("irreducible-factor-over-Q") >= 0) L.push("note: the remaining factor has no rational root (irreducible over the rationals)");
    L.push("rules: these results come from the deterministic math engine and are authoritative. Present them EXACTLY as given; never recompute, round differently or replace any number. Explain the method, the formula used and what the result means. " +
           (out.status === STATUS.VERIFIED_NUMERICALLY ? "The verification was numerical: say it was checked numerically, not proven. " : "") +
           (out.status === STATUS.COMPUTED_NOT_INDEPENDENTLY_VERIFIED ? "This result could not be verified independently: say so clearly and do not present it as certain. " : ""));
    return { header: out.status === STATUS.VERIFIED_EXACT ? "MATH ENGINE RESULT (computed deterministically, verified exactly — authoritative)" : out.status === STATUS.VERIFIED_NUMERICALLY ? "MATH ENGINE RESULT (computed deterministically, verified numerically — authoritative)" : "MATH ENGINE RESULT (computed deterministically, NOT independently verified)", text: L.join("\n") };
  }

  /* La carte affichée à l'élève (rendue en LaTeX côté page). Les libellés visibles passent par translations.js : ici, des CLÉS. */
  function cardOf(out, lang){
    var card = { kind: out.kind, problemText: out.problemText, problemLatex: out.problemLatex, engine: out.engine, statusClass: out.statusClass, status: out.status, ok: out.ok };
    if(out.ok){
      var exL = out.exact && (out.exact.latex || out.exact.text), exT = out.exact && out.exact.text;
      card.exactText = exT || null; card.exactLatex = exL || null; card.approxText = out.approx && out.approx.text || null;
      card.moneyText = null;
      var r = out.raw || {};
      if(out.kind === "finance" && r.value instanceof Rat){
        card.exactText = r.value.toString() + (out.money ? " €" : ""); card.exactLatex = C.toLatex(C.qnode(r.value)) + (out.money ? "\\ \\text{€}" : "");
        if(out.exactIsHuge){ card.exactText = null; card.exactLatex = null; }
        var dd = C.fmtRatDecimal(r.value, 10, lang); card.approxText = (r.kind === "percent-change" || r.kind === "cagr" || r.kind === "equivalent-rate" || r.kind === "proportional-rate" || r.kind === "effective-rate") ? C.fmtRatDecimal(r.value.mul(rat(100)), 8, lang).text + " %" : dd.text + (out.money ? " €" : "");
        if(out.rounded) card.moneyText = F.money(out.rounded, lang, out.money ? "€" : "");
        if(r.kind === "percent-change" || r.kind === "cagr") card.exactText = card.approxText;
      }
      if(out.kind === "stats" && out.lines){ card.lines = out.lines.slice(); card.exactText = null; card.exactLatex = null; }
      card.verification = { status: out.status, method: out.verification.method };
      card.steps = (out.steps || []).slice(0, 6); card.notes = (out.notes || []).filter(function(n){ return /^(domain-excludes|no-real-solution|complex-solutions|constant-of-integration|log-base-10|multiple-irr-possible|infinite-solutions|singular|irreducible)/.test(n) || !/^(percent|implicit|split-word|irrational|non-integer)/.test(n); });
      card.convAmbiguous = !!out.raw && !!out.raw.convAmbiguous;
    } else { card.message = out.message; card.code = out.code; card.complexNote = out.complexNote || null; }
    return card;
  }

  /* ── 6. PRATIQUE (M'ENTRAÎNER) ──────────────────────────────────────────────
     Exercices GÉNÉRÉS de façon déterministe (graine) ; la réponse de l'élève est vérifiée par comparaison
     MATHÉMATIQUE ; une erreur ne donne PAS la solution : indice → étape → solution, à la demande. */
  function rng(seed){ var a = (seed >>> 0) || 1; return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var PRACTICE_KINDS = ["linear", "quadratic", "derivative", "compound", "mean"];
  var PRACTICE_TEXT = {
    linear:    { fr: "Résous l'équation : ", en: "Solve the equation: ", es: "Resuelve la ecuación: ", de: "Löse die Gleichung: ", it: "Risolvi l'equazione: " },
    quadratic: { fr: "Factorise : ", en: "Factor: ", es: "Factoriza: ", de: "Faktorisiere: ", it: "Fattorizza: " },
    derivative:{ fr: "Calcule la dérivée de ", en: "Differentiate ", es: "Calcula la derivada de ", de: "Berechne die Ableitung von ", it: "Calcola la derivata di " },
    compound:  { fr: "Un capital est placé à intérêts composés (capitalisation annuelle). Calcule sa valeur finale (en €) : ", en: "A capital is invested at compound interest (annual compounding). Compute its final value (in €): ", es: "Un capital se invierte a interés compuesto (capitalización anual). Calcula su valor final (en €): ", de: "Ein Kapital wird mit Zinseszins (jährliche Verzinsung) angelegt. Berechne den Endwert (in €): ", it: "Un capitale è investito a interesse composto (capitalizzazione annua). Calcola il valore finale (in €): " },
    mean:      { fr: "Calcule la moyenne de la série : ", en: "Compute the mean of the data: ", es: "Calcula la media de la serie: ", de: "Berechne den Mittelwert der Daten: ", it: "Calcola la media della serie: " }
  };
  function practiceGenerate(kind, seed, lang){
    lang = lang || "fr"; var rnd = rng(seed === undefined ? 12345 : seed); var ri = function(a, b){ return a + Math.floor(rnd() * (b - a + 1)); };
    kind = kind || PRACTICE_KINDS[ri(0, PRACTICE_KINDS.length - 1)];
    var ex = { kind: kind, seed: seed, lang: lang, id: kind + ":" + seed, hints: [], steps: [] }, T = PRACTICE_TEXT[kind][lang] || PRACTICE_TEXT[kind].fr;
    if(kind === "linear"){
      var a = ri(2, 9), x = ri(-9, 9), b = ri(-12, 12), c = a * x + b;
      ex.problemText = T + a + "x " + (b < 0 ? "- " + (-b) : "+ " + b) + " = " + c; ex.expected = C.parse(String(x)).ast; ex.expectedText = "x = " + x; ex.requireForm = null;
      ex.hints = ["isole le terme en x : retire " + b + " des deux côtés", "divise ensuite par " + a]; ex.steps = [a + "x = " + (c - b), "x = " + (c - b) + "/" + a + " = " + x];
    } else if(kind === "quadratic"){
      var r1 = ri(-6, 6), r2 = ri(-6, 6); while(r2 === r1) r2 = ri(-6, 6);
      var bb = -(r1 + r2), cc = r1 * r2, poly = "x^2" + (bb === 0 ? "" : (bb < 0 ? " - " + (-bb) + "x" : " + " + bb + "x")) + (cc === 0 ? "" : (cc < 0 ? " - " + (-cc) : " + " + cc));
      var fx = function(r){ return "(x " + (r < 0 ? "+ " + (-r) : "- " + r) + ")"; };
      ex.problemText = T + poly; ex.expected = C.parse(poly).ast; ex.expectedText = fx(r1) + fx(r2); ex.requireForm = "factored";
      ex.hints = ["cherche deux nombres de somme " + (-bb) + " et de produit " + cc, "ces nombres sont les racines : " + r1 + " et " + r2];
      ex.steps = ["somme " + (-bb) + ", produit " + cc + " → " + r1 + " et " + r2, "x² + … = " + fx(r1) + fx(r2)];
    } else if(kind === "derivative"){
      var p3 = ri(1, 4), p2 = ri(1, 6), p1 = ri(-8, 8), p0 = ri(-9, 9);
      var fS = p3 + "x^3 " + (p2 < 0 ? "- " + (-p2) : "+ " + p2) + "x^2 " + (p1 < 0 ? "- " + (-p1) : "+ " + p1) + "x " + (p0 < 0 ? "- " + (-p0) : "+ " + p0);
      var dS = (3 * p3) + "x^2 + " + (2 * p2) + "x + " + p1;
      ex.problemText = T + "f(x) = " + fS; ex.expected = C.parse(dS).ast; ex.expectedText = "f'(x) = " + dS; ex.requireForm = null;
      ex.hints = ["règle : (xⁿ)′ = n·xⁿ⁻¹, et la dérivée d'une constante est 0", "dérive chaque terme séparément"]; ex.steps = ["(" + p3 + "x³)′ = " + (3 * p3) + "x²", "(" + p2 + "x²)′ = " + (2 * p2) + "x", "(" + p1 + "x)′ = " + p1, "constante → 0"];
    } else if(kind === "compound"){
      var cap = ri(2, 20) * 500, rate = ri(2, 8), yrs = ri(2, 5);
      var fv = rat(cap).mul(rat(100 + rate, 100).pow(yrs));
      ex.problemText = T + cap + " € à " + rate + " % pendant " + yrs + " ans"; ex.expected = C.qnode(fv); ex.expectedText = F.money(fv, lang, "€") + " (exact : " + fv.toString() + ")"; ex.expectedExact = fv; ex.requireForm = null; ex.roundTo = 2;
      ex.hints = ["VF = C × (1 + r)^n", "ici (1 + r) = " + C.fmtRatDecimal(rat(100 + rate, 100), 4, lang).text]; ex.steps = ["VF = " + cap + " × " + C.fmtRatDecimal(rat(100 + rate, 100), 4, lang).text + "^" + yrs, "VF = " + fv.toString()];
    } else if(kind === "mean"){
      var len = ri(4, 7), arr = []; for(var i = 0; i < len; i++) arr.push(ri(2, 20));
      var mean = rat(arr.reduce(function(s, z){ return s + z; }, 0), len);
      ex.problemText = T + arr.join(" ; "); ex.expected = C.qnode(mean); ex.expectedText = mean.toString(); ex.requireForm = null;
      ex.hints = ["additionne toutes les valeurs", "divise la somme par " + len]; ex.steps = ["somme = " + arr.reduce(function(s, z){ return s + z; }, 0), "moyenne = somme / " + len];
    } else return { ok: false, code: "UNKNOWN_KIND" };
    ex.ok = true; return ex;
  }
  function practiceCheck(ex, studentText, opts){
    opts = opts || {};
    var r = V.compareAnswer(studentText, ex.expected, { decimalComma: (ex.lang || "fr") !== "en", requireForm: ex.requireForm });
    // finance : un arrondi correct à 2 décimales est accepté, sans que le résultat exact soit exigé
    if(r.verdict === "incorrect" && ex.roundTo !== undefined && ex.expectedExact){
      try{ var sa = C.evalExact(C.parse(String(studentText).replace(/€/g, ""), { decimalComma: (ex.lang || "fr") !== "en" }).ast, {}); if(sa.eq(F.roundHalfUp(ex.expectedExact, ex.roundTo))) return { verdict: "correct", status: STATUS.VERIFIED_EXACT, method: "arrondi-exact", message: "correct (arrondi à " + ex.roundTo + " décimales)" }; }catch(e){}
    }
    return r;
  }
  function practiceNext(ex, level){          // level 1 = indice, 2 = étape suivante, 3 = solution
    if(level <= 1) return { type: "hint", text: ex.hints[0] || "relis l'énoncé" };
    if(level === 2) return { type: "hint", text: ex.hints[1] || ex.hints[0] || "" };
    if(level === 3) return { type: "steps", steps: ex.steps };
    return { type: "solution", text: ex.expectedText, steps: ex.steps };
  }

  NS.engine = {
    VERSION: VERSION, analyze: analyze, solve: solve, runFast: runFast, casRequest: casRequest, verifyCas: verifyCas, blockOf: blockOf, cardOf: cardOf,
    extractNumbers: extractNumbers, problemText: problemText, problemLatex: problemLatex, statusClass: statusClass, STATUS_PHRASE: STATUS_PHRASE,
    practice: { kinds: PRACTICE_KINDS, generate: practiceGenerate, check: practiceCheck, next: practiceNext }
  };
  /* API publique minimale, réutilisable par le futur REV-EM Excel Lab : fonctions numériques/statistiques EXACTES, sans l'analyseur. */
  NS.api = {
    parse: C.parse, evalExact: C.evalExact, evalFloat: C.evalFloat, toLatex: C.toLatex, toText: C.toText, Rat: C.Rat, rat: C.rat,
    mean: function(xs){ return F.descriptive(xs).mean; }, descriptive: F.descriptive, covariance: F.covariance, binomial: F.binomial, normalCdf: F.normalCdf, normalInv: F.normalInv,
    npv: F.npv, irr: F.irr, compound: F.compound, annuityPayment: F.annuityPayment, compareAnswer: V.compareAnswer, equivalent: V.equivalent
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
