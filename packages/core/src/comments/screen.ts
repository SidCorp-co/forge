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
import { gatherFacts } from '../messaging/gather.js';
import { screenMessage } from '../messaging/screen.js';

// cm:guard agents ONLY, and the test is `authorAgency`, which `require-pat.ts` resolves from the token owner's `users.kind` rather than from anything the caller sends. A person writing on the web UI has a full markdown editor and is not the audience of any of these rules (ISS-997 out of scope); binding them here would be a gate on the wrong reader.
// cm:guard the screen runs BEFORE the insert and through the CALLER's handle. Before, because a refused comment must leave no row; through the caller's handle, because a caller inside a transaction that read the pool here would hold one connection and wait for a second (ISS-981).
export async function screenAgentComment(
  projectId: string,
  body: string,
  tx: Tx,
): Promise<void> {
  const segments = [body];
  const facts = await gatherFacts({
    projectId,
    audience: ROLE_HOLDER,
    intent: 'report',
    segments,
    executor: tx,
  });
  const verdict = screenMessage({ audience: ROLE_HOLDER, intent: 'report', segments, facts });
  if (!verdict.ok) throw new MessageRefusedError('comment-write', verdict.refusals);
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
