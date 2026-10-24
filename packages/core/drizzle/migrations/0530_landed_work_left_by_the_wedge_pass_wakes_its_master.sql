-- Landed work the wedge pass leaves at `in_progress` wakes the project's master (ISS-564 round 2).
--
-- issue.landedWorkLeft is an outbox event type: the reconciler writes one per mark, in the
-- transaction of the notice it posts on an `in_progress` issue nothing holds whose merge stands
-- (`pipeline/reconciler.ts:leaveLandedWork`). Its one consumer, `master-wake`, wakes the master that
-- owes the move to `awaiting_release`. A new type only: no existing row changes.
--
-- ROLLBACK: DELETE FROM outbox_event_types WHERE type = 'issue.landedWorkLeft', once no
-- pipeline_outbox row names it.

INSERT INTO "outbox_event_types" ("type") VALUES ('issue.landedWorkLeft') ON CONFLICT DO NOTHING;
