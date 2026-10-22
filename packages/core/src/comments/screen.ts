import type { Tx } from '../db/client.js';
import { ROLE_HOLDER } from '../messaging/audiences.js';
import { type MessageRefusal, MessageRefusedError } from '../messaging/contract.js';
import { type ForgeRecord, readForgeRecords } from '../messaging/forge-record.js';
import { gatherFacts } from '../messaging/gather.js';
import {
  fenceNamed,
  recordFenceRefusal,
  recordInCommentRefusal,
  recordInCommentWarning,
  recordRefusals,
  severalRecordsRefusals,
  untaggedFenceRefusal,
} from '../messaging/record-screen.js';
import { screenMessage } from '../messaging/screen.js';

/**
 * Every record fence of a body is screened, each named where there are several: one carrying no
 * record, or naming no kind, is refused whatever the caller declared; records are refused where the
 * caller declared it can write elsewhere and warned where it did not, both off one message so the
 * two cannot drift; and several fences stand only where every one is a verdict (ISS-608).
 */
export function screenRecordFence(body: string, declaresRecordRoute: boolean): string[] {
  const reads = readForgeRecords(body);
  const of = reads.length;
  const shapes = reads.flatMap(({ index, fault }) => {
    const refusal = recordFenceRefusal(fault, fenceNamed(index, of));
    return refusal ? [refusal] : [];
  });
  if (shapes.length > 0) throw new MessageRefusedError('comment-write', shapes);
  const records = reads.flatMap(({ index, record }) => (record ? [{ index, record }] : []));
  const [first] = records;
  if (!first) return [];
  if (declaresRecordRoute) {
    const refusal = recordInCommentRefusal(first.record);
    throw new MessageRefusedError('comment-write', refusal ? [refusal] : []);
  }
  const unread = [
    ...records.flatMap(({ index, record }) => {
      const refusal = untaggedFenceRefusal(record, fenceNamed(index, of));
      return refusal ? [refusal] : [];
    }),
    ...severalRecordsRefusals(records, of),
  ];
  if (unread.length > 0) throw new MessageRefusedError('comment-write', unread);
  const warning = recordInCommentWarning(first.record);
  return warning ? [warning] : [];
}

/** Every record a body's fences carry, in the order written. */
function recordsIn(body: string): ForgeRecord[] {
  return readForgeRecords(body).flatMap(({ record }) => (record ? [record] : []));
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
  const onRecords: MessageRefusal[] = [];
  for (const record of recordsIn(body)) {
    onRecords.push(...(await recordRefusals(projectId, record, tx)));
  }
  const refusals = [...onBody, ...onRecords];
  if (refusals.length > 0) throw new MessageRefusedError('comment-write', refusals, at);
}
