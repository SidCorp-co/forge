CREATE FUNCTION pg_temp.repaired_citation(e jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(r.e->'coverage') = 'object' AND NOT (r.e->'coverage' ? 'atSha')
      THEN jsonb_set(r.e, '{coverage,atSha}', 'null'::jsonb)
    ELSE r.e END
  FROM (SELECT CASE
    WHEN jsonb_typeof(e) = 'object' AND NOT (e ? 'kind') AND e ? 'file' THEN e || '{"kind":"repo"}'::jsonb
    ELSE e END AS e) r
$$;--> statement-breakpoint
CREATE FUNCTION pg_temp.citation_defect(e jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN e IS NULL OR jsonb_typeof(e) = 'null' THEN NULL
    WHEN jsonb_typeof(e) <> 'object' THEN 'is a ' || jsonb_typeof(e) || ', not a citation object'
    WHEN NOT (e ? 'kind') THEN 'kind is absent and the citation names no file, so it is not a repo citation'
    WHEN e->>'kind' = 'repo' THEN CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'file', 'symbol', 'coverage'))
        THEN 'holds a key a repo citation does not: ' || (SELECT string_agg(k, ', ') FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'file', 'symbol', 'coverage'))
      WHEN jsonb_typeof(e->'file') IS DISTINCT FROM 'string' THEN 'file is not a string'
      WHEN e ? 'symbol' AND jsonb_typeof(e->'symbol') <> 'string' THEN 'symbol is not a string'
      WHEN NOT (e ? 'coverage') THEN NULL
      WHEN jsonb_typeof(e->'coverage') <> 'object' THEN 'coverage is not an object'
      WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(e->'coverage') k WHERE k NOT IN ('reading', 'atSha'))
        THEN 'coverage holds a key other than reading and atSha'
      WHEN NOT (e->'coverage'->>'reading' IN ('walked', 'not_walked', 'unmeasured'))
        THEN 'coverage.reading is ' || coalesce(e->'coverage'->>'reading', 'absent')
      WHEN jsonb_typeof(e->'coverage'->'atSha') <> 'null' AND NOT (e->'coverage'->>'atSha' ~ '^[0-9a-f]{40}$')
        THEN 'coverage.atSha is not a whole commit sha'
      ELSE NULL END
    WHEN e->>'kind' = 'storefront' THEN CASE
      WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'provider', 'ref', 'id'))
        THEN 'holds a key a storefront citation does not: ' || (SELECT string_agg(k, ', ') FROM jsonb_object_keys(e) k WHERE k NOT IN ('kind', 'provider', 'ref', 'id'))
      ELSE NULL END
    ELSE 'kind is ' || (e->>'kind') || ', neither repo nor storefront' END
$$;--> statement-breakpoint
DO $$
DECLARE
  bad record;
  repaired integer;
BEGIN
  UPDATE "project_workflow_observations" o SET "document" = o."document"
    || jsonb_build_object('steps', (
      SELECT coalesce(jsonb_agg(CASE WHEN t.x ? 'evidence'
        THEN jsonb_set(t.x, '{evidence}', pg_temp.repaired_citation(t.x->'evidence')) ELSE t.x END ORDER BY t.ord), '[]'::jsonb)
      FROM jsonb_array_elements(o."document"->'steps') WITH ORDINALITY AS t(x, ord)))
    || jsonb_build_object('edges', (
      SELECT coalesce(jsonb_agg(CASE WHEN t.x ? 'evidence'
        THEN jsonb_set(t.x, '{evidence}', pg_temp.repaired_citation(t.x->'evidence')) ELSE t.x END ORDER BY t.ord), '[]'::jsonb)
      FROM jsonb_array_elements(coalesce(o."document"->'edges', '[]'::jsonb)) WITH ORDINALITY AS t(x, ord)))
  WHERE jsonb_typeof(o."document"->'steps') = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(o."document"->'steps' || coalesce(o."document"->'edges', '[]'::jsonb)) AS a(x)
      WHERE pg_temp.repaired_citation(a.x->'evidence') IS DISTINCT FROM a.x->'evidence');
  GET DIAGNOSTICS repaired = ROW_COUNT;

  SELECT o."id", t.part, t.ord - 1 AS position, pg_temp.citation_defect(t.x->'evidence') AS defect INTO bad
  FROM "project_workflow_observations" o
  CROSS JOIN LATERAL (
    SELECT 'steps' AS part, s.x, s.ord FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(o."document"->'steps') = 'array' THEN o."document"->'steps' ELSE '[]'::jsonb END) WITH ORDINALITY AS s(x, ord)
    UNION ALL
    SELECT 'edges', g.x, g.ord FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(o."document"->'edges') = 'array' THEN o."document"->'edges' ELSE '[]'::jsonb END) WITH ORDINALITY AS g(x, ord)
  ) t
  WHERE pg_temp.citation_defect(t.x->'evidence') IS NOT NULL
  ORDER BY o."created_at", o."id", t.part DESC, t.ord LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'OBSERVATION_CITATION_UNREPRESENTABLE: project_workflow_observations row % at /%/%/evidence %; a citation is { kind: "repo", file, symbol?, coverage?: { reading, atSha } } or { kind: "storefront", provider, ref, id }, and this migration writes nothing until that row is repaired by hand', bad."id", bad.part, bad.position, bad.defect USING ERRCODE = 'check_violation';
  END IF;
  RAISE NOTICE 'project_workflow_observations: % row(s) had a copied citation given its kind or its coverage atSha', repaired;
END $$;
