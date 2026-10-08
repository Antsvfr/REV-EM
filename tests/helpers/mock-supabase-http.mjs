/* ============================================================================
   Backend Supabase SIMULÉ AU NIVEAU HTTP — pour faire tourner le VRAI SDK
   ----------------------------------------------------------------------------
   Les autres suites remplacent `window.supabase` par un double en mémoire, ce
   qui ne prouve rien sur le comportement du vrai SDK (événements d'auth,
   session persistée, sérialisation PostgREST, en-têtes). Ici c'est le SDK
   officiel, tel que le charge le site, qui parle HTTP ; seul le SERVEUR est
   simulé, en interceptant les requêtes du navigateur (Playwright `route`).

   Ce qui est reproduit :
     • GoTrue : connexion e-mail/mot de passe, rafraîchissement, /user,
       déconnexion. Les jetons sont des JWT-formés (non signés) dont le `sub`
       est l'identifiant du compte.
     • PostgREST : select (eq/in/order), upsert (on_conflict, return=
       representation), delete filtré, objet unique (maybeSingle).
     • RLS : chaque ligne porte `user_id` ; une lecture ne renvoie QUE les
       lignes de `sub`, une écriture dont `user_id` ≠ `sub` est refusée (403,
       code 42501) — jamais de confiance dans le `user_id` envoyé.

   Ce qui n'est PAS reproduit : les contraintes SQL (types, FK, CHECK), les
   triggers, les vraies policies — voir tests/user-data.test.mjs, qui les
   exerce contre un vrai PostgreSQL. Ce backend n'est PAS un vrai Supabase :
   voir le rapport (NOT TESTED contre une vraie instance).
   ========================================================================== */

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const HOST = "otlkvlmzakklhugvaxeg.supabase.co";

export function createMockSupabase() {
  const users = {};                 // email -> { id, email, password }
  const tables = {};                // nom -> lignes
  const log = [];                   // { method, path, table, status }
  let seq = 1;
  let netDown = false;              // simule une panne réseau (les requêtes échouent)
  let latencyMs = 0;                // latence ajoutée à chaque requête REST (test « rechargement pendant l'hydratation »)
  let failTables = new Set();       // tables dont les lectures/écritures renvoient 500

  const CONFLICT = {
    subjects: ["user_id", "local_id"], chapters: ["user_id", "local_id"],
    documents: ["user_id", "local_id"], planning_events: ["user_id", "local_id"],
    progress: ["user_id", "kind", "scope"], question_stats: ["user_id", "question_uid"],
    exam_history: ["user_id", "taken_at"], badges: ["user_id", "badge_id"],
    ai_cards: ["user_id", "builtin_chapter_id"], course_notes: ["user_id", "event_id"],
    ai_history: ["user_id"], preferences: ["user_id"], study_plans: ["user_id"],
    user_stats: ["user_id"], daily_stats: ["user_id", "day"],
    activities: ["user_id", "ts"], chapter_visits: ["user_id", "chapter_key"], math_practice: ["user_id", "ts"],
    profiles: ["id"],
  };
  const rowsOf = (t) => (tables[t] = tables[t] || []);
  const uuid = () => "00000000-0000-4000-8000-" + String(seq++).padStart(12, "0");

  function tokenFor(user) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp: now + 3600, iat: now };
    return b64({ alg: "HS256", typ: "JWT" }) + "." + b64(payload) + ".sig";
  }
  function sessionFor(user) {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: tokenFor(user), token_type: "bearer", expires_in: 3600, expires_at: now + 3600,
      refresh_token: "rt-" + user.id + "-" + seq++,
      user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email,
              email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {},
              created_at: new Date().toISOString() },
    };
  }
  function subOf(req) {
    const auth = req.headers()["authorization"] || "";
    const m = auth.match(/^Bearer\s+[^.]+\.([^.]+)\./);
    if (!m) return null;
    try { return JSON.parse(Buffer.from(m[1], "base64url").toString()).sub || null; } catch (e) { return null; }
  }

  function parseFilters(url) {
    const filters = [];
    for (const [k, v] of url.searchParams.entries()) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
      const i = v.indexOf(".");
      const op = v.slice(0, i), val = v.slice(i + 1);
      if (op === "eq") filters.push((r) => String(r[k]) === val);
      else if (op === "in") {
        const list = val.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, ""));
        filters.push((r) => list.includes(String(r[k])));
      } else if (op === "neq") filters.push((r) => String(r[k]) !== val);
    }
    return (r) => filters.every((f) => f(r));
  }

  const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
  const json = (route, status, body, headers) =>
    route.fulfill({ status, contentType: "application/json", headers: Object.assign({}, CORS, headers || {}), body: JSON.stringify(body) });

  async function handleRest(route, req, url) {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    const table = url.pathname.replace("/rest/v1/", "");
    const sub = subOf(req);
    const method = req.method();
    const entry = { method, path: url.pathname, table, status: 0 };
    log.push(entry);
    const done = (status, body, headers) => { entry.status = status; return json(route, status, body, headers); };

    if (failTables.has(table)) return done(500, { code: "XX000", message: "panne simulée sur " + table });
    if (!sub) return done(401, { code: "PGRST301", message: "JWT manquant" });
    const prefer = req.headers()["prefer"] || "";
    const wantsObject = /vnd\.pgrst\.object/.test(req.headers()["accept"] || "");
    const isProfiles = table === "profiles";
    const ownerCol = isProfiles ? "id" : "user_id";

    if (method === "GET" || method === "HEAD") {
      const match = parseFilters(url);
      const out = rowsOf(table).filter((r) => r[ownerCol] === sub && match(r)).map((r) => JSON.parse(JSON.stringify(r)));
      if (wantsObject) {
        if (out.length !== 1) return done(406, { code: "PGRST116", message: "0 ou plusieurs lignes", details: `${out.length} lignes` });
        return done(200, out[0]);
      }
      return done(200, out, { "content-range": out.length ? `0-${out.length - 1}/${out.length}` : "*/0" });
    }

    if (method === "POST" || method === "PATCH") {
      let body = []; try { body = JSON.parse(req.postData() || "[]"); } catch (e) {}
      const list = Array.isArray(body) ? body : [body];
      for (const row of list) {
        if (String(row[ownerCol]) !== sub) {
          return done(403, { code: "42501", message: 'new row violates row-level security policy for table "' + table + '"' });
        }
      }
      const keys = (url.searchParams.get("on_conflict") || "").split(",").filter(Boolean);
      const conflictCols = keys.length ? keys : (CONFLICT[table] || ["id"]);
      const out = [];
      for (const row of list) {
        const rows = rowsOf(table);
        const same = (r) => conflictCols.every((c) => String(r[c]) === String(row[c]));
        const i = rows.findIndex(same);
        const now = new Date().toISOString();
        if (i >= 0 && /merge-duplicates|ignore-duplicates/.test(prefer) || i >= 0 && method === "PATCH") {
          rows[i] = Object.assign({}, rows[i], row, { updated_at: now });
          out.push(rows[i]);
        } else if (i >= 0) {
          return done(409, { code: "23505", message: "doublon sur " + table });
        } else {
          const created = Object.assign({ id: uuid(), created_at: now, updated_at: now }, row);
          rows.push(created); out.push(created);
        }
      }
      if (/return=representation/.test(prefer)) return done(201, out.map((r) => JSON.parse(JSON.stringify(r))));
      entry.status = 201; return route.fulfill({ status: 201, headers: CORS, body: "" });
    }

    if (method === "DELETE") {
      const match = parseFilters(url);
      const before = rowsOf(table).length;
      tables[table] = rowsOf(table).filter((r) => !(r[ownerCol] === sub && match(r)));
      entry.deleted = before - tables[table].length;
      entry.status = 204;
      return route.fulfill({ status: 204, headers: CORS, body: "" });
    }
    return done(405, { message: "méthode non gérée" });
  }

  async function handleAuth(route, req, url) {
    const path = url.pathname.replace("/auth/v1", "");
    const method = req.method();
    log.push({ method, path: url.pathname, table: "@auth", status: 200 });
    const cors = { "access-control-allow-origin": "*" };
    if (path === "/token") {
      const grant = url.searchParams.get("grant_type");
      let body = {}; try { body = JSON.parse(req.postData() || "{}"); } catch (e) {}
      if (grant === "password") {
        const u = users[String(body.email || "").toLowerCase()];
        if (!u || u.password !== body.password) return json(route, 400, { code: "invalid_credentials", error_description: "Invalid login credentials", message: "Invalid login credentials" }, cors);
        return json(route, 200, sessionFor(u), cors);
      }
      if (grant === "refresh_token") {
        const m = String(body.refresh_token || "").match(/^rt-([0-9a-f-]+)-/);
        const u = m && Object.values(users).find((x) => x.id === m[1]);
        if (!u) return json(route, 400, { code: "refresh_token_not_found", message: "Invalid Refresh Token" }, cors);
        return json(route, 200, sessionFor(u), cors);
      }
    }
    if (path === "/user") {
      const sub = subOf(req);
      const u = Object.values(users).find((x) => x.id === sub);
      if (!u) return json(route, 401, { code: "bad_jwt", message: "invalid JWT" }, cors);
      return json(route, 200, sessionFor(u).user, cors);
    }
    if (path === "/logout") return route.fulfill({ status: 204, headers: cors, body: "" });
    return json(route, 404, { message: "route auth non simulée : " + path }, cors);
  }

  return {
    log, tables,
    addUser(email, password) {
      const u = { id: uuid().replace(/^0000/, "aaaa"), email: email.toLowerCase(), password };
      users[u.email] = u;
      /* Le trigger de création de profil existe côté Supabase (schéma). */
      rowsOf("profiles").push({ id: u.id, display_name: email.split("@")[0], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      return u;
    },
    userId: (email) => users[email.toLowerCase()].id,
    setNetworkDown(v) { netDown = !!v; },
    setLatency(ms) { latencyMs = ms || 0; },
    failTable(t, on) { if (on) failTables.add(t); else failTables.delete(t); },
    rows: (t, uid) => rowsOf(t).filter((r) => !uid || r.user_id === uid || r.id === uid).map((r) => JSON.parse(JSON.stringify(r))),
    /* À appeler sur chaque contexte de navigateur : ils partagent ce SEUL
       « serveur », comme deux appareils partagent un seul projet Supabase. */
    async attach(context, sdkUmdPath) {
      await context.route("**/@supabase/supabase-js@2/**", (route) => route.fulfill({
        status: 200, contentType: "application/javascript", body: require_fs().readFileSync(sdkUmdPath, "utf8"),
      }));
      await context.route(`https://${HOST}/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        if (req.method() === "OPTIONS") {
          return route.fulfill({ status: 204, headers: {
            "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*",
            "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-max-age": "600" } });
        }
        if (netDown) return route.abort("failed");
        if (url.pathname.startsWith("/auth/v1")) return handleAuth(route, req, url);
        if (url.pathname.startsWith("/rest/v1/")) {
          const r = await handleRest(route, req, url);
          return r;
        }
        if (url.pathname.startsWith("/storage/")) return route.fulfill({ status: 404, headers: { "access-control-allow-origin": "*" }, body: "{}" });
        return route.fulfill({ status: 404, headers: CORS, body: "{}" });
      });
    },
  };
}

import fs from "node:fs";
function require_fs() { return fs; }
