-- REV-EM — connexion automatique à LexNote depuis un lancement de cours (extension compatible de lexnote-revem/v1).
--
-- Prérequis : 008_integration_launch.sql. Ne crée AUCUNE table, ne modifie AUCUNE donnée existante.
--
-- Quand LexNote reçoit un lancement SANS session ouverte dans le navigateur, son serveur demande à REV-EM (requête SIGNÉE, serveur → serveur)
-- à quelle liaison appartient l'intention. Cette fonction répond SANS CONSOMMER l'intention :
--   * le nonce doit correspondre (empreinte) — sinon refus, l'intention reste intacte ;
--   * l'intention doit être EN ATTENTE, non expirée, et RÉCENTE (≤ 120 s : fenêtre plus courte que le lancement normal) ;
--   * la liaison doit être CONNECTED pour l'utilisateur qui a créé l'intention.
-- Elle renvoie l'identifiant de liaison et la RÉFÉRENCE de REV-EM dans cette liaison (pseudonyme, connu de LexNote) : jamais d'identifiant
-- d'utilisateur, d'e-mail ni de jeton. LexNote décide ensuite (consentement « connexion automatique » stocké chez lui) puis consomme
-- l'intention par le REDEEM_LAUNCH habituel — usage unique garanti par 008 (verrou de ligne + statut REDEEMED).

do $prereq$
begin
  if to_regclass('public.integration_launch_intents') is null then
    raise exception using
      message = 'REV-EM : migration précédente manquante — 008_integration_launch.sql',
      hint    = 'Exécute d''abord supabase/migrations/008_integration_launch.sql, puis cette migration.';
  end if;
end
$prereq$;

create or replace function public.integration_launch_identify(p_intent uuid, p_nonce_hash text, p_max_age_seconds int default 120)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.integration_launch_intents; l public.integration_links;
begin
  select * into r from public.integration_launch_intents where id = p_intent;
  if not found then return jsonb_build_object('reason', 'NOT_FOUND'); end if;
  if r.nonce_hash is distinct from p_nonce_hash then return jsonb_build_object('reason', 'NONCE_MISMATCH'); end if;
  if r.status = 'REDEEMED' then return jsonb_build_object('reason', 'USED'); end if;
  if r.status = 'CANCELLED' then return jsonb_build_object('reason', 'CANCELLED'); end if;
  if r.status = 'EXPIRED' or r.expires_at <= now()
     or r.created_at < now() - make_interval(secs => greatest(10, least(coalesce(p_max_age_seconds, 120), 300))) then
    return jsonb_build_object('reason', 'EXPIRED');
  end if;
  select * into l from public.integration_links where user_id = r.user_id and link_id = r.link_id and status = 'CONNECTED';
  if not found then return jsonb_build_object('reason', 'LINK_NOT_CONNECTED'); end if;
  return jsonb_build_object('reason', 'OK', 'link_id', l.link_id, 'local_reference', l.local_reference, 'expires_at', r.expires_at);
end $$;

revoke all on function public.integration_launch_identify(uuid, text, int) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.integration_launch_identify(uuid, text, int) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
