CREATE TABLE "device_run_ledger" (
	"device_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid,
	"master_session_id" uuid,
	"pid" integer,
	"worktree_path" text NOT NULL,
	"boot_id" text NOT NULL,
	"incarnation" text NOT NULL,
	"work" text NOT NULL,
	"blocker_kind" text,
	"waiting_on" text,
	"issues" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_run_ledger_device_id_run_id_pk" PRIMARY KEY("device_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "device_run_ledger" ADD CONSTRAINT "device_run_ledger_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_run_ledger" ADD CONSTRAINT "device_run_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_run_ledger_project_idx" ON "device_run_ledger" USING btree ("project_id");