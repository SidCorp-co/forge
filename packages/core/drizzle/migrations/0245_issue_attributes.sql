CREATE TABLE "issue_attribute_defs" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"value_type" text NOT NULL,
	"cardinality" text DEFAULT 'one' NOT NULL,
	"written_by" text NOT NULL,
	"surfaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_text" text,
	"value_num" double precision,
	"value_bool" boolean,
	"value_ts" timestamp with time zone,
	"value_ref" uuid,
	"source_comment_id" uuid,
	"asserted_by_user_id" uuid,
	"asserted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_attributes" ADD CONSTRAINT "issue_attributes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attributes" ADD CONSTRAINT "issue_attributes_key_issue_attribute_defs_key_fk" FOREIGN KEY ("key") REFERENCES "public"."issue_attribute_defs"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attributes" ADD CONSTRAINT "issue_attributes_source_comment_id_comments_id_fk" FOREIGN KEY ("source_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_attributes" ADD CONSTRAINT "issue_attributes_asserted_by_user_id_users_id_fk" FOREIGN KEY ("asserted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_attributes_issue_key_idx" ON "issue_attributes" USING btree ("issue_id","key");--> statement-breakpoint
CREATE INDEX "issue_attributes_ref_idx" ON "issue_attributes" USING btree ("value_ref");
--> statement-breakpoint
INSERT INTO "issue_attribute_defs" ("key","label","value_type","cardinality","written_by","surfaces","required") VALUES
	('obligation','Outstanding','text','many','agent','["state","exception"]',false),
	('obligation_owner','Owed by','ref_user','one','agent','["state"]',true),
	('obligation_carrier','Carried by','ref_issue','one','agent','["state"]',false),
	('delivered','Delivered','number','one','agent','["state","pulse"]',false),
	('delivered_of','Of','number','one','agent','["state","pulse"]',false),
	('blocking','Blocking','ref_issue','many','agent','["state"]',false),
	('supersedes','Supersedes','ref_issue','one','agent','["state"]',false),
	('human_required','Needs a person','bool','one','agent','["state","exception"]',false),
	('irreversible_if_wrong','Irreversible if wrong','text','one','agent','["decision"]',false),
	('source','Source','ref_comment','one','agent','["evidence"]',false)
ON CONFLICT ("key") DO NOTHING;
