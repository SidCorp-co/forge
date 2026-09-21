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
 * The fence rule at the comment door: refused where the caller declared it can write a record
 * elsewhere, warned where it did not — both off one message, so the two cannot drift.
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
 * The 400 a refused message becomes, or `null` when this error is not one. The door and the
 * refusals must ride under `details`, the only key of a cause `middleware/error.ts` puts on the
 * wire — a refusal placed elsewhere reaches the caller as prose with no structure behind it.
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
