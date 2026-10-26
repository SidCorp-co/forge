-- ISS-1300 round 3 — a person's mark carries the commit that landed.
--
-- `merged_commit_stated` says the commit in `merged_commit_sha` is one a person named, which the
-- project's repository was read to hold, and not a merge Forge saw land. The mark's kind reads it
-- (`packages/core/src/issues/merge-record.ts:mergeMarkKindOf`): a stated commit is `asserted`, a
-- claim, never `observed`. The CHECK holds the flag beside a commit and nowhere else.
--
-- Additive: every existing row reads back false, which is what each of them is (every commit the
-- column holds today is one Forge read from a pull request or the repository), and no row's data
-- moves. Rollback: `ALTER TABLE issues DROP COLUMN merged_commit_stated`, after which a stated
-- commit reads `observed`.
ALTER TABLE "issues" ADD COLUMN "merged_commit_stated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_commit_stated_chk" CHECK (NOT "issues"."merged_commit_stated" OR ("issues"."merged_at" IS NOT NULL AND "issues"."merged_commit_sha" IS NOT NULL));
