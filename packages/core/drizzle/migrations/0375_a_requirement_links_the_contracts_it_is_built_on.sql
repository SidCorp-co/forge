CREATE TABLE "requirement_contracts" (
	"requirement_id" uuid NOT NULL,
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"linked_by" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_contracts_requirement_id_provider_project_id_contract_slug_pk" PRIMARY KEY("requirement_id","provider_project_id","contract_slug")
);
--> statement-breakpoint
ALTER TABLE "requirement_contracts" ADD CONSTRAINT "requirement_contracts_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_contracts" ADD CONSTRAINT "requirement_contracts_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_contracts" ADD CONSTRAINT "requirement_contracts_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_contracts_contract_idx" ON "requirement_contracts" USING btree ("provider_project_id","contract_slug");