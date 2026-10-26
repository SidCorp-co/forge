-- ISS-1229 r43 — the master's ruling on judge-120's finding: a reply the reply check withdrew because it
-- held a token-looking URL was stored whole as the room's `withdrawnDraft`. A secret the check caught is not
-- kept: from this change on, a draft the check reads as a credential is stored as
-- `"withdrawnFor": "credential"` and no text (`packages/core/src/assistant/conversation-progress.ts`).
-- This clears the rows already holding one.
--
-- "Reads as a credential" is the `no-redacted-secret` rule's own predicate,
-- `packages/core/src/messaging/text-rules.ts:readsAsCredential` — the secret scrubber changes the text.
-- Below is each scrubber pattern (`packages/observability/src/index.ts:scrubLogText`) in Postgres regex;
-- `tests/integration/a-withheld-secret-is-not-kept-e2e.test.ts` runs this file over a corpus and holds it
-- to the same answer the scrubber gives; its `\s` and `.` are spelled out as the characters JavaScript
-- reads them as, so no locale decides them. One difference is known, and it clears more, never less: a
-- value already reading `[Filtered]`, which the scrubber leaves as it is, is cleared here.
--
-- 1. A withdrawn draft that is not text cannot be read for a credential: the deploy aborts naming it.
-- 2. Every withdrawn draft the check reads as a credential is removed, and `withdrawnFor` written in its
--    place. Every other row is left as it is.
--
-- Rollback: none for the cleared text, which is the point of the ruling; a row reads its withdrawal as
-- `withdrawnFor` and says why rather than what.
DO $$
DECLARE
  stray record;
  cleared integer;
BEGIN
  SELECT m.id, m.conversation_id, m.seq INTO stray
    FROM conversation_messages m
   WHERE jsonb_typeof(m.delivery_proof) = 'object'
     AND m.delivery_proof ? 'withdrawnDraft'
     AND jsonb_typeof(m.delivery_proof -> 'withdrawnDraft') <> 'string'
   ORDER BY m.created_at, m.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0378: message % (seq % in conversation %) holds a withdrawn draft that is not text, so whether it held a credential cannot be read; clear it (UPDATE conversation_messages SET delivery_proof = delivery_proof - ''withdrawnDraft'' WHERE id = %), then deploy again',
      stray.id, stray.seq, stray.conversation_id, stray.id;
  END IF;

  UPDATE conversation_messages m
     SET delivery_proof = (m.delivery_proof - 'withdrawnDraft') || '{"withdrawnFor": "credential"}'::jsonb
   WHERE jsonb_typeof(m.delivery_proof) = 'object'
     AND jsonb_typeof(m.delivery_proof -> 'withdrawnDraft') = 'string'
     AND (
       -- A PEM private key's opening line.
       (m.delivery_proof ->> 'withdrawnDraft') ~ '-----BEGIN ([A-Z]{1,12} ){0,3}PRIVATE KEY-----'
       -- A Forge personal access token, and a Google access token.
       OR (m.delivery_proof ->> 'withdrawnDraft') ~ 'forge_pat_(dev|stg|prd)_[A-Fa-f0-9]'
       OR (m.delivery_proof ->> 'withdrawnDraft') ~ 'ya29\.[A-Za-z0-9_.-]'
       -- A token in a URL's query.
       OR (m.delivery_proof ->> 'withdrawnDraft') ~* '[?&](token|jwt|access_token|refresh_token|api_key)=[^&#\n]'
       -- A secret header on its line.
       OR (m.delivery_proof ->> 'withdrawnDraft') ~* '(^|[^a-z0-9_])(authorization|cookie|x-device-token|x-api-key|x-csrf-token)[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[:=][\r\u2028\u2029]*[^\n\r\u2028\u2029]'
       -- A secret-named key and its value.
       OR (m.delivery_proof ->> 'withdrawnDraft') ~* '(^|[^a-z0-9_])(authtoken|auth_token|apikey|api_key|password|secret|jwt|token|accesstoken|access_token|refreshtoken|refresh_token|sessiontoken|session_token|bearertoken|testcredentials|privatekey|private_key|serviceaccountjson|service_account_json)[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[:=][\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*"?[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",}&]'
       -- An environment assignment of a secret, as a whole line.
       OR (m.delivery_proof ->> 'withdrawnDraft') ~ '(^|\n)[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(export[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+)?([A-Z0-9]+_)*(PASSWORD|SECRET|TOKEN|KEY|PASS|PEPPER|DSN|CREDENTIALS)(_[A-Z0-9]+)*[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*=[\t\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff][^\n\r\u2028\u2029]*(\n|$)'
     );
  GET DIAGNOSTICS cleared = ROW_COUNT;

  RAISE NOTICE '0378: % withdrawn draft(s) that read as a credential cleared, each now saying why it was withdrawn and none of its text',
    cleared;
END $$;
