-- ISS-1229 round 13 — a bell group and its members read one clock: when each record reached the
-- reader. A group's delivery row is made when its first member arrives and later members join it, so
-- the delivery's `created_at` dates the group and nothing dated a member.
--
-- Core kept no earlier record of when a member joined, so an existing row is filled with its
-- delivery's `created_at`, the moment the group was made: a member that joined later reads as old as
-- its group. The default dates every member written from here on.
ALTER TABLE "notification_delivery_members" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "notification_delivery_members" m SET "delivered_at" = d."created_at" FROM "notification_deliveries" d WHERE d."id" = m."delivery_id";--> statement-breakpoint
ALTER TABLE "notification_delivery_members" ALTER COLUMN "delivered_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "notification_delivery_members" ALTER COLUMN "delivered_at" SET NOT NULL;
