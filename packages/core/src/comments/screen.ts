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
  if (!verdict.ok) throw new MessageRefusedError('comment-write', verdict.refusals);
}

/**
 * The 400 a refused message becomes, or `null` when this error is not one.
 */
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
export function messageRefused(err: unknown): { code: string; message: string } | null {
  return err instanceof MessageRefusedError ? { code: err.code, message: err.message } : null;
}
