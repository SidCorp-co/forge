/**
 * ISS-239 — observability for the auto-skip resolver. Each hop of an
 * auto-skip chain appends one entry to `pipeline_runs.metadata.skipChain`
 * so operators can reconstruct why an issue advanced past a stage without
 * dispatching a job. When the chain caps without finding an anchor, a
 * separate operator-facing comment surfaces the misconfiguration.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  comments,
  issues,
  projects,
} from '../db/schema.js';
import { logger } from '../logger.js';
import type { SkipReason } from './state-machine.js';

export interface SkipChainEntry {
  from: IssueStatus;
  to: IssueStatus;
  reason: SkipReason;
  /** ISO-8601 timestamp the hop was applied. */
  at: string;
}

/**
 * Append a single skip-chain entry to the run's `metadata.skipChain` array.
 * Uses `jsonb_set` + `||` so concurrent writers don't clobber each other —
 * each hop is its own UPDATE. `pipeline_runs.metadata` is jsonb so no
 * migration is required.
 */
export async function appendSkipChainEntry(
  runId: string,
  entry: SkipChainEntry,
): Promise<void> {
  const payload = JSON.stringify([entry]);
  await db.execute(sql`
    UPDATE pipeline_runs
       SET metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{skipChain}',
             COALESCE(metadata->'skipChain', '[]'::jsonb) || ${payload}::jsonb,
             true
           ),
           updated_at = NOW()
     WHERE id = ${runId}
  `);
}

/**
 * Operator-facing comment body when a skip chain exhausts MAX_SKIP_CHAIN
 * without finding an anchor with a registered skill. English-only per the
 * project rule. Mirrors the missing-skill-guard tone — surfaces the
 * misconfiguration and the corrective action.
 */
export function buildSkipChainCappedCommentBody(
  from: IssueStatus,
  visited: IssueStatus[],
): string {
  const trail = visited.length > 0 ? visited.join(' → ') : '(none)';
  return [
    `🛑 **Auto-skip chain capped at stage \`${from}\`**`,
    '',
    `Walked: ${trail}`,
    '',
    'Reason: no enabled stage with a registered skill was reachable within the ' +
      'soft-skip horizon. The issue is parked at the source stage until a skill ' +
      'is registered or a stage is enabled in `pipelineConfig`.',
    '',
    'Required action:',
    '- Register a skill for one of the stages along the forward chain, or',
    '- Re-enable a stage in `pipelineConfig.states` so the chain can anchor.',
  ].join('\n');
}

/**
 * Insert an operator-facing comment for a capped skip chain. Mirrors the
 * creator-resolution + try/catch pattern from `postMissingSkillComment` so a
 * missing creator / insert failure does not break the orchestrator hook.
 */
export async function postSkipChainCappedComment(args: {
  projectId: string;
  issueId: string;
  from: IssueStatus;
  visited: IssueStatus[];
}): Promise<void> {
  const [row] = await db
    .select({ createdBy: projects.createdBy })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, args.issueId))
    .limit(1);
  if (!row?.createdBy) return;

  try {
    await db.insert(comments).values({
      issueId: args.issueId,
      authorId: row.createdBy,
      body: buildSkipChainCappedCommentBody(args.from, args.visited),
      isAi: true,
    } as never);
  } catch (err) {
    logger.warn(
      { err, issueId: args.issueId, from: args.from },
      'skip-chain-log: failed to post capped comment, continuing',
    );
  }
}

