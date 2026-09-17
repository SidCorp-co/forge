-- ISS-1085 slice 3 — the way back from 0268_sentry_admission_thresholds.sql.
--
-- NOT run by `db/migrate.js`. This file is applied BY HAND, against the database, BEFORE the
-- previous image is started — never after. The previous image's boot migrator knows only its
-- own migrations, so starting it against the new schema makes it loop; and the runtime image
-- installs only openssh-keygen, openssh-client and git, so there is no `psql` inside it.
-- Reach the database from a one-off container on the app's own network:
--
--   docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' <core-container>
--   docker run --rm --network <that-network> -i postgres:16 \
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     < packages/core/drizzle/rollback/0268_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0268_down.sql` would make psql look
-- for the file INSIDE the disposable container, which has no checkout mounted.
--
-- Then:
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0268 hash>';
-- and start the previous image.
--
-- READ THIS BEFORE RUNNING IT: THIS ONE LOSES SOMETHING, AND USUALLY YOU DO NOT NEED IT.
--
-- `admin_thresholds` is a single-row operator-policy table. The two columns this drops hold an
-- operator's OWN tuning of how loud a Sentry issue must be before Forge files it, and nothing
-- else in the system holds a second copy: dropping them is not dropping a cache, it is dropping
-- a decision a human made. There is no projection to rebuild them from.
--
-- The previous image does not need them gone. Drizzle's reads name their columns explicitly, so
-- an old `@forge/core` selecting from `admin_thresholds` neither sees nor is troubled by two
-- extra `integer NOT NULL DEFAULT` columns it has never heard of. **The preferred way back from
-- 0268 is to start the previous image and leave the columns in place** — the forward migration
-- is additive, and the old code is indifferent to the addition.
--
-- Run this file only when you must re-apply 0268 from a clean slate, and accept that the two
-- values go with it. Write them down first:
--
--   SELECT sentry_min_event_count, sentry_min_user_count FROM admin_thresholds;

BEGIN;

-- === 1. say what is about to be lost =====================================
-- A rollback that silently discards an operator's policy is the same defect as a migration that
-- silently skips: the loss must be visible in the transcript of the person running it, at the
-- moment they can still abort.
DO $$
DECLARE
  ev integer;
  us integer;
BEGIN
  SELECT sentry_min_event_count, sentry_min_user_count INTO ev, us FROM admin_thresholds LIMIT 1;
  IF ev IS NULL THEN
    RAISE NOTICE 'ISS-1085 rollback: admin_thresholds holds no row; nothing is being lost.';
  ELSE
    RAISE NOTICE
      'ISS-1085 rollback: DISCARDING the operator Sentry admission policy — '
      'sentry_min_event_count = %, sentry_min_user_count = %. '
      'These are the only copy. Re-enter them by hand after 0268 is re-applied.', ev, us;
  END IF;
END $$;

-- === 2. the constraints, then the columns ================================
-- The CHECKs are dropped first and by name: an `ALTER TABLE ... DROP COLUMN` would take them
-- with it, but naming them here means a constraint that has been renamed or replaced since 0268
-- fails loudly rather than disappearing inside a cascade nobody reads.
ALTER TABLE admin_thresholds DROP CONSTRAINT admin_thresholds_sentry_min_event_count_ck;
ALTER TABLE admin_thresholds DROP CONSTRAINT admin_thresholds_sentry_min_user_count_ck;

ALTER TABLE admin_thresholds DROP COLUMN sentry_min_event_count;
ALTER TABLE admin_thresholds DROP COLUMN sentry_min_user_count;

COMMIT;
