-- Record history has one source: every issue comment whose `forge-record` fence names a kind a
-- caller may write, and which has no event of its own (written before 0347 mirrored records), is given
-- the event the comment mirror would have written: same kind, contract, fields, lead and commentId,
-- the comment's moment, its author as the actor, and the `record-comment:<id>` key. The read that
-- scanned comments for such fences (`issues/record-events/history.ts:legacyCommentRecords`) is
-- deleted with this.
--
-- The fence is read as `messaging/forge-record.ts:parseForgeRecord` reads it. A fence that opens no
-- record, a kind outside the closed set, and a kernel-only kind (transition, park, verdict) were never
-- read as history and stay prose. A typed record the event table cannot hold — no fields, more than
-- 400, or a contract below 1 — aborts this migration naming the comment.
--
-- ROLLBACK: DELETE FROM activity_log WHERE payload->>'backfill' = '0415'.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE "activity_log" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "comments" IN SHARE MODE;--> statement-breakpoint
CREATE FUNCTION pg_temp.fence_closes(line text, fence text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT m IS NOT NULL AND left(m[1], 1) = left(fence, 1) AND length(m[1]) >= length(fence)
  FROM regexp_match(line, '^ {0,3}(`+|~+)[ \t]*$') AS m
$$;--> statement-breakpoint
CREATE FUNCTION pg_temp.forge_record_0415(body text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  lines text[] := string_to_array(body, E'\n');
  n int := coalesce(array_length(lines, 1), 0);
  i int;
  line text;
  m text[];
  ind text[];
  inside text;
  opener int;
  fence text;
  rest text;
  fence_kind text;
  fence_contract numeric;
  closed int;
  tag_kind text;
  tag_contract numeric;
  keys text[] := '{}';
  vals text[] := '{}';
  fields jsonb := '[]';
BEGIN
  FOR i IN 1..n LOOP
    lines[i] := regexp_replace(lines[i], E'\r$', '');
  END LOOP;
  FOR i IN 1..n LOOP
    line := lines[i];
    IF inside IS NOT NULL THEN
      IF pg_temp.fence_closes(line, inside) THEN inside := NULL; END IF;
      CONTINUE;
    END IF;
    m := regexp_match(line, '^(`{3,}|~{3,})([^\r  ]*)$');
    CONTINUE WHEN m IS NULL;
    IF left(m[1], 1) = '`' THEN
      ind := regexp_match(m[2], '^forge-record(?![A-Za-z0-9_-])([^\r  ]*)$');
      IF ind IS NOT NULL THEN
        opener := i;
        fence := m[1];
        rest := regexp_replace(ind[1], '^\s+|\s+$', '', 'g');
        EXIT;
      END IF;
    END IF;
    inside := m[1];
  END LOOP;
  IF opener IS NULL THEN RETURN NULL; END IF;
  IF rest <> '' THEN
    m := regexp_match(rest, '^: ([a-z]+) · contract ([0-9]+)$');
    IF m IS NULL THEN RETURN NULL; END IF;
    fence_kind := m[1];
    fence_contract := m[2]::numeric;
  END IF;
  FOR i IN opener + 1..n LOOP
    IF pg_temp.fence_closes(lines[i], fence) THEN closed := i; EXIT; END IF;
  END LOOP;
  IF closed IS NULL THEN RETURN NULL; END IF;
  FOR i IN closed + 1..n LOOP
    line := regexp_replace(lines[i], '^\s+|\s+$', '', 'g');
    CONTINUE WHEN line = '';
    m := regexp_match(line, '^`?forge-record: ([a-z]+) · contract ([0-9]+)`?\s*$');
    IF m IS NOT NULL THEN
      tag_kind := m[1];
      tag_contract := m[2]::numeric;
    END IF;
    EXIT;
  END LOOP;
  IF fence_kind IS NOT NULL AND tag_kind IS NOT NULL
     AND (tag_kind <> fence_kind OR tag_contract <> fence_contract) THEN
    RETURN NULL;
  END IF;
  FOR i IN opener + 1..closed - 1 LOOP
    line := lines[i];
    ind := regexp_match(line, '^ {2}([^\r  ]*)$');
    m := CASE WHEN ind IS NULL THEN regexp_match(line, '^([a-z][a-z0-9-]*): ?([^\r  ]*)$') END;
    IF m IS NOT NULL THEN
      keys := keys || m[1];
      vals := vals || m[2];
    ELSIF cardinality(keys) > 0 THEN
      vals[cardinality(vals)] := vals[cardinality(vals)] || E'\n' || coalesce(ind[1], line);
    END IF;
  END LOOP;
  FOR i IN 1..cardinality(keys) LOOP
    fields := fields || jsonb_build_object('key', keys[i], 'value', vals[i]);
  END LOOP;
  RETURN jsonb_build_object(
    'kind', coalesce(fence_kind, tag_kind),
    'contract', coalesce(fence_contract, tag_contract),
    'fields', fields,
    'lead', (SELECT f->'value' FROM jsonb_array_elements(fields) AS f WHERE f->>'key' = 'lead' LIMIT 1)
  );
END
$$;--> statement-breakpoint
DO $$
DECLARE
  r record;
  rec jsonb;
  kind text;
  contract numeric;
  width int;
BEGIN
  FOR r IN
    SELECT c.id, c.issue_id, c.body, c.author_id, c.author_device_id, c.created_at
    FROM comments c
    WHERE c.issue_id IS NOT NULL
      AND c.body LIKE '%forge-record%'
      AND NOT EXISTS (
        SELECT 1 FROM activity_log a WHERE a.dedupe_key = 'record-comment:' || c.id::text
      )
    ORDER BY c.created_at, c.id
  LOOP
    rec := pg_temp.forge_record_0415(r.body);
    kind := rec->>'kind';
    CONTINUE WHEN kind IS NULL OR NOT kind = ANY (ARRAY[
      'landing', 'correction', 'fold', 'routed', 'gap', 'baseline', 'decision', 'question',
      'answer', 'confirmation', 'superseded', 'review', 'finding', 'triage', 'folded', 'declined',
      'wave', 'verification'
    ]);
    contract := (rec->>'contract')::numeric;
    width := jsonb_array_length(rec->'fields');
    IF contract < 1 OR width = 0 OR width > 400 THEN
      RAISE EXCEPTION 'RECORD_BACKFILL_UNMAPPABLE: comment % on issue % carries a `forge-record: %` with contract % and % field(s); a record event holds contract >= 1 and 1 to 400 fields. Correct or remove that comment''s fence, then deploy again.',
        r.id, r.issue_id, kind, contract, width;
    END IF;
    INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at, dedupe_key)
    VALUES (
      r.issue_id,
      CASE WHEN r.author_device_id IS NULL THEN 'user' ELSE 'device' END,
      coalesce(r.author_device_id, r.author_id),
      CASE WHEN r.author_device_id IS NULL THEN 'human' ELSE 'agent' END,
      'record.' || kind,
      jsonb_build_object(
        'contract', contract,
        'fields', rec->'fields',
        'lead', rec->'lead',
        'commentId', r.id::text,
        'backfill', '0415'
      ),
      r.created_at,
      'record-comment:' || r.id::text
    );
  END LOOP;
END $$;
