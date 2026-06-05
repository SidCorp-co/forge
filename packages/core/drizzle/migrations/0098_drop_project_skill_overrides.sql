-- ISS-388 — global skills become immutable templates; remove the override/fork
-- surface entirely. The only per-project customization left is a same-name
-- project skill that shadows the global (dedup-by-name in the resolver).
--
-- Clean break (jarvis-agents style): the `project_skill_overrides` table and
-- any rows it holds are dropped WITHOUT reconciliation. Any wanted
-- customization must be re-created as a project skill. Dropping the table also
-- drops its indexes and FK constraints.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0084-0097 headers). The runtime migrator applies this row from
-- _journal.json.

DROP TABLE IF EXISTS "project_skill_overrides";
