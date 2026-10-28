-- A room's binding grants named abilities (REQ-75 r5 BC-27), and three of them change things outside
-- Forge, so each waits on a confirmer the grant names before it runs:
--   support_proposals  `kind` gains deploy (a bound target the grant names), command (a command that
--                      changes a host the grant names) and build (a commit pushed from the room's working
--                      copy and a change request into the development branch). None names a product-API
--                      tool, so each holds `tool` null, as a filing does.
-- Every existing row is a fix or a filing, which the wider check admits.
--
-- ROLLBACK: once no row holds kind deploy, command or build, restore support_proposals_kind_chk with
-- ('fix', 'filing').
ALTER TABLE "support_proposals" DROP CONSTRAINT IF EXISTS "support_proposals_kind_chk";--> statement-breakpoint
ALTER TABLE "support_proposals" ADD CONSTRAINT "support_proposals_kind_chk" CHECK ("support_proposals"."kind" IN ('fix', 'filing', 'deploy', 'command', 'build') AND ("support_proposals"."kind" = 'fix') = ("support_proposals"."tool" IS NOT NULL));
