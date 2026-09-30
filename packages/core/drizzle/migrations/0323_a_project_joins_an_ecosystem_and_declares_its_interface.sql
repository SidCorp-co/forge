-- Ecosystems, their two-party memberships and each project's interface document (ISS-19, slice E1
-- of the ecosystem design). An ecosystem and an interface are authored documents written with
-- { baseRevision, document } and refused STALE_BASE when the revision moved; every accepted write
-- also inserts one write-once revision row. A membership changes only by its transitions, which a
-- trigger holds to invited -> active | declined and active -> left | removed, and every transition
-- is kept as a write-once event. ecosystem_consumptions is derived: rewritten from the consumer's
-- interface in the same transaction that stores it. contract_versions and channel_counters are
-- created empty for E2 and E3 to write; E1 only reads them, for VERSION_UNKNOWN and
-- CHANNEL_CODE_IN_USE. Every table is new and starts empty; rollback is dropping them.
CREATE TABLE "channel_counters" (
	"ecosystem_id" uuid NOT NULL,
	"type" text NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "channel_counters_ecosystem_id_type_pk" PRIMARY KEY("ecosystem_id","type"),
	CONSTRAINT "channel_counters_type_chk" CHECK ("channel_counters"."type" IN ('change-notice', 'acknowledgement', 'rfi', 'change-request', 'decision')),
	CONSTRAINT "channel_counters_last_number_chk" CHECK ("channel_counters"."last_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "contract_versions" (
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"version" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_versions_provider_project_id_contract_slug_version_pk" PRIMARY KEY("provider_project_id","contract_slug","version")
);
--> statement-breakpoint
CREATE TABLE "ecosystem_consumptions" (
	"consumer_project_id" uuid NOT NULL,
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"ecosystem_id" uuid NOT NULL,
	"built_against" text NOT NULL,
	CONSTRAINT "ecosystem_consumptions_consumer_project_id_provider_project_id_contract_slug_ecosystem_id_pk" PRIMARY KEY("consumer_project_id","provider_project_id","contract_slug","ecosystem_id"),
	CONSTRAINT "ecosystem_consumptions_not_self_chk" CHECK ("ecosystem_consumptions"."consumer_project_id" <> "ecosystem_consumptions"."provider_project_id")
);
--> statement-breakpoint
CREATE TABLE "ecosystem_membership_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"verb" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ecosystem_membership_events_verb_chk" CHECK ("ecosystem_membership_events"."verb" IN ('invite', 'accept', 'decline', 'leave', 'remove'))
);
--> statement-breakpoint
CREATE TABLE "ecosystem_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ecosystem_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"state" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "ecosystem_memberships_state_chk" CHECK ("ecosystem_memberships"."state" IN ('invited', 'active', 'declined', 'left', 'removed')),
	CONSTRAINT "ecosystem_memberships_decided_chk" CHECK (("ecosystem_memberships"."state" = 'invited') = ("ecosystem_memberships"."decided_by" IS NULL AND "ecosystem_memberships"."decided_at" IS NULL)),
	CONSTRAINT "ecosystem_memberships_ended_chk" CHECK (("ecosystem_memberships"."state" IN ('left', 'removed')) = ("ecosystem_memberships"."ended_at" IS NOT NULL AND "ecosystem_memberships"."ended_reason" IS NOT NULL AND length("ecosystem_memberships"."ended_reason") BETWEEN 1 AND 500))
);
--> statement-breakpoint
CREATE TABLE "ecosystem_revisions" (
	"ecosystem_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"written_by" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ecosystem_revisions_ecosystem_id_revision_pk" PRIMARY KEY("ecosystem_id","revision"),
	CONSTRAINT "ecosystem_revisions_revision_chk" CHECK ("ecosystem_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "ecosystems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"channel_code" text NOT NULL,
	"steward_org_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ecosystems_revision_chk" CHECK ("ecosystems"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_interface_revisions" (
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"written_by" uuid NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_interface_revisions_project_id_revision_pk" PRIMARY KEY("project_id","revision"),
	CONSTRAINT "project_interface_revisions_revision_chk" CHECK ("project_interface_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_interfaces" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_interfaces_revision_chk" CHECK ("project_interfaces"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "channel_counters" ADD CONSTRAINT "channel_counters_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_consumptions" ADD CONSTRAINT "ecosystem_consumptions_consumer_project_id_projects_id_fk" FOREIGN KEY ("consumer_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_consumptions" ADD CONSTRAINT "ecosystem_consumptions_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_consumptions" ADD CONSTRAINT "ecosystem_consumptions_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_membership_events" ADD CONSTRAINT "ecosystem_membership_events_membership_id_ecosystem_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."ecosystem_memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_membership_events" ADD CONSTRAINT "ecosystem_membership_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_memberships" ADD CONSTRAINT "ecosystem_memberships_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_memberships" ADD CONSTRAINT "ecosystem_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_memberships" ADD CONSTRAINT "ecosystem_memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_memberships" ADD CONSTRAINT "ecosystem_memberships_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_revisions" ADD CONSTRAINT "ecosystem_revisions_ecosystem_id_ecosystems_id_fk" FOREIGN KEY ("ecosystem_id") REFERENCES "public"."ecosystems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystem_revisions" ADD CONSTRAINT "ecosystem_revisions_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystems" ADD CONSTRAINT "ecosystems_steward_org_id_organizations_id_fk" FOREIGN KEY ("steward_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ecosystems" ADD CONSTRAINT "ecosystems_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_interface_revisions" ADD CONSTRAINT "project_interface_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_interface_revisions" ADD CONSTRAINT "project_interface_revisions_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_interfaces" ADD CONSTRAINT "project_interfaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_interfaces" ADD CONSTRAINT "project_interfaces_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ecosystem_consumptions_provider_idx" ON "ecosystem_consumptions" USING btree ("provider_project_id");--> statement-breakpoint
CREATE INDEX "ecosystem_membership_events_membership_id_idx" ON "ecosystem_membership_events" USING btree ("membership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystem_memberships_open_uq" ON "ecosystem_memberships" USING btree ("ecosystem_id","project_id") WHERE state IN ('invited', 'active');--> statement-breakpoint
CREATE INDEX "ecosystem_memberships_project_id_idx" ON "ecosystem_memberships" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystems_slug_uq" ON "ecosystems" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "ecosystems_channel_code_uq" ON "ecosystems" USING btree ("channel_code");--> statement-breakpoint
CREATE INDEX "ecosystems_steward_org_id_idx" ON "ecosystems" USING btree ("steward_org_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION ecosystem_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is write-once: a row cannot be %', TG_TABLE_NAME, lower(TG_OP);
END;
$$;--> statement-breakpoint
CREATE TRIGGER ecosystem_revisions_write_once_trg BEFORE UPDATE OR DELETE ON "ecosystem_revisions" FOR EACH ROW EXECUTE FUNCTION ecosystem_write_once();--> statement-breakpoint
CREATE TRIGGER project_interface_revisions_write_once_trg BEFORE UPDATE ON "project_interface_revisions" FOR EACH ROW EXECUTE FUNCTION ecosystem_write_once();--> statement-breakpoint
CREATE TRIGGER ecosystem_membership_events_write_once_trg BEFORE UPDATE ON "ecosystem_membership_events" FOR EACH ROW EXECUTE FUNCTION ecosystem_write_once();--> statement-breakpoint
CREATE OR REPLACE FUNCTION ecosystem_membership_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ecosystem_id <> OLD.ecosystem_id OR NEW.project_id <> OLD.project_id
     OR NEW.invited_by <> OLD.invited_by OR NEW.invited_at <> OLD.invited_at THEN
    RAISE EXCEPTION 'membership %: ecosystem, project and invitation are fixed at invite', OLD.id;
  END IF;
  IF OLD.decided_by IS NOT NULL AND (NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'membership %: who decided it, and when, is fixed once decided', OLD.id;
  END IF;
  IF NOT ((OLD.state = 'invited' AND NEW.state IN ('active', 'declined'))
       OR (OLD.state = 'active' AND NEW.state IN ('left', 'removed'))) THEN
    RAISE EXCEPTION 'membership %: % -> % is not a transition; invited -> active | declined, active -> left | removed', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ecosystem_memberships_transition_trg BEFORE UPDATE ON "ecosystem_memberships" FOR EACH ROW EXECUTE FUNCTION ecosystem_membership_transition();
