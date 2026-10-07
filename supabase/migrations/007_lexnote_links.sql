-- ============================================================================
-- REV-EM — migration 007 : socle d'intégration REV-EM × LexNote (côté REV-EM)
-- ============================================================================
-- ⚠️ STATUT : FACULTATIVE ET PROVISOIRE. Rien dans l'application n'en dépend ; ne l'applique pas pour l'instant.
-- Elle a été écrite pour un lien par INSTALLATION, qui n'est PAS l'architecture définitive (cible : liaison
-- utilisateur REV-EM ↔ utilisateur LexNote, quand LexNote aura ses comptes). Elle sera revue ou remplacée.
-- Voir INTEGRATION_REVEM_LEXNOTE.md (§7, §11).
-- ----------------------------------------------------------------------------
-- Idempotente. AUCUNE suppression, AUCUN drop, AUCUNE donnée existante modifiée.
-- NE CONTIENT AUCUNE CLÉ SECRÈTE.
--
-- CE QUE CETTE MIGRATION CRÉE — ET CE QU'ELLE NE CRÉE PAS
-- ----------------------------------------------------------------------------
-- Deux tables d'INTÉGRATION, rien d'autre. Aucune donnée de cours, de notes, de planning ou de
-- progression n'est copiée ici : REV-EM reste source de vérité de ses données, LexNote des siennes.
-- Voir INTEGRATION_REVEM_LEXNOTE.md.
--
--   lexnote_links         le LIEN entre un compte REV-EM et une installation LexNote.
--                         `id` est le linkId PSEUDONYME : c'est lui (et non user_id) qui est
--                         transmis à LexNote. LexNote n'a pas de compte : `lexnote_external_reference`
--                         est l'identifiant OPAQUE de l'installation, jamais un e-mail.
--   lexnote_link_intents  les INTENTIONS de lancement (« ouvrir la séance de cet événement »),
--                         conservées côté serveur ; le jeton court n'en transporte que l'identifiant.
--                         Sert à l'usage unique (consumed_at) : un jeton valide mais déjà consommé
--                         est refusé.
--
-- ÉCRITURE : réservée aux Edge Functions (service_role). Le navigateur peut LIRE ses propres liens
-- (RLS), jamais en créer, activer ou révoquer : un client ne doit pas pouvoir se déclarer « lié ».
-- lexnote_link_intents n'est lisible ni écrivable par le navigateur (RLS activée, aucune policy).
--
-- Ces tables ne sont PAS dans user-data.js : pas de synchronisation, donc l'absence de cette
-- migration ne casse rien dans l'application (contrairement à un domaine synchronisé).
-- ============================================================================

do $prereq$
begin
  if to_regclass('public.profiles') is null or to_regprocedure('public.set_updated_at()') is null then
    raise exception using
      message = 'REV-EM : migration précédente manquante — 000_schema.sql',
      hint    = 'Dans le SQL Editor, exécute d''abord supabase/migrations/000_schema.sql (puis 001 à 006). '
             || 'Pour savoir où tu en es, exécute supabase/tests/00_diagnostic.sql.';
  end if;
end
$prereq$;


-- ============================================================================
-- 1. lexnote_links
-- ============================================================================
create table if not exists public.lexnote_links (
  id                         uuid primary key default gen_random_uuid(),   -- linkId pseudonyme
  user_id                    uuid not null references auth.users(id) on delete cascade,
  lexnote_external_reference text check (lexnote_external_reference ~ '^[A-Za-z0-9_.:\-]{1,128}$'),   -- opaque ; jamais un e-mail
  status                     text not null default 'pending' check (status in ('pending','active','revoked','expired')),
  scopes                     text[] not null default array['session:open']
                             check (cardinality(scopes) between 1 and 3 and scopes <@ array['session:open','artifact:read','event:read']),
  integration_version        text not null default '1' check (integration_version in ('1')),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  activated_at               timestamptz,
  revoked_at                 timestamptz,
  expires_at                 timestamptz,
  -- Un lien actif désigne forcément une installation et date de son activation.
  constraint lexnote_links_active_needs_ref check (status <> 'active' or (lexnote_external_reference is not null and activated_at is not null))
);

-- Une installation LexNote n'est liée qu'UNE fois à un compte donné (plusieurs installations : plusieurs liens).
create unique index if not exists uq_lexnote_links_user_ref
  on public.lexnote_links(user_id, lexnote_external_reference) where lexnote_external_reference is not null;
create index if not exists idx_lexnote_links_user on public.lexnote_links(user_id, status);

create or replace trigger trg_lexnote_links_updated_at
  before update on public.lexnote_links
  for each row execute function public.set_updated_at();

alter table public.lexnote_links enable row level security;

drop policy if exists "lexnote_links_select_own" on public.lexnote_links;
create policy "lexnote_links_select_own" on public.lexnote_links for select using (auth.uid() = user_id);
-- Volontairement AUCUNE policy insert/update/delete : seules les Edge Functions (service_role) écrivent.

revoke all on public.lexnote_links from anon;
revoke all on public.lexnote_links from authenticated;
grant select on public.lexnote_links to authenticated;


-- ============================================================================
-- 2. lexnote_link_intents
-- ============================================================================
create table if not exists public.lexnote_link_intents (
  jti          uuid primary key,                                           -- identifiant du jeton (claim jti)
  intent_id    uuid not null unique,                                        -- claim intent
  link_id      uuid not null references public.lexnote_links(id) on delete cascade,
  scope        text not null check (scope in ('session:open','artifact:read','event:read')),
  intent       jsonb not null,                                              -- CourseSessionIntent (côté serveur uniquement)
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,                                                 -- usage unique : renseigné à la première consommation
  -- Un jeton est COURT : 5 minutes au plus (même plafond que le contrat, MAX_TTL_SEC).
  constraint lexnote_link_intents_short_lived check (expires_at > created_at and expires_at <= created_at + interval '5 minutes')
);
create index if not exists idx_lexnote_link_intents_expires on public.lexnote_link_intents(expires_at);
create index if not exists idx_lexnote_link_intents_link on public.lexnote_link_intents(link_id);

-- RLS activée SANS policy : ni lecture ni écriture pour le navigateur (service_role contourne la RLS).
alter table public.lexnote_link_intents enable row level security;
revoke all on public.lexnote_link_intents from anon;
revoke all on public.lexnote_link_intents from authenticated;

-- Cache de schéma de l'API (voir 006).
notify pgrst, 'reload schema';
