-- ISS-652 fix — durable per-recipient dedupe/claim for the ops-alert sweeper.
-- At most one UNREAD row per (user_id, resolution_key); the sweeper claims via
-- INSERT ... ON CONFLICT (user_id, resolution_key) WHERE read = false DO NOTHING,
-- which is atomic under concurrent sweepers (unlike a check-then-insert).
CREATE UNIQUE INDEX "notifications_user_resolution_key_unread_uq" ON "notifications" USING btree ("user_id","resolution_key") WHERE read = false AND resolution_key IS NOT NULL;
