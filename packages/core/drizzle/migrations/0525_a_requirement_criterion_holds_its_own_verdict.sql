-- A business criterion judged on the running build at the requirement itself (ISS-588, REQ-74 BC-4,
-- BC-5). A requirement whose capability already shipped has no issue to carry its proof, and REQ-45
-- r3 BC-8 forbids filing one whose only work is verifying it; until now coverage read only verdicts
-- on issue criteria, so such a requirement could hold no proof and its breakdown stayed owed forever.
-- One insert-only row per judgement: the wording it judged (requirement_criteria.id, so a reworded
-- criterion's old verdicts read stale, as an issue's trace does), the word, why, what it cites, the
-- whole commit the running build was judged at, and who wrote it.
--
-- No row is backfilled: nothing judged a requirement this way before. ROLLBACK: drop the table;
-- coverage then reads issue criteria alone, as before this deploy.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_criterion_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL REFERENCES "requirements"("id") ON DELETE CASCADE,
  "requirement_criterion_id" uuid NOT NULL REFERENCES "requirement_criteria"("id") ON DELETE CASCADE,
  "verdict" text NOT NULL,
  "reason" text,
  "evidence" text[] DEFAULT '{}'::text[] NOT NULL,
  "commit_sha" text,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "author_device_id" uuid,
  "author_agency" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "requirement_criterion_verdicts_verdict_chk" CHECK ("verdict" IN ('pass', 'short', 'fail', 'skipped')),
  CONSTRAINT "requirement_criterion_verdicts_agency_chk" CHECK ("author_agency" IN ('human', 'agent')),
  CONSTRAINT "requirement_criterion_verdicts_commit_chk" CHECK ("commit_sha" IS NULL OR "commit_sha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "requirement_criterion_verdicts_judged_chk" CHECK ("verdict" = 'skipped' OR ("commit_sha" IS NOT NULL AND cardinality("evidence") > 0)),
  CONSTRAINT "requirement_criterion_verdicts_skipped_reason_chk" CHECK ("verdict" <> 'skipped' OR coalesce("reason", '') ~ '[^[:space:]]')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requirement_criterion_verdicts_requirement_idx" ON "requirement_criterion_verdicts" ("requirement_id", "created_at" DESC);
