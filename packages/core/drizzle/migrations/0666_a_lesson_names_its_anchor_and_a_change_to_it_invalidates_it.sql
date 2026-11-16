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
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_invalid_by_chk" CHECK (("lessons"."invalid_at" IS NULL) = ("lessons"."invalid_by" IS NULL));--> statement-breakpoint
-- A capability card's freshness (§5, §7), keyed by the card's id (cards live in code, owned by no
-- project): owed a re-check since a landing touched it; the last replay of each scenario; each delta
-- a lesson that held folded into it, proposed until the card's code carries it. New tables, no row.
-- ROLLBACK (continued): DROP TABLE card_deltas; DROP TABLE card_scenario_runs; DROP TABLE card_rechecks;
CREATE TABLE IF NOT EXISTS "card_rechecks" (
  "card_id" text PRIMARY KEY NOT NULL,
  "owed_since" timestamp with time zone DEFAULT now() NOT NULL,
  "owed_by" text NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_scenario_runs" (
  "card_id" text NOT NULL,
  "scenario" text NOT NULL,
  "passed" integer NOT NULL,
  "change" text NOT NULL,
  "reason" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "card_scenario_runs_passed_chk" CHECK ("card_scenario_runs"."passed" IN (0, 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_scenario_runs_card_scenario_uq" ON "card_scenario_runs" ("card_id", "scenario");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "card_deltas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" text NOT NULL,
  "field" text NOT NULL,
  "op" text NOT NULL,
  "text" text NOT NULL,
  "replaces" text,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "from_lesson" text NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "card_deltas_field_chk" CHECK ("card_deltas"."field" IN ('situation', 'bestPractice', 'redFlag')),
  CONSTRAINT "card_deltas_op_chk" CHECK ("card_deltas"."op" IN ('add', 'update')),
  CONSTRAINT "card_deltas_status_chk" CHECK ("card_deltas"."status" IN ('proposed', 'applied', 'dropped')),
  CONSTRAINT "card_deltas_replaces_chk" CHECK (("card_deltas"."op" = 'update') = ("card_deltas"."replaces" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_deltas_card_idx" ON "card_deltas" ("card_id", "status");
