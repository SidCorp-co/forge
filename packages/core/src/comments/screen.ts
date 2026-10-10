import type { Tx } from '../db/client.js';
import { ROLE_HOLDER } from '../messaging/audiences.js';
import { MessageRefusedError } from '../messaging/contract.js';
import { parseForgeRecord, readForgeRecord } from '../messaging/forge-record.js';
import { gatherFacts } from '../messaging/gather.js';
import {
  recordFenceRefusal,
  recordInCommentRefusal,
  recordInCommentWarning,
  recordRefusals,
} from '../messaging/record-screen.js';
import { screenMessage } from '../messaging/screen.js';

/**
 * A fence carrying no record is refused whatever the caller declared; one carrying a record is
 * refused where the caller declared it can write elsewhere and warned where it did not, both off
 * one message so the two cannot drift.
 */
export function screenRecordFence(body: string, declaresRecordRoute: boolean): string[] {
  const { record, fault } = readForgeRecord(body);
  const shape = recordFenceRefusal(fault);
  if (shape) throw new MessageRefusedError('comment-write', [shape]);
  if (!record) return [];
  if (declaresRecordRoute) {
    const refusal = recordInCommentRefusal(record);
    throw new MessageRefusedError('comment-write', refusal ? [refusal] : []);
  }
  const warning = recordInCommentWarning(record);
  return warning ? [warning] : [];
}

/** Screen an agent's comment; `at` is where its text sat in the caller's request. */
export async function screenAgentComment(
  projectId: string,
  body: string,
  tx: Tx,
  at?: string,
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
  const onBody = verdict.ok ? [] : verdict.refusals;
  const onRecord = await recordRefusals(projectId, parseForgeRecord(body), tx);
  const refusals = [...onBody, ...onRecord];
  if (refusals.length > 0) throw new MessageRefusedError('comment-write', refusals, at);
}
