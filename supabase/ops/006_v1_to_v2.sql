-- ============================================================================
-- 006_v1_to_v2.sql — met à niveau une base où 006_integration_links.sql a été exécutée dans sa VERSION INITIALE (PR #21,
-- commit 33be91f) vers la version finale (PR #23). À exécuter UNIQUEMENT si prod_readiness.sql affiche
-- « VERSION INITIALE (#21) — stratégies à mettre à jour ».
-- ============================================================================
-- Idempotent. Ne touche AUCUNE donnée, aucune table, aucune colonne, aucune fonction. Il ne fait que :
--   1. remplacer la stratégie de lecture par `(select auth.uid())` (évaluée une fois par requête — Performance Advisor) ;
--   2. ajouter le refus EXPLICITE aux navigateurs sur les intentions et les nonces (déjà refusé par l'absence de droits).
-- Effet fonctionnel : aucun (mêmes accès qu'avant). Se rejoue sans risque.
-- ============================================================================
begin;

drop policy if exists integration_links_select_own on public.integration_links;
create policy integration_links_select_own on public.integration_links for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists integration_intents_no_client_access on public.integration_link_intents;
create policy integration_intents_no_client_access on public.integration_link_intents for all to anon, authenticated using (false) with check (false);

drop policy if exists integration_nonces_no_client_access on public.integration_nonces;
create policy integration_nonces_no_client_access on public.integration_nonces for all to anon, authenticated using (false) with check (false);

commit;
