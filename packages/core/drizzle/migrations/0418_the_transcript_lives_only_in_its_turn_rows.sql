-- A session's transcript is stored once, as its `agent_session_turns` rows (TD-C1). Until now every
-- write mirrored the whole `agent_sessions.messages` blob into the rows in one transaction and reads
-- came from either; the blob goes.
--
-- Nothing is rewritten to make a session fit. A session the rows cannot represent exactly aborts the
-- migration naming it: a blob that is not an array, an entry no turn role holds, a row that is not the
-- blob's entry at its index, or a blob entry with no row in a session that has rows. Reconcile that
-- session by hand and deploy again. A session with a blob and no rows at all gets its rows here, one
-- per entry at its index.
--
-- ROLLBACK: ALTER TABLE agent_sessions ADD COLUMN messages jsonb NOT NULL DEFAULT '[]'::jsonb; then
-- UPDATE agent_sessions s SET messages = (SELECT coalesce(jsonb_agg(t.content->'value' ORDER BY
-- t.turn_index), '[]'::jsonb) FROM agent_session_turns t WHERE t.agent_session_id = s.id).

DO $$
DECLARE
  bad record;
BEGIN
  SELECT s.id, jsonb_typeof(s.messages) AS shape INTO bad
  FROM agent_sessions s
  WHERE jsonb_typeof(s.messages) <> 'array'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0418: agent_sessions % holds messages as % rather than an array; no turn rows represent it', bad.id, bad.shape;
  END IF;

  SELECT s.id, e.ord - 1 AS idx, coalesce(e.v -> 'type', 'null'::jsonb)::text AS type INTO bad
  FROM agent_sessions s, jsonb_array_elements(s.messages) WITH ORDINALITY AS e(v, ord)
  WHERE jsonb_typeof(e.v) <> 'object'
     OR coalesce(e.v ->> 'type', '') NOT IN ('user', 'assistant', 'system', 'tool_use', 'tool_result')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0418: agent_sessions % messages[%] has type %, which no turn role represents (user, assistant, system, tool_use, tool_result)', bad.id, bad.idx, bad.type;
  END IF;

  SELECT t.agent_session_id AS id, t.turn_index AS idx INTO bad
  FROM agent_session_turns t
  JOIN agent_sessions s ON s.id = t.agent_session_id
  WHERE t.turn_index < 0
     OR (s.messages -> t.turn_index) IS DISTINCT FROM (t.content -> 'value')
     OR t.role IS DISTINCT FROM (
       CASE s.messages -> t.turn_index ->> 'type'
         WHEN 'user' THEN 'user'
         WHEN 'assistant' THEN 'assistant'
         ELSE 'tool'
       END)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0418: agent_sessions % disagrees with its turn rows at turn_index %: the row is not the blob entry at that index', bad.id, bad.idx;
  END IF;

  SELECT s.id, e.ord - 1 AS idx INTO bad
  FROM agent_sessions s, jsonb_array_elements(s.messages) WITH ORDINALITY AS e(v, ord)
  WHERE EXISTS (SELECT 1 FROM agent_session_turns t WHERE t.agent_session_id = s.id)
    AND NOT EXISTS (
      SELECT 1 FROM agent_session_turns t
      WHERE t.agent_session_id = s.id AND t.turn_index = e.ord - 1)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0418: agent_sessions % disagrees with its turn rows: messages[%] has no turn row while the session has others', bad.id, bad.idx;
  END IF;
END $$;--> statement-breakpoint
INSERT INTO agent_session_turns (agent_session_id, turn_index, role, content, created_at)
SELECT
  s.id,
  e.ord - 1,
  CASE e.v ->> 'type' WHEN 'user' THEN 'user' WHEN 'assistant' THEN 'assistant' ELSE 'tool' END,
  jsonb_build_object('value', e.v),
  CASE
    WHEN jsonb_typeof(e.v -> 'timestamp') = 'number'
     AND (e.v ->> 'timestamp')::numeric BETWEEN 0 AND 253402300799999
      THEN to_timestamp((e.v ->> 'timestamp')::double precision / 1000)
    ELSE s.created_at
  END
FROM agent_sessions s, jsonb_array_elements(s.messages) WITH ORDINALITY AS e(v, ord)
WHERE NOT EXISTS (SELECT 1 FROM agent_session_turns t WHERE t.agent_session_id = s.id);--> statement-breakpoint
ALTER TABLE agent_sessions DROP COLUMN messages;
