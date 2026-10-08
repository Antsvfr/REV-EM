-- ============================================================================
-- REV-EM — migration 007 : journal du tuteur Maths & Stats (« M'entraîner »)
-- ============================================================================
-- À exécuter APRÈS 000 à 005 (006_integration_links.sql est indépendante : l'ordre entre 006 et 007 n'a pas d'importance). Idempotente : relançable sans
-- risque. AUCUNE suppression, AUCUN drop de table, AUCUNE donnée existante modifiée.
--
-- NE CONTIENT AUCUNE CLÉ SECRÈTE. SQL pur, sûr à committer.
--
-- ----------------------------------------------------------------------------
-- CE QUE CETTE TABLE CONTIENT — ET CE QU'ELLE NE CONTIENT PAS
-- ----------------------------------------------------------------------------
-- Une ligne = UN EXERCICE TERMINÉ (résolu, ou solution demandée, ou quitté après
-- effort) : thème, difficulté, nombre de réponses, nombre d'indices, réussite.
--
-- Elle ne contient JAMAIS l'énoncé, ni la réponse de l'élève, ni la solution : un
-- exercice est entièrement déterminé par { type, difficulté, graine } et se
-- régénère à l'identique côté client. On ne stocke que ce qui sert au suivi.
--
-- La MAÎTRISE n'est pas stockée : elle est CALCULÉE à partir du journal
-- (math-tutor.js, `progress`). Un journal « union » (comme `activities`) est
-- sans conflit entre appareils : deux appareils qui s'entraînent hors ligne
-- ajoutent chacun leurs lignes, personne n'écrase personne. Un compteur agrégé
-- (attempts += 1) perdrait des écritures — c'est pourquoi on n'en a pas.
--
-- ----------------------------------------------------------------------------
-- SÉCURITÉ
-- ----------------------------------------------------------------------------
-- RLS activée, quatre policies strictement « auth.uid() = user_id » (lecture,
-- insertion, mise à jour, suppression) ; accès anonyme retiré. Un compte ne lit,
-- n'écrit et ne supprime jamais les lignes d'un autre compte. Les contraintes
-- CHECK bornent chaque colonne : une valeur absurde est refusée par la base,
-- pas seulement par le client.
-- ============================================================================

-- ============================================================================
-- PRÉREQUIS — à lire si cette migration refuse de s'exécuter
-- ----------------------------------------------------------------------------
-- Les migrations s'appliquent DANS L'ORDRE NUMÉRIQUE, en commençant par
-- 000_schema.sql. Ce bloc le vérifie et s'arrête avec un message qui dit QUOI
-- FAIRE, plutôt que de laisser PostgreSQL échouer plus bas. Il ne modifie rien.
-- ============================================================================
do $prereq$
declare
  manquant text := null;
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_subjects_user_local') then null; else manquant := '005_user_sync.sql'; end if;
  if to_regclass('public.oauth_states') is not null then null; else manquant := '004_oauth_hardening.sql'; end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='subjects' and column_name='source_updated_at') then null; else manquant := '003_sync_layer.sql'; end if;
  if to_regclass('public.activities') is not null then null; else manquant := '002_centralisation.sql'; end if;
  if to_regclass('public.brightspace_connections') is not null then null; else manquant := '001_brightspace.sql'; end if;
  if to_regclass('public.subjects') is not null then null; else manquant := '000_schema.sql'; end if;

  if manquant is not null then
    raise exception using
      message = 'REV-EM : migration précédente manquante — ' || manquant,
      detail  = 'Cette migration suppose que ' || manquant || ' a déjà été appliquée, '
             || 'et la base montre que ce n''est pas le cas.',
      hint    = 'Dans le SQL Editor, exécute les fichiers de supabase/migrations/ '
             || 'dans cet ordre : 000_schema.sql → 001_brightspace.sql → 002_centralisation.sql → 003_sync_layer.sql → 004_oauth_hardening.sql → 005_user_sync.sql → 006_integration_links.sql → 007_math_practice.sql. '
             || 'Ils sont tous idempotents : relancer ceux déjà passés ne crée aucun doublon. '
             || 'Pour savoir où tu en es, exécute supabase/tests/00_diagnostic.sql.';
  end if;
end
$prereq$;


-- ============================================================================
-- 1. math_practice — le journal
-- ============================================================================
create table if not exists public.math_practice (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  ts             timestamptz not null,
  -- thème = domaine (liste fermée, la même que math-tutor.js : DOMAINS)
  topic          text not null check (topic in ('algebra','functions','derivatives','integrals','probability','statistics','matrices','finance')),
  -- type d'exercice (« quad-solve », « fin-npv »…) : texte libre borné, pas une liste
  -- fermée — le catalogue évolue côté client sans exiger de migration.
  kind           text not null check (char_length(kind) between 1 and 64),
  -- difficulté : 0 débutant · 1 intermédiaire · 2 avancé
  difficulty     smallint not null check (difficulty between 0 and 2),
  context        text not null default 'pure' check (context in ('pure','business')),
  attempts       integer not null default 0 check (attempts between 0 and 99),
  hints_used     smallint not null default 0 check (hints_used between 0 and 3),
  success        boolean not null default false,
  solution_shown boolean not null default false,
  created_at     timestamptz not null default now(),
  -- Déduplication : deux exercices ne se terminent pas au même instant exact (ms)
  -- pour un même utilisateur. Rend la synchronisation idempotente (upsert
  -- on conflict) — même motif unique(user_id, ts) que `activities`.
  unique (user_id, ts)
);

create index if not exists idx_math_practice_user_topic on public.math_practice(user_id, topic, ts desc);


-- ============================================================================
-- 2. RLS — isolation stricte par utilisateur
-- ============================================================================
alter table public.math_practice enable row level security;

drop policy if exists "math_practice_select_own" on public.math_practice;
create policy "math_practice_select_own" on public.math_practice for select using (auth.uid() = user_id);

drop policy if exists "math_practice_insert_own" on public.math_practice;
create policy "math_practice_insert_own" on public.math_practice for insert with check (auth.uid() = user_id);

drop policy if exists "math_practice_update_own" on public.math_practice;
create policy "math_practice_update_own" on public.math_practice for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "math_practice_delete_own" on public.math_practice;
create policy "math_practice_delete_own" on public.math_practice for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.math_practice to authenticated;
revoke all on public.math_practice from anon;

-- ============================================================================
-- 3. Cache de schéma de l'API
-- ----------------------------------------------------------------------------
-- PostgREST (l'API de Supabase) garde le schéma en cache : une table créée à la
-- main peut rester « introuvable » (404 « Could not find the table … in the
-- schema cache ») jusqu'au prochain rechargement. On le demande explicitement.
-- Sans effet sur les données ; relançable sans risque.
-- ============================================================================
notify pgrst, 'reload schema';
