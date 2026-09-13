-- The `forge-*` component vocabulary was removed on 2026-09-14. Both columns
-- held the ROOT COMPONENT NAME of a body, which is meaningless once there are
-- no components: nothing writes one any more, and the reader that used it
-- (web-v2 `deriveCommentKind`, which preferred `template` over its regex) reads
-- the regex again.
--
-- The owner's call on the data: 11 rows fleet-wide carried a value and none of
-- it needs keeping. `format` STAYS — it still decides markdown from sanitized
-- html, and rows of both exist.
ALTER TABLE "comments" DROP COLUMN IF EXISTS "template";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN IF EXISTS "description_template";
--> statement-breakpoint
-- `comments_stage_created_at_idx` served one reader, the per-stage adoption
-- count behind the body mandate, and both went with the component vocabulary.
-- The `stage` and `author_agency` COLUMNS stay: they record a fact at the
-- moment of the write and cannot be recovered once dropped, while an index is
-- derivable and can be added back by whoever next needs to group on it.
DROP INDEX IF EXISTS "comments_stage_created_at_idx";
