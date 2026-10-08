-- ============================================================================
-- prod_readiness.sql — « où en est la PRODUCTION, et que faut-il exécuter après le merge de la PR #23 ? »
-- ============================================================================
-- EN LECTURE SEULE (aucun create / alter / drop / insert / update / delete). À coller dans le SQL Editor du projet
-- Supabase REV-EM (production) AVANT d'exécuter quoi que ce soit, puis à relancer APRÈS pour confirmer.
--
-- Il répond à quatre questions et conclut par la liste EXACTE des opérations à faire :
--   1. 006_integration_links est-elle déjà présente ?
--   2. Son schéma est-il celui de la version finale (#23), de la version initiale (#21, commit 33be91f), ou autre chose ?
--   3. 007_math_practice manque-t-elle ?  (et, si elle existe, son schéma est-il le bon ?)
--   4. Qu'exécuter ?
--
-- NE JAMAIS rejouer 006_integration_links.sql sur une base où elle existe déjà : elle utilise `create table` (sans
-- `if not exists`) et échouerait en cours de route. Si elle est présente en version initiale, on exécute UNIQUEMENT
-- supabase/ops/006_v1_to_v2.sql (idempotent, ne touche aucune donnée).
-- ============================================================================

with
-- ---------- empreinte du schéma de 006 (3 tables + 12 fonctions integration_*) ----------
t6 as (select unnest(array['integration_links','integration_link_intents','integration_nonces']) as t),
cols6 as (
  select string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by table_name, column_name) as s
    from information_schema.columns where table_schema = 'public' and table_name in (select t from t6)),
con6 as (
  select string_agg(c.conrelid::regclass::text || '.' || c.conname || ':' || pg_get_constraintdef(c.oid), '|' order by c.conrelid::regclass::text, c.conname) as s
    from pg_constraint c where c.conrelid in (select ('public.' || t)::regclass from t6 where to_regclass('public.' || t) is not null)
     and c.contype in ('p','u','c','f')),
idx6 as (
  select string_agg(indexname || ':' || indexdef, '|' order by indexname) as s from pg_indexes where schemaname = 'public' and tablename in (select t from t6)),
rls6 as (
  select string_agg(relname || ':' || relrowsecurity || ':' || relforcerowsecurity, '|' order by relname) as s
    from pg_class where relnamespace = 'public'::regnamespace and relname in (select t from t6)),
fn6 as (
  select string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || has_function_privilege('anon', p.oid, 'execute') || ':' || has_function_privilege('authenticated', p.oid, 'execute'), '|' order by p.proname) as s
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'integration\_%'),
grants6 as (
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, grantee, privilege_type) as s
    from information_schema.role_table_grants where table_schema = 'public' and table_name in (select t from t6) and grantee in ('anon','authenticated','public')),
colgrants6 as (
  select string_agg(table_name || '.' || column_name || ':' || grantee || ':' || privilege_type, '|' order by table_name, column_name, grantee) as s
    from information_schema.column_privileges where table_schema = 'public' and table_name in (select t from t6) and grantee in ('anon','authenticated')),
-- les stratégies : sans la partie qui distingue v1 et v2
pol6_common as (
  select string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text, '|' order by tablename, policyname) as s
    from pg_policies where schemaname = 'public' and tablename in (select t from t6) and policyname = 'integration_links_select_own'),
pol6_v2 as (
  select string_agg(tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' order by tablename, policyname) as s
    from pg_policies where schemaname = 'public' and tablename in (select t from t6)),
state6 as (
  select
    (select count(*) from t6 where to_regclass('public.' || t) is not null) as n_tables,
    -- empreinte « tout sauf stratégies »
    md5(coalesce((select s from cols6),'')) as c_cols, md5(coalesce((select s from con6),'')) as c_con, md5(coalesce((select s from idx6),'')) as c_idx,
    md5(coalesce((select s from rls6),'')) as c_rls, md5(coalesce((select s from fn6),'')) as c_fn,
    md5(coalesce((select s from grants6),'') || coalesce((select s from colgrants6),'')) as c_grants,
    md5(coalesce((select s from cols6),'') || '#' || coalesce((select s from con6),'') || '#' || coalesce((select s from idx6),'') || '#' ||
        coalesce((select s from rls6),'') || '#' || coalesce((select s from fn6),'') || '#' || coalesce((select s from grants6),'') || '#' ||
        coalesce((select s from colgrants6),'')) as fp_base,
    md5(coalesce((select s from pol6_v2),'')) as fp_pol,
    (select count(*) from pg_policies where schemaname = 'public' and tablename in (select t from t6)) as n_pol,
    (select s from pol6_v2) as pol_detail
),
-- ---------- empreinte de 007 ----------
state7 as (
  select
    (to_regclass('public.math_practice') is not null) as present,
    md5(
      coalesce((select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' order by column_name)
                  from information_schema.columns where table_schema = 'public' and table_name = 'math_practice'), '') || '#' ||
      coalesce((select string_agg(conname || ':' || pg_get_constraintdef(oid), '|' order by conname)
                  from pg_constraint where conrelid = to_regclass('public.math_practice') and contype in ('p','u','c','f')), '') || '#' ||
      coalesce((select string_agg(indexname || ':' || indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'math_practice'), '') || '#' ||
      coalesce((select relrowsecurity::text from pg_class where oid = to_regclass('public.math_practice')), '') || '#' ||
      coalesce((select string_agg(policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual,'') || ':' || coalesce(with_check,''), '|' order by policyname)
                  from pg_policies where schemaname = 'public' and tablename = 'math_practice'), '') || '#' ||
      coalesce((select string_agg(grantee || ':' || privilege_type, '|' order by grantee, privilege_type)
                  from information_schema.role_table_grants where table_schema = 'public' and table_name = 'math_practice' and grantee in ('anon','authenticated','public')), '')
    ) as fp
),
-- ---------- valeurs de référence (calculées sur PostgreSQL à partir des fichiers du dépôt) ----------
ref as (select
    '069bea45edca25136335c26c62cd18ea'::text as fp6_base,        -- 006, empreinte hors stratégies (identique en v1 et v2)
    'c0398d5179b791bc69f215bcf6afd9bb'::text as fp6_pol_v2,    -- 006 version finale (#23 / a1af8d5)
    'bdc783071e635f732fa662a8e473ae4c'::text as fp6_pol_v1,    -- 006 version initiale (#21 / 33be91f)
    'c9e576e3cc19a12070d740b60348bda0'::text as fp7),
verdict as (
  select
    case when s6.n_tables = 0 then 'ABSENTE'
         when s6.n_tables < 3 then 'INCOMPLÈTE (' || s6.n_tables || '/3 tables)'
         when s6.fp_base <> r.fp6_base then 'DIFFÉRENTE (tables / colonnes / fonctions / droits ≠ dépôt)'
         when s6.fp_pol = r.fp6_pol_v2 then 'IDENTIQUE À #23'
         when s6.fp_pol = r.fp6_pol_v1 then 'VERSION INITIALE (#21) — stratégies à mettre à jour'
         else 'DIFFÉRENTE (stratégies ≠ dépôt)' end as e6,
    case when not s7.present then 'ABSENTE'
         when s7.fp = r.fp7 then 'IDENTIQUE À #23'
         else 'PRÉSENTE MAIS DIFFÉRENTE du dépôt' end as e7
  from state6 s6, state7 s7, ref r
)
select 1 as n, '006_integration_links' as migration, e6 as "état", case
         when e6 = 'ABSENTE' then 'EXÉCUTER supabase/migrations/006_integration_links.sql (une seule fois, entier)'
         when e6 = 'IDENTIQUE À #23' then 'rien à faire'
         when e6 like 'VERSION INITIALE%' then 'EXÉCUTER UNIQUEMENT supabase/ops/006_v1_to_v2.sql — NE PAS rejouer 006'
         when e6 like 'INCOMPLÈTE%' then 'STOP — état partiel : ne rien rejouer, copier ce résultat et analyser avant d''agir'
         else 'STOP — schéma inattendu : ne rien exécuter, copier ce résultat et analyser avant d''agir' end as "opération"
  from verdict
union all
select 2, '007_math_practice', e7, case
         when e7 = 'ABSENTE' then 'EXÉCUTER supabase/migrations/007_math_practice.sql (idempotente)'
         when e7 = 'IDENTIQUE À #23' then 'rien à faire'
         else 'STOP — table existante différente (ex. ancienne 006_math_practice déjà jouée ?) : comparer avant d''agir ; 007 est idempotente et ne modifie pas une table existante' end
  from verdict
union all
select 3, 'empreintes mesurées (à joindre en cas de STOP)',
       '006 base=' || (select fp_base from state6) || ' [colonnes=' || (select left(c_cols,6) from state6) || ' contraintes=' || (select left(c_con,6) from state6) || ' index=' || (select left(c_idx,6) from state6) || ' rls=' || (select left(c_rls,6) from state6) || ' fonctions=' || (select left(c_fn,6) from state6) || ' droits=' || (select left(c_grants,6) from state6) || '] · stratégies=' || (select fp_pol from state6) || ' (' || (select n_pol from state6) || ') · 007=' || (select fp from state7),
       'information seulement'
order by n;
