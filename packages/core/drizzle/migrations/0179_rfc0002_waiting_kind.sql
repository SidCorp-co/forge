-- RFC 0002 phase 2 — `issues.waiting_kind`.
--
-- `waiting` used to mean five things and the meaning was DERIVED at read time
-- (`classifyWaitingCause`) from `merged_at`, the decompose-child count and the
-- latest run's jsonb `pauseReason`. That chain was structurally blind on
-- ISS-163: a best-effort jsonb write had failed, so a reopen-cap park read back
-- as `merged_parked` and the UI offered no override button at all.
--
-- The kind is now AUTHORED and stored. Two values, both meaning "a human is
-- needed": `needs_decision` (someone must decide) and `needs_resource` (someone
-- must supply something the agent cannot create). Nothing in core writes them —
-- an agent or a human does, alongside the status.
--
-- Nullable with no backfill on purpose: an issue already at `waiting` when this
-- deploys has no authored kind, and inventing one would be the derivation this
-- migration exists to delete. The UI renders those with the generic
-- "a human is needed" copy until someone re-states the reason.

ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "waiting_kind" text;--> statement-breakpoint

-- The value set is enforced in TypeScript (db/schema.ts `waitingKinds`) rather
-- than as a CHECK, matching every other status-like column in this schema:
-- a CHECK here would make adding a kind a migration instead of an edit, and
-- the write path is a single chokepoint (issues/apply-transition.ts).
CREATE INDEX IF NOT EXISTS "issues_waiting_kind_idx" ON "issues" ("project_id", "waiting_kind")
  WHERE waiting_kind IS NOT NULL;
