CREATE TABLE "assistant_speaker_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"external_label" text,
	"user_id" uuid NOT NULL,
	"confirmed_via" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_speaker_links" ADD CONSTRAINT "assistant_speaker_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_speaker_links_speaker_unique" ON "assistant_speaker_links" USING btree ("source","external_namespace","external_id");--> statement-breakpoint
CREATE INDEX "assistant_speaker_links_user_idx" ON "assistant_speaker_links" USING btree ("user_id");