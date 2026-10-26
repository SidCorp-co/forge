-- ISS-1421 r32 — judge-132: a project's integration removed (its binding switched off for the project)
-- could not be connected again. `integration_bindings_service_uq` held every SERVICE binding to one per
-- (project, provider, label), switched off or on, so the new binding collided with the removed one and
-- the create answered that an active binding already existed, which was untrue. The index now holds the
-- switched-on ones to one, which is what its own comment in 0253 said it did; a removed binding stays as
-- the record of what was connected and blocks nothing.
--
-- Nothing is lost: the new index covers a subset of the rows the old one held unique, so it builds over
-- any table the old one stood on.
--
-- Rollback: recreate the index `WHERE role = 'service'`. That aborts naming the tuple where a project
-- has connected a provider again since, which is the row a rollback would have to choose about.
DROP INDEX IF EXISTS "integration_bindings_service_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "integration_bindings_service_uq"
    ON "integration_bindings" ("project_id","provider","label")
 WHERE role = 'service' AND active;
