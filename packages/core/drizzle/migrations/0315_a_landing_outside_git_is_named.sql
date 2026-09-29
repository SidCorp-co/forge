-- ISS-1327 — a landing outside git is named on the issue, not implied by a timestamp.
--
-- `merged_landing` is where the work of a project that does not land in git now lives — a live
-- URL, a CMS entry, a published storefront resource. It is written only by
-- `packages/core/src/issues/merge-record.ts` alongside `merged_at`, and which projects must carry
-- it is decided by `packages/core/src/issues/landing-evidence.ts` alone.
--
-- Additive and nullable: every existing row reads back exactly as before (a NULL landing), no
-- row's data moves, and the CHECK holds on every row today because no row carries a landing yet.
-- Rollback: the column can stay unread, or `ALTER TABLE issues DROP COLUMN merged_landing`.
ALTER TABLE "issues" ADD COLUMN "merged_landing" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_landing_chk" CHECK ("issues"."merged_landing" IS NULL OR ("issues"."merged_at" IS NOT NULL AND btrim("issues"."merged_landing") <> '' AND char_length("issues"."merged_landing") <= 2000));
