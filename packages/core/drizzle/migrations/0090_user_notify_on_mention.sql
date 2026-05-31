-- Notification delivery preference: per-user opt-out of in-app `mention`
-- notifications (Settings → Notifications, web-v2 ISS-318).
--
-- Adds `user_preferences.notify_on_mention` (default true → opted-in, so
-- existing rows and absent rows keep notifying). `createNotification` gates
-- only the `mention` type on this flag; system/escalation notifications are
-- always delivered. `mention` is the only user-initiated notification type
-- currently produced, so it is the only honest opt-out exposed — no controls
-- for unimplemented delivery channels.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0087/0088/0089 headers). The runtime migrator
-- applies this row from _journal.json.

ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "notify_on_mention" boolean DEFAULT true NOT NULL;
