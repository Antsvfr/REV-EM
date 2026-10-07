-- REV-EM — liaison explicite avec un compte LexNote (projets Supabase INDÉPENDANTS : aucun UUID, aucune session, aucune clé partagés).
--
-- Principes :
--   * la liaison relie deux comptes par des PSEUDONYMES opaques générés côté serveur ; l'e-mail n'intervient jamais ;
--   * le navigateur ne peut que LIRE (colonnes non sensibles) ses propres liaisons : toute écriture passe par les Edge Functions
--     (clé service role côté serveur) via les fonctions `integration_*` ci-dessous, atomiques ;
--   * une intention de liaison est à usage unique, courte (≤ 15 min), et seule l'EMPREINTE de son nonce est stockée ;
--   * RLS forcée ; aucune policy d'écriture ; intentions et nonces inaccessibles aux rôles anon/authenticated.
-- Ne stocke JAMAIS : e-mail distant, mot de passe, access token, refresh token, service_role.

create table public.integration_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- application PARTENAIRE de la liaison (dans le projet LexNote, la valeur est 'revem' ; ici : 'lexnote').
  provider text not null check (provider in ('revem', 'lexnote')),
  -- « integrationLinkId » : identifiant PUBLIC de la liaison, commun aux deux projets.
  link_id text not null unique check (link_id ~ '^lnk_[A-Za-z0-9_-]{20,64}$'),
  -- pseudonyme de CET utilisateur dans la liaison (ce que le partenaire voit) …
  local_reference text not null check (local_reference ~ '^[A-Za-z0-9._:~@-]{16,128}$'),
  -- … et pseudonyme du partenaire (jamais son UUID).
  external_reference text not null check (external_reference ~ '^[A-Za-z0-9._:~@-]{16,128}$'),
  status text not null check (status in ('PENDING', 'CONNECTED', 'REVOKED', 'ERROR')),
  linked_at timestamptz,
  revoked_at timestamptz,
  revoked_by text check (revoked_by in ('self', 'partner')),
  error_code text check (error_code is null or length(error_code) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_links_connected_has_date check (status <> 'CONNECTED' or (linked_at is not null and revoked_at is null)),
  constraint integration_links_revoked_has_date check (status <> 'REVOKED' or revoked_at is not null)
);
-- Une seule liaison vivante par utilisateur, et un compte partenaire ne peut être lié qu'à UN compte (relation 1-1).
create unique index integration_links_one_live_per_user on public.integration_links (user_id, provider) where status in ('PENDING', 'CONNECTED');
create unique index integration_links_one_live_per_partner on public.integration_links (provider, external_reference) where status in ('PENDING', 'CONNECTED');
create index integration_links_user on public.integration_links (user_id);

create table public.integration_link_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'USED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  link_id text,
  constraint integration_intent_short_lived check (expires_at > created_at and expires_at <= created_at + interval '15 minutes')
);
create index integration_link_intents_user on public.integration_link_intents (user_id, status);

-- Anti-rejeu des messages serveur → serveur : un (expéditeur, nonce) n'est accepté qu'UNE fois.
create table public.integration_nonces (
  sender text not null check (sender in ('revem', 'lexnote')),
  nonce text not null,
  expires_at timestamptz not null,
  primary key (sender, nonce)
);
create index integration_nonces_expiry on public.integration_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- RLS + droits
-- ---------------------------------------------------------------------------
alter table public.integration_links enable row level security;
alter table public.integration_links force row level security;
alter table public.integration_link_intents enable row level security;
alter table public.integration_link_intents force row level security;
alter table public.integration_nonces enable row level security;
alter table public.integration_nonces force row level security;

revoke all on public.integration_links, public.integration_link_intents, public.integration_nonces from public, anon, authenticated;
-- Lecture de SES liaisons, colonnes non sensibles uniquement (les pseudonymes `*_reference` restent côté serveur).
grant select (id, provider, link_id, status, linked_at, revoked_at, revoked_by, error_code, created_at, updated_at) on public.integration_links to authenticated;
create policy integration_links_select_own on public.integration_links for select to authenticated using (user_id = auth.uid());
-- Aucune policy d'écriture : INSERT/UPDATE/DELETE impossibles depuis un navigateur.

-- ---------------------------------------------------------------------------
-- Fonctions serveur (appelées avec la clé service role par les Edge Functions). Toutes renvoient un jsonb {reason, …}.
-- ---------------------------------------------------------------------------
create or replace function public.integration_expire_stale() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.integration_link_intents set status = 'EXPIRED' where status = 'PENDING' and expires_at <= now();
  update public.integration_links set status = 'ERROR', error_code = 'PENDING_TIMEOUT', updated_at = now()
    where status = 'PENDING' and created_at < now() - interval '10 minutes';
  delete from public.integration_nonces where expires_at < now();
end $$;

create or replace function public.integration_start_intent(p_user uuid, p_nonce_hash text, p_ttl_seconds int)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_exp timestamptz;
begin
  perform public.integration_expire_stale();
  if exists (select 1 from public.integration_links where user_id = p_user and status = 'CONNECTED') then
    return jsonb_build_object('reason', 'ALREADY_LINKED');
  end if;
  -- Une liaison restée PENDING (activation interrompue) ne doit pas bloquer l'étudiant : une nouvelle intention la remplace.
  update public.integration_links set status = 'ERROR', error_code = 'SUPERSEDED', updated_at = now() where user_id = p_user and status = 'PENDING';
  update public.integration_link_intents set status = 'CANCELLED' where user_id = p_user and status = 'PENDING';
  v_exp := now() + make_interval(secs => greatest(30, least(coalesce(p_ttl_seconds, 300), 600)));
  insert into public.integration_link_intents (user_id, nonce_hash, expires_at) values (p_user, p_nonce_hash, v_exp) returning id into v_id;
  return jsonb_build_object('reason', 'OK', 'intent_id', v_id, 'expires_at', v_exp);
end $$;

create or replace function public.integration_cancel_intents(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update public.integration_link_intents set status = 'CANCELLED' where user_id = p_user and status = 'PENDING';
  get diagnostics n = row_count;
  return jsonb_build_object('reason', 'OK', 'cancelled', n);
end $$;

-- Diagnostic commun (sans effet de bord sauf l'expiration) : pourquoi une intention n'est-elle pas utilisable ?
create or replace function public.integration_intent_reason(p_intent uuid, p_nonce_hash text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_link_intents;
begin
  select * into r from public.integration_link_intents where id = p_intent;
  if not found then return 'NOT_FOUND'; end if;
  if r.nonce_hash <> p_nonce_hash then return 'NONCE_MISMATCH'; end if;
  if r.status = 'PENDING' and r.expires_at <= now() then
    update public.integration_link_intents set status = 'EXPIRED' where id = p_intent;
    return 'EXPIRED';
  end if;
  if r.status = 'PENDING' then return 'OK'; end if;
  return r.status;                       -- EXPIRED | CANCELLED | CONFIRMED | USED
end $$;

create or replace function public.integration_inspect_intent(p_intent uuid, p_nonce_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text; r public.integration_link_intents; v_hint text;
begin
  v_reason := public.integration_intent_reason(p_intent, p_nonce_hash);
  if v_reason <> 'OK' then return jsonb_build_object('reason', v_reason); end if;
  select * into r from public.integration_link_intents where id = p_intent;
  select left(trim(coalesce(nullif(display_name, ''), nullif(first_name, ''), 'Compte REV-EM')), 40) into v_hint from public.profiles where id = r.user_id;
  return jsonb_build_object('reason', 'OK', 'display_hint', coalesce(v_hint, 'Compte'), 'expires_at', r.expires_at);
end $$;

-- ATOMIQUE : consomme l'intention (PENDING → CONFIRMED) et crée la liaison PENDING dans la même transaction.
create or replace function public.integration_redeem_intent(p_intent uuid, p_nonce_hash text, p_provider text, p_partner_ref text, p_link_id text, p_local_ref text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid;
begin
  begin
    update public.integration_link_intents set status = 'CONFIRMED', used_at = now(), link_id = p_link_id
      where id = p_intent and nonce_hash = p_nonce_hash and status = 'PENDING' and expires_at > now()
      returning user_id into v_user;
    if v_user is null then
      return jsonb_build_object('reason', public.integration_intent_reason(p_intent, p_nonce_hash));
    end if;
    insert into public.integration_links (user_id, provider, link_id, local_reference, external_reference, status)
      values (v_user, p_provider, p_link_id, p_local_ref, p_partner_ref, 'PENDING');
  exception when unique_violation then
    return jsonb_build_object('reason', 'ALREADY_LINKED');         -- le sous-bloc est annulé : l'intention reste PENDING
  end;
  return jsonb_build_object('reason', 'OK', 'link_id', p_link_id, 'local_reference', p_local_ref);
end $$;

-- Côté « répondant » : enregistre la liaison PENDING pour l'utilisateur authentifié (identifié par l'Edge Function avec SON jeton).
create or replace function public.integration_create_pending_link(p_user uuid, p_provider text, p_link_id text, p_local_ref text, p_partner_ref text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.integration_expire_stale();
  if exists (select 1 from public.integration_links where user_id = p_user and status = 'CONNECTED') then
    return jsonb_build_object('reason', 'ALREADY_LINKED');
  end if;
  update public.integration_links set status = 'ERROR', error_code = 'SUPERSEDED', updated_at = now() where user_id = p_user and status = 'PENDING';
  insert into public.integration_links (user_id, provider, link_id, local_reference, external_reference, status)
    values (p_user, p_provider, p_link_id, p_local_ref, p_partner_ref, 'PENDING');
  return jsonb_build_object('reason', 'OK');
exception when unique_violation then
  return jsonb_build_object('reason', 'ALREADY_LINKED');
end $$;

create or replace function public.integration_activate_link(p_link_id text, p_partner_ref text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_links;
begin
  select * into r from public.integration_links where link_id = p_link_id and external_reference = p_partner_ref;
  if not found then return jsonb_build_object('reason', 'NOT_FOUND'); end if;
  if r.status = 'CONNECTED' then return jsonb_build_object('reason', 'OK'); end if;
  if r.status <> 'PENDING' then return jsonb_build_object('reason', r.status); end if;
  update public.integration_links set status = 'CONNECTED', linked_at = now(), error_code = null, updated_at = now() where id = r.id;
  update public.integration_link_intents set status = 'USED' where link_id = p_link_id and status = 'CONFIRMED';
  return jsonb_build_object('reason', 'OK');
end $$;

-- Révocation idempotente. `p_partner_ref` non nul = demande du PARTENAIRE (doit correspondre) ; nul = décision de l'utilisateur.
create or replace function public.integration_revoke_link(p_link_id text, p_partner_ref text, p_by text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_links;
begin
  select * into r from public.integration_links where link_id = p_link_id and (p_partner_ref is null or external_reference = p_partner_ref);
  if not found then return jsonb_build_object('reason', 'NOT_FOUND'); end if;
  if r.status <> 'REVOKED' then
    update public.integration_links set status = 'REVOKED', revoked_at = now(), revoked_by = p_by, updated_at = now() where id = r.id;
    update public.integration_link_intents set status = 'CANCELLED' where link_id = p_link_id and status in ('PENDING', 'CONFIRMED');
  end if;
  return jsonb_build_object('reason', 'OK', 'external_reference', r.external_reference);
end $$;

create or replace function public.integration_mark_error(p_link_id text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.integration_links set status = 'ERROR', error_code = left(p_code, 60), updated_at = now() where link_id = p_link_id and status in ('PENDING', 'CONNECTED');
  return jsonb_build_object('reason', 'OK');
end $$;

create or replace function public.integration_get_link(p_link_id text, p_partner_ref text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_links;
begin
  select * into r from public.integration_links where link_id = p_link_id and (p_partner_ref is null or external_reference = p_partner_ref);
  if not found then return jsonb_build_object('reason', 'NOT_FOUND'); end if;
  return jsonb_build_object('reason', 'OK', 'link', to_jsonb(r) - 'id');
end $$;

create or replace function public.integration_get_user_link(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_links;
begin
  perform public.integration_expire_stale();
  select * into r from public.integration_links where user_id = p_user order by (status in ('PENDING', 'CONNECTED', 'ERROR')) desc, created_at desc limit 1;
  if not found then return jsonb_build_object('reason', 'NOT_FOUND'); end if;
  return jsonb_build_object('reason', 'OK', 'link', to_jsonb(r) - 'id');
end $$;

create or replace function public.integration_register_nonce(p_sender text, p_nonce text, p_expires timestamptz) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.integration_nonces where expires_at < now();
  insert into public.integration_nonces (sender, nonce, expires_at) values (p_sender, p_nonce, p_expires);
  return jsonb_build_object('reason', 'OK');
exception when unique_violation then
  return jsonb_build_object('reason', 'REPLAY');
end $$;

-- Ces fonctions ne sont appelables QUE par le serveur (service_role) : jamais par un navigateur.
do $$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'integration\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
