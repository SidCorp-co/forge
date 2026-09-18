/**
 * The comment write door: an agent's comment on an issue is a REPORT read by
 * somebody holding a role on the project, and that is the pair it is read under.
 *
 * This is the situation ISS-997 exists to close. The write door sanitized markup
 * and never checked what the words claimed, so an agent writing *merged,
 * deployed, closed* to the person who decides met no check that any of it had
 * happened — while the same claim headed for a chat room was checked thoroughly.
 */

import { HTTPException } from 'hono/http-exception';
import type { Tx } from '../db/client.js';
import { ROLE_HOLDER } from '../messaging/audiences.js';
import { MessageRefusedError } from '../messaging/contract.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { gatherFacts } from '../messaging/gather.js';
import { recordRefusals } from '../messaging/record-screen.js';
import { screenMessage } from '../messaging/screen.js';

// cm:guard agents ONLY, and the test is `authorAgency`, which `require-pat.ts` resolves from the token owner's `users.kind` rather than from anything the caller sends. A person writing on the web UI has a full markdown editor and is not the audience of any of these rules (ISS-997 out of scope); binding them here would be a gate on the wrong reader.
// cm:guard the screen runs BEFORE the insert and through the CALLER's handle. Before, because a refused comment must leave no row; through the caller's handle, because a caller inside a transaction that read the pool here would hold one connection and wait for a second (ISS-981).
// cm:guard the whole-body `role:report` screen below is UNCHANGED by ISS-1089 — same cell, same
// four rules, same order — and the record screen is a second pass beside it rather than a widening
// of it. A comment carrying no fence reaches exactly the verdict it reached before: `recordRefusals`
// is handed a null parse and returns nothing without a query.
// cm:guard both passes are gathered into ONE refusal. `comment-write` declares `ending: 'refusal'`
// and no repairs, so a writer gets one answer and no second attempt: throwing on the body screen
// before the record has been measured would show it half of what is wrong and spend its only turn.
export async function screenAgentComment(projectId: string, body: string, tx: Tx): Promise<void> {
  const segments = [body];
  const facts = await gatherFacts({
    projectId,
    audience: ROLE_HOLDER,
    intent: 'report',
    segments,
    executor: tx,
  });
  const verdict = screenMessage({ audience: ROLE_HOLDER, intent: 'report', segments, facts });
  const onBody = verdict.ok ? [] : verdict.refusals;
  const onRecord = await recordRefusals(projectId, parseForgeRecord(body), tx);
  const refusals = [...onBody, ...onRecord];
  if (refusals.length > 0) throw new MessageRefusedError('comment-write', refusals);
}

/**
 * The 400 a refused message becomes, or `null` when this error is not one.
 */
// cm:guard the message is handed through VERBATIM, exactly as `bodyInvalidHttp` does for markup, and for the same measured reason: guidance an agent has to go and look up produced 0.02% compliance on comments, and a refusal carrying the rule, the shape and an example produced near 100%. A generic "message refused" here throws that away and the repair budget is spent guessing.
export function messageRefusalHttp(err: unknown): HTTPException | null {
  if (!(err instanceof MessageRefusedError)) return null;
  return new HTTPException(400, {
    message: err.message,
    cause: { code: err.code, door: err.door, refusals: err.refusals },
  });
}

/** Re-throw a refused message as a 400; anything else passes through untouched. */
export function rethrowMessageRefused(err: unknown): never {
  const mapped = messageRefusalHttp(err);
  if (mapped) throw mapped;
  throw err;
}

/**
 * The screen's refusal, as the `{ code, message }` a caller is told by name.
 */
// cm:guard this predicate exists so a caller does NOT have to import the messaging module to recognise a refused claim. `forge-comments.ts` reaches seven modules with that import and six is the fan-out limit, and widening `.arch.json` to make it fit would be paying the check instead of the design — the comments domain owns "what a refused comment looks like to my callers", which is what this is (ISS-997).
export function messageRefused(err: unknown): { code: string; message: string } | null {
  return err instanceof MessageRefusedError ? { code: err.code, message: err.message } : null;
}
