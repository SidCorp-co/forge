-- A person's decision settled through an act no other event reports tells the workspace's Activity
-- (ISS-1053): a revision's accept, a requirement's re-pin, a suggestion's accept, reject or withdrawal,
-- and a contract version's approve or return each write one `decision.settled`. Its one consumer,
-- `org-activity`, frames `org.activity.changed` and marks the project's held glances stale, so the
-- settled item leaves "waiting on you" on the next read. A new type only: no existing row changes.
--
-- ROLLBACK: DELETE FROM outbox_event_types WHERE type = 'decision.settled', once no
-- pipeline_outbox row names it.

INSERT INTO "outbox_event_types" ("type") VALUES ('decision.settled') ON CONFLICT DO NOTHING;
