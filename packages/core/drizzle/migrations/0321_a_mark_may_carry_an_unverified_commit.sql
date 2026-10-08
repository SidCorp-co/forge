-- ISS-1409 — an agent's commit mark in a project Forge has no way to read the repository of is
-- recorded as the `asserted` mark it always was, and the commit it named is kept as a claim.
--
-- `merged_claimed_commit` is that claim. The mark's KIND is still read from `merged_at`,
-- `merged_commit_sha` and `merged_landing` alone (`packages/core/src/issues/merge-record.ts`), so
-- the claim never makes a mark `observed`: the CHECK holds it beside a mark and never beside a merged
-- commit, and the one writer of the merge columns clears it in the statement that stamps one. It is
-- work evidence for `developed` and `testing`, and what a later `mark_merged` verifies against the
-- repository once the project gives Forge a way to read it.
--
-- Additive and nullable: every existing row reads back NULL, no row's data moves, and the CHECK
-- holds on every row because none carries a value.
-- Rollback: the column can stay unread, or `ALTER TABLE issues DROP COLUMN merged_claimed_commit`.
ALTER TABLE "issues" ADD COLUMN "merged_claimed_commit" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_claimed_commit_chk" CHECK ("issues"."merged_claimed_commit" IS NULL OR ("issues"."merged_at" IS NOT NULL AND "issues"."merged_commit_sha" IS NULL AND "issues"."merged_claimed_commit" ~ '^[0-9a-f]{7,64}$'));
