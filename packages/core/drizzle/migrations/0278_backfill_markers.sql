CREATE TABLE "backfill_markers" (
	"key" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
