-- ============================================================================
-- integration_links_tests.sql — isolation et robustesse des tables de LIAISON avec LexNote (migration 006)
-- ============================================================================
-- Prouve, sur un vrai PostgreSQL, que :
--   • A ne lit que SA liaison, jamais celle de B ; ni les pseudonymes (local_reference / external_reference) ;
--   • A ne peut ni créer, ni modifier, ni supprimer, ni révoquer une liaison (aucune policy d'écriture) ;
--   • intentions et nonces sont inaccessibles aux navigateurs ; anon ne voit rien ;
--   • les fonctions integration_* ne sont pas appelables par un navigateur, mais le sont par service_role ;
--   • une intention est à usage unique, expire, et un mauvais nonce ne la consomme pas ;
--   • un nonce de message ne peut être enregistré qu'une fois (anti-rejeu) ;
--   • 1 liaison vivante par utilisateur, relation 1-1 avec le partenaire, révocation idempotente, cascade à la suppression du compte.
--
-- Exécution :  psql -d revem_test -f supabase/tests/00_local_emulation.sql   (une fois, base de test uniquement)
--              psql -d revem_test -f supabase/migrations/006_integration_links.sql
--              psql -d revem_test -f supabase/tests/integration_links_tests.sql
-- Résultat : un tableau PASS/FAIL, une ligne « RÉSUMÉ » en dernier. Objectif : zéro FAIL.
-- Les deux comptes de test (UUID sentinelles) et leurs lignes sont supprimés à la fin (cascade).
-- ============================================================================

create or replace function pg_temp.integration_test_run()
returns table (n int, controle text, statut text)
language plpgsql as $fn$
declare
  ua uuid := '00000000-0000-4000-a000-0000000000a1';
  ub uuid := '00000000-0000-4000-b000-0000000000b1';
  la text := 'lnk_' || repeat('a', 24);
  lb text := 'lnk_' || repeat('b', 24);
  k int := 0; r jsonb; c bigint; denied boolean; ih text := repeat('1', 64);
  intent uuid;

begin
  -- Comptes de test (profil créé par le trigger, ou à défaut ici)
  insert into auth.users (id, email) values (ua, 'test-a@integration.invalid'), (ub, 'test-b@integration.invalid') on conflict do nothing;
  insert into public.profiles (id) values (ua), (ub) on conflict do nothing;

  -- Données de départ créées par le SERVEUR (fonctions), comme en production
  perform public.integration_create_pending_link(ua, 'lexnote', la, 'ref_' || repeat('a', 20), 'ref_' || repeat('A', 20));
  perform public.integration_activate_link(la, 'ref_' || repeat('A', 20));
  perform public.integration_create_pending_link(ub, 'lexnote', lb, 'ref_' || repeat('b', 20), 'ref_' || repeat('B', 20));
  perform public.integration_activate_link(lb, 'ref_' || repeat('B', 20));

  -- 1. A lit uniquement sa ligne (colonnes autorisées seulement : « select * » est refusé, voir plus bas)
  perform set_config('request.jwt.claim.sub', ua::text, true); set local role authenticated;
  select count(*) into c from (select link_id from public.integration_links) s;
  reset role;
  k := k + 1; n := k; controle := 'A voit exactement 1 liaison (la sienne)'; statut := case when c = 1 then 'PASS' else 'FAIL' end; return next;

  perform set_config('request.jwt.claim.sub', ua::text, true); set local role authenticated;
  select count(*) into c from public.integration_links where link_id = lb;
  reset role;
  k := k + 1; n := k; controle := 'A ne voit pas la liaison de B'; statut := case when c = 0 then 'PASS' else 'FAIL' end; return next;

  -- 2. colonnes sensibles / écritures / tables internes / fonctions : refus attendus
  denied := false;
  begin set local role authenticated; perform local_reference from public.integration_links; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'A ne lit pas local_reference'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; perform external_reference from public.integration_links; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'A ne lit pas external_reference'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; update public.integration_links set status = 'REVOKED', revoked_at = now() where link_id = lb; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'A ne révoque pas la liaison de B (UPDATE refusé)'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; delete from public.integration_links; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'A ne supprime aucune liaison (DELETE refusé)'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; insert into public.integration_links (user_id, provider, link_id, local_reference, external_reference, status) values (ua, 'lexnote', 'lnk_' || repeat('z', 24), 'ref_' || repeat('z', 20), 'ref_' || repeat('y', 20), 'PENDING'); exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'A ne crée pas de liaison (INSERT refusé)'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; perform 1 from public.integration_link_intents; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'intentions inaccessibles à un navigateur'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; perform 1 from public.integration_nonces; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'nonces inaccessibles à un navigateur'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role anon; perform link_id from public.integration_links; exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'anon : aucune lecture'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role authenticated; perform public.integration_revoke_link(lb, null, 'self'); exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'un navigateur ne peut pas appeler integration_revoke_link'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  denied := false;
  begin set local role anon; perform public.integration_register_nonce('lexnote', 'x', now()); exception when insufficient_privilege then denied := true; end; reset role;
  k := k + 1; n := k; controle := 'anon ne peut pas appeler integration_register_nonce'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  -- 3. intentions : usage unique, expiration, nonce
  r := public.integration_start_intent(ua, ih, 300);   -- A est déjà CONNECTED
  k := k + 1; n := k; controle := 'start_intent refusé tant que A est lié'; statut := case when r->>'reason' = 'ALREADY_LINKED' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_revoke_link(la, null, 'self');
  r := public.integration_revoke_link(la, null, 'self');
  k := k + 1; n := k; controle := 'révocation idempotente'; statut := case when r->>'reason' = 'OK' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_start_intent(ua, ih, 300); intent := (r->>'intent_id')::uuid;
  k := k + 1; n := k; controle := 'après révocation, nouvelle intention possible'; statut := case when r->>'reason' = 'OK' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_redeem_intent(intent, repeat('2', 64), 'lexnote', 'ref_' || repeat('C', 20), 'lnk_' || repeat('c', 24), 'ref_' || repeat('c', 20));
  k := k + 1; n := k; controle := 'mauvais nonce : refusé'; statut := case when r->>'reason' = 'NONCE_MISMATCH' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_redeem_intent(intent, ih, 'lexnote', 'ref_' || repeat('C', 20), 'lnk_' || repeat('c', 24), 'ref_' || repeat('c', 20));
  k := k + 1; n := k; controle := 'bon nonce : intention consommée (le mauvais essai ne l''avait pas consommée)'; statut := case when r->>'reason' = 'OK' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_redeem_intent(intent, ih, 'lexnote', 'ref_' || repeat('D', 20), 'lnk_' || repeat('d', 24), 'ref_' || repeat('d', 20));
  k := k + 1; n := k; controle := 'usage unique : second échange refusé'; statut := case when r->>'reason' = 'CONFIRMED' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_activate_link('lnk_' || repeat('c', 24), 'ref_' || repeat('X', 20));
  k := k + 1; n := k; controle := 'activation avec une mauvaise référence partenaire : refusée'; statut := case when r->>'reason' = 'NOT_FOUND' then 'PASS' else 'FAIL' end; return next;

  r := public.integration_activate_link('lnk_' || repeat('c', 24), 'ref_' || repeat('C', 20));
  select status into r from (select jsonb_build_object('s', status) as status from public.integration_link_intents where id = intent) q;
  k := k + 1; n := k; controle := 'activation → intention USED'; statut := case when r->>'s' = 'USED' then 'PASS' else 'FAIL' end; return next;

  update public.integration_links set status = 'REVOKED', revoked_at = now(), revoked_by = 'self' where user_id = ua;   -- libère A pour la suite
  r := public.integration_start_intent(ua, repeat('3', 64), 300); intent := (r->>'intent_id')::uuid;
  update public.integration_link_intents set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' where id = intent;
  r := public.integration_redeem_intent(intent, repeat('3', 64), 'lexnote', 'ref_' || repeat('E', 20), 'lnk_' || repeat('e', 24), 'ref_' || repeat('e', 20));
  k := k + 1; n := k; controle := 'intention expirée : refusée'; statut := case when r->>'reason' = 'EXPIRED' then 'PASS' else 'FAIL' end; return next;

  -- 4. anti-rejeu des messages
  r := public.integration_register_nonce('lexnote', 'nonce-unique-0123456789', now() + interval '5 minutes');
  k := k + 1; n := k; controle := 'premier nonce : accepté'; statut := case when r->>'reason' = 'OK' then 'PASS' else 'FAIL' end; return next;
  r := public.integration_register_nonce('lexnote', 'nonce-unique-0123456789', now() + interval '5 minutes');
  k := k + 1; n := k; controle := 'même nonce : rejeu refusé'; statut := case when r->>'reason' = 'REPLAY' then 'PASS' else 'FAIL' end; return next;

  -- 5. contraintes
  denied := false;
  begin insert into public.integration_link_intents (user_id, nonce_hash, expires_at) values (ua, repeat('4', 64), now() + interval '2 hours'); exception when check_violation then denied := true; end;
  k := k + 1; n := k; controle := 'durée d''une intention bornée à 15 minutes'; statut := case when denied then 'PASS' else 'FAIL' end; return next;
  denied := false;
  begin insert into public.integration_links (user_id, provider, link_id, local_reference, external_reference, status) values (ub, 'lexnote', 'lnk_' || repeat('f', 24), 'ref_' || repeat('f', 20), 'ref_' || repeat('F', 20), 'PENDING'); exception when unique_violation then denied := true; end;
  k := k + 1; n := k; controle := 'B ne peut pas avoir deux liaisons vivantes'; statut := case when denied then 'PASS' else 'FAIL' end; return next;
  denied := false;
  begin insert into public.integration_links (user_id, provider, link_id, local_reference, external_reference, status) values (ua, 'lexnote', 'lnk_' || repeat('g', 24), 'ref_' || repeat('g', 20), 'ref_' || repeat('B', 20), 'PENDING'); exception when unique_violation then denied := true; end;
  k := k + 1; n := k; controle := 'un compte partenaire ne se lie qu''à UN compte (1-1)'; statut := case when denied then 'PASS' else 'FAIL' end; return next;

  -- nettoyage (cascade)
  delete from auth.users where id in (ua, ub);
  select count(*) into c from public.integration_links where user_id in (ua, ub);
  k := k + 1; n := k; controle := 'suppression du compte → liaisons supprimées en cascade'; statut := case when c = 0 then 'PASS' else 'FAIL' end; return next;
end
$fn$;

create temp table integration_test_results as select * from pg_temp.integration_test_run();
select * from integration_test_results
union all
select 999, 'RÉSUMÉ', count(*) filter (where statut = 'PASS') || ' PASS / ' || count(*) filter (where statut = 'FAIL') || ' FAIL' from integration_test_results
order by 1;
