-- ISS-641 (REQ-34 BC-3; design requirement-to-delivery r19, step `ready`): the requirement's ready
-- checklist decides readiness and replaces the readiness suggestion and its gate. From this change
-- every door refuses a `readiness` suggestion SUGGESTION_KIND_RETIRED, its propose and its accept
-- alike (`suggestions/rules.ts:retiredKindRefusal`), so a readiness row still `proposed` could only
-- wait on Needs you for an accept Forge refuses.
--
-- Each such row moves `proposed -> stale` along the suggestion machine's own edge (version 2), with
-- its decided_at and a reason naming the retirement, and the move is recorded in
-- `kernel_transitions`. Nothing is deleted and no payload is cleared: `readiness` stays a stored
-- kind (`SUGGESTION_KINDS`, which `suggestions_kind_chk` is built from), so every accepted,
-- rejected, stale and withdrawn readiness row stays as the history it is, and the CHECK is not
-- rebuilt. A RAISE NOTICE names every row moved. Idempotent: a staled row is not proposed, so a
-- second run changes nothing.
--
-- ROLLBACK (by reason), run with forge.kernel_txn set to txid_current() as below:
--   UPDATE suggestions SET status = 'proposed', decided_at = NULL, reason = NULL
--    WHERE kind = 'readiness' AND status = 'stale' AND reason LIKE '%(migration 0551, ISS-641)';
DO $$
DECLARE
  prior text := current_setting('forge.kernel_txn', true);
  why constant text := 'readiness is retired: the requirement''s ready checklist decides readiness (REQ-34 BC-3), so no readiness suggestion is accepted (migration 0551, ISS-641)';
  n integer;
  listed text;
BEGIN
  CREATE TEMP TABLE retired_readiness ON COMMIT DROP AS
  SELECT s.id, p.slug, 'REQ-' || r.req_seq AS requirement
    FROM suggestions s
    JOIN projects p ON p.id = s.project_id
    LEFT JOIN requirements r ON r.id = s.requirement_id
   WHERE s.kind = 'readiness' AND s.status = 'proposed';

  PERFORM set_config('forge.kernel_txn', txid_current()::text, true);
  UPDATE suggestions s
     SET status = 'stale', decided_at = now(), reason = why
    FROM retired_readiness t
   WHERE s.id = t.id AND s.status = 'proposed';
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO kernel_transitions
    (entity, entity_id, from_status, to_status, machine_version, reason, actor_type, actor_agency, source, gates)
  SELECT 'suggestion', id, 'proposed', 'stale', 2, why, 'system', 'agent', 'migration', ARRAY[]::text[]
    FROM retired_readiness;
  PERFORM set_config('forge.kernel_txn', coalesce(prior, ''), true);

  SELECT string_agg(format('%s %s (suggestion %s)', slug, coalesce(requirement, 'no requirement'), id), '; '
           ORDER BY slug, requirement, id)
    INTO listed FROM retired_readiness;
  RAISE NOTICE '0551: % proposed readiness suggestion(s) moved to stale: %', n, coalesce(listed, 'none');
END
$$;
