-- ISS-1228 — a run session or a master is never left `idle`. Core opens both kinds `running`, and the
-- only write that ever set them `idle` was End this turn (`POST /agent-sessions/abort`), which their
-- box never acts on: the box's `agent:abort` ends a chat's turn and nothing else. A run session left
-- `idle` read "Not started" while its agent ran on, and its own reaper, which reads `running` only,
-- never ended it, so it held its issues for ever. That route now refuses every kind but a chat.
--
-- The old route had no status guard, so a session core had already ended could be flipped too.
-- Where the newest status move recorded for the session is to an ended status and it has not
-- checked in since, it takes that status back. Every other such session, an ambiguous history
-- included, is set `running`: its box's check-ins hold it, and its reaper ends it ten minutes after
-- its last beat, whereas a wrong ended status would end live work. Each move is recorded.
SELECT set_config('forge.kernel_txn', txid_current()::text, true);--> statement-breakpoint
WITH stuck AS (
  SELECT s.id, s.last_heartbeat_at,
         (SELECT m.to_status FROM (
            SELECT t.to_status, t.created_at AS at FROM kernel_transitions t
             WHERE t.entity = 'session' AND t.entity_id = s.id
            UNION ALL
            SELECT u.to_status, u.detected_at AS at FROM unaudited_transitions u
             WHERE u.entity = 'session' AND u.entity_id = s.id
          ) m ORDER BY m.at DESC LIMIT 1) AS last_status,
         (SELECT max(m.at) FROM (
            SELECT t.created_at AS at FROM kernel_transitions t
             WHERE t.entity = 'session' AND t.entity_id = s.id
            UNION ALL
            SELECT u.detected_at AS at FROM unaudited_transitions u
             WHERE u.entity = 'session' AND u.entity_id = s.id
          ) m) AS last_at
    FROM agent_sessions s
   WHERE s.kind IN ('run_session', 'master') AND s.status = 'idle'
),
target AS (
  SELECT id,
         CASE
           WHEN last_status IN ('completed', 'failed', 'completed_via_recovery', 'cancelled_stale', 'cancelled')
                AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= last_at)
             THEN last_status
           ELSE 'running'
         END AS status
    FROM stuck
),
moved AS (
  UPDATE agent_sessions s
     SET status = target.status, updated_at = now()
    FROM target
   WHERE s.id = target.id AND s.status = 'idle'
  RETURNING s.id, target.status
)
INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, reason, actor_type, actor_agency, source)
SELECT 'session', moved.id, 'idle', moved.status, 'turn_end_left_a_box_session_idle', 'system', 'agent', 'migration-0338'
  FROM moved;
