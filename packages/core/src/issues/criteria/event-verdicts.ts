// cm:hack — the verdict dual path (ISS-55, ISS-56): a comment carrying a `forge-record: verdict`
// fence is a verdict act, so each block is written into `criterion_verdicts` in the comment's
// transaction and core records each row (`store.ts:recordVerdict`); a block the table cannot hold
// refuses the whole comment by name. Ends when forge-plugin posts `POST /api/issues/:id/verdicts`
// (plugin-followups.md).

import { eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { isRefusal, type RefusalError } from '../../lib/refusal.js';
import { type MessageRefusal, MessageRefusedError } from '../../messaging/contract.js';
import type { ForgeRecord } from '../../messaging/forge-record.js';
import { criterionBlocksIn } from '../../messaging/verdict-identity.js';
import type { Actor } from '../activity.js';
import { recordVerdict, type VerdictAuthor } from './store.js';
import { draftFromBlock } from './verdict-input.js';

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
export function authorOfActor(actor: Actor): VerdictAuthor {
  return {
    userId: actor.type === 'user' ? actor.id : null,
    deviceId: actor.type === 'device' ? actor.id : null,
    agency: actor.agency,
  };
}

/** Write every criterion verdict a `verdict` record names, or refuse naming each block refused. */
export async function recordEventVerdicts(
  tx: Tx,
  event: { issueId: string; record: ForgeRecord; actor: Actor; commentId: string | null },
): Promise<number> {
  const blocks = criterionBlocksIn(event.record).filter((b) => b.verdict !== null);
  if (blocks.length === 0) return 0;
  const [issue] = await tx
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, event.issueId))
    .limit(1);
  if (!issue) return 0;
  const refusals: MessageRefusal[] = [];
  let written = 0;
  for (const block of blocks) {
    const draft = draftFromBlock({ ...block, verdict: block.verdict as string });
    try {
      await recordVerdict(tx, {
        issue,
        draft,
        author: authorOfActor(event.actor),
        commentId: event.commentId,
      });
      written += 1;
    } catch (err) {
      if (!isRefusal(err)) throw err;
      refusals.push(asMessageRefusal(err, draft.criterion));
    }
  }
  if (refusals.length > 0) {
    throw new MessageRefusedError(
      event.commentId ? 'comment-write' : 'record-event-write',
      refusals,
    );
  }
  return written;
}
