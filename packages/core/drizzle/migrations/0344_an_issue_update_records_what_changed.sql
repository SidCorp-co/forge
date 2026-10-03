-- An `issue.updated` row records the changes a write made, not a snapshot of the fields it touched.
-- Every existing row is rewritten from `{fields, before, after}` (whole values per field) into
-- `{fields, changes, anchor?, unchanged?}`, the shape `@forge/contracts` field-changes writes:
--
--   changes    one entry per path that moved: `set` {before, after}, `add` {after}, `remove` {before};
--              a document is walked key by key (keys in "C" order) and an array index by index.
--   anchor     a field's whole `before`, only where the previous row for that issue and field does
--              not already give it: the first row naming the field, or the row after a write that
--              recorded nothing. With it, every snapshot a row held is recovered from the chain.
--   unchanged  fields the snapshot writer listed whose value did not move.
--
-- A field the writer listed with no `before` (the merge marker recorded `mergedAt` alone) becomes a
-- `set` carrying only `after`, which is what that row knew. A row whose payload is not the snapshot
-- shape aborts the migration naming the row; nothing is skipped and nothing is deleted.

CREATE FUNCTION forge_issue_update_diff(p jsonb, a jsonb, b jsonb) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  i integer;
BEGIN
  IF a = b THEN
    RETURN;
  END IF;
  IF jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
    FOR k IN
      SELECT u.key FROM (SELECT jsonb_object_keys(a) AS key UNION SELECT jsonb_object_keys(b)) u
      ORDER BY u.key COLLATE "C"
    LOOP
      IF NOT b ? k THEN
        RETURN NEXT jsonb_build_object('path', p || to_jsonb(k), 'op', 'remove', 'before', a -> k);
      ELSIF NOT a ? k THEN
        RETURN NEXT jsonb_build_object('path', p || to_jsonb(k), 'op', 'add', 'after', b -> k);
      ELSIF a -> k <> b -> k THEN
        RETURN QUERY SELECT * FROM forge_issue_update_diff(p || to_jsonb(k), a -> k, b -> k);
      END IF;
    END LOOP;
    RETURN;
  END IF;
  IF jsonb_typeof(a) = 'array' AND jsonb_typeof(b) = 'array' THEN
    FOR i IN 0 .. greatest(jsonb_array_length(a), jsonb_array_length(b)) - 1 LOOP
      IF i >= jsonb_array_length(b) THEN
        RETURN NEXT jsonb_build_object('path', p || to_jsonb(i), 'op', 'remove', 'before', a -> i);
      ELSIF i >= jsonb_array_length(a) THEN
        RETURN NEXT jsonb_build_object('path', p || to_jsonb(i), 'op', 'add', 'after', b -> i);
      ELSIF a -> i <> b -> i THEN
        RETURN QUERY SELECT * FROM forge_issue_update_diff(p || to_jsonb(i), a -> i, b -> i);
      END IF;
    END LOOP;
    RETURN;
  END IF;
  RETURN NEXT jsonb_build_object('path', p, 'op', 'set', 'before', a, 'after', b);
END;
$$;--> statement-breakpoint

CREATE FUNCTION forge_issue_update_convert() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  f text;
  bef jsonb;
  aft jsonb;
  d jsonb;
  last_issue uuid := NULL;
  last_after jsonb := '{}'::jsonb;
  changes jsonb;
  moved jsonb;
  unchanged jsonb;
  anchor jsonb;
  converted jsonb;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT id, issue_id, payload FROM activity_log
    WHERE action = 'issue.updated'
    ORDER BY issue_id, created_at, id
  LOOP
    IF jsonb_typeof(r.payload) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'activity_log row % (issue %): the payload is a %, not the {fields, before, after} object an issue.updated row held; fix or remove that row and deploy again',
        r.id, r.issue_id, coalesce(jsonb_typeof(r.payload), 'SQL null');
    END IF;
    IF r.payload ? 'changes' THEN
      RAISE EXCEPTION 'activity_log row % (issue %): it already carries "changes", so it is not a snapshot row; an issue.updated row before this migration holds {fields, before, after} only',
        r.id, r.issue_id;
    END IF;
    IF jsonb_typeof(r.payload -> 'fields') IS DISTINCT FROM 'array'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(r.payload -> 'fields') e WHERE jsonb_typeof(e) <> 'string') THEN
      RAISE EXCEPTION 'activity_log row % (issue %): "fields" is %, where an array of field names is the only valid shape',
        r.id, r.issue_id, coalesce(r.payload ->> 'fields', 'absent');
    END IF;
    IF jsonb_typeof(r.payload -> 'before') IS DISTINCT FROM 'object'
       OR jsonb_typeof(r.payload -> 'after') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'activity_log row % (issue %): "before" is % and "after" is %, where both are objects keyed by field',
        r.id, r.issue_id, coalesce(jsonb_typeof(r.payload -> 'before'), 'absent'), coalesce(jsonb_typeof(r.payload -> 'after'), 'absent');
    END IF;

    IF last_issue IS DISTINCT FROM r.issue_id THEN
      last_issue := r.issue_id;
      last_after := '{}'::jsonb;
    END IF;
    changes := '[]'::jsonb;
    moved := '[]'::jsonb;
    unchanged := '[]'::jsonb;
    anchor := '{}'::jsonb;

    FOR f IN SELECT e FROM jsonb_array_elements_text(r.payload -> 'fields') WITH ORDINALITY AS t(e, ord) ORDER BY ord LOOP
      IF NOT (r.payload -> 'after') ? f THEN
        RAISE EXCEPTION 'activity_log row % (issue %): field "%" is listed in "fields" with no value in "after", so what it was set to is not recorded',
          r.id, r.issue_id, f;
      END IF;
      aft := r.payload -> 'after' -> f;
      IF (r.payload -> 'before') ? f THEN
        bef := r.payload -> 'before' -> f;
        IF NOT last_after ? f OR last_after -> f IS DISTINCT FROM bef THEN
          anchor := anchor || jsonb_build_object(f, bef);
        END IF;
        SELECT coalesce(jsonb_agg(x ORDER BY ord), '[]'::jsonb) INTO d
        FROM forge_issue_update_diff(jsonb_build_array(f), bef, aft) WITH ORDINALITY AS t(x, ord);
      ELSE
        d := jsonb_build_array(jsonb_build_object('path', jsonb_build_array(f), 'op', 'set', 'after', aft));
      END IF;
      IF jsonb_array_length(d) = 0 THEN
        unchanged := unchanged || to_jsonb(f);
      ELSE
        moved := moved || to_jsonb(f);
        changes := changes || d;
      END IF;
      last_after := last_after || jsonb_build_object(f, aft);
    END LOOP;

    converted := (r.payload - 'fields' - 'before' - 'after')
      || jsonb_build_object('fields', moved, 'changes', changes);
    IF anchor <> '{}'::jsonb THEN
      converted := converted || jsonb_build_object('anchor', anchor);
    END IF;
    IF jsonb_array_length(unchanged) > 0 THEN
      converted := converted || jsonb_build_object('unchanged', unchanged);
    END IF;
    UPDATE activity_log SET payload = converted WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0344: rewrote % issue.updated row(s) from snapshots into the changes they made', n;
  RETURN n;
END;
$$;--> statement-breakpoint

SELECT forge_issue_update_convert();--> statement-breakpoint
DROP FUNCTION forge_issue_update_convert();--> statement-breakpoint
DROP FUNCTION forge_issue_update_diff(jsonb, jsonb, jsonb);
