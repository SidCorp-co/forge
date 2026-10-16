-- ISS-1228 — a comment says it records a release because core's release flow said so as it wrote
-- it, never because of its words. `announces` is set only by core's system writer, to `release`,
-- by the two writers that record a release on an issue.
--
-- Additive and unfilled: the release writers post under the releasing person's own account, so no
-- stored row can be told from a person's comment carrying the same words. Rows written before this
-- column stay NULL rather than be marked on a guess about their text.
ALTER TABLE "comments" ADD COLUMN "announces" text;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_announces_chk" CHECK ("comments"."announces" IN ('release'));
