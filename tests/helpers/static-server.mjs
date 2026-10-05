/* Serveur statique minimal pour les tests navigateur (types MIME corrects pour .wasm / .mjs / .py / .webmanifest). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".py": "text/x-python; charset=utf-8",
  ".zip": "application/zip", ".whl": "application/octet-stream", ".css": "text/css", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain" };
export function startStatic(root, opts) {
  opts = opts || {};
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    hits.push(url);
    if (opts.blank && url === opts.blank) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<!doctype html><meta charset=utf-8><title>blank</title><body></body>"); }
    const p = path.join(root, path.normalize(url).replace(/^(\.\.[\/\\])+/, ""));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, hits, base: "http://127.0.0.1:" + server.address().port })));
}
