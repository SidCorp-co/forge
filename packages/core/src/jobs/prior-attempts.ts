// A retry's prompt is the PARENT's prompt string, copied verbatim by `retry.ts` — only
// `verify_skill` rebuilds it. So the "what did the last attempt do" block cannot be produced at
// enqueue time by `buildJobPromptString`; it is spliced in at dispatch time, the same way
// `injectTurnLevelRules` is.

import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, jobs } from '../db/schema.js';
import { logger } from '../logger.js';

export interface PriorAttempt {
  attempt: number;
  sessionId: string | null;
  messageCount: number;
  failureReason: string | null;
  salvage: SalvageRecord | null;
}

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/lifecycle.rs — the runner serialises this exact object onto `POST /api/jobs/:id/fail`. `failBodySchema` there is `.strict()`, so a field the runner adds without adding it here is a 400 and the WHOLE failure report is lost, not just the salvage half.
export const salvageSchema = z
  .object({
    outcome: z.enum(['pushed', 'committed_not_pushed', 'none', 'refused', 'failed']),
    branch: z.string().max(300).optional(),
    sha: z.string().max(64).optional(),
    files: z.number().int().min(0).optional(),
    insertions: z.number().int().min(0).optional(),
    detail: z.string().max(2000).optional(),
  })
  .strict();

/** What the runner managed to preserve of a failed attempt's working copy. Inferred from the
 *  schema above so the wire contract and the type cannot drift apart. */
export type SalvageRecord = z.infer<typeof salvageSchema>;

/** Merge a reported salvage into `jobs.failure_meta` without clobbering what is already there.
 *  Spreads to nothing when the runner reported none, so the caller can spread unconditionally. */
export function salvageSet(salvage: SalvageRecord | undefined | null) {
  if (!salvage) return {};
  return {
    failureMeta: sql`coalesce(${jobs.failureMeta}, '{}'::jsonb) || ${JSON.stringify({ salvage })}::jsonb`,
  };
}

function readSalvage(failureMeta: unknown): SalvageRecord | null {
  if (!failureMeta || typeof failureMeta !== 'object') return null;
  const raw = (failureMeta as Record<string, unknown>).salvage;
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.outcome !== 'string') return null;
  return s as unknown as SalvageRecord;
}

/**
 * Walk the `retryOf` chain from this job back to the root attempt, newest first.
 *
 * Bounded by `max` and by a seen-set rather than by trusting the chain: `retryOf` is a
 * self-referencing FK, and a cycle would otherwise spin here forever.
 */
export async function loadPriorAttempts(
  job: typeof jobs.$inferSelect,
  max = 5,
): Promise<PriorAttempt[]> {
  if (!job.retryOf) return [];
  const out: PriorAttempt[] = [];
  const seen = new Set<string>([job.id]);
  let cursor: string | null = job.retryOf;
  try {
    while (cursor && out.length < max && !seen.has(cursor)) {
      seen.add(cursor);
      const [row] = await db
        .select({
          id: jobs.id,
          attempts: jobs.attempts,
          retryOf: jobs.retryOf,
          agentSessionId: jobs.agentSessionId,
          failureReason: jobs.failureReason,
          failureMeta: jobs.failureMeta,
        })
        .from(jobs)
        .where(eq(jobs.id, cursor))
        .limit(1);
      if (!row) break;
      let messageCount = 0;
      if (row.agentSessionId) {
        const [s] = await db
          .select({ messages: agentSessions.messages })
          .from(agentSessions)
          .where(eq(agentSessions.id, row.agentSessionId))
          .orderBy(desc(agentSessions.createdAt))
          .limit(1);
        const msgs = s?.messages;
        messageCount = Array.isArray(msgs) ? msgs.length : 0;
      }
      out.push({
        attempt: row.attempts,
        sessionId: row.agentSessionId,
        messageCount,
        failureReason: row.failureReason,
        salvage: readSalvage(row.failureMeta),
      });
      cursor = row.retryOf;
    }
  } catch (err) {
    logger.warn(
      { err, jobId: job.id },
      'prior-attempts: chain walk failed — the retry dispatches without prior-attempt context',
    );
  }
  return out;
}

function salvageLine(s: SalvageRecord): string | null {
  switch (s.outcome) {
    case 'pushed':
      return `Its uncommitted work was salvaged to \`${s.branch}\` as \`${s.sha}\`${
        s.files ? ` (${s.files} file(s), +${s.insertions ?? 0})` : ''
      }. Start from that commit — it is WIP, not reviewed work.`;
    case 'committed_not_pushed':
      return `Its uncommitted work was committed on the runner as \`${s.sha}\` but the push FAILED, so it is not on the remote. Treat that work as lost and redo it.`;
    case 'refused':
    case 'failed':
      return `Salvaging its uncommitted work did not succeed (${s.outcome}${
        s.detail ? `: ${s.detail}` : ''
      }). Any uncommitted edits it made are gone.`;
    default:
      return null;
  }
}

/**
 * Render the `## Previous attempt failed` block.
 *
 * A POINTER, never an inlining: `prompt/user.ts` truncates `description` at
 * `DEFAULT_FIELD_CAPS.description` before an agent reads it, so pasting a transcript in here
 * would evict the requirements rather than merely bloat them. Returns `''` when there is nothing
 * to say, so the caller can splice unconditionally.
 */
export function renderPriorAttemptsBlock(attempts: PriorAttempt[], currentAttempt: number): string {
  const last = attempts[0];
  if (!last) return '';
  const older = attempts.slice(1);
  const lines = [
    '## Previous attempt failed — read it before you start',
    '',
    `This is attempt ${currentAttempt}. Attempt ${last.attempt} failed${
      last.failureReason ? `: ${last.failureReason}` : ''
    }.`,
    '',
  ];
  if (last.sessionId) {
    lines.push(
      `- Its transcript: \`forge_agent_sessions.get({ sessionId: '${last.sessionId}' })\` — returns the last-20 message tail${
        last.messageCount ? ` of ${last.messageCount} messages` : ''
      }.`,
    );
  }
  const olderWithSessions = older.filter((a) => a.sessionId);
  if (olderWithSessions.length > 0) {
    lines.push(
      `- Earlier attempts also failed and are readable the same way: ${olderWithSessions
        .map((a) => `attempt ${a.attempt} \`${a.sessionId}\` (${a.messageCount} messages)`)
        .join(', ')}.`,
    );
  }
  for (const a of attempts) {
    const sl = a.salvage ? salvageLine(a.salvage) : null;
    if (sl) lines.push(`- ${sl}`);
  }
  lines.push(
    '- Do NOT redo work those attempts already completed. Verify what landed, then continue from there.',
  );
  return lines.join('\n');
}
