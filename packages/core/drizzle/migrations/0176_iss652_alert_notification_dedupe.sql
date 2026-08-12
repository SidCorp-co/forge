-- ISS-652 fix — durable per-recipient dedupe/claim for the ops-alert sweeper.
-- At most one UNREAD ops_alert row per (user_id, resolution_key); the sweeper
-- claims via INSERT ... ON CONFLICT DO NOTHING, atomic under concurrent
-- sweepers (unlike a check-then-insert).
-- Scoped to type = 'ops_alert' like 0175's threshold index: other types
-- deliberately allow several unread rows under one resolution key
-- (notify-transitions.ts emits both `waiting` and `reopen` under
-- `issue:<id>:status`), so an unscoped index cannot be created on live data
-- and would afterwards make those inserts raise a swallowed unique violation.
CREATE UNIQUE INDEX "notifications_user_resolution_key_unread_uq" ON "notifications" USING btree ("user_id","resolution_key") WHERE read = false AND resolution_key IS NOT NULL AND "type" = 'ops_alert';
