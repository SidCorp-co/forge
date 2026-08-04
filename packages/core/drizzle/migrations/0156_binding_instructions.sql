-- Per-binding operator instructions, rendered verbatim under the provider's
-- bullet in the "Project integrations" prompt block. Nullable: the vast
-- majority of bindings carry none and inherit only the provider's guide.
ALTER TABLE "integration_bindings" ADD COLUMN "instructions" text;
