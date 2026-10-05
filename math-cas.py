# ============================================================================
# math-cas.py — la couche Python (SymPy) du CAS de REV-EM, exécutée par Pyodide
# ----------------------------------------------------------------------------
# Chargé par math-cas-worker.js (jamais par la page). Reçoit UNE requête JSON
#   { op, ... }  dont les expressions sont des AST (voir math-core.js) et renvoie
#   UN JSON { ok, exact, latex, approx, ... } ou { ok:false, error:{code,message,status} }.
#
# SÉCURITÉ — l'utilisateur fournit une EXPRESSION MATHÉMATIQUE, jamais du code :
#   * aucun sympify / parse_expr / eval / exec / __import__ sur une donnée utilisateur ;
#   * l'AST (déjà validé par le parseur JS à liste blanche) est converti par `build()`,
#     une table de construction fermée : seuls les nœuds et les fonctions listés existent ;
#   * garde-fous : nombre de nœuds, taille des entiers, exposants, factorielles.
# Le temps de calcul est borné PAR LE WORKER (terminate) : SymPy n'est pas interruptible.
# ============================================================================
import json
import re
import time

import sympy as sp
from sympy import (Symbol, Rational, Integer, Float, Eq, Matrix, pi, E, I, oo, S)

MAX_NODES = 600
MAX_INT_DIGITS = 6000
MAX_EXP = 10000
MAX_FACT = 5000


class CasError(Exception):
    def __init__(self, code, message, status="UNSUPPORTED"):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.status = status


def _count(n):
    c = 1
    t = n.get("t")
    if t in ("neg", "fact"):
        c += _count(n["a"])
    elif t in ("bin", "eq"):
        c += _count(n["l"]) + _count(n["r"])
    elif t == "call":
        for a in n["args"]:
            c += _count(a)
    elif t == "mat":
        for r in n["rows"]:
            for a in r:
                c += _count(a)
    return c


_SYMS = {}


def _sym(name, real):
    key = (name, real)
    if key not in _SYMS:
        _SYMS[key] = Symbol(name, real=True) if real else Symbol(name)
    return _SYMS[key]


def _big(x):
    return x.is_Integer and len(str(abs(int(x)))) > MAX_INT_DIGITS


def build(n, real):
    """AST (dict) -> objet SymPy. Table de construction FERMÉE."""
    t = n["t"]
    if t == "q":
        num, den = int(n["n"]), int(n["d"])
        if len(str(abs(num))) > MAX_INT_DIGITS or len(str(den)) > MAX_INT_DIGITS:
            raise CasError("TOO_COMPLEX", "nombre trop volumineux")
        return Rational(num, den)
    if t == "sym":
        return _sym(n["name"], real)
    if t == "const":
        name = n["name"]
        if name == "pi":
            return pi
        if name == "e":
            return E
        if name == "i":
            return I
        if name == "oo":
            return oo
        raise CasError("INVALID_INPUT", "constante inconnue", "INVALID_INPUT")
    if t == "neg":
        return -build(n["a"], real)
    if t == "fact":
        a = build(n["a"], real)
        if a.is_Integer and int(a) > MAX_FACT:
            raise CasError("TOO_COMPLEX", "factorielle trop grande")
        return sp.factorial(a)
    if t == "bin":
        l, r = build(n["l"], real), build(n["r"], real)
        op = n["op"]
        if op == "+":
            return l + r
        if op == "-":
            return l - r
        if op == "*":
            return l * r
        if op == "/":
            if r == 0:
                raise CasError("DIV_ZERO", "division par zéro", "INVALID_INPUT")
            return l / r
        if op == "^":
            if r.is_Integer and abs(int(r)) > MAX_EXP:
                raise CasError("TOO_COMPLEX", "exposant trop grand")
            if r.is_Rational and not r.is_Integer and r.q > 64:
                raise CasError("TOO_COMPLEX", "racine d'indice trop grand")
            return sp.Pow(l, r)
        raise CasError("INVALID_INPUT", "opérateur inconnu", "INVALID_INPUT")
    if t == "call":
        fn = n["fn"]
        a = [build(x, real) for x in n["args"]]
        if fn == "sqrt":
            return sp.sqrt(a[0])
        if fn == "cbrt":
            return sp.cbrt(a[0])
        if fn == "root":
            return sp.root(a[0], a[1])
        if fn == "abs":
            return sp.Abs(a[0])
        if fn == "exp":
            return sp.exp(a[0])
        if fn == "ln":
            return sp.log(a[0])
        if fn == "log":
            return sp.log(a[0], a[1]) if len(a) == 2 else sp.log(a[0], 10)
        if fn == "log10":
            return sp.log(a[0], 10)
        if fn == "log2":
            return sp.log(a[0], 2)
        simple = {"sin": sp.sin, "cos": sp.cos, "tan": sp.tan, "asin": sp.asin, "acos": sp.acos, "atan": sp.atan,
                  "sinh": sp.sinh, "cosh": sp.cosh, "tanh": sp.tanh, "floor": sp.floor, "ceil": sp.ceiling}
        if fn in simple:
            return simple[fn](a[0])
        if fn == "fact":
            if a[0].is_Integer and int(a[0]) > MAX_FACT:
                raise CasError("TOO_COMPLEX", "factorielle trop grande")
            return sp.factorial(a[0])
        if fn == "binom":
            if a[0].is_Integer and int(a[0]) > MAX_FACT:
                raise CasError("TOO_COMPLEX", "coefficient binomial trop grand")
            return sp.binomial(a[0], a[1])
        if fn == "mod":
            return sp.Mod(a[0], a[1])
        if fn == "gcd":
            return sp.gcd(a[0], a[1])
        if fn == "lcm":
            return sp.lcm(a[0], a[1])
        raise CasError("UNSUPPORTED", "fonction non supportée : " + fn)
    if t == "eq":
        return Eq(build(n["l"], real), build(n["r"], real))
    if t == "mat":
        return Matrix([[build(c, real) for c in row] for row in n["rows"]])
    raise CasError("INVALID_INPUT", "nœud inconnu : " + str(t), "INVALID_INPUT")


# ── sérialisation dans la grammaire de math-core.js ───────────────────────────
_BAD = (sp.Integral, sp.Limit, sp.Derivative, sp.Piecewise, sp.ConditionSet, sp.AccumBounds, sp.Sum, sp.Product)


def _check_evaluated(e):
    if isinstance(e, (sp.Basic,)):
        if e.has(sp.zoo) or e.has(sp.nan):
            raise CasError("UNEVALUATED", "résultat indéfini (infini complexe ou indéterminé)")
        for b in _BAD:
            if e.has(b):
                raise CasError("UNEVALUATED", "le CAS n'a pas pu évaluer ce problème (résultat non résolu)")
        if e.has(sp.CRootOf):
            raise CasError("ROOTOF", "racines données sous forme implicite")


_SUBS = [(r"\*\*", "^"), (r"\blog\(", "ln("), (r"\bAbs\(", "abs("), (r"\bE\b", "e"), (r"\bI\b", "i"),
         (r"\bfactorial\(", "fact("), (r"\bbinomial\(", "binom("), (r"\bceiling\(", "ceil("), (r"\bMod\(", "mod(")]


def to_text(e):
    s = sp.sstr(e)
    for pat, rep in _SUBS:
        s = re.sub(pat, rep, s)
    return s


def to_latex(e):
    try:
        return sp.latex(e, ln_notation=True)
    except Exception:
        return ""


def approx_of(e, digits=15):
    try:
        if e.free_symbols:
            return None, None
        v = sp.N(e, digits + 5)
        if v.is_real is False:
            return str(sp.N(e, digits)), None
        f = float(v)
        return sp.sstr(sp.N(e, digits)), f
    except Exception:
        return None, None


def num_float(e):
    try:
        if e.free_symbols:
            return None
        v = sp.N(e, 25)
        if v.is_real:
            return float(v)
    except Exception:
        pass
    return None


# ── opérations ────────────────────────────────────────────────────────────────
def op_simple(kind, req):
    e = build(req["expr"], True)
    if kind == "factor":
        r = sp.factor(e)
    elif kind == "expand":
        r = sp.expand(e)
    elif kind == "simplify":
        r = sp.simplify(e)
    else:  # evaluate
        r = sp.simplify(e)
    _check_evaluated(r)
    a, av = approx_of(r)
    return {"ok": True, "exact": to_text(r), "latex": to_latex(r), "approx": a if not r.is_Rational else None, "approxValue": av}


def _cplx(s):
    v = sp.N(s, 20)
    re_, im_ = v.as_real_imag()
    return float(re_), float(im_)


def _approx_text(re_, im_):
    r = "{:.10g}".format(re_)
    if abs(im_) < 1e-12:
        return r
    return (r + " " if abs(re_) >= 1e-12 else "") + ("+ " if im_ > 0 else "- ") + "{:.10g}".format(abs(im_)) + " i"


def _family_parts(rset, var):
    """Famille infinie (ImageSet sur ℤ) → (texte, latex, échantillons réels). None si autre forme."""
    items = list(rset.args) if isinstance(rset, sp.Union) else [rset]
    texts, lat, samples = [], [], []
    for it in items:
        if not isinstance(it, sp.ImageSet) or it.base_set != S.Integers:
            return None
        lam = it.lamda
        n = lam.variables[0]
        k = sp.Symbol("n")
        expr = lam.expr.subs(n, k)
        texts.append(var + " = " + to_text(expr) + " (n ∈ ℤ)")
        lat.append(var + " = " + to_latex(expr) + "\\;(n \\in \\mathbb{Z})")
        for kv in range(-2, 3):
            f = num_float(lam.expr.subs(n, kv))
            if f is not None:
                samples.append(f)
    return " ; ".join(texts), ",\\; ".join(lat), samples


def op_solve(req):
    eq = build(req["eq"], False)
    x = _sym(req["var"], False)
    expr = eq.lhs - eq.rhs
    notes = []
    try:
        cset = sp.solveset(expr, x, domain=S.Complexes)
    except Exception:
        # valeur absolue / fonctions non inversibles dans ℂ : on résout dans les réels, et on le dit
        eq = build(req["eq"], True)
        x = _sym(req["var"], True)
        expr = eq.lhs - eq.rhs
        cset = sp.solveset(expr, x, domain=S.Reals)
        notes.append("real-solutions-only")
    if not isinstance(cset, sp.FiniteSet) and cset != S.EmptySet:
        # équation transcendante : l'ensemble complexe est une famille infinie ; on donne le domaine RÉEL
        rset = sp.solveset(expr, x, domain=S.Reals)
        if isinstance(rset, sp.ConditionSet):
            raise CasError("UNSOLVED", "le CAS n'a pas trouvé de solution exacte pour cette équation")
        if isinstance(rset, sp.FiniteSet) or rset == S.EmptySet:
            cset = rset
            notes.append("real-solutions-only")
        else:
            fam = _family_parts(rset, req["var"])
            if fam is None:
                raise CasError("UNSOLVED", "ensemble de solutions trop complexe pour être présenté")
            text, latex, samples = fam
            sols = [{"str": None, "latex": None, "real": True, "value": v, "selfcheck": None, "approxOnly": True, "sample": True} for v in samples]
            return {"ok": True, "exact": text, "latex": latex, "solutions": sols, "kind": "family", "setLatex": latex,
                    "notes": ["infinite-family", "real-solutions-only"]}
    if cset == S.EmptySet:
        return {"ok": True, "exact": "aucune solution", "latex": "\\varnothing", "solutions": [], "kind": "none", "notes": notes}
    sols = []
    for sv in cset.args:
        if sv.has(sp.CRootOf):
            re_, im_ = _cplx(sv)
            real = abs(im_) < 1e-12
            sols.append({"str": None, "latex": None, "real": real, "value": re_ if real else None, "re": re_, "im": im_, "selfcheck": None, "approxOnly": True})
            continue
        real = sv.is_real is True
        val = num_float(sv) if real else None
        selfcheck = None
        try:
            r = sp.simplify(expr.subs(x, sv))
            selfcheck = True if r == 0 else (False if r.is_number and r != 0 else None)
        except Exception:
            selfcheck = None
        sols.append({"str": to_text(sv), "latex": to_latex(sv), "real": real, "value": val, "selfcheck": selfcheck, "approxOnly": False})
    sols.sort(key=lambda d: (0 if d["real"] else 1, d["value"] if d["value"] is not None else d.get("re", 0)))
    parts, latex_parts = [], []
    for d in sols:
        if d["approxOnly"]:
            t = _approx_text(d.get("re", d["value"]), d.get("im", 0.0))
            parts.append(req["var"] + " ≈ " + t)
            latex_parts.append(req["var"] + " \\approx " + t.replace(" i", "\\,i"))
        else:
            parts.append(req["var"] + " = " + d["str"])
            latex_parts.append(req["var"] + " = " + d["latex"])
    if any(d["approxOnly"] for d in sols):
        notes.append("approximate-roots")
    if not any(d["real"] for d in sols):
        notes.append("no-real-solution")
    if any(not d["real"] for d in sols):
        notes.append("complex-solutions")
    return {"ok": True, "exact": " ; ".join(parts), "latex": ",\\; ".join(latex_parts), "solutions": sols, "kind": "points", "notes": notes}


def op_system(req):
    eqs = [build(e, False) for e in req["eqs"]]
    syms = sorted(set().union(*[e.free_symbols for e in eqs]), key=lambda s: s.name)
    if not syms:
        raise CasError("INVALID_INPUT", "aucune inconnue", "INVALID_INPUT")
    res = sp.solve(eqs, syms, dict=True)
    if not res:
        return {"ok": True, "exact": "aucune solution (système incompatible)", "latex": "\\varnothing", "solutionKind": "none"}
    if len(res) > 1:
        parts = []
        for r in res:
            parts.append(" , ".join(k.name + " = " + to_text(v) for k, v in sorted(r.items(), key=lambda kv: kv[0].name)))
        return {"ok": True, "exact": " | ".join(parts), "latex": "", "solutionKind": "several", "solutions": []}
    r = res[0]
    free = [s for s in syms if s not in r]
    text = " ; ".join(k.name + " = " + to_text(v) for k, v in sorted(r.items(), key=lambda kv: kv[0].name))
    latex = ",\\; ".join(k.name + " = " + to_latex(v) for k, v in sorted(r.items(), key=lambda kv: kv[0].name))
    out = {"ok": True, "exact": text, "latex": latex, "solutionKind": "infinite" if free else "unique"}
    if free:
        out["notes"] = ["infinite-solutions"]
        out["exact"] = text + " (" + ", ".join(s.name for s in free) + " libre(s))"
    else:
        vals = {k.name: num_float(v) for k, v in r.items()}
        if all(v is not None for v in vals.values()):
            out["solution"] = vals
    return out


def op_diff(req):
    e = build(req["expr"], True)
    x = _sym(req["var"], True)
    r = sp.diff(e, x, int(req.get("order", 1)))
    _check_evaluated(r)
    return {"ok": True, "exact": to_text(r), "latex": to_latex(r), "approx": None}


def op_integrate(req):
    e = build(req["expr"], True)
    x = _sym(req["var"], True)
    b = req.get("bounds")
    if not b:
        r = sp.integrate(e, x)
        _check_evaluated(r)
        notes = ["constant-of-integration"]
        if r.has(sp.log):
            notes.append("log-domain")
        return {"ok": True, "exact": to_text(r) + " + C", "latex": to_latex(r) + " + C", "notes": notes, "exactNoConst": to_text(r)}
    lo, hi = build(b[0], True), build(b[1], True)
    r = sp.integrate(e, (x, lo, hi))
    if r.has(sp.Piecewise):
        raise CasError("UNEVALUATED", "résultat conditionnel : convergence à préciser")
    _check_evaluated(r) if r not in (oo, -oo) else None
    if r in (oo, -oo):
        return {"ok": True, "exact": to_text(r), "latex": to_latex(r), "numeric": None, "notes": ["divergent"]}
    a, av = approx_of(r)
    return {"ok": True, "exact": to_text(r), "latex": to_latex(r), "approx": a if not r.is_Rational else None, "approxValue": av, "numeric": av}


def _disp(r):
    return {oo: "+∞", -oo: "-∞"}.get(r, None) or to_text(r)


def _limit_one(e, x, pt, d):
    r = sp.limit(e, x, pt, d)
    if r.has(sp.Limit) or r.has(sp.AccumBounds) or r.has(sp.nan):
        raise CasError("UNEVALUATED", "limite non résolue par le CAS")
    return r


def _lim_kind(r):
    if r == oo:
        return {"kind": "oo"}
    if r == -oo:
        return {"kind": "-oo"}
    if r == sp.zoo:
        return {"kind": "none"}
    f = num_float(r)
    return {"kind": "finite", "value": f}


def op_limit(req):
    e = build(req["expr"], True)
    x = _sym(req["var"], True)
    p = req["point"]
    side = req.get("side")
    if p == "oo" or p == "-oo":
        pt = oo if p == "oo" else -oo
        r = _limit_one(e, x, pt, "+" if p == "oo" else "-")
        lim = _lim_kind(r)
        return {"ok": True, "exact": _disp(r), "latex": to_latex(r), "limit": lim, "approx": approx_of(r)[0] if lim["kind"] == "finite" and not r.is_Rational else None}
    pt = build(p, True)
    if side in ("+", "-"):
        r = _limit_one(e, x, pt, side)
        lim = _lim_kind(r)
        return {"ok": True, "exact": _disp(r), "latex": to_latex(r), "limit": lim, "approx": approx_of(r)[0] if lim["kind"] == "finite" and not r.is_Rational else None}
    rp = _limit_one(e, x, pt, "+")
    rm = _limit_one(e, x, pt, "-")
    if sp.simplify(rp - rm) == 0 if (rp.is_number and rm.is_number and rp.is_finite and rm.is_finite) else rp == rm:
        lim = _lim_kind(rp)
        return {"ok": True, "exact": _disp(rp), "latex": to_latex(rp), "limit": lim, "approx": approx_of(rp)[0] if lim["kind"] == "finite" and not rp.is_Rational else None}
    txt = "n'existe pas : limite à droite = " + _disp(rp) + ", limite à gauche = " + _disp(rm)
    return {"ok": True, "exact": txt, "latex": "\\text{n'existe pas}", "limit": {"kind": "none", "sides": {"+": _lim_kind(rp), "-": _lim_kind(rm)}}, "notes": ["one-sided-limits-differ"]}


def _mat_text(M):
    return "[" + "; ".join(", ".join(to_text(c) for c in M.row(i)) for i in range(M.rows)) + "]"


def _mat_floats(M):
    try:
        return [[float(sp.N(c, 20)) for c in M.row(i)] for i in range(M.rows)]
    except Exception:
        return None


def op_matrix(req):
    fn = req["fn"]
    A = build(req["A"], False)
    B = build(req["B"], False) if req.get("B") else None
    if fn == "transpose":
        R = A.T
        return {"ok": True, "exact": _mat_text(R), "latex": to_latex(R)}
    if fn == "add":
        R = A + B
        return {"ok": True, "exact": _mat_text(R), "latex": to_latex(R)}
    if fn == "mul":
        R = A * B
        return {"ok": True, "exact": _mat_text(R), "latex": to_latex(R)}
    if fn == "rank":
        return {"ok": True, "exact": str(A.rank()), "latex": str(A.rank())}
    if fn == "det":
        d = sp.simplify(A.det())
        a, av = approx_of(d)
        return {"ok": True, "exact": to_text(d), "latex": to_latex(d), "approx": a if not d.is_Rational else None}
    if fn == "inverse":
        try:
            R = A.inv()
        except Exception:
            return {"ok": True, "exact": "non inversible (déterminant 0)", "latex": "\\text{non inversible}", "notes": ["singular"]}
        return {"ok": True, "exact": _mat_text(R), "latex": to_latex(R), "matrix": _mat_floats(R), "matrixA": _mat_floats(A)}
    if fn == "eigen":
        ev = A.eigenvals()
        out = []
        for val, mult in ev.items():
            if val.has(sp.CRootOf):
                raise CasError("ROOTOF", "valeurs propres sous forme implicite")
            ok = None
            try:
                ok = sp.simplify((A - val * sp.eye(A.rows)).det()) == 0
            except Exception:
                ok = None
            out.append({"str": to_text(val), "latex": to_latex(val), "mult": int(mult), "selfcheck": ok})
        out.sort(key=lambda d: (num_float(sp.sympify(0)) or 0))
        text = " ; ".join("λ = " + d["str"] + (" (×" + str(d["mult"]) + ")" if d["mult"] > 1 else "") for d in out)
        latex = ",\\; ".join("\\lambda = " + d["latex"] for d in out)
        return {"ok": True, "exact": text, "latex": latex, "eigenvalues": out}
    if fn == "eigenvects":
        evs = A.eigenvects()
        parts = []
        for val, mult, vecs in evs:
            for v in vecs:
                parts.append("λ = " + to_text(val) + " : " + _mat_text(v.T))
        return {"ok": True, "exact": " ; ".join(parts), "latex": ""}
    raise CasError("UNSUPPORTED", "opération matricielle inconnue : " + str(fn))


_OPS = {
    "simplify": lambda r: op_simple("simplify", r), "factor": lambda r: op_simple("factor", r), "expand": lambda r: op_simple("expand", r),
    "evaluate": lambda r: op_simple("evaluate", r), "solve": op_solve, "system": op_system, "diff": op_diff,
    "integrate": op_integrate, "limit": op_limit, "matrix": op_matrix,
}


def run_request(json_text):
    t0 = time.time()
    try:
        req = json.loads(json_text)
        op = req.get("op")
        if op not in _OPS:
            raise CasError("UNSUPPORTED", "opération inconnue", "UNSUPPORTED")
        # garde-fou de taille, AVANT toute construction
        total = 0
        for k in ("expr", "eq", "A", "B"):
            if req.get(k):
                total += _count(req[k])
        for k in ("eqs",):
            for e in req.get(k) or []:
                total += _count(e)
        if total > MAX_NODES:
            raise CasError("TOO_COMPLEX", "expression trop complexe pour le moteur avancé")
        out = _OPS[op](req)
        out["timeMs"] = int((time.time() - t0) * 1000)
        return json.dumps(out)
    except CasError as ce:
        return json.dumps({"ok": False, "error": {"code": ce.code, "message": ce.message, "status": ce.status}, "timeMs": int((time.time() - t0) * 1000)})
    except RecursionError:
        return json.dumps({"ok": False, "error": {"code": "TOO_COMPLEX", "message": "calcul trop profond", "status": "UNSUPPORTED"}})
    except Exception as ex:  # SymPy peut lever des erreurs variées : jamais de résultat inventé
        msg = str(ex)
        return json.dumps({"ok": False, "error": {"code": "CAS_ERROR", "message": (msg[:200] or type(ex).__name__), "status": "UNSUPPORTED"}, "timeMs": int((time.time() - t0) * 1000)})
