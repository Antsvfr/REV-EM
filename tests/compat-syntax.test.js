/* Compatibilité navigateurs anciens (Safari / WKWebView) : une SEULE regex avec lookbehind `(?<=` / `(?<!` suffit à rendre
   un fichier entier inexécutable avant Safari 16.4 — donc à casser l'application. Ce test balaie tous les fichiers JS
   chargés par la page (et le script de la page elle-même) et refuse tout lookbehind.
   Lancer :  node tests/compat-syntax.test.js */
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const check = (name, ok, got) => { if (ok) { pass++; console.log("PASS — " + name); } else { fail++; console.log("FAIL — " + name + (got ? "  " + JSON.stringify(got) : "")); } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = fs.readdirSync(ROOT).filter(f => /\.js$/.test(f) && !/^(sw)\.js$/.test(f) || f === "sw.js").concat(["index.html"]);
files.forEach(f => {
  const src = strip(fs.readFileSync(path.join(ROOT, f), "utf8"));
  const hits = [];
  src.split("\n").forEach((l, i) => { if (/\(\?<[=!]/.test(l)) hits.push((i + 1) + ": " + l.trim().slice(0, 100)); });
  check(f + " : aucun lookbehind regex (Safari < 16.4)", hits.length === 0, hits);
});
console.log("\n" + pass + " vérifications réussies, " + fail + " échec(s).");
process.exit(fail ? 1 : 0);
