-- A release tags the commit its version names before anything is deployed from it (ISS-755 r2,
-- REQ-63 r7 BC-13..15): on a promotion release once the promotion is seen merged, otherwise at the cut.
--
-- release.committed is an outbox event type: the release writes one, once per run, in the unit that
-- records the commit its tag is owed on (`release-batch/release-tag.ts:oweReleaseTag`). Its one
-- consumer, `release-tag`, puts `v<version>` on that commit through the source host binding; it no
-- longer consumes `release.shipped`. A new type only: no existing row changes.
--
-- ROLLBACK: DELETE FROM outbox_event_types WHERE type = 'release.committed', once no
-- pipeline_outbox row names it.

INSERT INTO "outbox_event_types" ("type") VALUES ('release.committed') ON CONFLICT DO NOTHING;
