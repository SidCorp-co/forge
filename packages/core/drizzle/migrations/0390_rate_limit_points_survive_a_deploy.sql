-- ISS-190: rate-limiter-flexible's Postgres store keeps each key's consumed points here, so a
-- limit no longer resets on every deploy and an expired key is swept instead of held for ever.
-- The column shape is the library's own (`expire` is epoch milliseconds).
CREATE TABLE IF NOT EXISTS "rate_limit_points" (
  "key" varchar(255) PRIMARY KEY NOT NULL,
  "points" integer DEFAULT 0 NOT NULL,
  "expire" bigint
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_points_expire_idx" ON "rate_limit_points" ("expire");
