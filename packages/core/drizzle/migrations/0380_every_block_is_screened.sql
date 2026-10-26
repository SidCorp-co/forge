-- ISS-1229 r44 — the master's ruling on judge-124's finding: a tool call's input and output reached every
-- reader of a room unscreened, and the stored reply kept them. Every block a frame or a stored message
-- carries now passes the one credential screen, `packages/core/src/messaging/credential-screen.ts`, whose
-- predicate `readsAsCredential` also reads a quoted JSON key and every string a JSON object or array holds.
-- This clears what is already stored under that predicate.
--
-- `reads_as_credential_0380` restates `readsAsCredential`: 0378's patterns for `scrubLogText`
-- (`packages/observability/src/index.ts`), a secret-named key or header now matched before a closing quote,
-- plain or escaped, and, where the text is a JSON object or array, every string it holds read the same way.
-- `tests/integration/every-block-is-screened-e2e.test.ts` runs this file over a corpus and holds its answer
-- to the predicate's. Two differences are known, and each clears more, never less: a string the runtime
-- would scrub in place is cleared whole here; and a JSON text `jsonb` cannot decode though it is JSON (a
-- `\u0000` or a lone surrogate escape, both of which JavaScript reads) is cleared whole, unread.
--
-- 1. A stored `blocks` that is neither a JSON array nor JSON null cannot be read block by block: the deploy
--    aborts naming it.
-- 2. Where the text or reasoning a tool call split into blocks reads as a credential joined up, those blocks
--    become one `[Filtered]` block; then every string any block holds that reads as one becomes `[Filtered]`,
--    and so does a string or number that reads as one only beside its own key, as `{"password": "x"}` does.
-- 3. Every withdrawn draft the widened predicate reads as a credential is cleared as 0378 cleared them.
--
-- Rollback: none for the cleared text, which is the point of the ruling.
CREATE OR REPLACE FUNCTION pg_temp.reads_as_credential_0380(t text) RETURNS boolean
LANGUAGE plpgsql AS $f$
DECLARE
  j jsonb;
BEGIN
  IF t ~ '-----BEGIN ([A-Z]{1,12} ){0,3}PRIVATE KEY-----'
     OR t ~ 'forge_pat_(dev|stg|prd)_[A-Fa-f0-9]'
     OR t ~ 'ya29\.[A-Za-z0-9_.-]'
     OR t ~* '[?&](token|jwt|access_token|refresh_token|api_key)=[^&#\n]'
     OR t ~* '(^|[^a-z0-9_])(authorization|cookie|x-device-token|x-api-key|x-csrf-token)(\\*")?[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[:=][\r\u2028\u2029]*[^\n\r\u2028\u2029]'
     OR t ~* '(^|[^a-z0-9_])(authtoken|auth_token|apikey|api_key|password|secret|jwt|token|accesstoken|access_token|refreshtoken|refresh_token|sessiontoken|session_token|bearertoken|testcredentials|privatekey|private_key|serviceaccountjson|service_account_json)(\\*")?[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[:=][\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(\\*")?[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",}&]'
     OR t ~ '(^|\n)[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(export[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+)?([A-Z0-9]+_)*(PASSWORD|SECRET|TOKEN|KEY|PASS|PEPPER|DSN|CREDENTIALS)(_[A-Z0-9]+)*[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*=[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff][^\n\r\u2028\u2029]*(\n|$)'
  THEN
    RETURN true;
  END IF;
  IF t !~ '^[ \t\n\r]*[[{]' THEN
    RETURN false;
  END IF;
  BEGIN
    j := t::jsonb;
  EXCEPTION WHEN others THEN
    BEGIN
      PERFORM t::json;
    EXCEPTION WHEN others THEN
      RETURN false;
    END;
    RETURN true;
  END;
  RETURN EXISTS (
    SELECT 1 FROM jsonb_path_query(j, 'strict $.**') AS v
     WHERE jsonb_typeof(v) = 'string' AND pg_temp.reads_as_credential_0380(v #>> '{}')
  );
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.screened_0380(j jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE
  out jsonb;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'string' THEN
      IF pg_temp.reads_as_credential_0380(j #>> '{}') THEN
        RETURN to_jsonb('[Filtered]'::text);
      END IF;
      RETURN j;
    WHEN 'array' THEN
      SELECT COALESCE(jsonb_agg(pg_temp.screened_0380(e) ORDER BY n), '[]'::jsonb) INTO out
        FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, n);
      RETURN out;
    WHEN 'object' THEN
      SELECT COALESCE(jsonb_object_agg(k, CASE
               WHEN jsonb_typeof(v) IN ('string', 'number')
                AND pg_temp.screened_0380(v) = v
                AND pg_temp.reads_as_credential_0380(jsonb_build_object(k, 'x')::text)
                AND pg_temp.reads_as_credential_0380(jsonb_build_object(k, v)::text)
               THEN to_jsonb('[Filtered]'::text)
               ELSE pg_temp.screened_0380(v)
             END), '{}'::jsonb) INTO out
        FROM jsonb_each(j) AS o(k, v);
      RETURN out;
    ELSE
      RETURN j;
  END CASE;
END
$f$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.screened_blocks_0380(blocks jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $f$
DECLARE
  kind text;
  joined text;
  runs integer;
BEGIN
  FOREACH kind IN ARRAY ARRAY['text', 'thinking'] LOOP
    SELECT string_agg(e ->> kind, '' ORDER BY n), count(*) INTO joined, runs
      FROM jsonb_array_elements(blocks) WITH ORDINALITY AS a(e, n)
     WHERE e ->> 'type' = kind AND jsonb_typeof(e -> kind) = 'string';
    IF runs > 1 AND pg_temp.reads_as_credential_0380(joined) THEN
      SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) INTO blocks
        FROM jsonb_array_elements(blocks) WITH ORDINALITY AS a(e, n)
       WHERE NOT (e ->> 'type' = kind AND jsonb_typeof(e -> kind) = 'string');
      blocks := blocks || jsonb_build_array(jsonb_build_object('type', kind, kind, '[Filtered]'));
    END IF;
  END LOOP;
  RETURN pg_temp.screened_0380(blocks);
END
$f$;
--> statement-breakpoint
DO $$
DECLARE
  stray record;
  blocks_cleared integer;
  drafts_cleared integer;
BEGIN
  SELECT m.id, m.conversation_id, m.seq INTO stray
    FROM conversation_messages m
   WHERE jsonb_typeof(m.blocks) NOT IN ('array', 'null')
   ORDER BY m.created_at, m.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0380: message % (seq % in conversation %) stores blocks that are not a list, so its blocks cannot be read for a credential one by one; clear them (UPDATE conversation_messages SET blocks = NULL WHERE id = %), then deploy again',
      stray.id, stray.seq, stray.conversation_id, stray.id;
  END IF;

  WITH s AS (
    SELECT m.id, pg_temp.screened_blocks_0380(m.blocks) AS screened
      FROM conversation_messages m
     WHERE jsonb_typeof(m.blocks) = 'array'
  )
  UPDATE conversation_messages m
     SET blocks = s.screened
    FROM s
   WHERE m.id = s.id AND s.screened <> m.blocks;
  GET DIAGNOSTICS blocks_cleared = ROW_COUNT;

  UPDATE conversation_messages m
     SET delivery_proof = (m.delivery_proof - 'withdrawnDraft') || '{"withdrawnFor": "credential"}'::jsonb
   WHERE jsonb_typeof(m.delivery_proof) = 'object'
     AND jsonb_typeof(m.delivery_proof -> 'withdrawnDraft') = 'string'
     AND pg_temp.reads_as_credential_0380(m.delivery_proof ->> 'withdrawnDraft');
  GET DIAGNOSTICS drafts_cleared = ROW_COUNT;

  RAISE NOTICE '0380: % message(s) whose blocks held something that reads as a credential screened, and % withdrawn draft(s) cleared',
    blocks_cleared, drafts_cleared;
END $$;
--> statement-breakpoint
DROP FUNCTION pg_temp.screened_blocks_0380(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.screened_0380(jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.reads_as_credential_0380(text);
