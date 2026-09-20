import { HTTPException } from 'hono/http-exception';
import type { Tx } from '../db/client.js';
import { ROLE_HOLDER } from '../messaging/audiences.js';
import { MessageRefusedError } from '../messaging/contract.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { gatherFacts } from '../messaging/gather.js';
import {
  recordInCommentRefusal,
  recordInCommentWarning,
  recordRefusals,
} from '../messaging/record-screen.js';
import { screenMessage } from '../messaging/screen.js';

/**
 * The fence rule at the comment door: refused where the caller said it can
 * write a record elsewhere, and carried as a warning where it did not.
 *
 * Both outcomes come off one message, so the fleet reads the same sentence
 * before the gate exists as it will read from the gate. Which of the two a
 * caller gets is its own declaration and nothing else — see
 * `middleware/client-capabilities.ts` for why the switch is the caller's.
 */
export function screenRecordFence(body: string, declaresRecordRoute: boolean): string[] {
  const record = parseForgeRecord(body);
  if (!record) return [];
  if (declaresRecordRoute) {
    const refusal = recordInCommentRefusal(record);
    throw new MessageRefusedError('comment-write', refusal ? [refusal] : []);
  }
  const warning = recordInCommentWarning(record);
  return warning ? [warning] : [];
}

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
 *
 * The door and the refusals ride under `details`, which is the only key of a
 * cause that `middleware/error.ts` puts on the wire — it ships `code`,
 * `message` and `details` and drops everything else. They used to sit beside
 * `code`, so a caller reading the structured refusals this builds got nothing
 * and only the rendered prose survived (fixed under ISS-1113).
 */
export function messageRefusalHttp(err: unknown): HTTPException | null {
  if (!(err instanceof MessageRefusedError)) return null;
  return new HTTPException(400, {
    message: err.message,
    cause: { code: err.code, details: { door: err.door, refusals: err.refusals } },
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
