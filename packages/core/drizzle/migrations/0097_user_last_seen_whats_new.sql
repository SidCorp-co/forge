-- ISS-384 — in-app "What's New" feed: per-user last-seen marker.
--
-- Stores the identity of the newest changelog entry the user has seen (the
-- version string, or `unreleased:<hash>` for the moving [Unreleased] section).
-- The nav badge is shown while this differs from the current top entry, and
-- cleared (set to the current top id) when the user opens the What's New feed.
--
-- Nullable: absent means the user has never opened the feed. No backfill — a
-- null marker simply shows the badge on first load.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0087-0096 headers). The runtime migrator applies this row from
-- _journal.json.

ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "last_seen_whats_new" text;
