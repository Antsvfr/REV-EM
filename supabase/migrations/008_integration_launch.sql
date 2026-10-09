-- REV-EM — ouverture d'un cours dans LexNote (« Prendre mes notes dans LexNote ») : intentions de lancement à usage unique.
--
-- Prérequis : 006_integration_links.sql (liaison de comptes). Ne modifie AUCUNE table existante ; ne crée AUCUNE donnée de cours.
--
-- Principes (mêmes que les intentions de liaison) :
--   * l'intention contient le cours (`external-course-event`) établi PAR LE SERVEUR à partir des données de l'étudiant au moment du clic ;
--     elle n'est jamais écrite par le navigateur ;
--   * courte (≤ 5 min côté application, ≤ 15 min par contrainte), à usage unique (consommation atomique), seule l'EMPREINTE du nonce est stockée ;
--   * un mauvais nonce ne consomme pas l'intention ; une liaison révoquée la rend inutilisable ;
--   * aucun accès navigateur (RLS forcée + refus explicite) ; fonctions réservées à service_role.
-- Ne stocke JAMAIS : notes, mot de passe, jeton.

do $prereq$
begin
  if to_regclass('public.integration_links') is null then
    raise exception using
      message = 'REV-EM : migration précédente manquante — 006_integration_links.sql',
      hint    = 'Exécute d''abord supabase/migrations/006_integration_links.sql (puis 007), puis cette migration.';
  end if;
end
$prereq$;

create table if not exists public.integration_launch_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  link_id text not null,                                        -- liaison utilisée (integrationLinkId)
  event_ref text not null check (char_length(event_ref) between 1 and 128),   -- identifiant stable de l'évènement de planning
  event jsonb not null,                                         -- external-course-event figé par le serveur
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'REDEEMED', 'EXPIRED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  constraint integration_launch_short_lived check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index if not exists integration_launch_intents_user on public.integration_launch_intents (user_id, status, created_at desc);
create index if not exists integration_launch_intents_expiry on public.integration_launch_intents (expires_at);

alter table public.integration_launch_intents enable row level security;
alter table public.integration_launch_intents force row level security;
revoke all on public.integration_launch_intents from public, anon, authenticated;
drop policy if exists integration_launch_no_client_access on public.integration_launch_intents;
create policy integration_launch_no_client_access on public.integration_launch_intents for all to anon, authenticated using (false) with check (false);

-- Démarre une intention : la liaison doit être CONNECTED pour CET utilisateur. Au plus 20 intentions en attente par utilisateur.
create or replace function public.integration_launch_start(p_user uuid, p_link_id text, p_event_key text, p_event jsonb, p_nonce_hash text, p_ttl_seconds int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_exp timestamptz;
begin
  delete from public.integration_launch_intents where expires_at < now() - interval '1 hour';
  update public.integration_launch_intents set status = 'EXPIRED' where status = 'PENDING' and expires_at <= now();
  if not exists (select 1 from public.integration_links where user_id = p_user and link_id = p_link_id and status = 'CONNECTED') then
    return jsonb_build_object('reason', 'LINK_NOT_CONNECTED');
  end if;
  if (select count(*) from public.integration_launch_intents where user_id = p_user and status = 'PENDING') >= 20 then
    return jsonb_build_object('reason', 'RATE_LIMITED');
  end if;
  v_exp := now() + make_interval(secs => greatest(30, least(coalesce(p_ttl_seconds, 300), 600)));
  insert into public.integration_launch_intents (user_id, link_id, event_ref, event, nonce_hash, expires_at)
    values (p_user, p_link_id, p_event_key, p_event, p_nonce_hash, v_exp) returning id into v_id;
  return jsonb_build_object('reason', 'OK', 'intent_id', v_id, 'expires_at', v_exp);
end $$;

-- Consomme une intention (ATOMIQUE). Intention inconnue OU appartenant à une autre liaison → NOT_FOUND (rien n'est révélé).
create or replace function public.integration_launch_redeem(p_intent uuid, p_nonce_hash text, p_link_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_launch_intents;
begin
  select * into r from public.integration_launch_intents where id = p_intent for update;
  if not found or r.link_id is distinct from p_link_id then return jsonb_build_object('reason', 'NOT_FOUND'); end if;
  if r.status = 'REDEEMED' then return jsonb_build_object('reason', 'USED'); end if;
  if r.status = 'CANCELLED' then return jsonb_build_object('reason', 'CANCELLED'); end if;
  if r.status = 'EXPIRED' or r.expires_at <= now() then
    update public.integration_launch_intents set status = 'EXPIRED' where id = r.id and status = 'PENDING';
    return jsonb_build_object('reason', 'EXPIRED');
  end if;
  if r.nonce_hash is distinct from p_nonce_hash then return jsonb_build_object('reason', 'NONCE_MISMATCH'); end if;   -- ne consomme PAS
  if not exists (select 1 from public.integration_links where user_id = r.user_id and link_id = r.link_id and status = 'CONNECTED') then
    return jsonb_build_object('reason', 'LINK_NOT_CONNECTED');
  end if;
  update public.integration_launch_intents set status = 'REDEEMED', redeemed_at = now() where id = r.id;
  return jsonb_build_object('reason', 'OK', 'event', r.event, 'expires_at', r.expires_at);
end $$;

do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('integration_launch_start', 'integration_launch_redeem') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
