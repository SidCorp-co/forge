-- A design's fingerprint stood without its template for operational-flow@1 alone, and hashed its objects
-- in the order the writer sent them. It now hashes the template for every template and every object with
-- its keys sorted, so a write that sends the same design in another key order reads unchanged.
--
-- Each row is re-hashed from its stored document ONLY where its stored fingerprint is what the OLD rule
-- gives that document: a row whose fingerprint does not match was changed after it was stamped, and
-- re-hashing it would make a design read as unchanged over content nobody approved. Those rows are left
-- as they are, still reading "changed since approval", and each is named in a NOTICE (flow, project,
-- revision, status) which the migrator logs. status, approved_revision and revision are never touched.
-- A row whose document names no template is refused by name and aborts the deploy.
--
-- The hashes are designFingerprint's (packages/core/src/workflows/design.ts): the old rule is sha256 of
-- JSON.stringify of {kind, title, summary, steps, edges, template (not for operational-flow@1), lanes?,
-- basedOn?} in the writer's key order, the new rule the same shape, template always, keys sorted. A
-- node's band is dropped when it is its type's home band, and an edge's kind when its endpoint types
-- imply it, as the built-in templates declare them; fp_0452_templates() is that catalogue as it stood.
-- A row naming a template the catalogue does not hold is read as the code reads an unknown one: with
-- no home bands and no implied kinds. All helpers are dropped at the end.
CREATE FUNCTION fp_0452_templates() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $cat$
  SELECT '[{"id":"operational-flow","version":1,"defaultEdgeKind":"evaluates","nodeTypes":{"SOURCE":"trigger","EVENT":"trigger","ENTITY":"understand","CONTEXT":"understand","RULE":"decide","STATE":"decide","EXPECTATION":"decide","CASE":"organise","TASK":"organise","ATTENTION":"organise","ACTION":"act","OUTCOME":"result"},"edgeKinds":[{"id":"emits","fromTypes":["SOURCE"],"toTypes":["EVENT"]},{"id":"enriches","fromTypes":["ENTITY","CONTEXT"],"toTypes":["RULE"]},{"id":"evaluates","fromTypes":["EVENT"],"toTypes":["RULE"]},{"id":"derives","fromTypes":["RULE"],"toTypes":["STATE"]},{"id":"expects","fromTypes":["STATE"],"toTypes":["EXPECTATION"]},{"id":"opens","toTypes":["CASE"]},{"id":"assigns","fromTypes":["CASE"],"toTypes":["TASK"]},{"id":"performs","fromTypes":["TASK"],"toTypes":["ACTION"]},{"id":"results-in","fromTypes":["ACTION"],"toTypes":["OUTCOME"]},{"id":"breaches","fromTypes":["EXPECTATION"],"toTypes":["ATTENTION"]}]},{"id":"service-blueprint","version":1,"defaultEdgeKind":"flow","nodeTypes":{"EVIDENCE":"evidence","CUSTOMER_ACTION":"customer","FRONTSTAGE":"frontstage","BACKSTAGE":"backstage","SUPPORT":"support","GATEWAY":"backstage","WAIT":"backstage","FAIL_POINT":"backstage"},"edgeKinds":[{"id":"flow","toTypes":["CUSTOMER_ACTION","FRONTSTAGE","BACKSTAGE","GATEWAY","WAIT","FAIL_POINT"]},{"id":"handoff","fromTypes":["FRONTSTAGE","BACKSTAGE"],"toTypes":["FRONTSTAGE","BACKSTAGE"]},{"id":"uses","fromTypes":["FRONTSTAGE","BACKSTAGE"],"toTypes":["SUPPORT"]},{"id":"evidences","toTypes":["EVIDENCE"]}]},{"id":"service-blueprint-cross-functional","version":1,"defaultEdgeKind":"flow","nodeTypes":{"EVIDENCE":null,"CUSTOMER_ACTION":null,"FRONTSTAGE":null,"BACKSTAGE":null,"SUPPORT":null,"GATEWAY":null,"WAIT":null,"FAIL_POINT":null},"edgeKinds":[{"id":"flow","toTypes":["CUSTOMER_ACTION","FRONTSTAGE","BACKSTAGE","GATEWAY","WAIT","FAIL_POINT"]},{"id":"handoff","fromTypes":["FRONTSTAGE","BACKSTAGE"],"toTypes":["FRONTSTAGE","BACKSTAGE"]},{"id":"uses","fromTypes":["FRONTSTAGE","BACKSTAGE"],"toTypes":["SUPPORT"]},{"id":"evidences","toTypes":["EVIDENCE"]}]},{"id":"ux-flow","version":1,"defaultEdgeKind":"flow","nodeTypes":{"ENTRY":null,"SCREEN":null,"UI_STATE":null,"USER_ACTION":null,"DECISION":null,"SYSTEM":null,"EXIT":null},"edgeKinds":[{"id":"flow"},{"id":"navigates","fromTypes":["ENTRY","SCREEN","USER_ACTION","DECISION"],"toTypes":["SCREEN","EXIT"]},{"id":"shows","fromTypes":["SCREEN"],"toTypes":["UI_STATE"]},{"id":"returns","fromTypes":["SYSTEM"],"toTypes":["SCREEN","UI_STATE","EXIT"]}]},{"id":"state-machine","version":1,"defaultEdgeKind":"transition","nodeTypes":{"INITIAL":null,"STATE":null,"COMPOUND":null,"PARALLEL_REGION":null,"CHOICE":null,"FINAL":null},"edgeKinds":[{"id":"transition","fromTypes":["INITIAL","STATE","COMPOUND","PARALLEL_REGION","CHOICE"],"toTypes":["STATE","COMPOUND","PARALLEL_REGION","CHOICE","FINAL"]},{"id":"after","fromTypes":["INITIAL","STATE","COMPOUND","PARALLEL_REGION","CHOICE"],"toTypes":["STATE","COMPOUND","PARALLEL_REGION","CHOICE","FINAL"]}]},{"id":"state-machine-fhir-task","version":1,"defaultEdgeKind":"transition","nodeTypes":{"INITIAL":null,"STATE":null,"COMPOUND":null,"PARALLEL_REGION":null,"CHOICE":null,"FINAL":null},"edgeKinds":[{"id":"transition","fromTypes":["INITIAL","STATE","COMPOUND","PARALLEL_REGION","CHOICE"],"toTypes":["STATE","COMPOUND","PARALLEL_REGION","CHOICE","FINAL"]},{"id":"after","fromTypes":["INITIAL","STATE","COMPOUND","PARALLEL_REGION","CHOICE"],"toTypes":["STATE","COMPOUND","PARALLEL_REGION","CHOICE","FINAL"]}]},{"id":"state-machine-fhir-encounter","version":1,"defaultEdgeKind":"transition","nodeTypes":{"INITIAL":null,"STATE":null,"COMPOUND":null,"PARALLEL_REGION":null,"CHOICE":null,"FINAL":null},"edgeKinds":[{"id":"transition","fromTypes":["INITIAL","STATE","COMPOUND","PARALLEL_REGION","CHOICE"],"toTypes":["STATE","COMPOUND","PARALLEL_REGION","CHOICE","FINAL"]},{"id":"after","fromTypes":["INITIAL","STATE","COMPOUND","PARALLEL_REGION","CHOICE"],"toTypes":["STATE","COMPOUND","PARALLEL_REGION","CHOICE","FINAL"]}]},{"id":"integration-sequence","version":1,"defaultEdgeKind":"sync","nodeTypes":{"PARTICIPANT":null,"MESSAGE":null,"FRAGMENT":null,"NOTE":null},"edgeKinds":[{"id":"sync"},{"id":"async"},{"id":"reply"},{"id":"event"}]},{"id":"decision-model","version":1,"defaultEdgeKind":"requires-info","nodeTypes":{"DECISION":null,"INPUT_DATA":null,"KNOWLEDGE_SOURCE":null,"BKM":null},"edgeKinds":[{"id":"requires-info","fromTypes":["INPUT_DATA","DECISION"],"toTypes":["DECISION"]},{"id":"requires-knowledge","fromTypes":["BKM"],"toTypes":["DECISION","BKM"]},{"id":"authority","fromTypes":["KNOWLEDGE_SOURCE"],"toTypes":["DECISION","BKM"]}]},{"id":"data-flow","version":1,"defaultEdgeKind":"reads","nodeTypes":{"SOURCE_SYSTEM":null,"DATASET":null,"PROCESS":null,"EXTERNAL_ENTITY":null},"edgeKinds":[{"id":"reads","fromTypes":["SOURCE_SYSTEM","DATASET"],"toTypes":["PROCESS"]},{"id":"writes","fromTypes":["PROCESS"],"toTypes":["DATASET"]},{"id":"derives","fromTypes":["DATASET"],"toTypes":["DATASET"]},{"id":"publishes","fromTypes":["PROCESS","DATASET"],"toTypes":["EXTERNAL_ENTITY"]}]},{"id":"system-context","version":1,"defaultEdgeKind":"uses","nodeTypes":{"PERSON":null,"SYSTEM":null,"CONTAINER":null},"edgeKinds":[{"id":"uses"},{"id":"reads-from","toTypes":["SYSTEM"]},{"id":"writes-to","toTypes":["SYSTEM"]}]}]'::jsonb
$cat$;
--> statement-breakpoint
CREATE FUNCTION fp_0452_js(j jsonb, spec jsonb, canon boolean) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ord text[] := ARRAY(SELECT jsonb_array_elements_text(coalesce(spec->'ord', '[]'::jsonb)));
  nested constant jsonb := '{"ord":["when","result","provider","slug","element","template","flow","step","attachment","svg"]}';
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      RETURN '{' || coalesce((
        SELECT string_agg(to_json(e.k)::text || ':' || fp_0452_js(e.v, coalesce(spec->'kids'->e.k, nested), canon), ','
                          ORDER BY CASE WHEN canon THEN 0 ELSE coalesce(array_position(ord, e.k), 1000) END,
                                   CASE WHEN canon THEN 0 ELSE length(e.k) END, e.k COLLATE "C")
        FROM jsonb_each(j) AS e(k, v)
      ), '') || '}';
    WHEN 'array' THEN
      RETURN '[' || coalesce((
        SELECT string_agg(fp_0452_js(a.v, spec, canon), ',' ORDER BY a.n)
        FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, n)
      ), '') || ']';
    WHEN 'string' THEN
      RETURN to_json(j #>> '{}')::text;
    ELSE
      RETURN j::text;
  END CASE;
END $$;
--> statement-breakpoint
CREATE FUNCTION fp_0452_implied(tpl jsonb, ft text, tt text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH fits AS (
    SELECT k FROM jsonb_array_elements(coalesce(tpl->'edgeKinds', '[]'::jsonb)) AS x(k)
    WHERE (NOT k ? 'fromTypes' OR (ft IS NOT NULL AND k->'fromTypes' ? ft))
      AND (NOT k ? 'toTypes' OR (tt IS NOT NULL AND k->'toTypes' ? tt))
  ), typed AS (
    SELECT k FROM fits WHERE k ? 'fromTypes' OR k ? 'toTypes'
  ), pool AS (
    SELECT k FROM typed
    UNION ALL
    SELECT k FROM fits WHERE NOT EXISTS (SELECT 1 FROM typed)
  )
  SELECT CASE count(*)
    WHEN 0 THEN NULL
    WHEN 1 THEN max(k->>'id')
    ELSE CASE WHEN bool_or(k->>'id' = tpl->>'defaultEdgeKind') THEN tpl->>'defaultEdgeKind' END
  END FROM pool
$$;
--> statement-breakpoint
-- the design as the fingerprint reads it: steps and edges normalised, edges in `from>to` order as ICU
-- reads it (`_` < `-` < `>` < digits < letters; step ids hold nothing else), without the template
CREATE FUNCTION fp_0452_shape(doc jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  tpl jsonb;
  types jsonb;
  steps jsonb;
  edges jsonb;
BEGIN
  SELECT t INTO tpl FROM jsonb_array_elements(fp_0452_templates()) AS x(t)
    WHERE t->>'id' = doc->'template'->>'id' AND t->'version' = doc->'template'->'version';
  SELECT coalesce(jsonb_object_agg(s->>'id', s->'node'->>'type')
                  FILTER (WHERE tpl IS NOT NULL AND tpl->'nodeTypes' ? (s->'node'->>'type')), '{}'::jsonb)
    INTO types FROM jsonb_array_elements(doc->'steps') AS st(s);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', s->'id',
      'title', coalesce(s->'title', 'null'::jsonb),
      'does', s->'does',
      'after', (SELECT coalesce(jsonb_agg(a.v ORDER BY a.v COLLATE "C"), '[]'::jsonb)
                FROM jsonb_array_elements_text(coalesce(s->'after', '[]'::jsonb)) AS a(v)),
      'node', CASE WHEN NOT s ? 'node' THEN 'null'::jsonb
                   WHEN tpl IS NOT NULL AND s->'node'->>'band' = tpl->'nodeTypes'->>(s->'node'->>'type')
                     THEN (s->'node') - 'band'
                   ELSE s->'node' END
    ) ORDER BY st.n), '[]'::jsonb)
    INTO steps FROM jsonb_array_elements(doc->'steps') WITH ORDINALITY AS st(s, n);
  SELECT coalesce(jsonb_agg(
      CASE WHEN tpl IS NOT NULL AND ed.e ? 'kind'
                AND ed.e->>'kind' = fp_0452_implied(tpl, types->>(ed.e->>'from'), types->>(ed.e->>'to'))
           THEN ed.e - 'kind' ELSE ed.e END
      ORDER BY translate((ed.e->>'from') || '>' || (ed.e->>'to'), '_->', '!"#') COLLATE "C", ed.n), '[]'::jsonb)
    INTO edges FROM jsonb_array_elements(coalesce(doc->'edges', '[]'::jsonb)) WITH ORDINALITY AS ed(e, n);
  RETURN jsonb_build_object('kind', doc->'kind', 'title', doc->'title', 'summary', doc->'summary',
                            'steps', steps, 'edges', edges)
    || CASE WHEN doc ? 'lanes' THEN jsonb_build_object('lanes', doc->'lanes') ELSE '{}'::jsonb END
    || CASE WHEN doc ? 'basedOn' THEN jsonb_build_object('basedOn', doc->'basedOn') ELSE '{}'::jsonb END;
END $$;
--> statement-breakpoint
-- the fingerprint the old rule stored: the writer's key order, no template for operational-flow@1
CREATE FUNCTION fp_0452_old(doc jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(fp_0452_js(
    fp_0452_shape(doc)
      || CASE WHEN doc->'template' = '{"id":"operational-flow","version":1}'::jsonb
              THEN '{}'::jsonb ELSE jsonb_build_object('template', doc->'template') END,
    '{"ord":["kind","title","summary","steps","edges","template","lanes","basedOn"],"kids":{
       "steps":{"ord":["id","title","does","after","node"],"kids":{"node":{"ord":["type","label","band","purpose","inputs","outputs","owner","sla","conditions","tests","expectedOutcome","permissions","persona","wireframe","dataShown","actions","trigger","validation","variant","event","route","payload","idempotency","values","mapsTo","channel","contracts","binds","refs"]}}},
       "edges":{"ord":["kind","from","to","label","reevaluates","condition","action","mapping","idempotency","onFailure","payload","protocol"]},
       "template":{"ord":["id","version"]},
       "lanes":{"ord":["id","label","tooltip"]},
       "basedOn":{"ord":["workflow","revision"]}}}'::jsonb,
    false), 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- the fingerprint the new rule stores: the template always, every object's keys sorted
CREATE FUNCTION fp_0452_new(doc jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(fp_0452_js(
    fp_0452_shape(doc) || jsonb_build_object('template', doc->'template'), NULL, true), 'UTF8')), 'hex')
$$;
--> statement-breakpoint
DO $$
DECLARE
  untemplated text;
  unsortable text;
  r record;
  rehashed int := 0;
  settled int := 0;
  drifted int := 0;
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
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(w.document->'edges', '[]'::jsonb)) AS ed(e)
      WHERE coalesce(ed.e->>'from', '') !~ '^[a-z][a-z0-9_-]{0,62}$' OR coalesce(ed.e->>'to', '') !~ '^[a-z][a-z0-9_-]{0,62}$'
    );
  IF unsortable IS NOT NULL THEN
    RAISE EXCEPTION '0452: an edge names a step id outside [a-z][a-z0-9_-]{0,62}, which this migration cannot order as the fingerprint does, in: %.', unsortable;
  END IF;
  FOR r IN SELECT id, project_id, flow, revision, design_status, design_fingerprint, document
             FROM project_workflows ORDER BY project_id, flow LOOP
    IF r.design_fingerprint = fp_0452_new(r.document) THEN
      settled := settled + 1;
    ELSIF r.design_fingerprint = fp_0452_old(r.document) THEN
      UPDATE project_workflows SET design_fingerprint = fp_0452_new(r.document) WHERE id = r.id;
      rehashed := rehashed + 1;
    ELSE
      drifted := drifted + 1;
      RAISE NOTICE '0452: left drifted, its stored fingerprint is not the old rule''s for its document, so it keeps reading changed since approval: % (project %, revision %, status %, fingerprint %)',
        r.flow, r.project_id, r.revision, coalesce(r.design_status, 'none'), coalesce(r.design_fingerprint, 'null');
    END IF;
  END LOOP;
  RAISE NOTICE '0452: fingerprints re-hashed %, already current %, left drifted %', rehashed, settled, drifted;
END $$;
--> statement-breakpoint
DROP FUNCTION fp_0452_new(jsonb);
--> statement-breakpoint
DROP FUNCTION fp_0452_old(jsonb);
--> statement-breakpoint
DROP FUNCTION fp_0452_shape(jsonb);
--> statement-breakpoint
DROP FUNCTION fp_0452_implied(jsonb, text, text);
--> statement-breakpoint
DROP FUNCTION fp_0452_js(jsonb, jsonb, boolean);
--> statement-breakpoint
DROP FUNCTION fp_0452_templates();
