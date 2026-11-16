-- ISS-1251 (owner 2026-11-16, §5 freshness): a lesson names what it is about, and the change that
-- touches it invalidates it, kept for its history and served to no agent until the steward re-admits,
-- edits or retires it.
--   lessons.anchor: `card:<id>`, `REQ-<n> BC-<m>` or `<path>[:<symbol>]`; NULL on a lesson drafted
--     before, which the steward's pass anchors from its record or lists as owing one.
--   lessons.invalid_at, lessons.invalid_by: when a landing touched the anchor, and which (`ISS-12`),
--     with what it touched; both NULL while the lesson stands.
-- NULL on every row standing today, so no row is changed and the CHECKs hold.
--
-- ROLLBACK:
--   ALTER TABLE lessons DROP CONSTRAINT lessons_invalid_by_chk;
--   ALTER TABLE lessons DROP CONSTRAINT lessons_anchor_chk;
--   ALTER TABLE lessons DROP COLUMN invalid_by;
--   ALTER TABLE lessons DROP COLUMN invalid_at;
--   ALTER TABLE lessons DROP COLUMN anchor;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "anchor" text;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "invalid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "invalid_by" text;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_anchor_chk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_anchor_chk" CHECK ("lessons"."anchor" IS NULL OR length("lessons"."anchor") BETWEEN 3 AND 240);--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_invalid_by_chk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_invalid_by_chk" CHECK (("lessons"."invalid_at" IS NULL) = ("lessons"."invalid_by" IS NULL));
