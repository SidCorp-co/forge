// cm:hack — the comment-to-verdict dual path (ISS-55). forge-plugin 3.36.542 records verdicts only
// as a `forge-record: verdict` comment fence, so a comment carrying one is also written into
// `criterion_verdicts`, in the comment's own transaction: a block the table cannot hold (an
// abbreviated commit, a criterion the issue does not carry, a skip with no reason) refuses the whole
// comment by name, so a verdict never reads as recorded when the gate cannot see it. Ends when the
// plugin writes verdicts to `POST /api/issues/:id/verdicts` (forge-local-docs/plugin-followups.md);
// then a verdict fence in a comment is refused and this file goes.

import type { Tx } from '../../db/client.js';
import { MessageRefusedError, type MessageRefusal } from '../../messaging/contract.js';
import { parseForgeRecord } from '../../messaging/forge-record.js';
import { criterionBlocksIn } from '../../messaging/verdict-identity.js';
import { recordVerdict, type VerdictAuthor, VerdictRefused } from './store.js';
import { draftFromBlock } from './verdict-input.js';

const SHAPE =
  'a verdict block names a criterion this issue carries, a verdict (pass | short | fail | skipped; skipped with a `why`), and what it was judged against: `commit: <the whole 40-character sha>`, `runtime: <whole object id>` or `design: <flow> rev <n>`';

const EXAMPLE = [
  '```forge-record: verdict · contract 1',
  'criterion: 1',
  'verdict: pass',
  'commit: 3641ba21fec5096e2d1a91a40f2d9e50e9239068',
  'evidence: judge-log.txt',
  '```',
].join('\n');

function asMessageRefusal(err: VerdictRefused): MessageRefusal {
  return {
    rule: err.refusal.code,
    why: err.refusal.detail,
    quote: `criterion: ${err.refusal.criterion}`,
    shape: SHAPE,
    example: EXAMPLE,
  };
}

/** Write every verdict a comment's fence names, or refuse the comment naming each block refused. */
export async function recordCommentVerdicts(
  tx: Tx,
  comment: { id: string; issueId: string; projectId: string; body: string },
  author: VerdictAuthor,
): Promise<number> {
  const blocks = criterionBlocksIn(parseForgeRecord(comment.body));
  const refusals: MessageRefusal[] = [];
  let written = 0;
  for (const block of blocks) {
    if (block.verdict === null) continue;
    try {
      await recordVerdict(tx, {
        issue: { id: comment.issueId, projectId: comment.projectId },
        draft: draftFromBlock({ ...block, verdict: block.verdict }),
        author,
        commentId: comment.id,
      });
      written += 1;
    } catch (err) {
      if (!(err instanceof VerdictRefused)) throw err;
      refusals.push(asMessageRefusal(err));
    }
  }
  if (refusals.length > 0) throw new MessageRefusedError('comment-write', refusals);
  return written;
}
