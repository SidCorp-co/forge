import { RUN_ISSUES_METADATA_KEY, RUN_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { TERMINAL_AGENT_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import { applyStatusTransition } from '../issues/index.js';
import { traceStep } from '../lib/error-tracking.js';
import { logger } from '../lib/logger.js';
import { AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
import { postCapReachedComment } from './autonomous-rescue-comment.js';
import { projectCreatorOf } from './ports.js';
import { emitPipelineWedge, rescueCapWedgeEntityId } from './wedge.js';

/**
 * Run sessions an issue may spend without moving on before it is handed to a person. Matches
 * `STAGE_STALL_CAP` deliberately — same question, same tolerance — but counts a different thing.
 */
const AUTONOMOUS_RESCUE_CAP = 3;

/**
 * Where an issue last moved on: a person decided (a park), it was delivered (awaiting release,
 * closed) or sent back (reopen). Run sessions before that are not charged to it.
 */
const MOVED_ON_STATUSES = [
  'needs_info',
  'on_hold',
  'awaiting_release',
  'closed',
  'reopen',
] as const;

const terminalSessionList = sql.join(
  TERMINAL_AGENT_SESSION_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);
const movedOnList = sql.join(
  MOVED_ON_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** Run sessions over this issue that ended since it last moved on (issue-lifecycle `needs_info`). */
async function countSpentRunSessions(projectId: string, issueId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS n
      FROM issues i
      JOIN pipeline_runs r ON r.project_id = i.project_id
       AND r.metadata -> ${RUN_ISSUES_METADATA_KEY} ? ('ISS-' || i.iss_seq)
      JOIN agent_sessions s ON s.pipeline_run_id = r.id
     WHERE i.id = ${issueId}
       AND i.project_id = ${projectId}
       AND s.kind = ${RUN_SESSION_KIND}
       AND s.status IN (${terminalSessionList})
       AND s.created_at > COALESCE((
             SELECT max(k.created_at) FROM kernel_transitions k
              WHERE k.entity = 'issue' AND k.entity_id = i.id
                AND k.to_status IN (${movedOnList})
           ), '-infinity'::timestamptz)
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Has this issue spent its run sessions? Parks it at `AUTONOMOUS_QUESTION_STATUS` and comments
 * when it has, so the caller only has to skip. A failed check or a refused park throws, so the
 * caller skips the row rather than rescuing past the cap; a refused park is also raised as a wedge.
 */
export async function checkAutonomousRescueCap(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  reopenCount: number;
}): Promise<{ capped: boolean }> {
  const spent = await countSpentRunSessions(args.projectId, args.issueId);
  if (spent < AUTONOMOUS_RESCUE_CAP) return { capped: false };

  try {
    await parkForHuman({ ...args, spent });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await emitPipelineWedge({
      projectId: args.projectId,
      issueId: args.issueId,
      hop: 'result',
      entity: 'issue',
      entityId: rescueCapWedgeEntityId(args.issueId),
      reason: `rescue_cap_park_refused:${why}`,
      title: 'An issue spent its run sessions and could not be handed to a person',
      summary: `${spent} run sessions ended on this issue without it moving on, and moving it to \`${AUTONOMOUS_QUESTION_STATUS}\` was refused: ${why}. It is no longer rescued; it waits here.`,
      nextStep: 'Read the refusal, settle what it names, then move the issue on by hand.',
      action: 'Settle the refused move; the issue is not being rescued.',
    });
    throw err;
  }
  return { capped: true };
}

async function parkForHuman(args: {
  projectId: string;
  issueId: string;
  status: IssueStatus;
  reopenCount: number;
  spent: number;
}): Promise<void> {
  const actorId = await projectCreatorOf(args.projectId);
  if (!actorId) throw new Error(`the project of issue ${args.issueId} has no owner to act as`);

  await applyStatusTransition(
    {
      id: args.issueId,
      projectId: args.projectId,
      status: args.status,
      reopenCount: args.reopenCount,
    },
    AUTONOMOUS_QUESTION_STATUS,
    { id: actorId, ownerId: actorId },
    {
      reason: 'autonomous_rescue_cap_reached',
      transitionReason: `${args.spent} run sessions ended on this issue without it moving on, so it has stopped rather than open another.`,
      needs:
        'Whether to send it back to the driver as it stands, or what to change first — answering returns the issue to the status it left.',
      waitingKind: 'needs_decision',
    },
  );

  await postCapReachedComment({
    issueId: args.issueId,
    authorId: actorId,
    fromStatus: args.status,
    cap: AUTONOMOUS_RESCUE_CAP,
    runSessions: args.spent,
  });

  logger.warn(
    { issueId: args.issueId, spent: args.spent, from: args.status, cap: AUTONOMOUS_RESCUE_CAP },
    'autonomous-rescue-cap: run sessions spent — parked the issue for a human',
  );
  traceStep({
    category: 'pipeline.autonomous.rescue_cap_reached',
    level: 'warning',
    data: { issueId: args.issueId, spent: args.spent, from: args.status },
  });
}
