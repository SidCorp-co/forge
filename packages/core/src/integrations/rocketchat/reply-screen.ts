/**
 * ISS-672/ISS-675 — the shared output-guard composition for any reply headed
 * to a RocketChat room, sync or async. Extracted from
 * `connection-manager.ts`'s `checkReply`/`verifyReplyClaims` (which drove only
 * the synchronous mention-reply path) so the ISS-675 async escalation bridge
 * cannot bypass the same kernel-hard guards — clarify flagged this divergence
 * as a real gap, not a hypothetical one.
 *
 * Composes the pure guards in `reply-guard.ts` with one DB-aware step (does a
 * cited issue id/ISS-seq actually exist in this project?). Fails OPEN on a DB
 * error — an infra blip must never brick a reply outright.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { logger } from '../../logger.js';
import {
  detectEmptyPromise,
  extractIssueClaims,
  judgeIssueClaims,
  lintStakeholderReply,
} from './reply-guard.js';

export interface ReplyScreenVerdict {
  ok: boolean;
  problems: string[];
}

interface ClaimVerdict extends ReplyScreenVerdict {
  verifiedSeqs: Set<number>;
  verifiedUrlIds: Set<string>;
  dbError: boolean;
}

/**
 * Check a reply's issue references against the DB (project-scoped) and the
 * turn's actual tool calls. Fails OPEN on DB errors — the guard must never
 * brick replies on an infra blip. Also surfaces the verified id/seq sets and a
 * `dbError` flag so `lintStakeholderReply`'s bare-ISS-id rule can carve out
 * citations already checked here (and skip entirely on a DB blip, matching
 * this guard's own fail-open behavior).
 */
async function verifyReplyClaims(
  projectId: string,
  reply: string,
  toolCalls: Array<{ name: string; arguments: string }>,
): Promise<ClaimVerdict> {
  const claims = extractIssueClaims(reply);
  let ids = new Set<string>();
  let seqs = new Set<number>();
  if (claims.urlIds.length > 0 || claims.issSeqs.length > 0) {
    try {
      const conds = [
        ...(claims.urlIds.length > 0 ? [inArray(issues.id, claims.urlIds)] : []),
        ...(claims.issSeqs.length > 0 ? [inArray(issues.issSeq, claims.issSeqs)] : []),
      ];
      const rows = await db
        .select({ id: issues.id, issSeq: issues.issSeq })
        .from(issues)
        .where(and(eq(issues.projectId, projectId), or(...conds)));
      ids = new Set(rows.map((r) => r.id));
      seqs = new Set(rows.map((r) => r.issSeq));
    } catch (err) {
      logger.warn({ err, projectId }, 'rocketchat: claim verification query failed; skipping');
      return {
        ok: true,
        problems: [],
        verifiedSeqs: new Set(),
        verifiedUrlIds: new Set(),
        dbError: true,
      };
    }
  }
  const verdict = judgeIssueClaims(claims, { ids, seqs }, toolCalls);
  return { ...verdict, verifiedSeqs: seqs, verifiedUrlIds: ids, dbError: false };
}

/**
 * Compose the issue-claim guard with the product-only lint and the
 * empty-promise guard into one verdict. Used by the synchronous
 * mention-reply path (`connection-manager.ts`) and both async completion
 * bridges (`escalation-bridge.ts`, `agent-chat-bridge.ts`) so none can drift
 * from the others' guarantees. `toolCalls` is `[]` for the escalation bridge
 * (its reply comes from a separate Bao synthesis turn with no tool calls of
 * its own) — the claimed-creation-but-no-create-call check is then skipped,
 * but the pure product-lint + empty-promise + issue-id-existence checks
 * still apply. The agent-chat bridge instead threads in the runner
 * session's own tool calls (`agent-chat-bridge.ts`'s `extractToolCalls`),
 * so that check applies there too.
 */
export async function screenStakeholderReply(
  projectId: string,
  reply: string,
  toolCalls: Array<{ name: string; arguments: string }>,
): Promise<ReplyScreenVerdict> {
  const claim = await verifyReplyClaims(projectId, reply, toolCalls);
  const lint = lintStakeholderReply(reply, {
    verifiedSeqs: claim.verifiedSeqs,
    skipIssueIdRule: claim.dbError,
  });
  const promise = detectEmptyPromise(reply);
  return {
    ok: claim.ok && lint.ok && promise.ok,
    problems: [...claim.problems, ...lint.problems, ...promise.problems],
  };
}
