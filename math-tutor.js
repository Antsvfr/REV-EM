/* ============================================================================
   math-tutor.js — TUTEUR MATHS & STATS (M'ENTRAÎNER) de REV-EM
   ----------------------------------------------------------------------------
   `globalThis.RevemMath.tutor` — pur : aucun DOM, aucun réseau, aucun WebLLM, aucun stockage. Dépend de
   math-core.js, math-fast.js, math-verify.js (donc du MÊME socle que le Math Engine ; pas de second moteur).

       RÔLES                      QUI FAIT QUOI
       ─────────────────────────  ──────────────────────────────────────────────────────────────────────────────
       générateur d'exercices     ce fichier, DÉTERMINISTE (graine) : 8 domaines × 3 niveaux, contexte « pure » ou
                                  « école de commerce »
       vérité de l'énoncé         le Fast Engine (math-fast.js) RECALCULE chaque réponse attendue de façon
                                  indépendante avant que l'exercice soit proposé (`verified`) ; sinon on le jette
       vérité de la réponse       MathVerifier (math-verify.js : `compareAnswer`) — équivalence MATHÉMATIQUE
                                  (1/2 = 0,5 = 2/4 ; (x+1)² = x²+2x+1), jamais comparaison de chaînes
       indices / méthode /        ce fichier — textes pédagogiques pré-écrits, 5 langues, ZÉRO appel IA
       solution
       explication orale          WebLLM, côté page seulement, et UNIQUEMENT pour expliquer un résultat que le
                                  moteur a déjà validé (voir AI_MATH.md). Ce fichier ne l'appelle pas.
       suivi                      `record` / `progress` : journal d'exercices → maîtrise par thème (pur ; le
                                  stockage et la synchronisation Supabase sont dans index.html / user-data.js)

   Un exercice est entièrement déterminé par { kind, level, context, seed, lang } : on ne persiste jamais l'objet,
   on peut toujours le régénérer à l'identique.
   ============================================================================ */
(function(global){
  "use strict";
  var NS = global.RevemMath = global.RevemMath || {};
  var C = NS.core, F = NS.fast, V = NS.verify;
  if(!C || !F || !V) throw new Error("math-tutor.js : charger math-core, math-fast et math-verify d'abord");
  var rat = C.rat, STATUS = C.STATUS;
  var VERSION = "1.0.0";

  var DOMAINS = ["algebra", "functions", "derivatives", "integrals", "probability", "statistics", "matrices", "finance"];
  var LEVELS = ["beginner", "intermediate", "advanced"];
  var CONTEXTS = ["pure", "business"];
  var LANGS = ["fr", "en", "es", "de", "it"];
  var LEVEL_WEIGHT = [1, 1.5, 2];

  /* ── 0. OUTILS ────────────────────────────────────────────────────────────── */
  function rng(seed){ var a = (seed >>> 0) || 1; return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function L(fr, en, es, de, it){ return { fr: fr, en: en, es: es, de: de, it: it }; }
  function pick(tbl, lang){ return tbl ? (tbl[lang] || tbl.fr) : ""; }
  function fill(tpl, p){ return String(tpl).replace(/\{(\w+)\}/g, function(m, k){ return p[k] === undefined ? m : p[k]; }); }
  var SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻" };
  function pretty(s){ return String(s).replace(/\^(-?\d+)/g, function(m, e){ return e.split("").map(function(ch){ return SUP[ch] || ch; }).join(""); }).replace(/\*/g, "·"); }
  function par(n){ return n < 0 ? "(" + n + ")" : String(n); }
  function sgnTerm(n, first){ return first ? String(n) : (n < 0 ? "- " + (-n) : "+ " + n); }

  /* Polynôme (coefficients par degré croissant, entiers) → « 3x^2 - 5x + 6 ». */
  function polyStr(c, v){
    var s = "", i;
    for(i = c.length - 1; i >= 0; i--){
      var a = c[i]; if(!a) continue;
      var abs = Math.abs(a), term = i === 0 ? String(abs) : (abs === 1 ? "" : String(abs)) + v + (i > 1 ? "^" + i : "");
      s += s ? (a < 0 ? " - " : " + ") + term : (a < 0 ? "-" : "") + term;
    }
    return s || "0";
  }
  /* Même polynôme, mais pour l'évaluer : substitue la valeur (k entier) : 2·(-3)^2 - 3·(-3) + 1 */
  function substStr(c, k){
    var s = "", i;
    for(i = c.length - 1; i >= 0; i--){
      var a = c[i]; if(!a) continue;
      var term = i === 0 ? String(Math.abs(a)) : (Math.abs(a) === 1 ? "" : Math.abs(a) + "·") + par(k) + (i > 1 ? "^" + i : "");
      s += s ? (a < 0 ? " - " : " + ") + term : (a < 0 ? "-" : "") + term;
    }
    return s || "0";
  }
  function evalPoly(c, k){ var s = BigInt(0), i, K = BigInt(k); for(i = c.length - 1; i >= 0; i--) s = s * K + BigInt(c[i]); return rat(s); }
  function polyDeriv(c){ var d = [], i; for(i = 1; i < c.length; i++) d.push(c[i] * i); return d.length ? d : [0]; }
  function parse(s){ return C.parse(s, { decimalComma: false }).ast; }
  /* Une formule affichable : texte joli + LaTeX (KaTeX). Un `prefix` (« f(x) = ») reste hors de l'AST. */
  function fm(src, prefix){
    var ast = parse(src);
    return { text: (prefix || "") + pretty(C.toText(ast)), latex: (prefix ? prefix.replace(/′/g, "'") : "") + C.toLatex(ast) };
  }
  function ratOfText(t){ return C.evalExact(parse(String(t).replace(/−/g, "-")), {}); }
  function sameSet(a, b){
    var ua = [], ub = [];
    a.forEach(function(x){ if(!ua.some(function(y){ return y.eq(x); })) ua.push(x); });
    b.forEach(function(x){ if(!ub.some(function(y){ return y.eq(x); })) ub.push(x); });
    return ua.length === ub.length && ua.every(function(x){ return ub.some(function(y){ return y.eq(x); }); });
  }
  function sortRats(a){ return a.slice().sort(function(x, y){ return x.cmp(y); }); }
  /* Racines rationnelles d'une équation, trouvées par le Fast Engine (ou null s'il y en a d'autres sortes). */
  function engineRoots(eqSrc){
    var r = F.solveEquation(parse(eqSrc), "x");
    if(!r || !r.ok || r.solutionKind !== "points") return null;
    var out = [];
    for(var i = 0; i < r.solutions.length; i++){ var s = r.solutions[i]; if(s.kind !== "rational" || !s.real) return null; out.push(ratOfText(s.text)); }
    return out;
  }
  function descOf(data){ return F.descriptive(data.map(function(x){ return rat(x); })); }

  /* Contexte de génération : graine, niveau, contexte, langue, formateurs. */
  function makeG(seed, lvl, ctx, lang){
    var rnd = rng(seed), g = { lvl: lvl, ctx: ctx, lang: lang, biz: ctx === "business", rnd: rnd };
    g.ri = function(a, b){ return a + Math.floor(rnd() * (b - a + 1)); };
    g.nz = function(a, b){ var v, guard = 0; do{ v = g.ri(a, b); }while(v === 0 && guard++ < 50); return v || 1; };
    g.pick = function(arr){ return arr[g.ri(0, arr.length - 1)]; };
    g.shuffle = function(arr){ var a = arr.slice(), i, j, t; for(i = a.length - 1; i > 0; i--){ j = g.ri(0, i); t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
    g.N = function(r){ if(typeof r === "number") r = rat(r); return C.fmtRatDecimal(r, 10, lang, { group: false }).text; };   // pour l'énoncé, dans la langue de l'élève
    g.A = function(r){ if(typeof r === "number") r = rat(r); return C.fmtRatDecimal(r, 10, "en", { group: false }).text; };      // ASCII (point décimal), pour le moteur
    g.list = function(xs){ return xs.map(function(x){ return g.N(x); }).join(" ; "); };
    return g;
  }

  /* ── 1. LE CATALOGUE ─────────────────────────────────────────────────────────
     Chaque type d'exercice : domain, levels (0 débutant, 1 intermédiaire, 2 avancé), biz (niveaux où la version « école de
     commerce » existe), gen(g) → les données, TEXTES (cadre, cadre commerce, indice concept, indice méthode) en 5 langues.
     gen renvoie : params, formulas, expected{type,...}, expectedText, steps, example, unit, variant, verify().  */
  var K = {};
  function def(kind, o){ o.kind = kind; K[kind] = o; return o; }
  function ints(a){ return a.map(function(x){ return rat(x); }); }

  /* ═══ ALGÈBRE ═══ */
  def("linear", {
    domain: "algebra", levels: [0, 1], biz: [],
    frame: L("Résous l'équation :", "Solve the equation:", "Resuelve la ecuación:", "Löse die Gleichung:", "Risolvi l'equazione:"),
    concept: L("Une équation du premier degré est une balance : ce que tu fais d'un côté, tu le fais de l'autre.", "A first-degree equation is a balance: whatever you do to one side, you do to the other.", "Una ecuación de primer grado es una balanza: lo que haces a un lado, lo haces al otro.", "Eine lineare Gleichung ist eine Waage: Was du auf einer Seite tust, tust du auch auf der anderen.", "Un'equazione di primo grado è una bilancia: ciò che fai da una parte lo fai dall'altra."),
    method: L("Regroupe les termes en x d'un côté et les nombres de l'autre, puis divise par le coefficient de x.", "Collect the x terms on one side and the numbers on the other, then divide by the coefficient of x.", "Agrupa los términos en x a un lado y los números al otro; luego divide por el coeficiente de x.", "Bringe die x-Terme auf eine Seite und die Zahlen auf die andere, dann teile durch den Koeffizienten von x.", "Raggruppa i termini in x da una parte e i numeri dall'altra, poi dividi per il coefficiente di x."),
    gen: function(g){
      var a, b, c, d, x, eq, steps;
      if(g.lvl === 0){ a = g.ri(2, 9); x = g.nz(-9, 9); b = g.ri(-12, 12); c = a * x + b; eq = polyStr([b, a], "x") + " = " + c; steps = [a + "x = " + c + " - " + par(b) + " = " + (c - b), "x = " + (c - b) + "/" + a + " = " + x]; }
      else { a = g.ri(3, 9); c = g.ri(1, a - 1); x = g.nz(-9, 9); b = g.ri(-12, 12); d = (a - c) * x + b; eq = polyStr([b, a], "x") + " = " + polyStr([d, c], "x"); steps = ["(" + a + " - " + c + ")x = " + d + " - " + par(b) + " → " + (a - c) + "x = " + (d - b), "x = " + (d - b) + "/" + (a - c) + " = " + x]; }
      return { params: {}, formulas: [fm(eq)], expected: { type: "number", value: rat(x) }, expectedText: "x = " + x, steps: steps, example: String(x),
               verify: function(){ var r = engineRoots(eq); return !!r && r.length === 1 && r[0].eq(rat(x)); } };
    }
  });

  function quadData(g, lo, hi, distinct){
    var r1 = g.ri(lo, hi), r2 = g.ri(lo, hi), guard = 0;
    while(distinct && r2 === r1 && guard++ < 50) r2 = g.ri(lo, hi);
    if(r1 > r2){ var t = r1; r1 = r2; r2 = t; }
    return { r1: r1, r2: r2, b: -(r1 + r2), c: r1 * r2 };
  }
  var facOf = function(r){ return r === 0 ? "x" : (r < 0 ? "(x + " + (-r) + ")" : "(x - " + r + ")"); };

  def("quad-factor", {
    domain: "algebra", levels: [1, 2], biz: [],
    frame: L("Factorise le trinôme :", "Factor the quadratic:", "Factoriza el trinomio:", "Faktorisiere das Polynom:", "Fattorizza il trinomio:"),
    concept: L("Un trinôme x² + bx + c se factorise en (x − r₁)(x − r₂) où r₁ et r₂ sont ses racines.", "A quadratic x² + bx + c factors as (x − r₁)(x − r₂), where r₁ and r₂ are its roots.", "Un trinomio x² + bx + c se factoriza como (x − r₁)(x − r₂), donde r₁ y r₂ son sus raíces.", "Ein Polynom x² + bx + c zerfällt in (x − r₁)(x − r₂), wobei r₁ und r₂ die Nullstellen sind.", "Un trinomio x² + bx + c si fattorizza in (x − r₁)(x − r₂), dove r₁ e r₂ sono le sue radici."),
    method: L("Cherche deux nombres dont la somme vaut −b et le produit vaut c : ce sont les racines.", "Find two numbers whose sum is −b and whose product is c: they are the roots.", "Busca dos números cuya suma sea −b y cuyo producto sea c: son las raíces.", "Suche zwei Zahlen mit Summe −b und Produkt c: Das sind die Nullstellen.", "Cerca due numeri la cui somma è −b e il cui prodotto è c: sono le radici."),
    gen: function(g){
      var q = quadData(g, g.lvl === 1 ? -6 : -12, g.lvl === 1 ? 6 : 12, true), poly = polyStr([q.c, q.b, 1], "x"), ex = facOf(q.r1) + facOf(q.r2);
      return { params: {}, formulas: [fm(poly)], expected: { type: "expression", ast: parse(poly), form: "factored" }, expectedText: pretty(C.toText(parse(ex))).replace(/·/g, ""), steps: ["S = r₁ + r₂ = " + (-q.b) + " ; P = r₁·r₂ = " + q.c, "r₁ = " + q.r1 + " ; r₂ = " + q.r2, polyStr([q.c, q.b, 1], "x").replace(/\^2/g, "²") + " = " + ex], example: ex,
               verify: function(){ var r = engineRoots(poly + " = 0"); return !!r && sameSet(r, ints([q.r1, q.r2])) && V.equivalent(parse(ex), parse(poly), {}).equal === true; } };
    }
  });

  def("quad-solve", {
    domain: "algebra", levels: [1], biz: [],
    frame: L("Résous l'équation :", "Solve the equation:", "Resuelve la ecuación:", "Löse die Gleichung:", "Risolvi l'equazione:"),
    concept: L("Une équation du second degré peut avoir deux solutions : il ne faut pas s'arrêter à la première.", "A quadratic equation can have two solutions: don't stop at the first one.", "Una ecuación de segundo grado puede tener dos soluciones: no te detengas en la primera.", "Eine quadratische Gleichung kann zwei Lösungen haben: Höre nicht bei der ersten auf.", "Un'equazione di secondo grado può avere due soluzioni: non fermarti alla prima."),
    method: L("Factorise (somme −b, produit c) ou utilise le discriminant Δ = b² − 4ac ; un produit est nul si l'un de ses facteurs est nul.", "Factor (sum −b, product c) or use the discriminant Δ = b² − 4ac; a product is zero when one of its factors is zero.", "Factoriza (suma −b, producto c) o usa el discriminante Δ = b² − 4ac; un producto es nulo si uno de sus factores es nulo.", "Faktorisiere (Summe −b, Produkt c) oder nutze die Diskriminante Δ = b² − 4ac; ein Produkt ist null, wenn ein Faktor null ist.", "Fattorizza (somma −b, prodotto c) o usa il discriminante Δ = b² − 4ac; un prodotto è nullo se uno dei fattori è nullo."),
    gen: function(g){
      var q = quadData(g, -6, 6, true), poly = polyStr([q.c, q.b, 1], "x"), disc = q.b * q.b - 4 * q.c;
      return { params: {}, formulas: [fm(poly + " = 0")], expected: { type: "set", values: ints([q.r1, q.r2]) }, expectedText: "x = " + q.r1 + " ; x = " + q.r2, steps: ["Δ = " + par(q.b) + "² - 4·" + q.c + " = " + disc, "x = (" + (-q.b) + " ± √" + disc + ") / 2", "x₁ = " + q.r1 + " ; x₂ = " + q.r2], example: q.r1 + " ; " + q.r2,
               verify: function(){ var r = engineRoots(poly + " = 0"); return !!r && sameSet(r, ints([q.r1, q.r2])); } };
    }
  });

  def("quad-solve-lead", {
    domain: "algebra", levels: [2], biz: [],
    frame: L("Résous l'équation :", "Solve the equation:", "Resuelve la ecuación:", "Löse die Gleichung:", "Risolvi l'equazione:"),
    concept: L("Quand le coefficient de x² n'est pas 1, les solutions peuvent être des fractions : le discriminant les donne toutes.", "When the coefficient of x² isn't 1, the solutions can be fractions: the discriminant finds them all.", "Cuando el coeficiente de x² no es 1, las soluciones pueden ser fracciones: el discriminante las da todas.", "Wenn der Koeffizient von x² nicht 1 ist, können die Lösungen Brüche sein: Die Diskriminante liefert sie alle.", "Quando il coefficiente di x² non è 1, le soluzioni possono essere frazioni: il discriminante le trova tutte."),
    method: L("Calcule Δ = b² − 4ac, puis x = (−b ± √Δ) / (2a).", "Compute Δ = b² − 4ac, then x = (−b ± √Δ) / (2a).", "Calcula Δ = b² − 4ac y luego x = (−b ± √Δ) / (2a).", "Berechne Δ = b² − 4ac, dann x = (−b ± √Δ) / (2a).", "Calcola Δ = b² − 4ac, poi x = (−b ± √Δ) / (2a)."),
    gen: function(g){
      var m1, m2, n1, n2, a, b, c, guard = 0, ra, rb;
      do{ m1 = g.ri(1, 3); m2 = g.ri(1, 3); n1 = g.nz(-6, 6); n2 = g.nz(-6, 6); ra = rat(n1, m1); rb = rat(n2, m2); a = m1 * m2; b = -(m1 * n2 + m2 * n1); c = n1 * n2; }while((ra.eq(rb) || (m1 === 1 && m2 === 1) || (a === 1)) && guard++ < 80);
      var roots = sortRats([ra, rb]), poly = polyStr([c, b, a], "x"), disc = b * b - 4 * a * c;
      return { params: {}, formulas: [fm(poly + " = 0")], expected: { type: "set", values: roots }, expectedText: "x = " + roots[0] + " ; x = " + roots[1], steps: ["Δ = " + par(b) + "² - 4·" + par(a) + "·" + par(c) + " = " + disc, "x = (" + (-b) + " ± √" + disc + ") / " + (2 * a), "x₁ = " + roots[0] + " ; x₂ = " + roots[1]], example: roots[0] + " ; " + roots[1],
               verify: function(){ var r = engineRoots(poly + " = 0"); return !!r && sameSet(r, roots); } };
    }
  });

  function lin2(a, b){ var s = (a === 1 ? "" : a === -1 ? "-" : a) + "x"; return s + (b === 0 ? "" : (b < 0 ? " - " : " + ") + (Math.abs(b) === 1 ? "" : Math.abs(b)) + "y"); }
  def("system", {
    domain: "algebra", levels: [1, 2], biz: [1],
    frame: L("Résous le système :", "Solve the system:", "Resuelve el sistema:", "Löse das Gleichungssystem:", "Risolvi il sistema:"),
    bizFrame: L("Un magasin vend deux types d'articles : le type A à {p} € l'unité et le type B à {q} € l'unité. Il a vendu {n} articles pour un chiffre d'affaires de {R} €. Détermine le nombre x d'articles de type A et le nombre y d'articles de type B.", "A shop sells two kinds of items: type A at €{p} each and type B at €{q} each. It sold {n} items for total sales of €{R}. Find the number x of type A items and the number y of type B items.", "Una tienda vende dos tipos de artículos: el tipo A a {p} € la unidad y el tipo B a {q} € la unidad. Ha vendido {n} artículos con una facturación de {R} €. Determina el número x de artículos de tipo A y el número y de tipo B.", "Ein Geschäft verkauft zwei Artikelsorten: Typ A für {p} € pro Stück und Typ B für {q} € pro Stück. Es wurden {n} Artikel für einen Umsatz von {R} € verkauft. Bestimme die Anzahl x der Artikel Typ A und die Anzahl y der Artikel Typ B.", "Un negozio vende due tipi di articoli: il tipo A a {p} € l'uno e il tipo B a {q} € l'uno. Ha venduto {n} articoli per un fatturato di {R} €. Determina il numero x di articoli di tipo A e il numero y di tipo B."),
    concept: L("Deux inconnues demandent deux équations : on élimine une inconnue pour revenir à une équation simple.", "Two unknowns need two equations: eliminate one unknown to get back to a simple equation.", "Dos incógnitas requieren dos ecuaciones: se elimina una incógnita para volver a una ecuación sencilla.", "Zwei Unbekannte brauchen zwei Gleichungen: Eliminiere eine Unbekannte, um eine einfache Gleichung zu erhalten.", "Due incognite richiedono due equazioni: si elimina un'incognita per tornare a un'equazione semplice."),
    method: L("Par substitution ou par combinaison : multiplie les équations pour que les coefficients de y soient opposés, additionne, puis remplace.", "By substitution or combination: scale the equations so the y coefficients are opposite, add them, then substitute back.", "Por sustitución o combinación: multiplica las ecuaciones para que los coeficientes de y sean opuestos, suma y luego sustituye.", "Per Einsetzen oder Addition: Multipliziere die Gleichungen so, dass die y-Koeffizienten entgegengesetzt sind, addiere sie und setze dann ein.", "Per sostituzione o combinazione: moltiplica le equazioni in modo che i coefficienti di y siano opposti, somma e poi sostituisci."),
    gen: function(g){
      var x0, y0, a1, b1, a2, b2, c1, c2, D, guard = 0, params = {}, eqs, steps;
      if(g.biz){
        var p, q;
        do{ x0 = g.ri(5, 40); y0 = g.ri(5, 40); p = g.ri(2, 12); q = g.ri(2, 12); }while(p === q && guard++ < 50);
        if(p === q) q = p + 1;
        var n = x0 + y0, R = p * x0 + q * y0;
        params = { p: String(p), q: String(q), n: String(n), R: String(R) };
        eqs = ["x + y = " + n, p + "x + " + q + "y = " + R];
        steps = ["x + y = " + n + " ; " + p + "x + " + q + "y = " + R, "x = " + n + " - y → " + p + "(" + n + " - y) + " + q + "y = " + R + " → " + (q - p) + "y = " + (R - p * n), "y = " + y0 + " ; x = " + n + " - " + y0 + " = " + x0];
        return { params: params, formulas: [], expected: { type: "assignments", vars: ["x", "y"], values: ints([x0, y0]) }, expectedText: "x = " + x0 + " ; y = " + y0, steps: steps, example: "x = " + x0 + " ; y = " + y0,
                 verify: function(){ var r = F.solveSystem(eqs.map(parse), ["x", "y"]); return !!(r && r.ok && r.solutionKind === "unique" && ratOfText(r.solution.x).eq(rat(x0)) && ratOfText(r.solution.y).eq(rat(y0))); } };
      }
      var lim = g.lvl === 1 ? 4 : 7;
      do{ x0 = g.nz(-5, 8); y0 = g.nz(-5, 8); a1 = g.nz(-lim, lim); b1 = g.nz(-lim, lim); a2 = g.nz(-lim, lim); b2 = g.nz(-lim, lim); D = a1 * b2 - a2 * b1; }while((D === 0 || (g.lvl === 1 && (a1 < 0 || b1 < 0 || a2 < 0 || b2 < 0))) && guard++ < 200);
      if(D === 0){ a1 = 2; b1 = 1; a2 = 1; b2 = -1; D = -3; }
      c1 = a1 * x0 + b1 * y0; c2 = a2 * x0 + b2 * y0;
      eqs = [lin2(a1, b1) + " = " + c1, lin2(a2, b2) + " = " + c2];
      steps = ["D = " + par(a1) + "·" + par(b2) + " - " + par(a2) + "·" + par(b1) + " = " + D, "x = (" + par(c1) + "·" + par(b2) + " - " + par(c2) + "·" + par(b1) + ") / " + par(D) + " = " + x0, "y = (" + par(a1) + "·" + par(c2) + " - " + par(a2) + "·" + par(c1) + ") / " + par(D) + " = " + y0];
      return { params: params, formulas: [fm(eqs[0]), fm(eqs[1])], expected: { type: "assignments", vars: ["x", "y"], values: ints([x0, y0]) }, expectedText: "x = " + x0 + " ; y = " + y0, steps: steps, example: "x = " + x0 + " ; y = " + y0,
               verify: function(){ var r = F.solveSystem(eqs.map(parse), ["x", "y"]); return !!(r && r.ok && r.solutionKind === "unique" && ratOfText(r.solution.x).eq(rat(x0)) && ratOfText(r.solution.y).eq(rat(y0))); } };
    }
  });

  /* ═══ FONCTIONS ═══ */
  def("func-eval", {
    domain: "functions", levels: [0, 1, 2], biz: [0, 1],
    frame: L("Soit f la fonction définie ci-dessous. Calcule f({k}).", "Let f be the function below. Compute f({k}).", "Sea f la función de abajo. Calcula f({k}).", "Sei f die unten definierte Funktion. Berechne f({k}).", "Sia f la funzione qui sotto. Calcola f({k})."),
    bizFrame: L("Le coût total de production de q unités est C(q) (en €), donné ci-dessous. Quel est le coût de production de {k} unités ?", "The total cost of producing q units is C(q) (in €), given below. What does it cost to produce {k} units?", "El coste total de producir q unidades es C(q) (en €), dado abajo. ¿Cuánto cuesta producir {k} unidades?", "Die Gesamtkosten für die Produktion von q Einheiten sind C(q) (in €), unten angegeben. Was kostet die Produktion von {k} Einheiten?", "Il costo totale di produzione di q unità è C(q) (in €), indicato qui sotto. Quanto costa produrre {k} unità?"),
    concept: L("Calculer f(k), c'est remplacer x par k partout dans l'expression, puis calculer.", "Computing f(k) means replacing x by k everywhere in the expression, then calculating.", "Calcular f(k) es sustituir x por k en toda la expresión y calcular.", "f(k) berechnen heißt, x überall im Term durch k zu ersetzen und dann zu rechnen.", "Calcolare f(k) significa sostituire x con k ovunque nell'espressione e poi calcolare."),
    method: L("Remplace la variable par la valeur (entre parenthèses si elle est négative), puis respecte les priorités : puissances, produits, sommes.", "Substitute the value for the variable (in brackets if negative), then follow the order of operations: powers, products, sums.", "Sustituye la variable por el valor (entre paréntesis si es negativo) y respeta las prioridades: potencias, productos, sumas.", "Setze den Wert für die Variable ein (in Klammern, wenn negativ) und beachte die Rechenreihenfolge: Potenzen, Produkte, Summen.", "Sostituisci la variabile con il valore (tra parentesi se negativo) e rispetta le priorità: potenze, prodotti, somme."),
    gen: function(g){
      var c, k, v = g.biz ? "q" : "x", fn = g.biz ? "C" : "f";
      if(g.biz){
        if(g.lvl === 0){ c = [g.ri(4, 18) * 50, g.ri(2, 20)]; k = g.ri(2, 10) * 10; }
        else { c = [g.ri(4, 12) * 50, g.ri(2, 12), g.ri(1, 3)]; k = g.ri(2, 8) * 5; }
      } else if(g.lvl === 0){ c = [g.ri(-9, 9), g.nz(-9, 9)]; k = g.ri(1, 10); if(c[1] === 0) c[1] = 2; }
      else if(g.lvl === 1){ c = [g.ri(-9, 9), g.ri(-9, 9), g.nz(-4, 4)]; k = g.nz(-5, 5); }
      else { c = [g.ri(-9, 9), g.ri(-6, 6), g.ri(-5, 5), g.nz(1, 3)]; k = g.nz(-3, 4); }
      var src = polyStr(c, v), val = evalPoly(c, k), vs = g.N(val);
      return { params: { k: String(k) }, formulas: [fm(src, fn + "(" + v + ") = ")], expected: { type: "number", value: val }, unit: g.biz ? "€" : "", expectedText: vs + (g.biz ? " €" : ""),
               steps: [fn + "(" + k + ") = " + substStr(c, k), fn + "(" + k + ") = " + vs], example: vs,
               verify: function(){ return C.evalExact(parse(src), { x: rat(k), q: rat(k) }).eq(val); } };
    }
  });

  def("func-slope", {
    domain: "functions", levels: [0, 1], biz: [0, 1],
    frame: L("Une droite passe par les points A({x1} ; {y1}) et B({x2} ; {y2}). Quel est son coefficient directeur (sa pente) ?", "A line passes through the points A({x1} ; {y1}) and B({x2} ; {y2}). What is its slope?", "Una recta pasa por los puntos A({x1} ; {y1}) y B({x2} ; {y2}). ¿Cuál es su pendiente?", "Eine Gerade verläuft durch die Punkte A({x1} ; {y1}) und B({x2} ; {y2}). Wie groß ist ihre Steigung?", "Una retta passa per i punti A({x1} ; {y1}) e B({x2} ; {y2}). Qual è il suo coefficiente angolare (pendenza)?"),
    bizFrame: L("Produire {x1} unités coûte {y1} € et en produire {x2} coûte {y2} € (le coût varie de façon affine avec la quantité). Combien coûte chaque unité supplémentaire (coût marginal) ?", "Producing {x1} units costs €{y1} and producing {x2} costs €{y2} (cost is a straight-line function of quantity). How much does each extra unit cost (marginal cost)?", "Producir {x1} unidades cuesta {y1} € y producir {x2} cuesta {y2} € (el coste varía de forma afín con la cantidad). ¿Cuánto cuesta cada unidad adicional (coste marginal)?", "{x1} Einheiten zu produzieren kostet {y1} €, {x2} Einheiten kosten {y2} € (die Kosten hängen linear von der Menge ab). Was kostet jede zusätzliche Einheit (Grenzkosten)?", "Produrre {x1} unità costa {y1} € e produrne {x2} costa {y2} € (il costo varia in modo lineare con la quantità). Quanto costa ogni unità in più (costo marginale)?"),
    concept: L("La pente mesure de combien y varie quand x augmente de 1.", "The slope tells how much y changes when x increases by 1.", "La pendiente mide cuánto varía y cuando x aumenta en 1.", "Die Steigung gibt an, um wie viel sich y ändert, wenn x um 1 wächst.", "La pendenza misura di quanto varia y quando x aumenta di 1."),
    method: L("Pente = (y₂ − y₁) / (x₂ − x₁) : écart des ordonnées divisé par l'écart des abscisses.", "Slope = (y₂ − y₁) / (x₂ − x₁): the change in y divided by the change in x.", "Pendiente = (y₂ − y₁) / (x₂ − x₁): la diferencia de ordenadas dividida por la de abscisas.", "Steigung = (y₂ − y₁) / (x₂ − x₁): Änderung von y geteilt durch Änderung von x.", "Pendenza = (y₂ − y₁) / (x₂ − x₁): la differenza delle ordinate divisa per quella delle ascisse."),
    gen: function(g){
      var x1 = g.biz ? g.ri(2, 8) * 10 : g.ri(-3, 4), dx = g.biz ? g.ri(1, 5) * 10 : g.ri(1, 5), x2 = x1 + dx, m, y1, y2;
      if(g.lvl === 0 || g.biz && g.lvl === 0){ m = g.biz ? g.ri(2, 15) : g.nz(-5, 6); y1 = g.biz ? g.ri(5, 30) * 50 : g.ri(-6, 8); y2 = y1 + m * dx; }
      else { y1 = g.biz ? g.ri(5, 30) * 50 : g.ri(-6, 8); y2 = y1 + (g.biz ? g.ri(1, 6) * dx / 2 + g.ri(0, 1) * 5 : g.ri(-9, 12)); }
      var val = rat(y2 - y1, x2 - x1), vs = g.N(val);
      return { params: { x1: String(x1), y1: String(y1), x2: String(x2), y2: String(y2) }, formulas: [], expected: { type: "number", value: val }, unit: g.biz ? "€" : "", expectedText: vs + (g.biz ? " €" : ""),
               steps: ["m = (y₂ - y₁) / (x₂ - x₁)", "m = (" + par(y2) + " - " + par(y1) + ") / (" + par(x2) + " - " + par(x1) + ") = " + (y2 - y1) + "/" + (x2 - x1) + " = " + vs], example: vs,
               verify: function(){ return C.evalExact(parse("(" + y2 + "-(" + y1 + "))/(" + x2 + "-(" + x1 + "))"), {}).eq(val); } };
    }
  });

  def("func-vertex", {
    domain: "functions", levels: [1, 2], biz: [1, 2],
    frame: [L("Pour quelle valeur de x la fonction ci-dessous atteint-elle son maximum ?", "For which value of x does the function below reach its maximum?", "¿Para qué valor de x alcanza su máximo la función de abajo?", "Für welchen Wert von x erreicht die folgende Funktion ihr Maximum?", "Per quale valore di x la funzione qui sotto raggiunge il massimo?"),
            L("Quelle est la valeur maximale de la fonction ci-dessous ?", "What is the maximum value of the function below?", "¿Cuál es el valor máximo de la función de abajo?", "Wie groß ist der Maximalwert der folgenden Funktion?", "Qual è il valore massimo della funzione qui sotto?")],
    bizFrame: [L("Le profit d'une entreprise (en €) est donné ci-dessous, q étant la quantité produite et vendue. Quelle quantité q maximise le profit ?", "A firm's profit (in €) is given below, q being the quantity produced and sold. Which quantity q maximises profit?", "El beneficio de una empresa (en €) se da abajo, siendo q la cantidad producida y vendida. ¿Qué cantidad q maximiza el beneficio?", "Der Gewinn eines Unternehmens (in €) ist unten angegeben; q ist die produzierte und verkaufte Menge. Welche Menge q maximiert den Gewinn?", "Il profitto di un'azienda (in €) è dato qui sotto, con q quantità prodotta e venduta. Quale quantità q massimizza il profitto?"),
               L("Le profit d'une entreprise (en €) est donné ci-dessous, q étant la quantité produite et vendue. Quel est le profit maximal ?", "A firm's profit (in €) is given below, q being the quantity produced and sold. What is the maximum profit?", "El beneficio de una empresa (en €) se da abajo, siendo q la cantidad producida y vendida. ¿Cuál es el beneficio máximo?", "Der Gewinn eines Unternehmens (in €) ist unten angegeben; q ist die produzierte und verkaufte Menge. Wie hoch ist der maximale Gewinn?", "Il profitto di un'azienda (in €) è dato qui sotto, con q quantità prodotta e venduta. Qual è il profitto massimo?")],
    concept: L("Une parabole tournée vers le bas atteint son maximum en son sommet, là où la pente s'annule.", "A downward parabola reaches its maximum at its vertex, where the slope is zero.", "Una parábola abierta hacia abajo alcanza su máximo en el vértice, donde la pendiente es cero.", "Eine nach unten geöffnete Parabel hat ihr Maximum im Scheitelpunkt, wo die Steigung null ist.", "Una parabola rivolta verso il basso raggiunge il massimo nel vertice, dove la pendenza si annulla."),
    method: L("Dérive : f′(x) = −2a·x + b, résous f′(x) = 0 pour obtenir x = b / (2a) ; pour la valeur maximale, remplace ensuite x dans f.", "Differentiate: f′(x) = −2a·x + b, solve f′(x) = 0 to get x = b / (2a); for the maximum value, then substitute x into f.", "Deriva: f′(x) = −2a·x + b, resuelve f′(x) = 0 para obtener x = b / (2a); para el valor máximo, sustituye luego x en f.", "Leite ab: f′(x) = −2a·x + b, löse f′(x) = 0 und erhalte x = b / (2a); für den Maximalwert setze x anschließend in f ein.", "Deriva: f′(x) = −2a·x + b, risolvi f′(x) = 0 per ottenere x = b / (2a); per il valore massimo sostituisci poi x in f."),
    gen: function(g){
      var a, b, c, xs, v = g.biz ? "q" : "x", variant = g.lvl === 2 ? 1 : 0, fn = g.biz ? "P" : "f";
      if(g.lvl === 1){ a = g.ri(1, 4); var xi = g.ri(1, 8); b = 2 * a * xi; }
      else { a = g.pick([1, 2, 4, 5]); b = g.ri(2, 16); }
      c = g.biz ? -g.ri(2, 20) * 10 : g.ri(-10, 20);
      if(g.biz && g.lvl === 1){ a = g.ri(1, 4); b = 2 * a * g.ri(5, 30); }
      xs = rat(b, 2 * a);
      var coef = [c, b, -a], src = polyStr(coef, v), val = variant === 0 ? xs : rat(c).add(rat(b * b, 4 * a)), vs = g.N(val), xt = g.N(xs);
      var steps = [fn + "′(" + v + ") = " + polyStr(polyDeriv(coef), v), fn + "′(" + v + ") = 0 ⇔ " + v + " = " + b + "/" + (2 * a) + " = " + xt];
      if(variant === 1) steps.push(fn + "(" + xt + ") = " + c + " + " + b + "·" + par(xt) + " - " + a + "·" + par(xt) + "² = " + vs);
      return { params: {}, variant: variant, formulas: [fm(src, fn + "(" + v + ") = ")], expected: { type: "number", value: val }, unit: g.biz && variant === 1 ? "€" : "", expectedText: vs + (g.biz && variant === 1 ? " €" : ""), steps: steps, example: vs,
               verify: function(){
                 var d = F.derivativePoly(parse(src), v === "q" ? "q" : "x"); if(!d || !d.ok) return false;
                 var r = engineRoots(d.exact.text.replace(/q/g, "x") + " = 0"); if(!r || r.length !== 1 || !r[0].eq(xs)) return false;
                 return variant === 0 ? true : C.evalExact(parse(src), { x: xs, q: xs }).eq(val);
               } };
    }
  });

  def("func-breakeven", {
    domain: "functions", levels: [1, 2], biz: [1, 2], bizOnly: true,
    frame: L("", "", "", "", ""),
    bizFrame: L("Une entreprise vend un produit {p} € l'unité. Le coût variable est de {c} € par unité et les coûts fixes s'élèvent à {F} €. Quelle quantité doit-elle vendre pour couvrir exactement ses coûts (seuil de rentabilité) ?", "A company sells a product at €{p} per unit. The variable cost is €{c} per unit and fixed costs are €{F}. What quantity must it sell to exactly cover its costs (break-even point)?", "Una empresa vende un producto a {p} € la unidad. El coste variable es de {c} € por unidad y los costes fijos ascienden a {F} €. ¿Qué cantidad debe vender para cubrir exactamente sus costes (umbral de rentabilidad)?", "Ein Unternehmen verkauft ein Produkt für {p} € pro Stück. Die variablen Kosten betragen {c} € pro Stück, die Fixkosten {F} €. Welche Menge muss es verkaufen, um seine Kosten genau zu decken (Break-even-Punkt)?", "Un'azienda vende un prodotto a {p} € l'unità. Il costo variabile è di {c} € per unità e i costi fissi ammontano a {F} €. Quale quantità deve vendere per coprire esattamente i costi (punto di pareggio)?"),
    concept: L("Le seuil de rentabilité est la quantité où le chiffre d'affaires égale les coûts : profit nul.", "Break-even is the quantity where revenue equals costs: zero profit.", "El umbral de rentabilidad es la cantidad en la que los ingresos igualan los costes: beneficio nulo.", "Der Break-even ist die Menge, bei der der Umsatz den Kosten entspricht: Gewinn null.", "Il punto di pareggio è la quantità in cui i ricavi uguagliano i costi: profitto nullo."),
    method: L("Écris recette = coût : p·q = c·q + F, d'où q = F / (p − c).", "Write revenue = cost: p·q = c·q + F, so q = F / (p − c).", "Escribe ingreso = coste: p·q = c·q + F, de donde q = F / (p − c).", "Schreibe Erlös = Kosten: p·q = c·q + F, also q = F / (p − c).", "Scrivi ricavo = costo: p·q = c·q + F, da cui q = F / (p − c)."),
    gen: function(g){
      var p, c, F0, q;
      if(g.lvl === 1){ var m = g.ri(2, 10); c = g.ri(3, 25); p = c + m; q = g.ri(10, 100); F0 = m * q; }
      else { var m2 = g.pick([2.5, 3.5, 4.5, 7.5]); c = g.ri(4, 30) + 0.5; p = c + m2; q = g.ri(5, 40) * 2; F0 = m2 * q; }
      var ps = g.N(rat(Math.round(p * 10), 10)), cs = g.N(rat(Math.round(c * 10), 10)), Fs = g.N(rat(Math.round(F0 * 10), 10));
      var pA = g.A(rat(Math.round(p * 10), 10)), cA = g.A(rat(Math.round(c * 10), 10)), FA = g.A(rat(Math.round(F0 * 10), 10));
      return { params: { p: ps, c: cs, F: Fs }, formulas: [], expected: { type: "number", value: rat(q) }, expectedText: String(q), steps: ["R(q) = " + ps + "·q ; C(q) = " + cs + "·q + " + Fs, "R(q) = C(q) ⇔ (" + ps + " - " + cs + ")·q = " + Fs, "q = " + Fs + " / " + g.N(rat(Math.round((p - c) * 10), 10)) + " = " + q], example: String(q),
               verify: function(){ var r = engineRoots(pA + "x = " + cA + "x + " + FA); return !!r && r.length === 1 && r[0].eq(rat(q)); } };
    }
  });

  /* ═══ DÉRIVÉES ═══ */
  var DERIV_CONCEPT = L("La dérivée mesure la vitesse de variation de la fonction : pour xⁿ, c'est n·xⁿ⁻¹.", "The derivative measures the rate of change of the function: for xⁿ it is n·xⁿ⁻¹.", "La derivada mide la velocidad de variación de la función: para xⁿ es n·xⁿ⁻¹.", "Die Ableitung misst die Änderungsrate der Funktion: Für xⁿ ist sie n·xⁿ⁻¹.", "La derivata misura la velocità di variazione della funzione: per xⁿ è n·xⁿ⁻¹.");
  def("derivative", {
    domain: "derivatives", levels: [0, 1, 2], biz: [0, 1],
    frame: L("Calcule la dérivée de la fonction suivante.", "Compute the derivative of the following function.", "Calcula la derivada de la siguiente función.", "Berechne die Ableitung der folgenden Funktion.", "Calcola la derivata della funzione seguente."),
    bizFrame: L("Le coût total de production est donné ci-dessous (en €). Exprime le coût marginal, c'est-à-dire la dérivée C′(q).", "The total production cost is given below (in €). Express the marginal cost, i.e. the derivative C′(q).", "El coste total de producción se da abajo (en €). Expresa el coste marginal, es decir, la derivada C′(q).", "Die Gesamtkosten der Produktion sind unten angegeben (in €). Gib die Grenzkosten an, also die Ableitung C′(q).", "Il costo totale di produzione è dato qui sotto (in €). Esprimi il costo marginale, cioè la derivata C′(q)."),
    concept: DERIV_CONCEPT,
    method: L("Dérive terme à terme : (a·xⁿ)′ = n·a·xⁿ⁻¹, la dérivée d'une constante est 0 ; pour un produit ou une puissance de parenthèse, applique la règle correspondante.", "Differentiate term by term: (a·xⁿ)′ = n·a·xⁿ⁻¹, the derivative of a constant is 0; for a product or a power of a bracket, apply the matching rule.", "Deriva término a término: (a·xⁿ)′ = n·a·xⁿ⁻¹, la derivada de una constante es 0; para un producto o una potencia de paréntesis, aplica la regla correspondiente.", "Leite Term für Term ab: (a·xⁿ)′ = n·a·xⁿ⁻¹, die Ableitung einer Konstanten ist 0; bei einem Produkt oder einer Klammerpotenz wende die passende Regel an.", "Deriva termine per termine: (a·xⁿ)′ = n·a·xⁿ⁻¹, la derivata di una costante è 0; per un prodotto o una potenza di parentesi applica la regola corrispondente."),
    gen: function(g){
      var v = g.biz ? "q" : "x", fn = g.biz ? "C" : "f", src, dsrc, steps, poly = true;
      if(g.lvl === 0 || (g.biz && g.lvl === 0)){ var a = g.ri(1, 6), b = g.ri(-8, 8), c = g.biz ? g.ri(2, 20) * 10 : g.ri(-9, 9); var co = [c, b, a]; src = polyStr(co, v); dsrc = polyStr(polyDeriv(co), v); steps = ["(" + a + v + "²)′ = " + 2 * a + v + " ; (" + par(b) + v + ")′ = " + b + " ; (" + c + ")′ = 0", fn + "′(" + v + ") = " + dsrc]; }
      else if(g.lvl === 1 || g.biz){ var co3 = [g.biz ? g.ri(2, 20) * 10 : g.ri(-9, 9), g.ri(-8, 8), g.ri(1, 6), g.nz(1, 4)]; src = polyStr(co3, v); dsrc = polyStr(polyDeriv(co3), v); steps = ["(" + co3[3] + v + "³)′ = " + 3 * co3[3] + v + "² ; (" + co3[2] + v + "²)′ = " + 2 * co3[2] + v + " ; (" + par(co3[1]) + v + ")′ = " + co3[1], fn + "′(" + v + ") = " + dsrc]; }
      else if(g.ri(0, 1) === 0){
        var p1 = g.nz(-4, 5), q1 = g.ri(-6, 6), p2 = g.nz(1, 4), q2 = g.ri(-6, 6); poly = false;
        src = "(" + polyStr([q1, p1], "x") + ")(" + polyStr([q2, p2], "x") + ")"; dsrc = polyStr([p1 * q2 + p2 * q1, 2 * p1 * p2], "x");
        steps = ["u = " + polyStr([q1, p1], "x") + " ; v = " + polyStr([q2, p2], "x") + " ; (uv)′ = u′v + uv′", "f′(x) = " + par(p1) + "·(" + polyStr([q2, p2], "x") + ") + " + par(p2) + "·(" + polyStr([q1, p1], "x") + ") = " + dsrc];
      } else {
        var pa = g.nz(1, 4), qb = g.ri(-5, 5), n = g.ri(3, 5); poly = false;
        src = "(" + polyStr([qb, pa], "x") + ")^" + n; dsrc = n * pa + "(" + polyStr([qb, pa], "x") + ")^" + (n - 1);
        steps = ["u = " + polyStr([qb, pa], "x") + " ; (uⁿ)′ = n·u′·uⁿ⁻¹", "f′(x) = " + n + "·" + pa + "·(" + polyStr([qb, pa], "x") + ")^" + (n - 1) + " = " + dsrc];
      }
      var fAst = parse(src), dAst = parse(dsrc);
      return { params: {}, formulas: [fm(src, fn + "(" + v + ") = ")], expected: { type: "expression", ast: dAst, form: null }, expectedText: fn + "′(" + v + ") = " + pretty(C.toText(dAst)), steps: steps, example: dsrc, varName: v,
               verify: function(){
                 if(poly){ var d = F.derivativePoly(fAst, v); return !!(d && d.ok && V.equivalent(parse(d.exact.text), dAst, {}).equal === true); }
                 var vd = V.verifyDerivative(fAst, dAst, "x"); return !!vd && /^VERIFIED/.test(vd.status);
               } };
    }
  });

  def("derivative-point", {
    domain: "derivatives", levels: [1, 2], biz: [1],
    frame: L("Soit f la fonction ci-dessous. Calcule f′({k}).", "Let f be the function below. Compute f′({k}).", "Sea f la función de abajo. Calcula f′({k}).", "Sei f die folgende Funktion. Berechne f′({k}).", "Sia f la funzione qui sotto. Calcola f′({k})."),
    bizFrame: L("Le coût total est donné ci-dessous (en €). Calcule le coût marginal pour q = {k} unités, c'est-à-dire C′({k}).", "The total cost is given below (in €). Compute the marginal cost at q = {k} units, i.e. C′({k}).", "El coste total se da abajo (en €). Calcula el coste marginal para q = {k} unidades, es decir, C′({k}).", "Die Gesamtkosten sind unten angegeben (in €). Berechne die Grenzkosten bei q = {k} Einheiten, also C′({k}).", "Il costo totale è dato qui sotto (in €). Calcola il costo marginale per q = {k} unità, cioè C′({k})."),
    concept: L("f′(k) est la pente de la courbe au point d'abscisse k : la variation instantanée de f en k.", "f′(k) is the slope of the curve at x = k: the instantaneous rate of change of f at k.", "f′(k) es la pendiente de la curva en x = k: la variación instantánea de f en k.", "f′(k) ist die Steigung der Kurve bei x = k: die momentane Änderungsrate von f in k.", "f′(k) è la pendenza della curva in x = k: la variazione istantanea di f in k."),
    method: L("Dérive d'abord f pour obtenir f′(x), puis remplace x par la valeur demandée.", "First differentiate f to get f′(x), then substitute the requested value for x.", "Primero deriva f para obtener f′(x) y luego sustituye x por el valor pedido.", "Leite zuerst f ab, um f′(x) zu erhalten, und setze dann den gefragten Wert für x ein.", "Prima deriva f per ottenere f′(x), poi sostituisci x con il valore richiesto."),
    gen: function(g){
      var v = g.biz ? "q" : "x", fn = g.biz ? "C" : "f", co, k;
      if(g.lvl === 1){ co = [g.biz ? g.ri(2, 20) * 10 : g.ri(-9, 9), g.ri(-6, 9), g.nz(1, 5)]; }
      else co = [g.ri(-9, 9), g.ri(-6, 9), g.ri(-5, 5), g.nz(1, 3)];
      k = g.biz ? g.ri(2, 12) : g.ri(1, 5);
      var src = polyStr(co, v), dco = polyDeriv(co), val = evalPoly(dco, k), vs = g.N(val);
      return { params: { k: String(k) }, formulas: [fm(src, fn + "(" + v + ") = ")], expected: { type: "number", value: val }, unit: g.biz ? "€" : "", expectedText: vs + (g.biz ? " €" : ""),
               steps: [fn + "′(" + v + ") = " + polyStr(dco, v), fn + "′(" + k + ") = " + substStr(dco, k) + " = " + vs], example: vs,
               verify: function(){ var d = F.derivativePoly(parse(src), v); return !!(d && d.ok && C.evalExact(parse(d.exact.text), { x: rat(k), q: rat(k) }).eq(val)); } };
    }
  });

  def("critical-points", {
    domain: "derivatives", levels: [2], biz: [],
    frame: L("Trouve les valeurs de x où la dérivée de la fonction ci-dessous s'annule (points critiques).", "Find the values of x where the derivative of the function below is zero (critical points).", "Encuentra los valores de x donde se anula la derivada de la función de abajo (puntos críticos).", "Finde die Werte von x, an denen die Ableitung der folgenden Funktion null ist (kritische Punkte).", "Trova i valori di x in cui si annulla la derivata della funzione qui sotto (punti critici)."),
    concept: L("Les extremums locaux d'une fonction dérivable se cherchent là où f′(x) = 0.", "The local extrema of a differentiable function are found where f′(x) = 0.", "Los extremos locales de una función derivable se buscan donde f′(x) = 0.", "Die lokalen Extrema einer differenzierbaren Funktion findet man dort, wo f′(x) = 0.", "Gli estremi locali di una funzione derivabile si cercano dove f′(x) = 0."),
    method: L("Calcule f′(x), puis résous l'équation f′(x) = 0 (équation du second degré : cherche les deux solutions).", "Compute f′(x), then solve f′(x) = 0 (a quadratic: look for both solutions).", "Calcula f′(x) y resuelve f′(x) = 0 (una ecuación de segundo grado: busca las dos soluciones).", "Berechne f′(x) und löse f′(x) = 0 (eine quadratische Gleichung: suche beide Lösungen).", "Calcola f′(x) e risolvi f′(x) = 0 (un'equazione di secondo grado: cerca entrambe le soluzioni)."),
    gen: function(g){
      var r1, r2, guard = 0;
      do{ r1 = g.ri(-4, 5); r2 = g.ri(-4, 5); }while((r1 === r2 || (r1 + r2) % 2 !== 0) && guard++ < 100);
      if(r1 === r2 || (r1 + r2) % 2 !== 0){ r1 = 1; r2 = 3; }
      if(r1 > r2){ var t = r1; r1 = r2; r2 = t; }
      var co = [g.ri(-5, 5), 3 * r1 * r2, -3 * (r1 + r2) / 2, 1], src = polyStr(co, "x"), dco = polyDeriv(co);
      return { params: {}, formulas: [fm(src, "f(x) = ")], expected: { type: "set", values: ints([r1, r2]) }, expectedText: "x = " + r1 + " ; x = " + r2,
               steps: ["f′(x) = " + polyStr(dco, "x"), "f′(x) = 0 ⇔ " + polyStr([dco[0] / 3, dco[1] / 3, 1], "x") + " = 0", "x = " + r1 + " ; x = " + r2], example: r1 + " ; " + r2,
               verify: function(){ var d = F.derivativePoly(parse(src), "x"); if(!d || !d.ok) return false; var r = engineRoots(d.exact.text + " = 0"); return !!r && sameSet(r, ints([r1, r2])); } };
    }
  });

  /* ═══ INTÉGRALES ═══ */
  function antiStr(c, v){          // primitive de Σ cₖ xᵏ : « x^3/3 + 2x^2 »
    var s = "", k;
    for(k = c.length - 1; k >= 0; k--){
      var a = c[k]; if(!a) continue;
      var n = k + 1, abs = Math.abs(a), term;
      var coef = abs % n === 0 ? (abs / n === 1 ? "" : String(abs / n)) : null;
      var xp = v + (n > 1 ? "^" + n : "");
      term = coef !== null ? coef + xp : (abs === 1 ? xp + "/" + n : "(" + abs + "/" + n + ")" + xp);
      s += s ? (a < 0 ? " - " : " + ") + term : (a < 0 ? "-" : "") + term;
    }
    return s || "0";
  }
  def("integral-def", {
    domain: "integrals", levels: [0, 1, 2], biz: [1, 2],
    frame: L("Calcule l'intégrale suivante.", "Compute the following integral.", "Calcula la siguiente integral.", "Berechne das folgende Integral.", "Calcola il seguente integrale."),
    bizFrame: L("Le flux de trésorerie instantané d'un projet (en k€ par an) vaut r(t), donné ci-dessous. Calcule le flux cumulé entre t = {a} et t = {b} (en k€).", "A project's instantaneous cash flow (in k€ per year) is r(t), given below. Compute the cumulative cash flow between t = {a} and t = {b} (in k€).", "El flujo de caja instantáneo de un proyecto (en k€ por año) es r(t), dado abajo. Calcula el flujo acumulado entre t = {a} y t = {b} (en k€).", "Der momentane Cashflow eines Projekts (in k€ pro Jahr) ist r(t), unten angegeben. Berechne den kumulierten Cashflow zwischen t = {a} und t = {b} (in k€).", "Il flusso di cassa istantaneo di un progetto (in k€ all'anno) è r(t), indicato qui sotto. Calcola il flusso cumulato tra t = {a} e t = {b} (in k€)."),
    concept: L("Une intégrale définie ∫ₐᵇ f(x)dx cumule f entre a et b : c'est F(b) − F(a), où F est une primitive de f.", "A definite integral ∫ₐᵇ f(x)dx accumulates f between a and b: it equals F(b) − F(a), where F is an antiderivative of f.", "Una integral definida ∫ₐᵇ f(x)dx acumula f entre a y b: es F(b) − F(a), donde F es una primitiva de f.", "Ein bestimmtes Integral ∫ₐᵇ f(x)dx summiert f zwischen a und b: Es ist F(b) − F(a), wobei F eine Stammfunktion von f ist.", "Un integrale definito ∫ₐᵇ f(x)dx accumula f tra a e b: vale F(b) − F(a), dove F è una primitiva di f."),
    method: L("Trouve une primitive F (xⁿ → xⁿ⁺¹/(n+1)), puis calcule F(b) − F(a).", "Find an antiderivative F (xⁿ → xⁿ⁺¹/(n+1)), then compute F(b) − F(a).", "Halla una primitiva F (xⁿ → xⁿ⁺¹/(n+1)) y calcula F(b) − F(a).", "Bestimme eine Stammfunktion F (xⁿ → xⁿ⁺¹/(n+1)) und berechne F(b) − F(a).", "Trova una primitiva F (xⁿ → xⁿ⁺¹/(n+1)) e calcola F(b) − F(a)."),
    gen: function(g){
      var co, lo, hi, v = g.biz ? "t" : "x";
      if(g.lvl === 0){ co = [g.ri(0, 6), g.nz(1, 5)]; lo = 0; hi = g.ri(1, 5); }
      else if(g.lvl === 1){ co = [g.ri(0, 5), g.ri(-3, 6), g.nz(1, 4)]; lo = g.ri(0, 2); hi = lo + g.ri(1, 3); }
      else { co = g.biz ? [g.ri(0, 5), g.ri(0, 6), g.ri(-3, 4), g.nz(1, 3)] : [g.ri(-4, 5), g.ri(-3, 6), g.ri(-3, 4), g.nz(1, 3)]; lo = g.biz ? g.ri(0, 2) : g.ri(-2, 1); hi = lo + g.ri(1, 3); }
      var src = polyStr(co, v), Fs = antiStr(co, v), Fa = C.evalExact(parse(antiStr(co, "x")), { x: rat(lo) }), Fb = C.evalExact(parse(antiStr(co, "x")), { x: rat(hi) });
      var val = Fb.sub(Fa), vs = g.N(val), fnLabel = g.biz ? "r(t) = " : "";
      var tex = "\\int_{" + lo + "}^{" + hi + "} \\left(" + C.toLatex(parse(src)) + "\\right)\\,d" + v;
      var txt = "∫ (" + pretty(C.toText(parse(src))) + ") d" + v + "   [" + lo + " → " + hi + "]";
      return { params: { a: String(lo), b: String(hi) }, formulas: g.biz ? [fm(src, "r(t) = ")] : [{ text: txt, latex: tex }], expected: { type: "number", value: val }, unit: g.biz ? "k€" : "", expectedText: vs + (g.biz ? " k€" : ""),
               steps: ["F(" + v + ") = " + Fs, "F(" + hi + ") - F(" + par(lo) + ") = " + g.N(Fb) + " - " + par(g.N(Fa)) + " = " + vs], example: vs,
               verify: function(){ var r = F.integralPoly(parse(polyStr(co, "x")), "x", [parse(String(lo)), parse(String(hi))]); return !!(r && r.ok && ratOfText(r.exact.text).eq(val)); } };
    }
  });

  /* ═══ PROBABILITÉS ═══ */
  function dataFm(g, label, xs){ var t = label + " : " + g.list(xs); return { text: t, latex: null }; }
  def("proba-simple", {
    domain: "probability", levels: [0], biz: [0],
    frame: [L("Une urne contient {r} boules rouges, {b} boules bleues et {v} boules vertes. On tire une boule au hasard. Quelle est la probabilité qu'elle soit rouge ?", "An urn contains {r} red balls, {b} blue balls and {v} green balls. One ball is drawn at random. What is the probability that it is red?", "Una urna contiene {r} bolas rojas, {b} bolas azules y {v} bolas verdes. Se extrae una bola al azar. ¿Cuál es la probabilidad de que sea roja?", "Eine Urne enthält {r} rote, {b} blaue und {v} grüne Kugeln. Es wird zufällig eine Kugel gezogen. Wie groß ist die Wahrscheinlichkeit, dass sie rot ist?", "Un'urna contiene {r} palline rosse, {b} blu e {v} verdi. Si estrae una pallina a caso. Qual è la probabilità che sia rossa?"),
            L("Une urne contient {r} boules rouges, {b} boules bleues et {v} boules vertes. On tire une boule au hasard. Quelle est la probabilité qu'elle ne soit pas rouge ?", "An urn contains {r} red balls, {b} blue balls and {v} green balls. One ball is drawn at random. What is the probability that it is not red?", "Una urna contiene {r} bolas rojas, {b} bolas azules y {v} bolas verdes. Se extrae una bola al azar. ¿Cuál es la probabilidad de que no sea roja?", "Eine Urne enthält {r} rote, {b} blaue und {v} grüne Kugeln. Es wird zufällig eine Kugel gezogen. Wie groß ist die Wahrscheinlichkeit, dass sie nicht rot ist?", "Un'urna contiene {r} palline rosse, {b} blu e {v} verdi. Si estrae una pallina a caso. Qual è la probabilità che non sia rossa?")],
    bizFrame: [L("Un lot de {n} pièces contient {d} pièces défectueuses. On prélève une pièce au hasard. Quelle est la probabilité qu'elle soit défectueuse ?", "A batch of {n} parts contains {d} defective parts. One part is picked at random. What is the probability that it is defective?", "Un lote de {n} piezas contiene {d} piezas defectuosas. Se elige una pieza al azar. ¿Cuál es la probabilidad de que sea defectuosa?", "Eine Charge von {n} Teilen enthält {d} defekte Teile. Es wird zufällig ein Teil entnommen. Wie groß ist die Wahrscheinlichkeit, dass es defekt ist?", "Un lotto di {n} pezzi contiene {d} pezzi difettosi. Si preleva un pezzo a caso. Qual è la probabilità che sia difettoso?"),
               L("Un lot de {n} pièces contient {d} pièces défectueuses. On prélève une pièce au hasard. Quelle est la probabilité qu'elle soit en bon état ?", "A batch of {n} parts contains {d} defective parts. One part is picked at random. What is the probability that it is in good condition?", "Un lote de {n} piezas contiene {d} piezas defectuosas. Se elige una pieza al azar. ¿Cuál es la probabilidad de que esté en buen estado?", "Eine Charge von {n} Teilen enthält {d} defekte Teile. Es wird zufällig ein Teil entnommen. Wie groß ist die Wahrscheinlichkeit, dass es einwandfrei ist?", "Un lotto di {n} pezzi contiene {d} pezzi difettosi. Si preleva un pezzo a caso. Qual è la probabilità che sia in buono stato?")],
    concept: L("Probabilité = nombre de cas favorables / nombre de cas possibles (quand tous les cas sont équiprobables).", "Probability = number of favourable outcomes / number of possible outcomes (when all outcomes are equally likely).", "Probabilidad = casos favorables / casos posibles (cuando todos los casos son equiprobables).", "Wahrscheinlichkeit = günstige Fälle / mögliche Fälle (wenn alle Fälle gleich wahrscheinlich sind).", "Probabilità = casi favorevoli / casi possibili (quando tutti i casi sono equiprobabili)."),
    method: L("Compte le total des cas possibles, puis les cas favorables ; pour « le contraire », utilise P(non A) = 1 − P(A).", "Count all possible outcomes, then the favourable ones; for « the opposite », use P(not A) = 1 − P(A).", "Cuenta el total de casos posibles y luego los favorables; para « lo contrario », usa P(no A) = 1 − P(A).", "Zähle alle möglichen Fälle und dann die günstigen; für « das Gegenteil » nutze P(nicht A) = 1 − P(A).", "Conta tutti i casi possibili, poi quelli favorevoli; per « il contrario » usa P(non A) = 1 − P(A)."),
    gen: function(g){
      var variant = g.ri(0, 1), r, b, v, n, d, fav, tot, params, steps, flab;
      if(g.biz){ n = g.ri(4, 30) * 10; d = g.ri(1, 12) * 5; if(d >= n) d = n / 5; params = { n: String(n), d: String(d) }; tot = n; fav = variant === 0 ? d : n - d; steps = ["P = cas favorables / cas possibles", "P = " + fav + " / " + tot + " = " + g.N(rat(fav, tot))]; }
      else { r = g.ri(2, 8); b = g.ri(2, 8); v = g.ri(1, 6); tot = r + b + v; fav = variant === 0 ? r : b + v; params = { r: String(r), b: String(b), v: String(v) }; steps = [variant === 0 ? "P(rouge) = " + r + " / (" + r + " + " + b + " + " + v + ")" : "P(non rouge) = (" + b + " + " + v + ") / " + tot, "P = " + fav + " / " + tot + " = " + g.N(rat(fav, tot))]; }
      var val = rat(fav, tot);
      return { params: params, variant: variant, formulas: [], expected: { type: "number", value: val }, expectedText: val.toString() + (val.isInt() ? "" : " ≈ " + g.N(rat(Math.round(val.toNumber() * 1000), 1000))), steps: steps, example: val.toString(), accept: { rounding: true },
               verify: function(){ return C.evalExact(parse(fav + "/" + tot), {}).eq(val); } };
    }
  });

  def("proba-union", {
    domain: "probability", levels: [0], biz: [0],
    frame: L("On donne P(A) = {pa}, P(B) = {pb} et P(A ∩ B) = {pab}. Calcule P(A ∪ B).", "Given P(A) = {pa}, P(B) = {pb} and P(A ∩ B) = {pab}, compute P(A ∪ B).", "Se dan P(A) = {pa}, P(B) = {pb} y P(A ∩ B) = {pab}. Calcula P(A ∪ B).", "Gegeben sind P(A) = {pa}, P(B) = {pb} und P(A ∩ B) = {pab}. Berechne P(A ∪ B).", "Dati P(A) = {pa}, P(B) = {pb} e P(A ∩ B) = {pab}, calcola P(A ∪ B)."),
    bizFrame: L("{pa} % des clients achètent le produit A, {pb} % achètent le produit B, et {pab} % achètent les deux. Quelle proportion de clients achète au moins l'un des deux produits ?", "{pa}% of customers buy product A, {pb}% buy product B, and {pab}% buy both. What proportion of customers buys at least one of the two products?", "El {pa} % de los clientes compra el producto A, el {pb} % compra el producto B y el {pab} % compra ambos. ¿Qué proporción de clientes compra al menos uno de los dos productos?", "{pa} % der Kunden kaufen Produkt A, {pb} % kaufen Produkt B und {pab} % kaufen beide. Welcher Anteil der Kunden kauft mindestens eines der beiden Produkte?", "Il {pa} % dei clienti acquista il prodotto A, il {pb} % il prodotto B e il {pab} % entrambi. Quale proporzione di clienti acquista almeno uno dei due prodotti?"),
    concept: L("En comptant A puis B, on compte deux fois ce qui est dans les deux : il faut retirer l'intersection.", "Counting A then B counts what is in both twice: you must remove the intersection.", "Al contar A y luego B, se cuenta dos veces lo que está en ambos: hay que restar la intersección.", "Zählt man A und dann B, wird das, was in beiden liegt, doppelt gezählt: Man muss den Durchschnitt abziehen.", "Contando A e poi B si conta due volte ciò che è in entrambi: bisogna sottrarre l'intersezione."),
    method: L("P(A ∪ B) = P(A) + P(B) − P(A ∩ B).", "P(A ∪ B) = P(A) + P(B) − P(A ∩ B).", "P(A ∪ B) = P(A) + P(B) − P(A ∩ B).", "P(A ∪ B) = P(A) + P(B) − P(A ∩ B).", "P(A ∪ B) = P(A) + P(B) − P(A ∩ B)."),
    gen: function(g){
      var pa = g.ri(30, 70), pb = g.ri(20, 60), pab = g.ri(5, Math.max(6, Math.min(pa, pb) - 5)), u = pa + pb - pab;
      var show = function(x){ return g.biz ? String(x) : g.N(rat(x, 100)); };
      var val = g.biz ? rat(u) : rat(u, 100);
      return { params: { pa: show(pa), pb: show(pb), pab: show(pab) }, formulas: [], expected: { type: "number", value: val, percentMode: g.biz ? "either" : null }, unit: g.biz ? "%" : "", expectedText: g.biz ? u + " %" : g.N(val),
               steps: ["P(A ∪ B) = P(A) + P(B) - P(A ∩ B)", g.biz ? pa + " % + " + pb + " % - " + pab + " % = " + u + " %" : g.N(rat(pa, 100)) + " + " + g.N(rat(pb, 100)) + " - " + g.N(rat(pab, 100)) + " = " + g.N(val)], example: g.biz ? u + " %" : g.N(val),
               verify: function(){ return C.evalExact(parse(pa + "+" + pb + "-" + pab), {}).eq(rat(u)); } };
    }
  });

  def("proba-binomial", {
    domain: "probability", levels: [1, 2], biz: [1, 2],
    frame: [L("On répète {n} fois, de façon indépendante, une expérience dont la probabilité de succès est {p}. X est le nombre de succès (X suit la loi binomiale B({n} ; {p})). Calcule P(X = {k}).", "An experiment with success probability {p} is repeated {n} times independently. X is the number of successes (X follows the binomial law B({n} ; {p})). Compute P(X = {k}).", "Se repite {n} veces, de forma independiente, un experimento cuya probabilidad de éxito es {p}. X es el número de éxitos (X sigue la ley binomial B({n} ; {p})). Calcula P(X = {k}).", "Ein Experiment mit Erfolgswahrscheinlichkeit {p} wird {n}-mal unabhängig wiederholt. X ist die Anzahl der Erfolge (X ist binomialverteilt B({n} ; {p})). Berechne P(X = {k}).", "Un esperimento con probabilità di successo {p} viene ripetuto {n} volte in modo indipendente. X è il numero di successi (X segue la legge binomiale B({n} ; {p})). Calcola P(X = {k})."),
            L("On répète {n} fois, de façon indépendante, une expérience dont la probabilité de succès est {p}. X est le nombre de succès (X suit la loi binomiale B({n} ; {p})). Calcule P(X ≥ 1).", "An experiment with success probability {p} is repeated {n} times independently. X is the number of successes (X follows the binomial law B({n} ; {p})). Compute P(X ≥ 1).", "Se repite {n} veces, de forma independiente, un experimento cuya probabilidad de éxito es {p}. X es el número de éxitos (X sigue la ley binomial B({n} ; {p})). Calcula P(X ≥ 1).", "Ein Experiment mit Erfolgswahrscheinlichkeit {p} wird {n}-mal unabhängig wiederholt. X ist die Anzahl der Erfolge (X ist binomialverteilt B({n} ; {p})). Berechne P(X ≥ 1).", "Un esperimento con probabilità di successo {p} viene ripetuto {n} volte in modo indipendente. X è il numero di successi (X segue la legge binomiale B({n} ; {p})). Calcola P(X ≥ 1).")],
    bizFrame: [L("Chaque client contacté achète avec une probabilité de {p}, indépendamment des autres. On contacte {n} clients. Quelle est la probabilité qu'exactement {k} d'entre eux achètent ?", "Each contacted customer buys with probability {p}, independently of the others. {n} customers are contacted. What is the probability that exactly {k} of them buy?", "Cada cliente contactado compra con probabilidad {p}, de forma independiente. Se contacta a {n} clientes. ¿Cuál es la probabilidad de que compren exactamente {k}?", "Jeder kontaktierte Kunde kauft mit Wahrscheinlichkeit {p}, unabhängig von den anderen. Es werden {n} Kunden kontaktiert. Wie groß ist die Wahrscheinlichkeit, dass genau {k} kaufen?", "Ogni cliente contattato acquista con probabilità {p}, indipendentemente dagli altri. Si contattano {n} clienti. Qual è la probabilità che ne acquistino esattamente {k}?"),
               L("Chaque client contacté achète avec une probabilité de {p}, indépendamment des autres. On contacte {n} clients. Quelle est la probabilité qu'au moins un client achète ?", "Each contacted customer buys with probability {p}, independently of the others. {n} customers are contacted. What is the probability that at least one customer buys?", "Cada cliente contactado compra con probabilidad {p}, de forma independiente. Se contacta a {n} clientes. ¿Cuál es la probabilidad de que compre al menos un cliente?", "Jeder kontaktierte Kunde kauft mit Wahrscheinlichkeit {p}, unabhängig von den anderen. Es werden {n} Kunden kontaktiert. Wie groß ist die Wahrscheinlichkeit, dass mindestens ein Kunde kauft?", "Ogni cliente contattato acquista con probabilità {p}, indipendentemente dagli altri. Si contattano {n} clienti. Qual è la probabilità che almeno un cliente acquisti?")],
    concept: L("Une succession d'épreuves indépendantes à deux issues suit une loi binomiale B(n ; p).", "A series of independent two-outcome trials follows a binomial law B(n ; p).", "Una sucesión de pruebas independientes de dos resultados sigue una ley binomial B(n ; p).", "Eine Folge unabhängiger Versuche mit zwei Ausgängen folgt einer Binomialverteilung B(n ; p).", "Una successione di prove indipendenti a due esiti segue una legge binomiale B(n ; p)."),
    method: L("P(X = k) = C(n, k) · pᵏ · (1 − p)ⁿ⁻ᵏ ; pour « au moins un », utilise P(X ≥ 1) = 1 − (1 − p)ⁿ.", "P(X = k) = C(n, k) · pᵏ · (1 − p)ⁿ⁻ᵏ; for « at least one », use P(X ≥ 1) = 1 − (1 − p)ⁿ.", "P(X = k) = C(n, k) · pᵏ · (1 − p)ⁿ⁻ᵏ; para « al menos uno », usa P(X ≥ 1) = 1 − (1 − p)ⁿ.", "P(X = k) = C(n, k) · pᵏ · (1 − p)ⁿ⁻ᵏ; für « mindestens einer » nutze P(X ≥ 1) = 1 − (1 − p)ⁿ.", "P(X = k) = C(n, k) · pᵏ · (1 − p)ⁿ⁻ᵏ; per « almeno uno » usa P(X ≥ 1) = 1 − (1 − p)ⁿ."),
    gen: function(g){
      var variant = g.lvl === 2 && g.ri(0, 1) === 1 ? 1 : 0, n, p, k;
      if(g.lvl === 1){ n = g.ri(3, 6); p = rat(1, 2); }
      else { n = g.ri(5, 10); p = g.pick([rat(3, 10), rat(1, 5), rat(1, 4), rat(2, 5)]); }
      k = g.ri(1, n - 1);
      var q = rat(1).sub(p), pmf = rat(C.binomBig(n, k)).mul(p.pow(k)).mul(q.pow(n - k)), val = variant === 0 ? pmf : rat(1).sub(q.pow(n)), ps = g.N(p), qs = g.N(q);
      var steps = variant === 0 ? ["P(X = k) = C(n, k) · pᵏ · (1 − p)ⁿ⁻ᵏ", "P(X = " + k + ") = C(" + n + ", " + k + ") · " + par(ps) + "^" + k + " · " + par(qs) + "^" + (n - k) + " = " + g.N(val)]
                                 : ["P(X ≥ 1) = 1 − P(X = 0) = 1 − (1 − p)ⁿ", "P(X ≥ 1) = 1 − " + par(qs) + "^" + n + " = " + g.N(val)];
      return { params: { n: String(n), p: ps, k: String(k) }, variant: variant, formulas: [], expected: { type: "number", value: val }, expectedText: g.N(val) + (val.isInt() ? "" : " (" + val.toString() + ")"), steps: steps, example: val.toString(), accept: { rounding: true },
               verify: function(){ var r = F.binomial(n, p, variant === 0 ? { kind: "eq", k: k } : { kind: "ge", k: 1 }, {}); return !!(r && r.ok && r.value.eq(val)); } };
    }
  });

  def("proba-expect", {
    domain: "probability", levels: [1], biz: [1],
    frame: L("Une variable aléatoire X prend les valeurs ci-dessous avec les probabilités indiquées. Calcule son espérance E(X).", "A random variable X takes the values below with the given probabilities. Compute its expected value E(X).", "Una variable aleatoria X toma los valores de abajo con las probabilidades indicadas. Calcula su esperanza E(X).", "Eine Zufallsvariable X nimmt die unten stehenden Werte mit den angegebenen Wahrscheinlichkeiten an. Berechne ihren Erwartungswert E(X).", "Una variabile aleatoria X assume i valori qui sotto con le probabilità indicate. Calcola il suo valore atteso E(X)."),
    bizFrame: L("Selon trois scénarios, un investissement rapporte les rendements ci-dessous (en %), avec les probabilités indiquées. Quel est le rendement espéré (en %) ?", "Under three scenarios, an investment earns the returns below (in %), with the stated probabilities. What is the expected return (in %)?", "Según tres escenarios, una inversión rinde los rendimientos de abajo (en %), con las probabilidades indicadas. ¿Cuál es el rendimiento esperado (en %)?", "In drei Szenarien erzielt eine Anlage die unten stehenden Renditen (in %) mit den angegebenen Wahrscheinlichkeiten. Wie hoch ist die erwartete Rendite (in %)?", "In tre scenari, un investimento rende i rendimenti qui sotto (in %), con le probabilità indicate. Qual è il rendimento atteso (in %)?"),
    concept: L("L'espérance est la moyenne pondérée des valeurs par leurs probabilités : ce qu'on obtient « en moyenne ».", "The expected value is the average of the values weighted by their probabilities: what you get « on average ».", "La esperanza es el promedio de los valores ponderado por sus probabilidades: lo que se obtiene « en promedio ».", "Der Erwartungswert ist der mit den Wahrscheinlichkeiten gewichtete Mittelwert der Werte: was man « im Durchschnitt » erhält.", "Il valore atteso è la media dei valori ponderata per le loro probabilità: ciò che si ottiene « in media »."),
    method: L("E(X) = x₁·p₁ + x₂·p₂ + x₃·p₃ : multiplie chaque valeur par sa probabilité, puis additionne.", "E(X) = x₁·p₁ + x₂·p₂ + x₃·p₃: multiply each value by its probability, then add.", "E(X) = x₁·p₁ + x₂·p₂ + x₃·p₃: multiplica cada valor por su probabilidad y suma.", "E(X) = x₁·p₁ + x₂·p₂ + x₃·p₃: Multipliziere jeden Wert mit seiner Wahrscheinlichkeit und addiere.", "E(X) = x₁·p₁ + x₂·p₂ + x₃·p₃: moltiplica ogni valore per la sua probabilità e somma."),
    gen: function(g){
      var xs = g.shuffle([g.ri(-12, -2), g.ri(0, 6), g.ri(8, 25)]).sort(function(a, b){ return a - b; });
      var ps = g.pick([[20, 50, 30], [30, 50, 20], [25, 50, 25], [10, 60, 30], [30, 30, 40], [40, 40, 20], [20, 30, 50]]);
      var e = rat(xs[0] * ps[0] + xs[1] * ps[1] + xs[2] * ps[2], 100), es = g.N(e);
      var pc = ps.map(function(p){ return g.N(rat(p, 100)); });
      var table = [dataFm(g, g.biz ? "R (%)" : "x", xs), { text: "P : " + pc.join(" ; "), latex: null }];
      return { params: {}, formulas: table, expected: { type: "number", value: e }, unit: g.biz ? "%" : "", expectedText: es + (g.biz ? " %" : ""), accept: { rounding: true },
               steps: ["E(X) = Σ xᵢ·pᵢ", "E(X) = " + par(xs[0]) + "·" + pc[0] + " + " + par(xs[1]) + "·" + pc[1] + " + " + par(xs[2]) + "·" + pc[2] + " = " + es], example: es,
               verify: function(){ return C.evalExact(parse("(" + xs[0] + "*" + ps[0] + "+" + xs[1] + "*" + ps[1] + "+" + xs[2] + "*" + ps[2] + ")/100"), {}).eq(e); } };
    }
  });

  def("proba-bayes", {
    domain: "probability", levels: [2], biz: [2],
    frame: L("Dans une population, {pA} % des personnes ont une maladie M. Un test est positif pour {s} % des malades et pour {f} % des personnes saines. Une personne a un test positif : quelle est la probabilité qu'elle soit malade ? (valeur décimale, arrondie à 3 décimales si besoin)", "In a population, {pA}% of people have a disease M. A test is positive for {s}% of the sick and for {f}% of healthy people. A person tests positive: what is the probability that they are sick? (decimal value, rounded to 3 places if needed)", "En una población, el {pA} % de las personas tiene una enfermedad M. Una prueba es positiva en el {s} % de los enfermos y en el {f} % de las personas sanas. Una persona da positivo: ¿cuál es la probabilidad de que esté enferma? (valor decimal, redondeado a 3 decimales si hace falta)", "In einer Bevölkerung haben {pA} % der Personen eine Krankheit M. Ein Test ist bei {s} % der Kranken und bei {f} % der Gesunden positiv. Eine Person testet positiv: Wie groß ist die Wahrscheinlichkeit, dass sie krank ist? (Dezimalwert, bei Bedarf auf 3 Stellen gerundet)", "In una popolazione, il {pA} % delle persone ha una malattia M. Un test è positivo per il {s} % dei malati e per il {f} % delle persone sane. Una persona risulta positiva: qual è la probabilità che sia malata? (valore decimale, arrotondato a 3 decimali se serve)"),
    bizFrame: L("{pA} % des entreprises d'un portefeuille font défaut. Un modèle de risque signale {s} % des entreprises qui feront défaut et {f} % des entreprises saines. Une entreprise est signalée : quelle est la probabilité qu'elle fasse défaut ? (valeur décimale, arrondie à 3 décimales si besoin)", "{pA}% of the companies in a portfolio default. A risk model flags {s}% of the companies that will default and {f}% of the healthy ones. A company is flagged: what is the probability that it defaults? (decimal value, rounded to 3 places if needed)", "El {pA} % de las empresas de una cartera incumple. Un modelo de riesgo señala al {s} % de las empresas que incumplirán y al {f} % de las sanas. Una empresa es señalada: ¿cuál es la probabilidad de que incumpla? (valor decimal, redondeado a 3 decimales si hace falta)", "{pA} % der Unternehmen eines Portfolios fallen aus. Ein Risikomodell markiert {s} % der Unternehmen, die ausfallen werden, und {f} % der gesunden. Ein Unternehmen wird markiert: Wie groß ist die Wahrscheinlichkeit, dass es ausfällt? (Dezimalwert, bei Bedarf auf 3 Stellen gerundet)", "Il {pA} % delle aziende di un portafoglio va in default. Un modello di rischio segnala il {s} % delle aziende che andranno in default e il {f} % di quelle sane. Un'azienda è segnalata: qual è la probabilità che vada in default? (valore decimale, arrotondato a 3 decimali se serve)"),
    concept: L("La formule de Bayes « retourne » une probabilité conditionnelle : on connaît P(test | malade) et on cherche P(malade | test).", "Bayes' formula « reverses » a conditional probability: we know P(test | sick) and want P(sick | test).", "La fórmula de Bayes « da la vuelta » a una probabilidad condicional: conocemos P(prueba | enfermo) y buscamos P(enfermo | prueba).", "Die Formel von Bayes « kehrt » eine bedingte Wahrscheinlichkeit « um »: Man kennt P(Test | krank) und sucht P(krank | Test).", "La formula di Bayes « rovescia » una probabilità condizionata: si conosce P(test | malato) e si cerca P(malato | test)."),
    method: L("Calcule P(positif) = P(M)·P(+|M) + P(non M)·P(+|non M), puis P(M|+) = P(M)·P(+|M) / P(positif).", "Compute P(positive) = P(M)·P(+|M) + P(not M)·P(+|not M), then P(M|+) = P(M)·P(+|M) / P(positive).", "Calcula P(positivo) = P(M)·P(+|M) + P(no M)·P(+|no M) y luego P(M|+) = P(M)·P(+|M) / P(positivo).", "Berechne P(positiv) = P(M)·P(+|M) + P(nicht M)·P(+|nicht M), dann P(M|+) = P(M)·P(+|M) / P(positiv).", "Calcola P(positivo) = P(M)·P(+|M) + P(non M)·P(+|non M), poi P(M|+) = P(M)·P(+|M) / P(positivo)."),
    gen: function(g){
      var pA = g.pick([1, 2, 5, 10]), s = g.pick([80, 90, 95]), f = g.pick([5, 10, 20]);
      var a = rat(pA, 100), sv = rat(s, 100), fv = rat(f, 100), pPos = a.mul(sv).add(rat(1).sub(a).mul(fv)), val = a.mul(sv).div(pPos);
      var rd = rat(Math.round(val.toNumber() * 1000), 1000), vs = g.N(rd);
      return { params: { pA: String(pA), s: String(s), f: String(f) }, formulas: [], expected: { type: "number", value: val }, expectedText: vs + " (" + val.toString() + ")", accept: { rounding: true },
               steps: ["P(+) = " + g.N(a) + "·" + g.N(sv) + " + " + g.N(rat(1).sub(a)) + "·" + g.N(fv) + " = " + g.N(pPos), "P(M|+) = " + g.N(a) + "·" + g.N(sv) + " / " + g.N(pPos) + " = " + val.toString() + " ≈ " + vs], example: vs,
               verify: function(){ var r = F.bayes(a, sv, { pBgNotA: fv }); return !!(r && r.ok && r.value.eq(val)); } };
    }
  });

  /* ═══ STATISTIQUES ═══ */
  function seriesLabel(g){ return g.biz ? "k€" : ""; }
  def("stats-mean", {
    domain: "statistics", levels: [0], biz: [0],
    frame: L("Calcule la moyenne de la série suivante.", "Compute the mean of the following data.", "Calcula la media de la siguiente serie.", "Berechne den Mittelwert der folgenden Daten.", "Calcola la media della serie seguente."),
    bizFrame: L("Les ventes mensuelles (en k€) d'une boutique sont données ci-dessous. Quelle est la moyenne mensuelle (en k€) ?", "A shop's monthly sales (in k€) are given below. What is the monthly average (in k€)?", "Las ventas mensuales (en k€) de una tienda se dan abajo. ¿Cuál es el promedio mensual (en k€)?", "Die monatlichen Umsätze (in k€) eines Geschäfts sind unten angegeben. Wie hoch ist der Monatsdurchschnitt (in k€)?", "Le vendite mensili (in k€) di un negozio sono indicate qui sotto. Qual è la media mensile (in k€)?"),
    concept: L("La moyenne est la valeur « équilibrée » : ce que chacun aurait si on partageait le total à égalité.", "The mean is the « balanced » value: what each would get if the total were shared equally.", "La media es el valor « equilibrado »: lo que tendría cada uno si se repartiera el total por igual.", "Der Mittelwert ist der « ausgeglichene » Wert: was jeder bekäme, wenn man die Summe gleichmäßig verteilte.", "La media è il valore « bilanciato »: ciò che ognuno avrebbe se il totale fosse diviso in parti uguali."),
    method: L("Additionne toutes les valeurs, puis divise la somme par le nombre de valeurs.", "Add all the values, then divide the sum by the number of values.", "Suma todos los valores y divide la suma por el número de valores.", "Addiere alle Werte und teile die Summe durch die Anzahl der Werte.", "Somma tutti i valori e dividi la somma per il numero di valori."),
    gen: function(g){
      var n = g.pick([4, 5, 6]), xs = [], i; for(i = 0; i < n; i++) xs.push(g.biz ? g.ri(12, 60) : g.ri(2, 20));
      var S = xs.reduce(function(a, b){ return a + b; }, 0), val = rat(S, n), vs = g.N(val);
      return { params: {}, formulas: [dataFm(g, g.biz ? "k€" : "x", xs)], expected: { type: "number", value: val }, unit: g.biz ? "k€" : "", expectedText: vs + (g.biz ? " k€" : ""), accept: { rounding: true },
               steps: ["Σx = " + xs.join(" + ") + " = " + S, "x̄ = " + S + " / " + n + " = " + vs], example: vs,
               verify: function(){ var d = descOf(xs); return !!(d && d.ok && d.mean.eq(val)); } };
    }
  });

  def("stats-median", {
    domain: "statistics", levels: [0, 1], biz: [0, 1],
    frame: L("Calcule la médiane de la série suivante.", "Compute the median of the following data.", "Calcula la mediana de la siguiente serie.", "Berechne den Median der folgenden Daten.", "Calcola la mediana della serie seguente."),
    bizFrame: L("Les salaires mensuels (en k€) des employés d'une équipe sont donnés ci-dessous. Quelle est la médiane (en k€) ?", "The monthly salaries (in k€) of a team's employees are given below. What is the median (in k€)?", "Los salarios mensuales (en k€) de los empleados de un equipo se dan abajo. ¿Cuál es la mediana (en k€)?", "Die Monatsgehälter (in k€) der Mitarbeiter eines Teams sind unten angegeben. Wie hoch ist der Median (in k€)?", "Gli stipendi mensili (in k€) dei dipendenti di un team sono indicati qui sotto. Qual è la mediana (in k€)?"),
    concept: L("La médiane coupe la série en deux moitiés égales : autant de valeurs en dessous qu'au-dessus.", "The median splits the data into two equal halves: as many values below as above.", "La mediana divide la serie en dos mitades iguales: tantos valores por debajo como por encima.", "Der Median teilt die Daten in zwei gleich große Hälften: ebenso viele Werte darunter wie darüber.", "La mediana divide la serie in due metà uguali: tanti valori sotto quanti sopra."),
    method: L("Range d'abord les valeurs dans l'ordre croissant ; s'il y a un nombre pair de valeurs, la médiane est la moyenne des deux valeurs du milieu.", "First sort the values in increasing order; with an even number of values, the median is the average of the two middle values.", "Ordena primero los valores de menor a mayor; si hay un número par de valores, la mediana es el promedio de los dos centrales.", "Ordne die Werte zuerst aufsteigend; bei einer geraden Anzahl ist der Median der Mittelwert der beiden mittleren Werte.", "Ordina prima i valori in senso crescente; con un numero pari di valori la mediana è la media dei due valori centrali."),
    gen: function(g){
      var n = g.lvl === 0 ? g.pick([5, 7]) : g.pick([6, 8]), xs = [], i; for(i = 0; i < n; i++) xs.push(g.biz ? g.ri(18, 70) / 2 : g.ri(2, 30));
      xs = xs.map(function(x){ return Math.round(x * 2) / 2; });
      var sorted = xs.slice().sort(function(a, b){ return a - b; }), toR = function(x){ return rat(Math.round(x * 2), 2); };
      var val = n % 2 ? toR(sorted[(n - 1) / 2]) : toR(sorted[n / 2 - 1]).add(toR(sorted[n / 2])).div(rat(2)), vs = g.N(val);
      var shown = g.shuffle(xs.map(toR));
      return { params: {}, formulas: [{ text: (g.biz ? "k€" : "x") + " : " + shown.map(function(x){ return g.N(x); }).join(" ; "), latex: null }], expected: { type: "number", value: val }, unit: g.biz ? "k€" : "", expectedText: vs + (g.biz ? " k€" : ""),
               steps: ["tri : " + sorted.map(function(x){ return g.N(toR(x)); }).join(" ; "), n % 2 ? "médiane = valeur n°" + ((n + 1) / 2) + " = " + vs : "médiane = (" + g.N(toR(sorted[n / 2 - 1])) + " + " + g.N(toR(sorted[n / 2])) + ") / 2 = " + vs], example: vs,
               verify: function(){ var d2 = F.descriptive(shown); return !!(d2 && d2.ok && d2.median.eq(val)); } };
    }
  });

  def("stats-variance", {
    domain: "statistics", levels: [1], biz: [1],
    frame: L("Calcule la variance (de la population) de la série suivante.", "Compute the (population) variance of the following data.", "Calcula la varianza (poblacional) de la siguiente serie.", "Berechne die (Populations-)Varianz der folgenden Daten.", "Calcola la varianza (della popolazione) della serie seguente."),
    bizFrame: L("Les rendements annuels (en %) d'un fonds sont donnés ci-dessous. Calcule la variance (de la population) de ces rendements.", "A fund's annual returns (in %) are given below. Compute the (population) variance of these returns.", "Los rendimientos anuales (en %) de un fondo se dan abajo. Calcula la varianza (poblacional) de estos rendimientos.", "Die jährlichen Renditen (in %) eines Fonds sind unten angegeben. Berechne die (Populations-)Varianz dieser Renditen.", "I rendimenti annui (in %) di un fondo sono indicati qui sotto. Calcola la varianza (della popolazione) di questi rendimenti."),
    concept: L("La variance mesure la dispersion : la moyenne des carrés des écarts à la moyenne.", "Variance measures spread: the average of the squared deviations from the mean.", "La varianza mide la dispersión: el promedio de los cuadrados de las desviaciones respecto a la media.", "Die Varianz misst die Streuung: der Mittelwert der quadrierten Abweichungen vom Mittelwert.", "La varianza misura la dispersione: la media dei quadrati degli scarti dalla media."),
    method: L("Calcule la moyenne x̄, puis les écarts (x − x̄), mets-les au carré, et fais leur moyenne : σ² = Σ(x − x̄)² / n.", "Compute the mean x̄, then the deviations (x − x̄), square them and average: σ² = Σ(x − x̄)² / n.", "Calcula la media x̄, luego las desviaciones (x − x̄), elévalas al cuadrado y haz su promedio: σ² = Σ(x − x̄)² / n.", "Berechne den Mittelwert x̄, dann die Abweichungen (x − x̄), quadriere sie und mittle: σ² = Σ(x − x̄)² / n.", "Calcola la media x̄, poi gli scarti (x − x̄), elevali al quadrato e fanne la media: σ² = Σ(x − x̄)² / n."),
    gen: function(g){
      var n = g.pick([4, 5]), xs = [], i; for(i = 0; i < n; i++) xs.push(g.biz ? g.ri(-4, 18) : g.ri(1, 15));
      var d = descOf(xs), mean = d.mean, val = d.varPop, vs = g.N(val), S = xs.reduce(function(a, b){ return a + b; }, 0);
      var sq = xs.map(function(x){ var e = rat(x).sub(mean); return e.mul(e); }), sumSq = sq.reduce(function(a, b){ return a.add(b); }, rat(0));
      return { params: {}, formulas: [dataFm(g, g.biz ? "R (%)" : "x", xs)], expected: { type: "number", value: val }, unit: "", expectedText: vs, accept: { rounding: true },
               steps: ["x̄ = " + S + " / " + n + " = " + g.N(mean), "Σ(x − x̄)² = " + g.N(sumSq), "σ² = " + g.N(sumSq) + " / " + n + " = " + vs], example: vs,
               verify: function(){ var d2 = descOf(xs); var mean2 = rat(xs.reduce(function(a, b){ return a + b * b; }, 0), n).sub(d2.mean.mul(d2.mean)); return !!(d2 && d2.ok && d2.varPop.eq(val) && mean2.eq(val)); } };
    }
  });

  def("stats-stdev", {
    domain: "statistics", levels: [2], biz: [2],
    frame: L("Calcule l'écart-type (de la population) de la série suivante.", "Compute the (population) standard deviation of the following data.", "Calcula la desviación típica (poblacional) de la siguiente serie.", "Berechne die (Populations-)Standardabweichung der folgenden Daten.", "Calcola la deviazione standard (della popolazione) della serie seguente."),
    bizFrame: L("Les rendements annuels d'un actif (en %) sont donnés ci-dessous. Calcule sa volatilité, c'est-à-dire l'écart-type (de la population) de ces rendements, en points de %.", "An asset's annual returns (in %) are given below. Compute its volatility, i.e. the (population) standard deviation of these returns, in percentage points.", "Los rendimientos anuales de un activo (en %) se dan abajo. Calcula su volatilidad, es decir, la desviación típica (poblacional) de estos rendimientos, en puntos porcentuales.", "Die jährlichen Renditen eines Wertpapiers (in %) sind unten angegeben. Berechne seine Volatilität, also die (Populations-)Standardabweichung dieser Renditen, in Prozentpunkten.", "I rendimenti annui di un titolo (in %) sono indicati qui sotto. Calcola la sua volatilità, cioè la deviazione standard (della popolazione) di questi rendimenti, in punti percentuali."),
    concept: L("L'écart-type est la racine de la variance : l'écart « typique » à la moyenne, dans la même unité que les données (en finance : le risque).", "The standard deviation is the square root of the variance: the « typical » distance from the mean, in the same unit as the data (in finance: the risk).", "La desviación típica es la raíz de la varianza: la distancia « típica » a la media, en la misma unidad que los datos (en finanzas: el riesgo).", "Die Standardabweichung ist die Wurzel der Varianz: der « typische » Abstand zum Mittelwert, in derselben Einheit wie die Daten (in der Finanzwelt: das Risiko).", "La deviazione standard è la radice della varianza: lo scarto « tipico » dalla media, nella stessa unità dei dati (in finanza: il rischio)."),
    method: L("Calcule la moyenne, puis la variance σ² = Σ(x − x̄)² / n, puis prends sa racine carrée.", "Compute the mean, then the variance σ² = Σ(x − x̄)² / n, then take its square root.", "Calcula la media, luego la varianza σ² = Σ(x − x̄)² / n y toma su raíz cuadrada.", "Berechne den Mittelwert, dann die Varianz σ² = Σ(x − x̄)² / n und ziehe die Wurzel.", "Calcola la media, poi la varianza σ² = Σ(x − x̄)² / n e prendine la radice quadrata."),
    gen: function(g){
      var tbl = g.pick([[1, 7, 5], [2, 14, 10], [7, 17, 13], [3, 21, 15]]), a = tbl[0], b = tbl[1], sd = tbl[2], mu = g.biz ? g.ri(8, 16) : g.ri(b + 2, b + 30);
      var xs = [mu - b, mu - a, mu + a, mu + b], shown = g.shuffle(xs), vs = String(sd);
      var d = descOf(xs), sumSq = (b * b + a * a) * 2;
      return { params: {}, formulas: [dataFm(g, g.biz ? "R (%)" : "x", shown)], expected: { type: "number", value: rat(sd) }, unit: g.biz ? "%" : "", expectedText: vs + (g.biz ? " %" : ""),
               steps: ["x̄ = " + mu, "σ² = (" + b + "² + " + a + "² + " + a + "² + " + b + "²) / 4 = " + sumSq + " / 4 = " + sd * sd, "σ = √" + sd * sd + " = " + sd], example: vs,
               verify: function(){ return !!(d && d.ok && d.varPop.eq(rat(sd * sd))); } };
    }
  });

  def("stats-zscore", {
    domain: "statistics", levels: [1], biz: [1],
    frame: L("Une série a pour moyenne {mu} et pour écart-type {sd}. Quel est le z-score (valeur centrée réduite) de x = {x} ?", "A data set has mean {mu} and standard deviation {sd}. What is the z-score of x = {x}?", "Una serie tiene media {mu} y desviación típica {sd}. ¿Cuál es el z-score (valor tipificado) de x = {x}?", "Eine Datenreihe hat den Mittelwert {mu} und die Standardabweichung {sd}. Wie groß ist der z-Wert von x = {x}?", "Una serie ha media {mu} e deviazione standard {sd}. Qual è lo z-score (valore standardizzato) di x = {x}?"),
    bizFrame: L("Les ventes quotidiennes d'un magasin ont pour moyenne {mu} € et pour écart-type {sd} €. Un jour, les ventes atteignent {x} €. Quel est le z-score de ce jour ?", "A shop's daily sales have a mean of €{mu} and a standard deviation of €{sd}. One day, sales reach €{x}. What is that day's z-score?", "Las ventas diarias de una tienda tienen media {mu} € y desviación típica {sd} €. Un día las ventas alcanzan {x} €. ¿Cuál es el z-score de ese día?", "Die Tagesumsätze eines Geschäfts haben den Mittelwert {mu} € und die Standardabweichung {sd} €. An einem Tag erreicht der Umsatz {x} €. Wie groß ist der z-Wert dieses Tages?", "Le vendite giornaliere di un negozio hanno media {mu} € e deviazione standard {sd} €. Un giorno le vendite raggiungono {x} €. Qual è lo z-score di quel giorno?"),
    concept: L("Le z-score dit à combien d'écarts-types une valeur se situe de la moyenne (positif : au-dessus, négatif : en dessous).", "The z-score tells how many standard deviations a value lies from the mean (positive: above, negative: below).", "El z-score indica a cuántas desviaciones típicas está un valor de la media (positivo: por encima, negativo: por debajo).", "Der z-Wert gibt an, um wie viele Standardabweichungen ein Wert vom Mittelwert entfernt liegt (positiv: darüber, negativ: darunter).", "Lo z-score indica a quante deviazioni standard si trova un valore dalla media (positivo: sopra, negativo: sotto)."),
    method: L("z = (x − μ) / σ : retire la moyenne, puis divise par l'écart-type.", "z = (x − μ) / σ: subtract the mean, then divide by the standard deviation.", "z = (x − μ) / σ: resta la media y divide por la desviación típica.", "z = (x − μ) / σ: Ziehe den Mittelwert ab und teile durch die Standardabweichung.", "z = (x − μ) / σ: sottrai la media e dividi per la deviazione standard."),
    gen: function(g){
      var sd = g.biz ? g.pick([20, 40, 50, 100, 150]) : g.pick([2, 4, 5, 10, 15]), z = g.pick([-2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2, 2.5]), mu = g.biz ? g.ri(5, 30) * 100 : g.ri(20, 80);
      var zr = rat(Math.round(z * 2), 2), x = rat(mu).add(zr.mul(rat(sd))), xs = g.N(x), vs = g.N(zr);
      return { params: { mu: String(mu), sd: String(sd), x: xs }, formulas: [], expected: { type: "number", value: zr }, expectedText: vs,
               steps: ["z = (x − μ) / σ", "z = (" + xs + " − " + mu + ") / " + sd + " = " + g.N(x.sub(rat(mu))) + " / " + sd + " = " + vs], example: vs,
               verify: function(){ var r = F.zScore(x, rat(mu), rat(sd)); return !!(r && r.ok && r.value.eq(zr)); } };
    }
  });

  function regData(g){
    var n = g.pick([4, 5]), s = g.ri(1, 5), b0 = g.ri(2, 10), xs = [], ys = [], i, guard = 0, flat = true;
    for(i = 1; i <= n; i++){ xs.push(i); ys.push(b0 + s * i + g.ri(-2, 2)); }
    while(ys.every(function(y){ return y === ys[0]; }) && guard++ < 5) ys[n - 1] += 3;
    return { n: n, xs: xs, ys: ys };
  }
  var REG_CONCEPT = L("La droite de régression y = a·x + b résume la tendance : a est la variation moyenne de y quand x augmente de 1.", "The regression line y = a·x + b summarises the trend: a is the average change in y when x increases by 1.", "La recta de regresión y = a·x + b resume la tendencia: a es la variación media de y cuando x aumenta en 1.", "Die Regressionsgerade y = a·x + b fasst den Trend zusammen: a ist die mittlere Änderung von y, wenn x um 1 steigt.", "La retta di regressione y = a·x + b riassume la tendenza: a è la variazione media di y quando x aumenta di 1.");
  def("regression-slope", {
    domain: "statistics", levels: [2], biz: [2],
    frame: L("On ajuste une droite de régression y = a·x + b sur les points (x ; y) donnés ci-dessous. Calcule la pente a.", "A regression line y = a·x + b is fitted to the points (x ; y) given below. Compute the slope a.", "Se ajusta una recta de regresión y = a·x + b a los puntos (x ; y) dados abajo. Calcula la pendiente a.", "Eine Regressionsgerade y = a·x + b wird an die unten angegebenen Punkte (x ; y) angepasst. Berechne die Steigung a.", "Si adatta una retta di regressione y = a·x + b ai punti (x ; y) indicati qui sotto. Calcola la pendenza a."),
    bizFrame: L("Budget publicitaire x (en k€) et ventes y (en k€) sont donnés ci-dessous. Avec la droite de régression y = a·x + b, quelle est la pente a (gain de ventes pour 1 k€ de publicité de plus) ?", "Advertising budget x (in k€) and sales y (in k€) are given below. With the regression line y = a·x + b, what is the slope a (sales gained per extra k€ of advertising)?", "El presupuesto publicitario x (en k€) y las ventas y (en k€) se dan abajo. Con la recta de regresión y = a·x + b, ¿cuál es la pendiente a (ventas ganadas por cada k€ adicional de publicidad)?", "Werbebudget x (in k€) und Umsatz y (in k€) sind unten angegeben. Wie groß ist bei der Regressionsgeraden y = a·x + b die Steigung a (Umsatzgewinn pro zusätzlichem k€ Werbung)?", "Budget pubblicitario x (in k€) e vendite y (in k€) sono indicati qui sotto. Con la retta di regressione y = a·x + b, qual è la pendenza a (vendite guadagnate per ogni k€ in più di pubblicità)?"),
    concept: REG_CONCEPT,
    method: L("a = Sxy / Sxx avec Sxx = Σ(x − x̄)² et Sxy = Σ(x − x̄)(y − ȳ) : calcule d'abord x̄ et ȳ.", "a = Sxy / Sxx with Sxx = Σ(x − x̄)² and Sxy = Σ(x − x̄)(y − ȳ): first compute x̄ and ȳ.", "a = Sxy / Sxx con Sxx = Σ(x − x̄)² y Sxy = Σ(x − x̄)(y − ȳ): calcula primero x̄ e ȳ.", "a = Sxy / Sxx mit Sxx = Σ(x − x̄)² und Sxy = Σ(x − x̄)(y − ȳ): Berechne zuerst x̄ und ȳ.", "a = Sxy / Sxx con Sxx = Σ(x − x̄)² e Sxy = Σ(x − x̄)(y − ȳ): calcola prima x̄ e ȳ."),
    gen: function(g){
      var d = regData(g), R = F.covariance(ints(d.xs), ints(d.ys)), a = R.slope, vs = g.N(a);
      var sxx = d.xs.reduce(function(s, x){ var e = rat(x).sub(R.meanX); return s.add(e.mul(e)); }, rat(0)), sxy = a.mul(sxx);
      return { params: {}, formulas: [{ text: "x : " + d.xs.join(" ; "), latex: null }, { text: "y : " + d.ys.join(" ; "), latex: null }], expected: { type: "number", value: a }, expectedText: vs, accept: { rounding: true },
               steps: ["x̄ = " + g.N(R.meanX) + " ; ȳ = " + g.N(R.meanY), "Sxx = " + g.N(sxx) + " ; Sxy = " + g.N(sxy), "a = Sxy / Sxx = " + g.N(sxy) + " / " + g.N(sxx) + " = " + vs], example: vs,
               verify: function(){ var r = F.covariance(ints(d.xs), ints(d.ys)); return !!(r && r.ok && r.slope && r.slope.eq(a)); } };
    }
  });
  def("regression-predict", {
    domain: "statistics", levels: [2], biz: [2],
    frame: L("On ajuste une droite de régression y = a·x + b sur les points (x ; y) donnés ci-dessous. Quelle valeur de y prédit-elle pour x = {x0} ?", "A regression line y = a·x + b is fitted to the points (x ; y) given below. What value of y does it predict for x = {x0}?", "Se ajusta una recta de regresión y = a·x + b a los puntos (x ; y) dados abajo. ¿Qué valor de y predice para x = {x0}?", "Eine Regressionsgerade y = a·x + b wird an die unten angegebenen Punkte (x ; y) angepasst. Welchen Wert von y sagt sie für x = {x0} voraus?", "Si adatta una retta di regressione y = a·x + b ai punti (x ; y) indicati qui sotto. Quale valore di y prevede per x = {x0}?"),
    bizFrame: L("Budget publicitaire x (en k€) et ventes y (en k€) sont donnés ci-dessous. Avec la droite de régression y = a·x + b, quelles ventes (en k€) prévois-tu pour un budget de {x0} k€ ?", "Advertising budget x (in k€) and sales y (in k€) are given below. With the regression line y = a·x + b, what sales (in k€) do you forecast for a budget of {x0} k€?", "El presupuesto publicitario x (en k€) y las ventas y (en k€) se dan abajo. Con la recta de regresión y = a·x + b, ¿qué ventas (en k€) prevés para un presupuesto de {x0} k€?", "Werbebudget x (in k€) und Umsatz y (in k€) sind unten angegeben. Welchen Umsatz (in k€) prognostizierst du mit der Regressionsgeraden y = a·x + b für ein Budget von {x0} k€?", "Budget pubblicitario x (in k€) e vendite y (in k€) sono indicati qui sotto. Con la retta di regressione y = a·x + b, quali vendite (in k€) prevedi per un budget di {x0} k€?"),
    concept: REG_CONCEPT,
    method: L("Calcule la pente a = Sxy / Sxx, puis l'ordonnée b = ȳ − a·x̄, puis remplace x par la valeur demandée.", "Compute the slope a = Sxy / Sxx, then the intercept b = ȳ − a·x̄, then substitute the requested x.", "Calcula la pendiente a = Sxy / Sxx, luego la ordenada b = ȳ − a·x̄ y sustituye x por el valor pedido.", "Berechne die Steigung a = Sxy / Sxx, dann den Achsenabschnitt b = ȳ − a·x̄ und setze den gefragten Wert für x ein.", "Calcola la pendenza a = Sxy / Sxx, poi l'intercetta b = ȳ − a·x̄ e sostituisci x con il valore richiesto."),
    gen: function(g){
      var d = regData(g), R = F.covariance(ints(d.xs), ints(d.ys)), a = R.slope, b = R.intercept, x0 = d.n + 1, val = a.mul(rat(x0)).add(b), vs = g.N(val);
      return { params: { x0: String(x0) }, formulas: [{ text: "x : " + d.xs.join(" ; "), latex: null }, { text: "y : " + d.ys.join(" ; "), latex: null }], expected: { type: "number", value: val }, unit: g.biz ? "k€" : "", expectedText: vs + (g.biz ? " k€" : ""), accept: { rounding: true },
               steps: ["a = " + g.N(a) + " ; x̄ = " + g.N(R.meanX) + " ; ȳ = " + g.N(R.meanY), "b = ȳ − a·x̄ = " + g.N(R.meanY) + " − " + g.N(a) + "·" + g.N(R.meanX) + " = " + g.N(b), "ŷ(" + x0 + ") = " + g.N(a) + "·" + x0 + " + " + par(g.N(b)) + " = " + vs], example: vs,
               verify: function(){ var r = F.covariance(ints(d.xs), ints(d.ys)); return !!(r && r.ok && r.slope && r.slope.mul(rat(x0)).add(r.intercept).eq(val)); } };
    }
  });

  /* ═══ MATRICES ═══ */
  function matFm(name, M){
    return { text: name + " = (" + M.map(function(r){ return r.join(" "); }).join(" ; ") + ")", latex: name + " = \\begin{pmatrix} " + M.map(function(r){ return r.join(" & "); }).join(" \\\\ ") + " \\end{pmatrix}" };
  }
  function randMat(g, n, lo, hi){ var M = [], i, j; for(i = 0; i < n; i++){ M.push([]); for(j = 0; j < n; j++) M[i].push(g.ri(lo, hi)); } return M; }
  function toRatMat(M){ return M.map(function(r){ return r.map(function(x){ return rat(x); }); }); }
  var DET_CONCEPT = L("Le déterminant est un nombre associé à une matrice carrée : il est nul si la matrice n'est pas inversible.", "The determinant is a number attached to a square matrix: it is zero when the matrix is not invertible.", "El determinante es un número asociado a una matriz cuadrada: es nulo si la matriz no es invertible.", "Die Determinante ist eine Zahl, die zu einer quadratischen Matrix gehört: Sie ist null, wenn die Matrix nicht invertierbar ist.", "Il determinante è un numero associato a una matrice quadrata: è nullo se la matrice non è invertibile.");
  def("matrix-det2", {
    domain: "matrices", levels: [0, 1], biz: [],
    frame: L("Calcule le déterminant de la matrice A.", "Compute the determinant of the matrix A.", "Calcula el determinante de la matriz A.", "Berechne die Determinante der Matrix A.", "Calcola il determinante della matrice A."),
    concept: DET_CONCEPT,
    method: L("Pour une matrice 2×2 (a b ; c d) : det = a·d − b·c (produit de la diagonale moins produit de l'autre diagonale).", "For a 2×2 matrix (a b ; c d): det = a·d − b·c (product of the diagonal minus product of the other diagonal).", "Para una matriz 2×2 (a b ; c d): det = a·d − b·c (producto de la diagonal menos producto de la otra diagonal).", "Für eine 2×2-Matrix (a b ; c d): det = a·d − b·c (Produkt der Diagonale minus Produkt der Nebendiagonale).", "Per una matrice 2×2 (a b ; c d): det = a·d − b·c (prodotto della diagonale meno prodotto dell'altra diagonale)."),
    gen: function(g){
      var M = randMat(g, 2, g.lvl === 0 ? 0 : -9, 9), a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1], val = rat(a * d - b * c);
      return { params: {}, formulas: [matFm("A", M)], expected: { type: "number", value: val }, expectedText: val.toString(),
               steps: ["det A = a·d − b·c", "det A = " + par(a) + "·" + par(d) + " − " + par(b) + "·" + par(c) + " = " + (a * d) + " − " + par(b * c) + " = " + val], example: val.toString(),
               verify: function(){ return F.detLaplace(toRatMat(M)).eq(val); } };
    }
  });
  def("matrix-det3", {
    domain: "matrices", levels: [2], biz: [],
    frame: L("Calcule le déterminant de la matrice A (3×3).", "Compute the determinant of the 3×3 matrix A.", "Calcula el determinante de la matriz A (3×3).", "Berechne die Determinante der 3×3-Matrix A.", "Calcola il determinante della matrice A (3×3)."),
    concept: DET_CONCEPT,
    method: L("Développe selon une ligne : det = a(ei − fh) − b(di − fg) + c(dh − eg), ou utilise la règle de Sarrus.", "Expand along a row: det = a(ei − fh) − b(di − fg) + c(dh − eg), or use Sarrus' rule.", "Desarrolla por una fila: det = a(ei − fh) − b(di − fg) + c(dh − eg), o usa la regla de Sarrus.", "Entwickle nach einer Zeile: det = a(ei − fh) − b(di − fg) + c(dh − eg), oder nutze die Regel von Sarrus.", "Sviluppa lungo una riga: det = a(ei − fh) − b(di − fg) + c(dh − eg), oppure usa la regola di Sarrus."),
    gen: function(g){
      var M = randMat(g, 3, -3, 4), a = M[0][0], b = M[0][1], c = M[0][2], d = M[1][0], e = M[1][1], f = M[1][2], gg = M[2][0], h = M[2][1], i = M[2][2];
      var m1 = e * i - f * h, m2 = d * i - f * gg, m3 = d * h - e * gg, val = rat(a * m1 - b * m2 + c * m3);
      return { params: {}, formulas: [matFm("A", M)], expected: { type: "number", value: val }, expectedText: val.toString(),
               steps: ["det A = a(ei − fh) − b(di − fg) + c(dh − eg)", "det A = " + par(a) + "·" + par(m1) + " − " + par(b) + "·" + par(m2) + " + " + par(c) + "·" + par(m3), "det A = " + val], example: val.toString(),
               verify: function(){ return F.detLaplace(toRatMat(M)).eq(val); } };
    }
  });
  def("matrix-product", {
    domain: "matrices", levels: [1, 2], biz: [1, 2],
    frame: L("On donne les matrices A et B. Calcule le coefficient situé ligne {i}, colonne {j} du produit A·B.", "Matrices A and B are given. Compute the entry in row {i}, column {j} of the product A·B.", "Se dan las matrices A y B. Calcula el coeficiente de la fila {i}, columna {j} del producto A·B.", "Gegeben sind die Matrizen A und B. Berechne den Eintrag in Zeile {i}, Spalte {j} des Produkts A·B.", "Date le matrici A e B, calcola il coefficiente alla riga {i}, colonna {j} del prodotto A·B."),
    bizFrame: L("A donne les quantités vendues (lignes : magasins, colonnes : produits) et B les prix en € (lignes : produits, colonnes : saisons). Quel est le chiffre d'affaires du magasin {i} pour la saison {j} (coefficient ligne {i}, colonne {j} de A·B) ?", "A gives quantities sold (rows: shops, columns: products) and B gives prices in € (rows: products, columns: seasons). What is the revenue of shop {i} in season {j} (entry in row {i}, column {j} of A·B)?", "A da las cantidades vendidas (filas: tiendas, columnas: productos) y B los precios en € (filas: productos, columnas: temporadas). ¿Cuál es la facturación de la tienda {i} en la temporada {j} (coeficiente fila {i}, columna {j} de A·B)?", "A gibt die verkauften Mengen an (Zeilen: Geschäfte, Spalten: Produkte) und B die Preise in € (Zeilen: Produkte, Spalten: Saisons). Wie hoch ist der Umsatz von Geschäft {i} in Saison {j} (Eintrag Zeile {i}, Spalte {j} von A·B)?", "A indica le quantità vendute (righe: negozi, colonne: prodotti) e B i prezzi in € (righe: prodotti, colonne: stagioni). Qual è il fatturato del negozio {i} nella stagione {j} (coefficiente riga {i}, colonna {j} di A·B)?"),
    concept: L("Le produit A·B combine les lignes de A avec les colonnes de B : chaque coefficient est un « produit scalaire ».", "The product A·B combines the rows of A with the columns of B: each entry is a « dot product ».", "El producto A·B combina las filas de A con las columnas de B: cada coeficiente es un « producto escalar ».", "Das Produkt A·B verbindet die Zeilen von A mit den Spalten von B: Jeder Eintrag ist ein « Skalarprodukt ».", "Il prodotto A·B combina le righe di A con le colonne di B: ogni coefficiente è un « prodotto scalare »."),
    method: L("Le coefficient (i, j) vaut a_i1·b_1j + a_i2·b_2j : multiplie la ligne i de A par la colonne j de B, terme à terme, puis additionne.", "Entry (i, j) is a_i1·b_1j + a_i2·b_2j: multiply row i of A by column j of B term by term, then add.", "El coeficiente (i, j) vale a_i1·b_1j + a_i2·b_2j: multiplica la fila i de A por la columna j de B término a término y suma.", "Der Eintrag (i, j) ist a_i1·b_1j + a_i2·b_2j: Multipliziere Zeile i von A mit Spalte j von B Term für Term und addiere.", "Il coefficiente (i, j) vale a_i1·b_1j + a_i2·b_2j: moltiplica la riga i di A per la colonna j di B termine a termine e somma."),
    gen: function(g){
      var A = randMat(g, 2, g.biz ? 5 : (g.lvl === 1 ? 0 : -4), g.biz ? 60 : 5), B = randMat(g, 2, g.biz ? 2 : (g.lvl === 1 ? 0 : -4), g.biz ? 20 : 5), i = g.ri(1, 2), j = g.ri(1, 2);
      var val = rat(A[i - 1][0] * B[0][j - 1] + A[i - 1][1] * B[1][j - 1]);
      return { params: { i: String(i), j: String(j) }, formulas: [matFm("A", A), matFm("B", B)], expected: { type: "number", value: val }, unit: g.biz ? "€" : "", expectedText: val + (g.biz ? " €" : ""),
               steps: ["(AB)" + i + j + " = a" + i + "1·b1" + j + " + a" + i + "2·b2" + j, "(AB)" + i + j + " = " + par(A[i - 1][0]) + "·" + par(B[0][j - 1]) + " + " + par(A[i - 1][1]) + "·" + par(B[1][j - 1]) + " = " + val], example: val.toString(),
               verify: function(){ var P = F.matMul(toRatMat(A), toRatMat(B)); return P[i - 1][j - 1].eq(val); } };
    }
  });

  /* ═══ MATHÉMATIQUES FINANCIÈRES ═══ */
  def("fin-percent", {
    domain: "finance", levels: [0], biz: [0],
    frame: L("Une grandeur passe de {v0} à {v1}. Quelle est sa variation en pourcentage ?", "A quantity goes from {v0} to {v1}. What is its percentage change?", "Una magnitud pasa de {v0} a {v1}. ¿Cuál es su variación porcentual?", "Eine Größe ändert sich von {v0} auf {v1}. Wie groß ist die prozentuale Veränderung?", "Una grandezza passa da {v0} a {v1}. Qual è la sua variazione percentuale?"),
    bizFrame: [L("Le PIB d'un pays passe de {v0} à {v1} milliards d'euros d'une année à l'autre. Quel est son taux de croissance (en %) ?", "A country's GDP goes from €{v0} billion to €{v1} billion from one year to the next. What is its growth rate (in %)?", "El PIB de un país pasa de {v0} a {v1} mil millones de euros de un año a otro. ¿Cuál es su tasa de crecimiento (en %)?", "Das BIP eines Landes steigt von {v0} auf {v1} Milliarden Euro von einem Jahr zum nächsten. Wie hoch ist die Wachstumsrate (in %)?", "Il PIL di un paese passa da {v0} a {v1} miliardi di euro da un anno all'altro. Qual è il tasso di crescita (in %)?"),
               L("Une action achetée {v0} € vaut {v1} € un an plus tard (sans dividende). Quel est son rendement (en %) ?", "A share bought for €{v0} is worth €{v1} a year later (no dividend). What is its return (in %)?", "Una acción comprada a {v0} € vale {v1} € un año después (sin dividendo). ¿Cuál es su rentabilidad (en %)?", "Eine für {v0} € gekaufte Aktie ist ein Jahr später {v1} € wert (ohne Dividende). Wie hoch ist die Rendite (in %)?", "Un'azione acquistata a {v0} € vale {v1} € un anno dopo (senza dividendo). Qual è il suo rendimento (in %)?")],
    concept: L("Une variation en pourcentage compare l'écart à la valeur de départ.", "A percentage change compares the difference with the starting value.", "Una variación porcentual compara la diferencia con el valor inicial.", "Eine prozentuale Veränderung vergleicht die Differenz mit dem Ausgangswert.", "Una variazione percentuale confronta la differenza con il valore di partenza."),
    method: L("Variation en % = (nouvelle valeur − ancienne valeur) / ancienne valeur × 100.", "Percentage change = (new value − old value) / old value × 100.", "Variación en % = (valor nuevo − valor antiguo) / valor antiguo × 100.", "Prozentuale Veränderung = (neuer Wert − alter Wert) / alter Wert × 100.", "Variazione in % = (nuovo valore − vecchio valore) / vecchio valore × 100."),
    gen: function(g){
      var old = g.pick([100, 200, 400, 500, 800, 1000, 2000, 2400]), pct = g.pick([-25, -20, -15, -10, -5, 2, 4, 5, 8, 10, 12, 15, 20, 25, 30, 50]), nw = old * (100 + pct) / 100;
      var variant = g.biz ? g.ri(0, 1) : 0, val = rat(pct);
      return { params: { v0: String(old), v1: String(nw) }, variant: variant, formulas: [], expected: { type: "number", value: val, percentMode: "strict" }, unit: "%", expectedText: pct + " %",
               steps: ["variation = (nouveau − ancien) / ancien × 100", "= (" + nw + " − " + old + ") / " + old + " × 100 = " + (nw - old) + "/" + old + " × 100 = " + pct + " %"], example: pct + " %",
               verify: function(){ var r = F.percentChange(rat(old), rat(nw)); return !!(r && r.ok && ratOfText(r.exact.text).eq(val)); } };
    }
  });

  def("fin-compound", {
    domain: "finance", levels: [0, 1], biz: [0, 1],
    frame: L("Un capital de {C} € est placé à {r} % par an, à intérêts composés (capitalisation annuelle), pendant {n} ans. Quelle est sa valeur finale ? (arrondie au centime si besoin)", "A capital of €{C} is invested at {r}% per year with compound interest (annual compounding) for {n} years. What is its final value? (rounded to the cent if needed)", "Un capital de {C} € se invierte al {r} % anual a interés compuesto (capitalización anual) durante {n} años. ¿Cuál es su valor final? (redondeado al céntimo si hace falta)", "Ein Kapital von {C} € wird {n} Jahre lang mit {r} % pro Jahr bei Zinseszins (jährliche Verzinsung) angelegt. Wie hoch ist der Endwert? (bei Bedarf auf den Cent gerundet)", "Un capitale di {C} € è investito al {r} % annuo a interesse composto (capitalizzazione annua) per {n} anni. Qual è il suo valore finale? (arrotondato al centesimo se serve)"),
    bizFrame: L("Un investisseur place {C} € dans un fonds qui rapporte {r} % par an, gains réinvestis. Quelle sera la valeur de son placement après {n} ans ? (arrondie au centime si besoin)", "An investor puts €{C} into a fund earning {r}% a year, gains reinvested. What will the investment be worth after {n} years? (rounded to the cent if needed)", "Un inversor coloca {C} € en un fondo que rinde un {r} % anual, con las ganancias reinvertidas. ¿Cuánto valdrá la inversión tras {n} años? (redondeado al céntimo si hace falta)", "Ein Anleger legt {C} € in einem Fonds an, der {r} % pro Jahr erwirtschaftet, Erträge werden reinvestiert. Wie viel ist die Anlage nach {n} Jahren wert? (bei Bedarf auf den Cent gerundet)", "Un investitore mette {C} € in un fondo che rende il {r} % annuo, con utili reinvestiti. Quanto varrà l'investimento dopo {n} anni? (arrotondato al centesimo se serve)"),
    concept: L("Avec des intérêts composés, les intérêts rapportent eux-mêmes des intérêts : le capital est multiplié par (1 + r) chaque année.", "With compound interest, interest earns interest itself: the capital is multiplied by (1 + r) each year.", "Con interés compuesto, los intereses generan a su vez intereses: el capital se multiplica por (1 + r) cada año.", "Bei Zinseszins bringen die Zinsen selbst Zinsen: Das Kapital wird jedes Jahr mit (1 + r) multipliziert.", "Con l'interesse composto, gli interessi producono a loro volta interessi: il capitale è moltiplicato per (1 + r) ogni anno."),
    method: L("VF = C × (1 + r)ⁿ, avec r en décimal (5 % → 0,05) et n le nombre d'années.", "FV = C × (1 + r)ⁿ, with r as a decimal (5% → 0.05) and n the number of years.", "VF = C × (1 + r)ⁿ, con r en decimal (5 % → 0,05) y n el número de años.", "Endwert = C × (1 + r)ⁿ, mit r als Dezimalzahl (5 % → 0,05) und n der Anzahl der Jahre.", "VF = C × (1 + r)ⁿ, con r in decimale (5 % → 0,05) e n il numero di anni."),
    gen: function(g){
      var C0 = g.ri(2, 20) * 500, r = g.ri(2, 8), n = g.lvl === 0 ? g.ri(2, 3) : g.ri(3, 6), growth = rat(100 + r, 100), val = rat(C0).mul(growth.pow(n)), rounded = F.roundHalfUp(val, 2), vs = g.N(rounded);
      return { params: { C: String(C0), r: String(r), n: String(n) }, formulas: [], expected: { type: "number", value: val }, unit: "€", expectedText: F.money(rounded, g.lang, "€") + (val.eq(rounded) ? "" : " (≈)"), accept: { rounding: true, money: true },
               steps: ["VF = C × (1 + r)ⁿ", "VF = " + C0 + " × " + g.N(growth) + "^" + n + " = " + C0 + " × " + g.N(growth.pow(n)) + " = " + g.N(val) + " ≈ " + vs], example: vs,
               verify: function(){ var f = F.compound(rat(C0), rat(r, 100), rat(n), 1, {}); return !!(f && f.ok && f.value && f.value.eq(val)); } };
    }
  });

  def("fin-discount", {
    domain: "finance", levels: [1, 2], biz: [1, 2],
    frame: L("Quelle est la valeur actuelle d'une somme de {FV} € reçue dans {n} an(s), avec un taux d'actualisation de {r} % ?", "What is the present value of €{FV} received in {n} year(s), with a discount rate of {r}%?", "¿Cuál es el valor actual de {FV} € recibidos dentro de {n} año(s), con una tasa de descuento del {r} %?", "Wie hoch ist der Barwert von {FV} €, die in {n} Jahr(en) eingehen, bei einem Diskontsatz von {r} %?", "Qual è il valore attuale di {FV} € ricevuti tra {n} anno/i, con un tasso di attualizzazione del {r} %?"),
    bizFrame: L("Un client doit vous payer {FV} € dans {n} an(s). Avec un taux d'actualisation de {r} %, quelle est la valeur de cette créance aujourd'hui ?", "A customer owes you €{FV} in {n} year(s). With a discount rate of {r}%, what is the value of this receivable today?", "Un cliente debe pagarte {FV} € dentro de {n} año(s). Con una tasa de descuento del {r} %, ¿cuál es hoy el valor de este crédito?", "Ein Kunde schuldet Ihnen in {n} Jahr(en) {FV} €. Welchen Wert hat diese Forderung heute bei einem Diskontsatz von {r} %?", "Un cliente deve pagarti {FV} € tra {n} anno/i. Con un tasso di attualizzazione del {r} %, qual è oggi il valore di questo credito?"),
    concept: L("Un euro demain vaut moins qu'un euro aujourd'hui : actualiser, c'est ramener une somme future à sa valeur d'aujourd'hui.", "A euro tomorrow is worth less than a euro today: discounting brings a future sum back to today's value.", "Un euro mañana vale menos que un euro hoy: actualizar es traer una suma futura a su valor de hoy.", "Ein Euro morgen ist weniger wert als ein Euro heute: Abzinsen bringt eine künftige Summe auf ihren heutigen Wert.", "Un euro domani vale meno di un euro oggi: attualizzare significa riportare una somma futura al suo valore di oggi."),
    method: L("VA = VF / (1 + r)ⁿ : divise la somme future par (1 + r) élevé à la puissance du nombre d'années.", "PV = FV / (1 + r)ⁿ: divide the future sum by (1 + r) raised to the number of years.", "VA = VF / (1 + r)ⁿ: divide la suma futura por (1 + r) elevado al número de años.", "Barwert = Endwert / (1 + r)ⁿ: Teile die künftige Summe durch (1 + r) hoch Anzahl der Jahre.", "VA = VF / (1 + r)ⁿ: dividi la somma futura per (1 + r) elevato al numero di anni."),
    gen: function(g){
      var n = g.lvl === 1 ? g.ri(1, 2) : 3, m = g.ri(1, 9), FV = n === 1 ? 110 * m : (n === 2 ? 121 * m : 1331 * m), PV = n === 3 ? 1000 * m : 100 * m, growth = rat(11, 10).pow(n);
      return { params: { FV: String(FV), n: String(n), r: "10" }, formulas: [], expected: { type: "number", value: rat(PV) }, unit: "€", expectedText: PV + " €",
               steps: ["VA = VF / (1 + r)ⁿ", "VA = " + FV + " / " + g.N(rat(11, 10)) + "^" + n + " = " + FV + " / " + g.N(growth) + " = " + PV], example: String(PV),
               verify: function(){ var r = F.discount(rat(FV), rat(10, 100), rat(n), {}); return !!(r && r.ok && r.value.eq(rat(PV))); } };
    }
  });

  def("fin-npv", {
    domain: "finance", levels: [1, 2], biz: [1, 2],
    frame: L("Un projet nécessite un investissement initial de {I} € et rapporte {flows} € à la fin des années 1, 2{three}. Avec un taux d'actualisation de 10 %, calcule sa valeur actuelle nette (VAN), en €.", "A project requires an initial investment of €{I} and returns €{flows} at the end of years 1, 2{three}. With a 10% discount rate, compute its net present value (NPV), in €.", "Un proyecto requiere una inversión inicial de {I} € y aporta {flows} € al final de los años 1, 2{three}. Con una tasa de descuento del 10 %, calcula su valor actual neto (VAN), en €.", "Ein Projekt erfordert eine Anfangsinvestition von {I} € und bringt {flows} € am Ende der Jahre 1, 2{three}. Berechne bei einem Diskontsatz von 10 % den Kapitalwert (NPV) in €.", "Un progetto richiede un investimento iniziale di {I} € e rende {flows} € alla fine degli anni 1, 2{three}. Con un tasso di attualizzazione del 10 %, calcola il valore attuale netto (VAN), in €."),
    bizFrame: L("Pour lancer un produit, une entreprise investit {I} € et prévoit des flux de trésorerie de {flows} € à la fin des années 1, 2{three}. Avec un taux d'actualisation de 10 %, calcule la VAN du projet (en €) : si elle est positive, le projet crée de la valeur.", "To launch a product, a company invests €{I} and expects cash flows of €{flows} at the end of years 1, 2{three}. With a 10% discount rate, compute the project's NPV (in €): if positive, the project creates value.", "Para lanzar un producto, una empresa invierte {I} € y prevé flujos de caja de {flows} € al final de los años 1, 2{three}. Con una tasa de descuento del 10 %, calcula el VAN del proyecto (en €): si es positivo, el proyecto crea valor.", "Zum Start eines Produkts investiert ein Unternehmen {I} € und erwartet Cashflows von {flows} € am Ende der Jahre 1, 2{three}. Berechne bei einem Diskontsatz von 10 % den Kapitalwert des Projekts (in €): Ist er positiv, schafft das Projekt Wert.", "Per lanciare un prodotto, un'azienda investe {I} € e prevede flussi di cassa di {flows} € alla fine degli anni 1, 2{three}. Con un tasso di attualizzazione del 10 %, calcola il VAN del progetto (in €): se è positivo, il progetto crea valore."),
    concept: L("La VAN additionne les flux futurs ramenés à aujourd'hui, moins l'investissement : positive, le projet est rentable au taux choisi.", "The NPV adds the future cash flows brought back to today, minus the investment: if positive, the project pays off at the chosen rate.", "El VAN suma los flujos futuros traídos a hoy, menos la inversión: si es positivo, el proyecto es rentable a la tasa elegida.", "Der Kapitalwert summiert die auf heute abgezinsten künftigen Zahlungen abzüglich der Investition: Ist er positiv, lohnt sich das Projekt beim gewählten Satz.", "Il VAN somma i flussi futuri riportati a oggi, meno l'investimento: se è positivo, il progetto è redditizio al tasso scelto."),
    method: L("VAN = −I + F₁/(1+r) + F₂/(1+r)² + … : actualise chaque flux séparément, additionne, puis retire l'investissement.", "NPV = −I + F₁/(1+r) + F₂/(1+r)² + …: discount each flow separately, add them up, then subtract the investment.", "VAN = −I + F₁/(1+r) + F₂/(1+r)² + …: actualiza cada flujo por separado, suma y resta la inversión.", "NPV = −I + F₁/(1+r) + F₂/(1+r)² + …: Zinse jede Zahlung einzeln ab, addiere und ziehe die Investition ab.", "VAN = −I + F₁/(1+r) + F₂/(1+r)² + …: attualizza ogni flusso separatamente, somma e sottrai l'investimento."),
    gen: function(g){
      var m1 = g.ri(1, 6), m2 = g.ri(1, 6), m3 = g.ri(1, 6), three = g.lvl === 2, I = g.ri(2, 18) * 50;
      var flows = [rat(110 * m1), rat(121 * m2)]; if(three) flows.push(rat(1331 * m3, 10));
      var pv = 100 * m1 + 100 * m2 + (three ? 100 * m3 : 0), val = rat(pv - I), fl = flows.map(function(x){ return g.N(x); }).join(" ; ");
      var parts = [g.N(flows[0]) + "/1,1", g.N(flows[1]) + "/1,1²"]; if(three) parts.push(g.N(flows[2]) + "/1,1³");
      return { params: { I: String(I), flows: fl, three: three ? ", 3" : "" }, formulas: [], expected: { type: "number", value: val }, unit: "€", expectedText: val + " €",
               steps: ["VAN = −I + Σ Fₜ / (1 + r)ᵗ", "VAN = −" + I + " + " + parts.join(" + "), "VAN = −" + I + " + " + (100 * m1) + " + " + (100 * m2) + (three ? " + " + (100 * m3) : "") + " = " + val], example: val.toString(),
               verify: function(){ var r = F.npv(rat(10, 100), [rat(-I)].concat(flows), {}); return !!(r && r.ok && ratOfText(r.exact.text).eq(val)); } };
    }
  });

  def("fin-cagr", {
    domain: "finance", levels: [2], biz: [2],
    frame: L("Une valeur passe de {v0} à {v1} en {n} ans. Quel est son taux de croissance annuel moyen (TCAM), en % ?", "A value goes from {v0} to {v1} in {n} years. What is its compound annual growth rate (CAGR), in %?", "Un valor pasa de {v0} a {v1} en {n} años. ¿Cuál es su tasa de crecimiento anual media (TCAM), en %?", "Ein Wert steigt in {n} Jahren von {v0} auf {v1}. Wie hoch ist die durchschnittliche jährliche Wachstumsrate (CAGR) in %?", "Un valore passa da {v0} a {v1} in {n} anni. Qual è il suo tasso di crescita annuo medio (CAGR), in %?"),
    bizFrame: [L("Le PIB d'un pays passe de {v0} à {v1} milliards d'euros en {n} ans. Quel est son taux de croissance annuel moyen (en %) ?", "A country's GDP goes from €{v0} billion to €{v1} billion in {n} years. What is its average annual growth rate (in %)?", "El PIB de un país pasa de {v0} a {v1} mil millones de euros en {n} años. ¿Cuál es su tasa de crecimiento anual media (en %)?", "Das BIP eines Landes wächst in {n} Jahren von {v0} auf {v1} Milliarden Euro. Wie hoch ist die durchschnittliche jährliche Wachstumsrate (in %)?", "Il PIL di un paese passa da {v0} a {v1} miliardi di euro in {n} anni. Qual è il suo tasso di crescita annuo medio (in %)?"),
               L("Le chiffre d'affaires d'une entreprise passe de {v0} k€ à {v1} k€ en {n} ans. Quel est son taux de croissance annuel moyen (en %) ?", "A company's revenue goes from €{v0}k to €{v1}k in {n} years. What is its average annual growth rate (in %)?", "Los ingresos de una empresa pasan de {v0} k€ a {v1} k€ en {n} años. ¿Cuál es su tasa de crecimiento anual media (en %)?", "Der Umsatz eines Unternehmens wächst in {n} Jahren von {v0} k€ auf {v1} k€. Wie hoch ist die durchschnittliche jährliche Wachstumsrate (in %)?", "Il fatturato di un'azienda passa da {v0} k€ a {v1} k€ in {n} anni. Qual è il suo tasso di crescita annuo medio (in %)?")],
    concept: L("Le TCAM est le taux constant qui, appliqué chaque année, mène de la valeur de départ à la valeur d'arrivée.", "The CAGR is the constant rate that, applied every year, takes the starting value to the final value.", "La TCAM es la tasa constante que, aplicada cada año, lleva del valor inicial al valor final.", "Die CAGR ist die konstante Rate, die, jedes Jahr angewandt, vom Anfangswert zum Endwert führt.", "Il CAGR è il tasso costante che, applicato ogni anno, porta dal valore iniziale al valore finale."),
    method: L("V₁ = V₀ × (1 + g)ⁿ, donc g = (V₁ / V₀)^(1/n) − 1 ; multiplie par 100 pour l'exprimer en %.", "V₁ = V₀ × (1 + g)ⁿ, so g = (V₁ / V₀)^(1/n) − 1; multiply by 100 to express it in %.", "V₁ = V₀ × (1 + g)ⁿ, luego g = (V₁ / V₀)^(1/n) − 1; multiplica por 100 para expresarlo en %.", "V₁ = V₀ × (1 + g)ⁿ, also g = (V₁ / V₀)^(1/n) − 1; mit 100 multiplizieren für die Angabe in %.", "V₁ = V₀ × (1 + g)ⁿ, quindi g = (V₁ / V₀)^(1/n) − 1; moltiplica per 100 per esprimerlo in %."),
    gen: function(g){
      var opt = g.pick([[10, 2, 100, 121], [10, 3, 1000, 1331], [20, 2, 100, 144], [50, 2, 400, 900], [25, 2, 400, 625]]), pct = opt[0], n = opt[1], mul = g.ri(1, 6), v0 = opt[2] * mul, v1 = opt[3] * mul, variant = g.biz ? g.ri(0, 1) : 0;
      var ratio = rat(opt[3], opt[2]);
      return { params: { v0: String(v0), v1: String(v1), n: String(n) }, variant: variant, formulas: [], expected: { type: "number", value: rat(pct), percentMode: "strict" }, unit: "%", expectedText: pct + " %",
               steps: ["TCAM = (V₁ / V₀)^(1/n) − 1", "= (" + v1 + " / " + v0 + ")^(1/" + n + ") − 1 = " + g.N(ratio) + "^(1/" + n + ") − 1 = " + g.N(rat(pct, 100)) + " = " + pct + " %"], example: pct + " %",
               verify: function(){ var r = F.cagr(rat(v0), rat(v1), rat(n), {}); return !!(r && r.ok && r.value && r.value.eq(rat(pct, 100))); } };
    }
  });

  /* ── 2. CONSTRUCTION D'UN EXERCICE ──────────────────────────────────────────── */
  function levelIndex(l){
    if(typeof l === "number") return Math.max(0, Math.min(2, l | 0));
    var i = LEVELS.indexOf(String(l)); return i < 0 ? 0 : i;
  }
  function kindsFor(domain, level, context){
    var lvl = levelIndex(level), out = [];
    Object.keys(K).forEach(function(k){
      var s = K[k];
      if(s.domain !== domain || s.levels.indexOf(lvl) < 0) return;
      if(context === "business"){ if(s.biz.indexOf(lvl) >= 0) out.push(k); }
      else if(!s.bizOnly) out.push(k);
    });
    return out;
  }
  function frameOf(spec, useBiz, variant, lang){
    var f = useBiz ? spec.bizFrame : spec.frame;
    if(Array.isArray(f)) f = f[Math.min(variant || 0, f.length - 1)];
    return pick(f, lang);
  }

  function terminates(r){ var d = r.d, two = BigInt(2), five = BigInt(5), z = BigInt(0); while(d % two === z) d = d / two; while(d % five === z) d = d / five; return d === BigInt(1); }
  /* build(kind, seed, level, context, lang) → exercice COMPLET ou { ok:false, code } — jamais un exercice non vérifié. */
  function build(kind, seed, level, context, lang){
    var spec = K[kind]; if(!spec) return { ok: false, code: "UNKNOWN_KIND" };
    lang = LANGS.indexOf(lang) >= 0 ? lang : "fr";
    var lvl = levelIndex(level); if(spec.levels.indexOf(lvl) < 0) return { ok: false, code: "LEVEL_UNSUPPORTED" };
    var useBiz = context === "business" && spec.biz.indexOf(lvl) >= 0;
    if(spec.bizOnly && !useBiz) return { ok: false, code: "CONTEXT_UNSUPPORTED" };
    var g = makeG(seed, lvl, useBiz ? "business" : "pure", lang), d;
    try{ d = spec.gen(g); }catch(e){ return { ok: false, code: "GENERATION_ERROR", message: e && e.message }; }
    var verified = false; try{ verified = !!d.verify(); }catch(e2){ verified = false; }
    if(!verified) return { ok: false, code: "NOT_VERIFIED", kind: kind, seed: seed };       // le Fast Engine n'a pas retrouvé la réponse attendue : on ne propose JAMAIS cet exercice
    var intro = fill(frameOf(spec, useBiz, d.variant, lang), d.params || {}), formulas = d.formulas || [];
    var text = intro + (formulas.length ? " " + formulas.map(function(f){ return f.text; }).join(" ; ") : "");
    var exp = d.expected;
    var accept = d.accept || {};
    if(exp.type === "number" && !terminates(exp.value)){            // décimale infinie : un arrondi (≥ 2 décimales) est une réponse légitime
      accept = { rounding: true, money: !!accept.money };
      d.example = C.fmtRatDecimal(exp.value, 4, lang, { group: false }).text;
    }
    var ex = {
      ok: true, id: kind + ":" + lvl + ":" + (useBiz ? "b" : "p") + ":" + seed, signature: kind + "|" + text, kind: kind, domain: spec.domain, topic: spec.domain, level: lvl, levelName: LEVELS[lvl],
      context: useBiz ? "business" : "pure", contextFallback: context === "business" && !useBiz, seed: seed, lang: lang, variant: d.variant || 0,
      statement: { intro: intro, formulas: formulas, text: text },
      answer: { type: exp.type, unit: d.unit || "", form: exp.form || null, percentMode: exp.percentMode || null, vars: exp.vars || null, hasUnit: !!d.unit },
      expected: exp, expectedText: d.expectedText, example: d.example, steps: d.steps || [], accept: accept, varName: d.varName || null,
      hints: [
        { level: 1, type: "concept", text: pick(spec.concept, lang) },
        { level: 2, type: "method", text: pick(spec.method, lang) },
        { level: 3, type: "start", lines: (d.steps || []).slice(0, 1) }
      ],
      verified: { engine: "fast", ok: true }
    };
    return ex;
  }

  /* generate({ domain, level, context, kind?, seed?, lang, avoid? }) : choisit un type compatible, essaie plusieurs graines. */
  function generate(o){
    o = o || {};
    var lvl = levelIndex(o.level), lang = LANGS.indexOf(o.lang) >= 0 ? o.lang : "fr", ctx = o.context === "business" ? "business" : "pure";
    var seed = (o.seed === undefined || o.seed === null) ? ((Date.now() % 1000003) + 1) : (o.seed >>> 0), avoid = o.avoid || [];
    var domain = DOMAINS.indexOf(o.domain) >= 0 ? o.domain : null;
    var rnd = rng(seed), tries = 0, ex, fallback = false;
    var cands = o.kind && K[o.kind] && K[o.kind].levels.indexOf(lvl) >= 0 ? [o.kind] : (domain ? kindsFor(domain, lvl, ctx) : []);
    if(!cands.length && ctx === "business"){ cands = domain ? kindsFor(domain, lvl, "pure") : []; fallback = true; }
    if(!cands.length && domain){                       // niveau sans exercice dans ce domaine : le niveau le plus proche
      for(var dl = 1; dl <= 2 && !cands.length; dl++){ [lvl - dl, lvl + dl].forEach(function(l2){ if(!cands.length && l2 >= 0 && l2 <= 2) cands = kindsFor(domain, l2, ctx); if(!cands.length && l2 >= 0 && l2 <= 2) cands = kindsFor(domain, l2, "pure"); if(cands.length) lvl = l2; }); }
    }
    if(!cands.length) return { ok: false, code: "NO_KIND" };
    while(tries < 16){
      var kind = cands[Math.floor(rnd() * cands.length)], sd = seed + tries * 7919;
      ex = build(kind, sd, lvl, fallback ? "pure" : ctx, lang);
      if(ex.ok && avoid.indexOf(ex.signature) < 0){ if(fallback) ex.contextFallback = true; return ex; }
      tries++;
    }
    return ex && ex.ok ? ex : { ok: false, code: "GENERATION_FAILED", last: ex && ex.code };
  }

  /* ── 3. LA RÉPONSE DE L'ÉLÈVE (MathVerifier) ──────────────────────────────────── */
  function normalizeAnswer(text){
    var s = String(text == null ? "" : text).replace(/[−–—]/g, "-").replace(/[×∙⋅]/g, "*").replace(/÷/g, "/").replace(/ | /g, " ").trim();
    s = s.replace(/\s*(?:k\s*€|€|euros?|eur|\$|dollars?)\s*$/i, "").replace(/^\s*(?:€|\$)\s*/, "").trim();
    var prev;
    do{ prev = s; s = s.replace(/(\d) (?=\d{3}(?!\d))/g, "$1"); }while(s !== prev);          // « 1 250 » → « 1250 » (milliers) ; « 1 25 » reste invalide
    return s.replace(/[.;]\s*$/, "").trim();
  }
  var LHS = /^\s*[A-Za-z](?:[A-Za-z0-9_]*)\s*(?:'|′)?\s*(?:\(\s*[A-Za-z]\s*\))?\s*=\s*/;
  function stripLhs(s){ return LHS.test(s) && !/^\s*[A-Za-z]+\s*=\s*=/.test(s) ? s.replace(LHS, "") : s; }
  function ratOfStudent(s, lang){
    try{ var p = C.parse(s, { decimalComma: lang !== "en" }); return { value: C.evalExact(p.ast, {}), percent: p.notes.indexOf("percent") >= 0 }; }catch(e){ return null; }
  }
  function decimalsIn(s){ var m = /[.,](\d+)\s*%?\s*$/.exec(s); return m ? m[1].length : 0; }

  function res(verdict, diagnosis, extra){ var r = { verdict: verdict, diagnosis: diagnosis || null, status: STATUS.VERIFIED_EXACT, method: "rationnels-exacts", counts: false, success: false }; if(extra) for(var k in extra) r[k] = extra[k]; return r; }

  function checkNumber(ex, raw){
    var exp = ex.expected, s = stripLhs(raw), lang = ex.lang;
    var sv = ratOfStudent(s, lang);
    if(!sv){
      var cr = V.compareAnswer(s, C.qnode(exp.value), { decimalComma: lang !== "en" });
      return cr.verdict === "invalid" ? res("invalid", cr.code === "STRAY_VARIABLES" ? "stray" : null, { message: cr.message, status: cr.status, method: cr.method }) : res("incorrect", "none");
    }
    var cmp = V.compareAnswer(s, C.qnode(exp.value), { decimalComma: lang !== "en" });
    if(cmp.verdict === "correct") return res("correct", null, { method: cmp.method });
    if(exp.percentMode === "either" && !sv.percent && sv.value.mul(rat(100)).eq(exp.value)) return res("correct", null);
    if(ex.accept && ex.accept.rounding){
      var d = decimalsIn(s);
      if(d >= 2 && d <= 10 && !/\//.test(s)){ var rd = F.roundHalfUp(exp.value, d); if(sv.value.eq(rd) && !sv.value.eq(exp.value)) return res("correct-rounded", null, { decimals: d }); }
      if(ex.accept.money && !/\//.test(s) && sv.value.eq(F.roundHalfUp(exp.value, 2)) && !sv.value.eq(exp.value)) return res("correct-rounded", null, { decimals: 2 });      // 8575,3 = 8575,30 (zéro final non écrit)
    }
    var diag = "none";
    if(!exp.value.isZero() && sv.value.eq(exp.value.neg())) diag = "sign";
    else if(exp.percentMode === "strict" && !sv.percent && sv.value.mul(rat(100)).eq(exp.value)) diag = "percent-unit";
    else if(exp.percentMode === "strict" && sv.percent && !sv.value.mul(rat(100)).eq(exp.value) && sv.value.eq(exp.value)) diag = "none";
    else {
      var a = sv.value.toNumber(), b = exp.value.toNumber();
      if(isFinite(a) && isFinite(b) && b !== 0 && Math.abs(a - b) / Math.abs(b) < 0.05) diag = "close";
    }
    return res("incorrect", diag);
  }

  function checkExpression(ex, raw){
    var s = stripLhs(raw), lang = ex.lang, want = ex.expected.ast;
    var cmp = V.compareAnswer(s, want, { decimalComma: lang !== "en", requireForm: ex.expected.form });
    if(cmp.verdict === "invalid" && cmp.code === "STRAY_VARIABLES"){            // la bonne expression écrite avec une autre lettre (x au lieu de q)
      try{
        var sAst = C.parse(s, { decimalComma: lang !== "en" }).ast, sv = C.freeVars(sAst), ev = C.freeVars(want);
        if(sv.length === 1 && ev.length === 1){ var re = C.substitute(sAst, sv[0], C.sym(ev[0])), q = V.equivalent(re, want, {}); if(q.equal === true) return res("correct", null, { method: q.method, status: q.status }); if(q.equal === false) return res("incorrect", "none"); }
      }catch(e){}
      return res("invalid", "stray", { message: cmp.message });
    }
    if(cmp.verdict === "invalid") return res("invalid", null, { message: cmp.message, status: cmp.status, method: cmp.method });
    if(cmp.verdict === "unsure") return res("unsure", null, { status: cmp.status, method: cmp.method });
    if(cmp.verdict === "correct-wrong-form") return res("correct-wrong-form", cmp.form || "form", { status: cmp.status, method: cmp.method });
    return res(cmp.verdict === "correct" ? "correct" : "incorrect", cmp.verdict === "correct" ? null : "none", { status: cmp.status, method: cmp.method });
  }

  var SEP = /\s*(?:;|\bou\b|\bet\b|\bor\b|\band\b|\boder\b|\bund\b|\bo\b|\by\b|\be\b)\s*/i;
  function splitItems(s, lang){
    var t = s.replace(/[{}\[\]]/g, "").trim();
    if(/^\(.*\)$/.test(t) && t.indexOf(";") < 0 && t.indexOf(",") >= 0) t = t.slice(1, -1);
    var parts = t.split(SEP).map(function(x){ return x.trim(); }).filter(Boolean);
    if(parts.length === 1){
      var byComma = t.split(/,\s+/).map(function(x){ return x.trim(); }).filter(Boolean);
      if(byComma.length > 1) parts = byComma;
      else if(lang === "en" && /,/.test(t)) parts = t.split(",").map(function(x){ return x.trim(); }).filter(Boolean);
      else if(lang !== "en" && /^[^,]+,[^,]+$/.test(t) && /^\s*-?\d+\s*,\s*-?\d+\s*$/.test(t)) parts = [t];       // « 2,3 » = 2,3 (décimal), pas {2 ; 3}
    }
    return parts;
  }
  function checkSet(ex, raw){
    var items = splitItems(raw, ex.lang), vals = [], i;
    if(!items.length) return res("invalid", null);
    for(i = 0; i < items.length; i++){
      var sv = ratOfStudent(stripLhs(items[i]), ex.lang); if(!sv) return res("invalid", null, { message: items[i] });
      vals.push(sv.value);
    }
    var want = ex.expected.values;
    if(sameSet(vals, want)) return res("correct", null);
    var inWant = vals.filter(function(v){ return want.some(function(w){ return w.eq(v); }); }), uniqIn = [];
    inWant.forEach(function(v){ if(!uniqIn.some(function(u){ return u.eq(v); })) uniqIn.push(v); });
    var diag = "none";
    if(sameSet(vals.map(function(v){ return v.neg(); }), want)) diag = "sign";
    else if(uniqIn.length && uniqIn.length < want.length && inWant.length === vals.length) diag = "partial";
    else if(uniqIn.length === want.length) diag = "extra";
    else if(uniqIn.length) diag = "some";
    return res("incorrect", diag, { matched: uniqIn.length });
  }
  function checkAssignments(ex, raw){
    var vars = ex.expected.vars, want = ex.expected.values, s = raw.replace(/[{}\[\]]/g, "").trim();
    if(/^\(.*\)$/.test(s) && s.indexOf("=") < 0) s = s.slice(1, -1);
    var items = s.split(/\s*(?:;|\bet\b|\band\b|\bund\b)\s*/i).map(function(x){ return x.trim(); }).filter(Boolean);
    if(items.length < vars.length){ var byC = s.split(/,\s+/).map(function(x){ return x.trim(); }).filter(Boolean); if(byC.length >= vars.length) items = byC; }
    if(items.length !== vars.length) return res("invalid", null);
    var got = [], labelled = items.every(function(x){ return /^[A-Za-z]\w*\s*=/.test(x); }), i;
    if(labelled){
      var map = {};
      for(i = 0; i < items.length; i++){ var m = /^([A-Za-z]\w*)\s*=\s*(.+)$/.exec(items[i]), sv = m && ratOfStudent(m[2], ex.lang); if(!sv) return res("invalid", null); map[m[1]] = sv.value; }
      for(i = 0; i < vars.length; i++){ if(!map[vars[i]]) return res("invalid", null); got.push(map[vars[i]]); }
    } else {
      for(i = 0; i < items.length; i++){ var sv2 = ratOfStudent(items[i], ex.lang); if(!sv2) return res("invalid", null); got.push(sv2.value); }
    }
    var ok = got.every(function(v, j){ return v.eq(want[j]); });
    if(ok) return res("correct", null);
    var matched = got.filter(function(v, j){ return v.eq(want[j]); }).length, diag = "none";
    if(got.length === 2 && got[0].eq(want[1]) && got[1].eq(want[0]) && !want[0].eq(want[1])) diag = "swap";
    else if(matched > 0) diag = "some";
    return res("incorrect", diag, { matched: matched });
  }

  /* check(ex, studentText) → { verdict, diagnosis, ... }
     verdict : "correct" | "correct-rounded" | "correct-wrong-form" | "incorrect" | "invalid" | "unsure" | "empty"
     « invalid » / « empty » ne comptent PAS comme un essai : l'élève n'a pas donné de réponse lisible.  */
  function check(ex, studentText){
    if(!ex || !ex.ok) return res("invalid", null);
    var raw = normalizeAnswer(studentText);
    if(!raw) return res("empty", null);
    var r;
    try{
      switch(ex.answer.type){
        case "expression": r = checkExpression(ex, raw); break;
        case "set": r = checkSet(ex, raw); break;
        case "assignments": r = checkAssignments(ex, raw); break;
        default: r = checkNumber(ex, raw);
      }
    }catch(e){ r = res("invalid", null, { message: e && e.message }); }
    r.counts = r.verdict === "incorrect" || r.verdict === "correct" || r.verdict === "correct-rounded" || r.verdict === "correct-wrong-form" || r.verdict === "unsure";
    r.success = r.verdict === "correct" || r.verdict === "correct-rounded";
    return r;
  }
  /* Clé de traduction du retour (mt.fb.*), jamais un texte en dur. */
  function fbKey(r){
    if(!r) return "invalid";
    if(r.verdict === "correct") return "correct";
    if(r.verdict === "correct-rounded") return "correct_rounded";
    if(r.verdict === "correct-wrong-form") return r.diagnosis === "not-expanded" ? "wrong_form_expanded" : "wrong_form_factored";
    if(r.verdict === "empty") return "empty";
    if(r.verdict === "invalid") return r.diagnosis === "stray" ? "invalid_stray" : "invalid";
    if(r.verdict === "unsure") return "unsure";
    switch(r.diagnosis){
      case "sign": return "incorrect_sign";
      case "percent-unit": return "incorrect_percent";
      case "close": return "incorrect_close";
      case "partial": return "incorrect_partial";
      case "extra": return "incorrect_extra";
      case "some": return "incorrect_some";
      case "swap": return "incorrect_swap";
      default: return "incorrect";
    }
  }

  /* ── 4. INDICES, MÉTHODE, SOLUTION ──────────────────────────────────────────── */
  function hint(ex, n){ return ex && ex.hints && n >= 1 && n <= ex.hints.length ? ex.hints[n - 1] : null; }
  function method(ex){
    var h = hint(ex, 2);
    return { text: h ? h.text : "", lines: (ex.steps || []).slice(0, Math.max(0, (ex.steps || []).length - 1)) };
  }
  function solution(ex){ return { answer: ex.expectedText, lines: (ex.steps || []).slice(), method: (hint(ex, 2) || {}).text || "" }; }

  /* Le bloc donné au modèle POUR EXPLIQUER (jamais pour décider) : tout vient du moteur. */
  function aiBlock(ex, studentText, verdict){
    var lines = ["MATH ENGINE RESULT (exercise generated and checked deterministically by the Fast Engine; this answer is certain, do not recompute it, only explain it):",
                 "Exercise: " + ex.statement.text,
                 "Verified answer: " + ex.expectedText];
    if(ex.steps && ex.steps.length) lines.push("Calculation steps from the engine: " + ex.steps.join(" | "));
    if(studentText !== undefined && studentText !== null && String(studentText).trim()) lines.push("Student's last answer: " + String(studentText).trim() + (verdict ? " (verdict by the verifier: " + verdict + ")" : ""));
    lines.push("Explain WHY this is the answer, in a few short lines, for a business-school student. Do not change the verified answer.");
    return lines.join("\n");
  }

  /* ── 5. SUIVI : journal d'exercices → maîtrise par thème ─────────────────────── */
  /* Une entrée = un exercice TERMINÉ (résolu, ou solution demandée) :
       { ts, topic (= domaine), kind, difficulty (0|1|2), context, attempts (réponses lisibles données), hintsUsed (0..3),
         success (résolu par l'élève), solutionShown }                                                                          */
  function record(e){
    e = e || {};
    var d = levelIndex(e.difficulty !== undefined ? e.difficulty : e.level);
    return {
      ts: isFinite(Number(e.ts)) ? Math.round(Number(e.ts)) : Date.now(),
      topic: DOMAINS.indexOf(e.topic) >= 0 ? e.topic : (K[e.kind] ? K[e.kind].domain : "algebra"),
      kind: K[e.kind] ? e.kind : String(e.kind || ""),
      difficulty: d, context: e.context === "business" ? "business" : "pure",
      attempts: Math.max(0, Math.min(99, e.attempts | 0)), hintsUsed: Math.max(0, Math.min(3, e.hintsUsed | 0)),
      success: !!e.success, solutionShown: !!e.solutionShown
    };
  }
  /* Valeur d'un exercice terminé : 1 si résolu seul ; −0,15 par indice utilisé, −0,10 par réponse fausse avant la bonne (plafonné) ;
     jamais moins de 0,3 pour un exercice RÉSOLU ; 0 si la solution a été montrée ou si l'élève a abandonné. */
  function scoreOf(e){
    if(!e.success || e.solutionShown) return 0;
    var wrong = Math.max(0, e.attempts - 1), s = 1 - 0.15 * Math.min(3, e.hintsUsed) - 0.10 * Math.min(3, wrong);
    return Math.max(0.3, Math.min(1, s));
  }
  function confidenceOf(n){ return n <= 0 ? "insufficient" : n < 3 ? "low" : n < 10 ? "moderate" : "high"; }     // mêmes seuils que smart-revision.js
  var WINDOW = 20;
  function masteryOf(list){
    var w = 0, s = 0, i;
    for(i = 0; i < list.length; i++){ var wt = LEVEL_WEIGHT[list[i].difficulty] || 1; w += wt; s += wt * scoreOf(list[i]); }
    return w ? Math.round(100 * s / w) : null;
  }
  function progress(entries){
    var list = (entries || []).map(record).sort(function(a, b){ return a.ts - b.ts; }), topics = {}, total = { exercises: list.length, success: 0, attempts: 0, hintsUsed: 0 };
    DOMAINS.forEach(function(d){ topics[d] = { topic: d, exercises: 0, success: 0, attempts: 0, hintsUsed: 0, mastery: null, confidence: "insufficient", levels: [0, 1, 2].map(function(l){ return { level: l, exercises: 0, success: 0, mastery: null }; }), last: null }; });
    var byTopic = {}; DOMAINS.forEach(function(d){ byTopic[d] = []; });
    list.forEach(function(e){
      var t = topics[e.topic]; t.exercises++; t.attempts += e.attempts; t.hintsUsed += e.hintsUsed; if(e.success) t.success++; t.last = e.ts;
      var lv = t.levels[e.difficulty]; lv.exercises++; if(e.success) lv.success++;
      byTopic[e.topic].push(e); total.attempts += e.attempts; total.hintsUsed += e.hintsUsed; if(e.success) total.success++;
    });
    DOMAINS.forEach(function(d){
      var t = topics[d], recent = byTopic[d].slice(-WINDOW);
      t.mastery = masteryOf(recent); t.confidence = confidenceOf(recent.length);
      [0, 1, 2].forEach(function(l){ var at = recent.filter(function(e){ return e.difficulty === l; }); t.levels[l].mastery = masteryOf(at); });
    });
    return { topics: topics, total: total };
  }
  /* Niveau conseillé pour un thème : monte quand le niveau actuel est maîtrisé (≥ 75 sur ≥ 3 exercices), redescend quand il est
     clairement fragile (< 40 sur ≥ 3). Sans assez de données : on ne conseille RIEN (reason "none"). */
  function suggestLevel(topicProgress, current){
    var cur = levelIndex(current), lv = topicProgress && topicProgress.levels ? topicProgress.levels[cur] : null;
    if(!lv || lv.exercises < 3 || lv.mastery === null) return { level: cur, reason: "none" };
    if(lv.mastery >= 75 && cur < 2) return { level: cur + 1, reason: "up" };
    if(lv.mastery < 40 && cur > 0) return { level: cur - 1, reason: "down" };
    return { level: cur, reason: "stay" };
  }

  /* ── 6. LA SÉANCE : le déroulé d'UN exercice (réponses, indices, méthode, solution) ───────────────────────────
     Machine à états PURE — l'interface ne fait qu'afficher son état et appeler ses méthodes. Politique :
       • une réponse illisible (« invalid », « empty ») ne compte pas comme un essai ;
       • les indices se débloquent dans l'ordre 1 → 2 → 3 (concept, méthode, début du calcul) ;
       • la méthode (démarche + étapes SAUF la dernière) vaut le dernier indice dans le suivi ;
       • la solution n'est offerte qu'après un effort (une réponse OU un indice) — jamais d'office ;
       • montrer la solution clôt l'exercice SANS le compter comme réussi.                                              */
  function session(ex){
    var S = { ex: ex, status: "open", attempts: 0, failed: 0, hintsUsed: 0, methodShown: false, solutionShown: false, last: null, startedAt: null, log: [] };
    S.canShowSolution = function(){ return S.status === "open" && (S.attempts > 0 || S.hintsUsed > 0 || S.methodShown); };
    S.actions = function(){
      if(S.status === "solved") return ["explain_ai", "another"];
      if(S.status === "revealed") return ["explain_ai", "another"];
      var a = [];
      if(S.hintsUsed < 3) a.push("hint");
      if(S.attempts > 0) a.push("retry");
      if(!S.methodShown) a.push("method");
      if(S.canShowSolution()) a.push("solution");
      return a;
    };
    S.answer = function(text){
      if(S.status !== "open") return { ok: false, code: "CLOSED" };
      var r = check(ex, text);
      if(r.counts){ S.attempts++; if(!r.success) S.failed++; }
      S.last = r; S.log.push({ type: "answer", verdict: r.verdict });
      if(r.success){ S.status = "solved"; }
      return { ok: true, result: r, key: fbKey(r), status: S.status, actions: S.actions() };
    };
    S.hint = function(){
      if(S.status !== "open") return { ok: false, code: "CLOSED" };
      if(S.hintsUsed >= 3) return { ok: false, code: "NO_MORE_HINTS", actions: S.actions() };
      S.hintsUsed++; S.log.push({ type: "hint", n: S.hintsUsed });
      return { ok: true, hint: hint(ex, S.hintsUsed), n: S.hintsUsed, left: 3 - S.hintsUsed, actions: S.actions() };
    };
    S.showMethod = function(){
      if(S.status !== "open") return { ok: false, code: "CLOSED" };
      S.methodShown = true; S.log.push({ type: "method" });
      return { ok: true, method: method(ex), actions: S.actions() };
    };
    S.showSolution = function(){
      if(!S.canShowSolution()) return { ok: false, code: S.status === "open" ? "TRY_FIRST" : "CLOSED" };
      S.solutionShown = true; S.status = "revealed"; S.log.push({ type: "solution" });
      return { ok: true, solution: solution(ex), actions: S.actions() };
    };
    /* Après une réponse juste : l'explication DÉTERMINISTE (méthode + étapes + vérification) — l'IA n'est qu'un bonus facultatif. */
    S.explanation = function(){
      if(S.status === "open") return null;
      return { method: (hint(ex, 2) || {}).text || "", concept: (hint(ex, 1) || {}).text || "", steps: ex.steps.slice(), answer: ex.expectedText, verified: ex.verified };
    };
    /* L'entrée du journal de suivi. Terminée = résolue ou solution montrée ; `abandoned` pour un exercice quitté après effort. */
    S.entry = function(ts, o){
      o = o || {};
      var done = S.status !== "open";
      if(!done && !(o.abandoned && (S.attempts > 0 || S.hintsUsed > 0 || S.methodShown))) return null;
      return record({ ts: ts, topic: ex.domain, kind: ex.kind, difficulty: ex.level, context: ex.context, attempts: S.attempts, hintsUsed: S.methodShown ? 3 : S.hintsUsed, success: S.status === "solved", solutionShown: S.solutionShown });
    };
    return S;
  }

  /* Couverture (tests) : pour chaque domaine × niveau × contexte, les types disponibles. */
  function coverage(){
    var out = {};
    DOMAINS.forEach(function(d){ out[d] = {}; [0, 1, 2].forEach(function(l){ out[d][l] = { pure: kindsFor(d, l, "pure"), business: kindsFor(d, l, "business") }; }); });
    return out;
  }
  function textsComplete(){        // chaque texte pédagogique existe dans les 5 langues
    var missing = [];
    Object.keys(K).forEach(function(k){
      var s = K[k];
      [["concept", s.concept], ["method", s.method]].forEach(function(p){ LANGS.forEach(function(l){ if(!p[1] || !p[1][l]) missing.push(k + "." + p[0] + "." + l); }); });
      [["frame", s.frame, !s.bizOnly], ["bizFrame", s.bizFrame, s.biz.length > 0]].forEach(function(p){
        if(!p[2]) return;
        var fr = Array.isArray(p[1]) ? p[1] : [p[1]];
        fr.forEach(function(f, i){ LANGS.forEach(function(l){ if(!f || !f[l]) missing.push(k + "." + p[0] + "[" + i + "]." + l); }); });
      });
    });
    return missing;
  }

  NS.tutor = {
    VERSION: VERSION, DOMAINS: DOMAINS, LEVELS: LEVELS, CONTEXTS: CONTEXTS, LANGS: LANGS, KINDS: Object.keys(K),
    kindsFor: kindsFor, build: build, generate: generate, session: session, check: check, fbKey: fbKey, hint: hint, method: method, solution: solution, aiBlock: aiBlock,
    record: record, scoreOf: scoreOf, progress: progress, suggestLevel: suggestLevel, confidenceOf: confidenceOf, levelIndex: levelIndex,
    coverage: coverage, textsComplete: textsComplete, specOf: function(k){ return K[k] ? { domain: K[k].domain, levels: K[k].levels.slice(), biz: K[k].biz.slice(), bizOnly: !!K[k].bizOnly } : null; }
  };
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this));
