-- ISS-1003 — one string stops doing three jobs: a join key, an address, and a label.
--
-- `users.email` was all three. It is the key every invitation, reset and OAuth-link path matches
-- on; it was also the only place an agent's handle was stored, recovered by splitting on the first
-- dot; and it was the only thing any screen had to print for any user of any kind. Two of those
-- three leave it here.
--
--   * `organization_members.handle` — the ADDRESS, the thing typed after `@`. It sits on the
--     membership and not on `users` for one reason: the issue's rule is that a handle is unique
--     WITHIN ITS ORG, and `(org_id, handle)` is a unique index only on a table that holds both. A
--     handle column on `users` could be asserted unique-per-org by a writer and enforced by
--     nothing, which is the same defect in a friendlier place. Two orgs may each hold `@forge-dev`;
--     one org may not hold two.
--   * `users.display_name` — the LABEL. Not unique, free text, accented, changeable, and read by
--     nothing that decides anything.
--
-- `users.email` keeps its job and its shape. An agent's stays synthesized at the reserved-invalid
-- domain with its random suffix intact, because that suffix is what lets the two `@forge-dev`s
-- above both exist under a system-wide unique index.
--
-- Not idempotent, and it does not need to be: drizzle applies the whole run in one transaction, so
-- an abort below leaves the database exactly as it was.
--
-- SEARCH PATH — pinned and every relation qualified, for the reason 0240 carries: PL/pgSQL resolves
-- an unqualified name against the INVOKING session's path at execution time, `pg_temp` is searched
-- ahead of `public` without appearing in `SHOW search_path`, and a guard that reads an empty shadow
-- relation finds nothing and passes.
SET LOCAL search_path = public, pg_temp;--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "handle" text;--> statement-breakpoint

-- REFUSE, before anything is written: an agent whose address does not yield a legal handle.
--
-- The shape is `auth/agent-account.ts:HANDLE_PATTERN`, and the CHECK below is what will hold it
-- from here on. A row that cannot satisfy it is named rather than renamed to fit: renaming one
-- would hand whoever addresses `@name` a different principal than the one they have been talking
-- to, silently, which is the whole reason a re-assignable name may not be a key.
DO $$
DECLARE bad RECORD;
BEGIN
  SELECT u.id, u.email INTO bad
  FROM public.users u
  WHERE u.kind = 'agent'
    AND split_part(u.email, '.', 1) !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent % (%) yields the handle "%", which is no legal handle; it is not being renamed to make the constraint apply (ISS-1003)',
      bad.id, bad.email, split_part(bad.email, '.', 1);
  END IF;
END $$;--> statement-breakpoint

-- REFUSE: two agents in ONE org deriving the SAME handle.
--
-- The issue is explicit that this aborts naming BOTH rows and does not rename one to make the
-- constraint apply. Both ids are in the message because the operator's next act is to decide which
-- of the two keeps the name, and a message naming one of them does not say what the other is.
DO $$
DECLARE bad RECORD;
BEGIN
  SELECT om.org_id,
         split_part(u.email, '.', 1) AS handle,
         array_agg(u.id ORDER BY u.created_at, u.id) AS ids,
         array_agg(u.email ORDER BY u.created_at, u.id) AS emails
  INTO bad
  FROM public.organization_members om
  JOIN public.users u ON u.id = om.user_id
  WHERE u.kind = 'agent'
  GROUP BY om.org_id, split_part(u.email, '.', 1)
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'organization % holds % agents that all derive the handle "%": % (addresses %). A handle is unique within its org and neither row is being renamed to make that true (ISS-1003)',
      bad.org_id, array_length(bad.ids, 1), bad.handle, bad.ids, bad.emails;
  END IF;
END $$;--> statement-breakpoint

-- Name what is already there. An agent's handle is what every reader was splitting out of the
-- address up to this migration, so this stores the answer rather than changing it.
UPDATE "organization_members" om
SET "handle" = split_part(u."email", '.', 1)
FROM "users" u
WHERE u."id" = om."user_id" AND u."kind" = 'agent';--> statement-breakpoint

-- And give each agent a label to start from. A person's stays NULL: nobody has typed one yet, and
-- an address invented as a name is the thing this column exists to stop being printed.
UPDATE "users" u
SET "display_name" = split_part(u."email", '.', 1)
WHERE u."kind" = 'agent' AND u."display_name" IS NULL;--> statement-breakpoint

-- The shape, from here on. NULL passes: a person holds no handle today, and the day they do it
-- comes through this same constraint rather than around it.
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_handle_shape"
  CHECK ("handle" IS NULL OR "handle" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');--> statement-breakpoint

-- The rule itself, enforced by the database and not by a caller. Partial on `handle IS NOT NULL`
-- so that the many people in an org who hold no handle do not collide on NULL — which they would
-- not under Postgres's NULL semantics anyway, but a partial index says so to a reader and keeps
-- the index the size of the population that has one.
CREATE UNIQUE INDEX "organization_members_org_handle_uniq"
  ON "organization_members" ("org_id", "handle") WHERE "handle" IS NOT NULL;
