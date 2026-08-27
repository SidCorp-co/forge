CREATE UNIQUE INDEX "notifications_ops_alert_active_uq" ON "notifications" USING btree ("user_id","resolution_key") WHERE resolved_at IS NULL AND resolution_key IS NOT NULL AND "type" = 'ops_alert';
