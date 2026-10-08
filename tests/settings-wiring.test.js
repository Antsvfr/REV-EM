/* Non-régression statique : « Applications connectées » doit rester BRANCHÉE dans l'interface principale.
   Origine : une branche déployée a servi une interface sans la section (voir PR de réconciliation).
   Exécution : node tests/settings-wiring.test.js */
const fs = require("fs"), path = require("path");
let fail = 0;
const ok = (c, l) => { console.log((c ? "PASS" : "FAIL") + " — " + l); if(!c) fail++; };
const html = fs.readFileSync("index.html", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

/* corps de renderSettings() : de sa déclaration à la prochaine déclaration de fonction de premier niveau */
const start = html.indexOf("function renderSettings(");
const end = html.indexOf("\nfunction ", start + 10);
const body = html.slice(start, end);
ok(start > 0, "renderSettings() existe");
ok(body.includes("${renderConnectedApps()}"), "renderSettings() contient ${renderConnectedApps()}");
ok(/function renderConnectedApps\s*\(/.test(html), "renderConnectedApps() est défini");
ok(/function attachSettingsEvents\([^)]*\)\s*\{[\s\S]*?attachConnectedAppsEvents\(\)/.test(html), "attachSettingsEvents() branche attachConnectedAppsEvents()");
ok(/<script src="connected-apps\.js"><\/script>/.test(html), "index.html charge connected-apps.js");
ok(html.indexOf('<script src="connected-apps.js">') < html.indexOf("function renderConnectedApps"), "connected-apps.js est chargé avant son utilisation");
ok(/"\.\/connected-apps\.js"/.test(sw), "sw.js précache connected-apps.js");
ok(/"\.\/math-tutor\.js"/.test(sw) && /<script src="math-tutor\.js"><\/script>/.test(html), "math-tutor.js est chargé et précaché");
const missing = [...html.matchAll(/<script src="([^"?#:]+)"/g)].map(m => m[1]).filter(f => !fs.existsSync(f));
ok(missing.length === 0, "tout <script src> local existe sur disque " + missing.join(","));
const tr = fs.readFileSync("translations.js", "utf8");
ok((tr.match(/"lnk\.title"/g) || []).length === 5, "lnk.title traduit dans les 5 langues");
ok((tr.match(/"lnk\.card_desc"/g) || []).length === 5, "lnk.card_desc traduit dans les 5 langues");
ok(/const CACHE_VERSION = "rev-em-v(\d+)"/.test(sw) && +sw.match(/rev-em-v(\d+)/)[1] >= 14, "CACHE_VERSION >= v14 (invalide les anciens caches)");

/* UNE seule architecture LexNote */
ok(!fs.existsSync("integration-contract"), "pas de second contrat integration-contract/");
const migs = fs.readdirSync("supabase/migrations");
ok(migs.every((f, i, a) => !a.some((g, j) => j !== i && g.slice(0, 3) === f.slice(0, 3))), "numéros de migration uniques: " + migs.join(" "));
ok(!migs.some(f => /lexnote_links/.test(f)), "pas de migration lexnote_links concurrente");
ok(migs.includes("006_integration_links.sql") && migs.includes("007_math_practice.sql"), "chaîne 006_integration_links → 007_math_practice");
console.log(fail ? `\n${fail} ÉCHEC(S)` : "\nTout est passé.");
process.exit(fail ? 1 : 0);
