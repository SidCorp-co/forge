// cm:hack — the verdict dual path (ISS-55, ISS-56): a comment carrying a `forge-record: verdict`
// fence is a verdict act, so each block is written into `criterion_verdicts` in the comment's
// transaction and core records each row (`store.ts:recordVerdict`), from every verdict fence the
// comment holds (ISS-608); a block the table cannot hold refuses the whole comment by name. Ends when forge-plugin posts `POST /api/issues/:id/verdicts`
// (plugin-followups.md).

import { eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { isRefusal, type RefusalError } from '../../lib/refusal.js';
import { type MessageRefusal, MessageRefusedError } from '../../messaging/contract.js';
import type { ForgeRecord } from '../../messaging/forge-record.js';
import { criterionBlocksIn } from '../../messaging/verdict-identity.js';
import type { Actor } from '../activity.js';
import { draftFromBlock } from './verdict-input.js';
import { recordVerdict, type VerdictAuthor } from './verdict-record.js';

const SHAPE =
  'a verdict block names a criterion this issue carries, a verdict (pass | short | fail | skipped; skipped with a `why`), and what it was judged against: `commit: <the whole 40-character sha>`, `runtime: <whole object id>`, `runtime: <workflow id>@draft:<draft version>` with `environment: <key>`, or `design: <flow> rev <n>`';

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 1',
  'verdict: pass',
  'commit: 3641ba21fec5096e2d1a91a40f2d9e50e9239068',
  'evidence: judge-log.txt',
  '```',
].join('\n');

function asMessageRefusal(err: RefusalError, criterion: number): MessageRefusal {
  const [refusal] = err.refusals;
  return {
    rule: refusal?.code ?? err.fallbackCode,
    why: refusal?.detail ?? err.message,
    quote: `criterion: ${criterion}`,
    shape: SHAPE,
    example: EXAMPLE,
  };
}

/** The verdict's author as the event's actor names it: a box is an agent, an account its agency. */
function authorOfActor(actor: Actor): VerdictAuthor {
  return {
    userId: actor.type === 'user' ? actor.id : null,
    deviceId: actor.type === 'device' ? actor.id : null,
    agency: actor.agency,
  };
}

/** A criterion line that is not a whole number, or a block that names no verdict: never dropped. */
function unparsedBlocks(record: ForgeRecord): MessageRefusal[] {
  const refusal = (rule: string, why: string, quote: string): MessageRefusal => ({
    rule,
    why,
    quote,
    shape: SHAPE,
    example: EXAMPLE,
  });
  const out: MessageRefusal[] = [];
  for (const field of record.kind === 'verdict' ? record.fields : []) {
    if (field.key === 'criterion' && !/^\d+$/.test(field.value.trim())) {
      out.push(
        refusal(
          'VERDICT_CRITERION_UNKNOWN',
          'a criterion is named by its whole number',
          `criterion: ${field.value}`,
        ),
      );
    }
  }
  for (const block of criterionBlocksIn(record)) {
    if (block.verdict === null) {
      out.push(
        refusal(
          'VERDICT_VALUE_UNKNOWN',
          'this block names no verdict, so nothing would be recorded for it',
          `criterion: ${block.criterion}`,
        ),
      );
    }
  }
  return out;
}

/** Each refusal of one fence, named as that fence where the comment holds several. */
function named(refusals: readonly MessageRefusal[], fence: string): MessageRefusal[] {
  return fence === '' ? [...refusals] : refusals.map((r) => ({ ...r, why: `${fence}${r.why}` }));
}

/**
 * Write every criterion verdict the `verdict` records name — every fence of a comment, ISS-608 —
 * or refuse the whole act naming each block refused and the fence it sits in, so nothing of it is
 * written: a comment recorded with half its verdicts reads as whole. Answers how many each record
 * wrote, in the order given.
 */
export async function recordEventVerdicts(
  tx: Tx,
  event: {
    issueId: string;
    records: readonly { record: ForgeRecord; fence: string }[];
    actor: Actor;
    commentId: string | null;
  },
): Promise<number[]> {
  const door = event.commentId ? 'comment-write' : 'record-event-write';
  const unparsed = event.records.flatMap(({ record, fence }) =>
    named(unparsedBlocks(record), fence),
  );
  if (unparsed.length > 0) throw new MessageRefusedError(door, unparsed);
  if (event.records.every(({ record }) => criterionBlocksIn(record).length === 0)) {
    return event.records.map(() => 0);
  }
  const [issue] = await tx
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, event.issueId))
    .limit(1);
  if (!issue) return event.records.map(() => 0);
  const refusals: MessageRefusal[] = [];
  const written: number[] = [];
  for (const { record, fence } of event.records) {
    let count = 0;
    for (const block of criterionBlocksIn(record)) {
      const draft = draftFromBlock({ ...block, verdict: block.verdict as string });
      try {
        await recordVerdict(tx, {
          issue,
          draft,
          author: authorOfActor(event.actor),
          commentId: event.commentId,
        });
        count += 1;
      } catch (err) {
        if (!isRefusal(err)) throw err;
        refusals.push(...named([asMessageRefusal(err, draft.criterion)], fence));
      }
    }
    written.push(count);
  }
  if (refusals.length > 0) throw new MessageRefusedError(door, refusals);
  return written;
}
