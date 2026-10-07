/* ============================================================================
   REV-EM — socle d'intégration LexNote (migration 007) contre une VRAIE base PostgreSQL
   ----------------------------------------------------------------------------
   RÉEL : PostgreSQL (contraintes, RLS évaluée avec le rôle `authenticated` et un claim `sub`, privilèges).
   REMPLACÉ : le transport HTTP de PostgREST et Supabase Auth (comme tests/user-data.test.mjs).
   NON TESTÉ : un vrai projet Supabase (voir « REAL SUPABASE TEST STATUS » du rapport).
   Lancer :  service postgresql start && node tests/lexnote-links.test.mjs
   ========================================================================== */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const DB = "revem_lexnote_test", ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
let pass = 0, fail = 0;
const check = (l, ok, d) => { if (ok) { pass++; console.log("PASS — " + l); } else { fail++; console.log("FAIL — " + l + (d !== undefined ? "  " + JSON.stringify(d) : "")); } };
const sh = (c) => execSync(c, { encoding: "utf8", stdio: "pipe" });

sh(`su postgres -c "dropdb --if-exists ${DB}; createdb ${DB}"`);
for (const f of ["supabase/tests/00_local_emulation.sql", ...[0, 1, 2, 3, 4, 5, 6, 7].map(n => sh(`ls ${ROOT}/supabase/migrations | grep ^00${n}_`).trim().replace(/^/, "supabase/migrations/"))])
  sh(`su postgres -c "psql -q -v ON_ERROR_STOP=0 -d ${DB} -f ${ROOT}/${f}"`);
sh(`su postgres -c "psql -q -d ${DB} -c \\"alter role postgres password 'itest_pw'\\""`);
const one = (sql) => sh(`su postgres -c "psql -tAX -d ${DB} -c \\"${sql}\\""`).trim().split("\n")[0].trim();
const A = one("insert into auth.users (email) values ('a@test.invalid') returning id"), B = one("insert into auth.users (email) values ('b@test.invalid') returning id");
const pool = new Pool({ host: "127.0.0.1", port: 5432, user: "postgres", password: "itest_pw", database: DB, max: 4 });
async function as(role, sub, sql, params) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    if (role !== "postgres") await c.query(`set local role ${role}`);
    if (sub) { await c.query("select set_config('request.jwt.claim.sub',$1,true)", [sub]); await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub, role })]); }
    const r = await c.query(sql, params); await c.query("commit"); return { rows: r.rows, count: r.rowCount };
  } catch (e) { try { await c.query("rollback"); } catch (_) {} return { error: e.message, code: e.code }; } finally { c.release(); }
}
const svc = (sql, p) => as("postgres", null, sql, p);

try {
  /* service_role (Edge Function) crée les liens */
  const l1 = await svc("insert into public.lexnote_links (user_id, lexnote_external_reference, status, activated_at) values ($1,'install_7f3a','active',now()) returning id", [A]);
  const l2 = await svc("insert into public.lexnote_links (user_id) values ($1) returning id", [B]);
  check("l'Edge Function (service) crée un lien actif et un lien en attente", !l1.error && !l2.error, [l1.error, l2.error]);
  check("valeurs par défaut : scopes session:open, version 1, statut pending", (await svc("select scopes, integration_version, status from public.lexnote_links where id=$1", [l2.rows[0].id])).rows[0].scopes[0] === "session:open");

  /* RLS : lecture de SES liens seulement */
  const ra = await as("authenticated", A, "select id, user_id from public.lexnote_links");
  check("A ne lit que son lien", ra.rows.length === 1 && ra.rows[0].user_id === A, ra);
  check("B ne lit pas le lien de A", (await as("authenticated", B, "select id from public.lexnote_links where user_id=$1", [A])).rows.length === 0);

  /* le navigateur ne peut rien écrire */
  for (const [label, sql, p] of [
    ["insert d'un lien actif refusé", "insert into public.lexnote_links (user_id, lexnote_external_reference, status, activated_at) values ($1,'x1','active',now())", [A]],
    ["insert d'un lien en attente refusé", "insert into public.lexnote_links (user_id) values ($1)", [A]],
    ["update (s'auto-activer) refusé", "update public.lexnote_links set status='active' where user_id=$1", [A]],
    ["delete refusé", "delete from public.lexnote_links where user_id=$1", [A]],
  ]) { const r = await as("authenticated", A, sql, p); check(label, !!r.error && /permission denied/i.test(r.error), r); }
  check("le lien de A est intact", (await svc("select count(*)::int n from public.lexnote_links where user_id=$1", [A])).rows[0].n === 1);

  /* anon : rien */
  for (const t of ["lexnote_links", "lexnote_link_intents"]) {
    const r = await as("anon", null, `select * from public.${t}`); check(`anon ne lit pas ${t}`, !!r.error && /permission denied/i.test(r.error), r);
  }
  /* intentions : inaccessibles au navigateur */
  const jti = "11111111-1111-4111-8111-111111111111", intent = "22222222-2222-4222-8222-222222222222";
  const ins = await svc("insert into public.lexnote_link_intents (jti, intent_id, link_id, scope, intent, expires_at) values ($1,$2,$3,'session:open','{}'::jsonb, now() + interval '2 minutes') returning jti", [jti, intent, l1.rows[0].id]);
  check("service : crée une intention de 2 min", !ins.error, ins);
  for (const [label, sql] of [["authenticated ne lit pas les intentions", "select * from public.lexnote_link_intents"], ["authenticated n'écrit pas les intentions", "update public.lexnote_link_intents set consumed_at=now()"], ["authenticated ne supprime pas les intentions", "delete from public.lexnote_link_intents"]]) {
    const r = await as("authenticated", A, sql); check(label, !!r.error && /permission denied/i.test(r.error), r);
  }
  /* usage unique : la consommation est atomique */
  const c1 = await svc("update public.lexnote_link_intents set consumed_at=now() where jti=$1 and consumed_at is null and expires_at > now() returning jti", [jti]);
  const c2 = await svc("update public.lexnote_link_intents set consumed_at=now() where jti=$1 and consumed_at is null and expires_at > now() returning jti", [jti]);
  check("usage unique : la 1re consommation réussit, la 2e ne trouve plus rien", c1.count === 1 && c2.count === 0, [c1.count, c2.count]);

  /* contraintes */
  const bad = async (label, sql, p) => { const r = await svc(sql, p); check(label, !!r.error && /violates|check/i.test(r.error), r); };
  await bad("un e-mail n'est pas une référence d'installation valide", "insert into public.lexnote_links (user_id, lexnote_external_reference) values ($1,'a@b.fr')", [A]);
  await bad("lien actif sans référence refusé", "insert into public.lexnote_links (user_id, status, activated_at) values ($1,'active',now())", [A]);
  await bad("statut inconnu refusé", "insert into public.lexnote_links (user_id, status) values ($1,'ok')", [A]);
  await bad("scope inconnu refusé", "insert into public.lexnote_links (user_id, scopes) values ($1, array['admin'])", [A]);
  await bad("scopes vides refusés", "insert into public.lexnote_links (user_id, scopes) values ($1, array[]::text[])", [A]);
  await bad("version de protocole inconnue refusée", "insert into public.lexnote_links (user_id, integration_version) values ($1,'2')", [A]);
  await bad("la même installation ne se lie pas deux fois au même compte", "insert into public.lexnote_links (user_id, lexnote_external_reference) values ($1,'install_7f3a')", [A]);
  await bad("un jeton de plus de 5 minutes refusé", "insert into public.lexnote_link_intents (jti, intent_id, link_id, scope, intent, expires_at) values (gen_random_uuid(), gen_random_uuid(), $1,'session:open','{}'::jsonb, now() + interval '10 minutes')", [l1.rows[0].id]);
  await bad("scope d'intention inconnu refusé", "insert into public.lexnote_link_intents (jti, intent_id, link_id, scope, intent, expires_at) values (gen_random_uuid(), gen_random_uuid(), $1,'root','{}'::jsonb, now() + interval '1 minute')", [l1.rows[0].id]);
  check("deux installations différentes pour un même compte : permis", !(await svc("insert into public.lexnote_links (user_id, lexnote_external_reference) values ($1,'install_other') returning id", [A])).error);

  /* updated_at et cascade */
  const before = (await svc("select updated_at from public.lexnote_links where id=$1", [l1.rows[0].id])).rows[0].updated_at;
  await new Promise(r => setTimeout(r, 20));
  await svc("update public.lexnote_links set status='revoked', revoked_at=now() where id=$1", [l1.rows[0].id]);
  check("updated_at est tenu par le trigger", (await svc("select updated_at from public.lexnote_links where id=$1", [l1.rows[0].id])).rows[0].updated_at > before);
  await svc("delete from auth.users where id=$1", [A]);
  check("supprimer le compte supprime ses liens ET ses intentions (cascade)", (await svc("select (select count(*) from public.lexnote_links where user_id=$1)::int + (select count(*) from public.lexnote_link_intents)::int n", [A])).rows[0].n === 0);

  /* idempotence et indépendance */
  let again = "ok"; try { sh(`su postgres -c "psql -q -v ON_ERROR_STOP=1 -d ${DB} -f ${ROOT}/supabase/migrations/007_lexnote_links.sql"`); } catch (e) { again = String(e.stderr || e).slice(0, 300); }
  check("la migration est idempotente (relancée sans erreur)", again === "ok", again);
  check("rien d'autre n'a été touché : aucune table de données REV-EM ajoutée par 007 (2 tables lexnote_*)", Number(one("select count(*) from information_schema.tables where table_schema='public' and table_name like 'lexnote%'")) === 2);
} finally {
  await pool.end(); sh(`su postgres -c "dropdb --if-exists ${DB}"`);
}
console.log(`\n${pass}/${pass + fail} vérifications passées, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
