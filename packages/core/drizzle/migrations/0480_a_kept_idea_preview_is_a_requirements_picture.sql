-- A kept idea preview is a requirement's picture (REQ-41 BC-16; docs/proposals/chat-first.md "Idea
-- preview"): `requirement_pictures.kind` takes `preview`, whose content is the sketch branch and its
-- head, the patch id the box reported and the page's one rrweb snapshot. Written by the keep of an
-- idea preview only; the picture route refuses the kind. Widening a CHECK leaves every existing row valid.
--
-- ROLLBACK: DELETE FROM "requirement_pictures" WHERE "kind" = 'preview' (clearing any
-- requirement_revisions.picture_id that names one first); then rebuild requirement_pictures_kind_chk
-- with the four kinds it held before.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_pictures" DROP CONSTRAINT IF EXISTS "requirement_pictures_kind_chk";--> statement-breakpoint
ALTER TABLE "requirement_pictures" ADD CONSTRAINT "requirement_pictures_kind_chk" CHECK ("kind" IN ('flow', 'example_table', 'wireframe', 'chart', 'preview'));
