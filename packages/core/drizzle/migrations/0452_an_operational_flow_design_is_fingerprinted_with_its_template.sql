-- A design's fingerprint stood without its template for operational-flow@1 alone, so a design written
-- before templates kept the fingerprint it was approved at. Every design now names its template, and
-- the fingerprint hashes it for every template: this re-hashes each operational-flow@1 row under that
-- rule, from the stored document, so an approved design stays approved at its approved revision and
-- does not read as changed since. status, approved_revision and the revision are not touched. A row
-- whose document names no template is refused by name and aborts the deploy.
--
-- The hash is the one designFingerprint (packages/core/src/workflows/design.ts) takes: sha256 of
-- JSON.stringify of {kind, title, summary, steps, edges, template, lanes?, basedOn?}, with a node's
-- band dropped when it is its type's home band and an edge's kind dropped when its endpoint types
-- imply it. The helpers below spell out operational-flow@1's bands and edge kinds, the only template
-- the old rule left out, and are dropped at the end.
CREATE FUNCTION fp_0452_js(j jsonb, ord text[]) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  nested constant text[] := ARRAY['when','result','provider','slug','element','template','flow','step','attachment','svg'];
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      RETURN '{' || coalesce((
        SELECT string_agg(to_json(e.k)::text || ':' || fp_0452_js(e.v, nested), ','
                          ORDER BY coalesce(array_position(ord, e.k), 1000), length(e.k), e.k COLLATE "C")
        FROM jsonb_each(j) AS e(k, v)
      ), '') || '}';
    WHEN 'array' THEN
      RETURN '[' || coalesce((
        SELECT string_agg(fp_0452_js(a.v, ord), ',' ORDER BY a.n)
        FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, n)
      ), '') || ']';
    WHEN 'string' THEN
      RETURN to_json(j #>> '{}')::text;
    ELSE
      RETURN j::text;
  END CASE;
END $$;
--> statement-breakpoint
CREATE FUNCTION fp_0452_implied(ft text, tt text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN tt = 'CASE' THEN 'opens'
    WHEN ft = 'SOURCE' AND tt = 'EVENT' THEN 'emits'
    WHEN ft IN ('ENTITY', 'CONTEXT') AND tt = 'RULE' THEN 'enriches'
    WHEN ft = 'EVENT' AND tt = 'RULE' THEN 'evaluates'
    WHEN ft = 'RULE' AND tt = 'STATE' THEN 'derives'
    WHEN ft = 'STATE' AND tt = 'EXPECTATION' THEN 'expects'
    WHEN ft = 'CASE' AND tt = 'TASK' THEN 'assigns'
    WHEN ft = 'TASK' AND tt = 'ACTION' THEN 'performs'
    WHEN ft = 'ACTION' AND tt = 'OUTCOME' THEN 'results-in'
    WHEN ft = 'EXPECTATION' AND tt = 'ATTENTION' THEN 'breaches'
  END
$$;
--> statement-breakpoint
CREATE FUNCTION fp_0452(doc jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  home constant jsonb := '{"SOURCE":"trigger","EVENT":"trigger","ENTITY":"understand","CONTEXT":"understand","RULE":"decide","STATE":"decide","EXPECTATION":"decide","CASE":"organise","TASK":"organise","ATTENTION":"organise","ACTION":"act","OUTCOME":"result"}';
  node_ord constant text[] := ARRAY['type','label','band','purpose','inputs','outputs','owner','sla','conditions','tests','expectedOutcome','permissions','persona','wireframe','dataShown','actions','trigger','validation','variant','event','route','payload','idempotency','values','mapsTo','channel','contracts','binds','refs'];
  edge_ord constant text[] := ARRAY['kind','from','to','label','reevaluates','condition','action','mapping','idempotency','onFailure','payload','protocol'];
  types jsonb;
  steps text;
  edges text;
BEGIN
  SELECT coalesce(jsonb_object_agg(s->>'id', s->'node'->>'type') FILTER (WHERE home ? (s->'node'->>'type')), '{}'::jsonb)
    INTO types
    FROM jsonb_array_elements(doc->'steps') AS st(s);
  SELECT '[' || coalesce(string_agg(
      '{"id":' || to_json(s->>'id')::text
      || ',"title":' || coalesce(to_json(s->>'title')::text, 'null')
      || ',"does":' || to_json(s->>'does')::text
      || ',"after":[' || coalesce((
           SELECT string_agg(to_json(a.v)::text, ',' ORDER BY a.v COLLATE "C")
           FROM jsonb_array_elements_text(coalesce(s->'after', '[]'::jsonb)) AS a(v)
         ), '') || ']'
      || ',"node":' || CASE WHEN s ? 'node'
           THEN fp_0452_js(CASE WHEN s->'node'->>'band' = home->>(s->'node'->>'type') THEN (s->'node') - 'band' ELSE s->'node' END, node_ord)
           ELSE 'null' END
      || '}', ',' ORDER BY st.n), '') || ']'
    INTO steps
    FROM jsonb_array_elements(doc->'steps') WITH ORDINALITY AS st(s, n);
  -- the edges sort on `from>to` as ICU reads it, where `_` < `-` < `>` < digits < letters; step ids hold nothing else
  SELECT '[' || coalesce(string_agg(
      fp_0452_js(CASE WHEN ed.e ? 'kind' AND ed.e->>'kind' = fp_0452_implied(types->>(ed.e->>'from'), types->>(ed.e->>'to'))
                      THEN ed.e - 'kind' ELSE ed.e END, edge_ord),
      ',' ORDER BY translate((ed.e->>'from') || '>' || (ed.e->>'to'), '_->', '!"#') COLLATE "C", ed.n), '') || ']'
    INTO edges
    FROM jsonb_array_elements(coalesce(doc->'edges', '[]'::jsonb)) WITH ORDINALITY AS ed(e, n);
  RETURN encode(sha256(convert_to(
    '{"kind":' || to_json(doc->>'kind')::text
    || ',"title":' || to_json(doc->>'title')::text
    || ',"summary":' || to_json(doc->>'summary')::text
    || ',"steps":' || steps
    || ',"edges":' || edges
    || ',"template":' || fp_0452_js(doc->'template', ARRAY['id','version'])
    || CASE WHEN doc ? 'lanes' THEN ',"lanes":' || fp_0452_js(doc->'lanes', ARRAY['id','label','tooltip']) ELSE '' END
    || CASE WHEN doc ? 'basedOn' THEN ',"basedOn":' || fp_0452_js(doc->'basedOn', ARRAY['workflow','revision']) ELSE '' END
    || '}', 'UTF8')), 'hex');
END $$;
--> statement-breakpoint
DO $$
DECLARE
  untemplated text;
  unsortable text;
BEGIN
  SELECT string_agg(format('%s (project %s, row %s)', flow, project_id, id), '; ' ORDER BY project_id, flow)
    INTO untemplated
    FROM project_workflows
    WHERE jsonb_typeof(document->'template') IS DISTINCT FROM 'object'
       OR jsonb_typeof(document->'template'->'id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(document->'template'->'version') IS DISTINCT FROM 'number';
  IF untemplated IS NOT NULL THEN
    RAISE EXCEPTION '0452: project_workflows.document names no template (an object with a string id and a numeric version) in: %. Every design is drawn in a template and the fingerprint hashes it; correct the document, then migrate.', untemplated;
  END IF;
  SELECT string_agg(format('%s (project %s, row %s)', flow, project_id, id), '; ' ORDER BY project_id, flow)
    INTO unsortable
    FROM project_workflows w
    WHERE w.document->'template'->>'id' = 'operational-flow' AND w.document->'template'->'version' = '1'::jsonb
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(w.document->'edges', '[]'::jsonb)) AS ed(e)
        WHERE coalesce(ed.e->>'from', '') !~ '^[a-z][a-z0-9_-]{0,62}$' OR coalesce(ed.e->>'to', '') !~ '^[a-z][a-z0-9_-]{0,62}$'
      );
  IF unsortable IS NOT NULL THEN
    RAISE EXCEPTION '0452: an edge names a step id outside [a-z][a-z0-9_-]{0,62}, which this migration cannot order as the fingerprint does, in: %.', unsortable;
  END IF;
END $$;
--> statement-breakpoint
UPDATE project_workflows
  SET design_fingerprint = fp_0452(document)
  WHERE document->'template'->>'id' = 'operational-flow'
    AND document->'template'->'version' = '1'::jsonb
    AND design_fingerprint IS DISTINCT FROM fp_0452(document);
--> statement-breakpoint
DROP FUNCTION fp_0452(jsonb);
--> statement-breakpoint
DROP FUNCTION fp_0452_implied(text, text);
--> statement-breakpoint
DROP FUNCTION fp_0452_js(jsonb, text[]);
