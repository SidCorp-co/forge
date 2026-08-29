// What a human answer means to the autonomous driver.
//
// The staged pipeline parks an issue at `needs_info` and waits for a person to
// press a button: the question is asked by one step and answered before the
// next one is dispatched, so a human is in the loop anyway. The autonomous
// driver has no next step to dispatch, so under `mode: 'autonomous'` a human
// comment on a `needs_info` issue IS the resume.
//
// Under `print` there was one way to act on it. The session that asked the
// question had exited with the turn, so the answer could only move the issue
// back to the entry status and let the orchestrator's transition hook dispatch
// a fresh job — the answer reached the driver as a new prompt, not as a reply.
//
// Under duplex that session is alive and parked on stdin, holding its runner
// slot. Dispatching there would queue a second job BEHIND the session that
// asked the question, and the answer would still not reach it. So the send is
// tried first and the transition is the fallback.
//
// Design: docs/proposals/agent-driven-pipeline.md · RFC 0003

import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { requestSessionSend, resolveSessionSend } from '../agent-sessions/session-send.js';
import { db } from '../db/client.js';
import {
  agentSessions,
  comments,
  issues,
  jobs,
  projects,
  terminalAgentSessionStatuses,
} from '../db/schema.js';
import { sessionInbox } from '../db/schema-session-inbox.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import type { LoopScope } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_ENTRY_STATUS, isAutonomous } from './autonomous-dispatch.js';
import type { HooksBus } from './hooks.js';
import { pipelineConfigSchema } from './pipeline-config-schema.js';

/** The park the driver enters to ask a question. */
// cm:edge lockstep -> packages/core/src/jobs/turn-verdict-routes.ts — the turn verdict asks the SAME question from the other end (may this session stay resident?), and the two answers must name one status: a verdict that parked on `waiting` too would hold a runner slot for a pause a human chose, and a resume that did would take that pause away from them.
export const QUESTION_STATUS = 'needs_info';

// cm:guard `needs_info` ONLY, never the other two parks the autonomous vocabulary also renders as needs_human — `waiting` and `on_hold` are stopped by a person, and a comment on one is discussion, not permission to restart. Resuming those would take the pause away from the human who chose it.
async function resumableIssue(issueId: string) {
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      status: issues.status,
      reopenCount: issues.reopenCount,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue || issue.status !== QUESTION_STATUS) return null;
  const [project] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  const ac = (project?.agentConfig as { pipelineConfig?: unknown } | null) ?? {};
  const parsed = pipelineConfigSchema.safeParse(ac.pipelineConfig ?? {});
  if (!parsed.success || !isAutonomous(parsed.data)) return null;
  return issue;
}

/**
 * The session that asked this question, if it is alive and still waiting.
 */
// cm:guard `awaiting_input` is required, not merely a non-terminal session. A session mid-turn has not asked anything yet — the park is what makes an answer the thing it is waiting for — and writing into one would land the reply as the NEXT turn's prompt, answering a question the agent had already moved on from.
// cm:edge lockstep -> packages/core/src/jobs/events-routes.ts — the column read here is written there and nowhere else on the pipeline path. If that write is removed, every answer silently takes the fallback and duplex loses the one thing it was for.
async function parkedSessionFor(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(jobs)
    .innerJoin(agentSessions, eq(agentSessions.id, jobs.agentSessionId))
    .where(
      and(
        eq(jobs.issueId, issueId),
        eq(agentSessions.runtimeState, 'awaiting_input'),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Deliver the answer to the session that asked, if there is one.
 *
 * Returns whether the durable path is now armed — i.e. whether core has handed
 * this answer to a runner and must wait for the episode to resolve rather than
 * dispatch.
 */
// cm:guard the issue stays at `needs_info` when this returns true, and that is load-bearing rather than an omission: `jobs/turn-verdict-routes.ts` reads the SAME status to keep the session resident, so the parked session and the pending answer agree by construction. Moving the issue here would end the session the answer is on its way to.
// cm:guard `published: false` is the ONLY synchronous fallback. Anything else — a runner that is silent, an ack that never comes — resolves through `resolveSessionSend`, because acting on a message that was in fact consumed puts a second agent on the same worktree.
async function deliverToPark(
  issueId: string,
  commentId: string,
  body: string,
  actor: { id: string },
): Promise<boolean> {
  const agentSessionId = await parkedSessionFor(issueId);
  if (!agentSessionId) return false;
  const { published } = await requestSessionSend({
    agentSessionId,
    kind: 'answer',
    intentId: commentId,
    body,
    actor: { userId: actor.id, reason: 'human answered a parked question', source: 'rest' },
  });
  return published;
}

/**
 * Register the answer-resume subscriber. Called once at boot from
 * `src/index.ts`, and only meaningful for projects running the autonomous
 * driver — a staged project takes the early return and pays one issue read.
 */
export function registerAnswerResume(bus: HooksBus): void {
  bus.on(
    'commentCreated',
    async (p) => {
      // cm:guard every AI comment path emits a `device` actor (mcp/tools/forge-comments.ts, forge-issues.ts) — widening this to any actor would let the driver's own question resume the issue it just parked, in a loop nothing else stops
      if (p.actor.type !== 'user') return;
      try {
        const issue = await resumableIssue(p.issueId);
        if (!issue) return;
        if (await deliverToPark(p.issueId, p.commentId, p.body, p.actor)) {
          logger.info(
            { issueId: p.issueId, commentId: p.commentId },
            'answer-resume: human answered, sent to the session that asked',
          );
          return;
        }
        await transitionIssueStatus(issue, AUTONOMOUS_ENTRY_STATUS, {
          type: 'user',
          id: p.actor.id,
        });
        logger.info(
          { issueId: p.issueId, commentId: p.commentId },
          'answer-resume: human answered, issue returned to the driver',
        );
      } catch (err) {
        logger.error({ err, issueId: p.issueId }, 'answer-resume: transition failed');
        throw err;
      }
    },
    { name: 'answer-resume' },
  );
}

/**
 * Hop 3d — the answer that never reached anyone.
 *
 * `deliverToPark` hands an answer to a runner and returns; it cannot know
 * whether the message arrived, and RFC 0003 forbids guessing. This is where
 * that episode is decided: `gone` means no live session consumed it, so the
 * answer becomes a dispatch after all — the print behaviour, arrived at late
 * rather than assumed early.
 */
// cm:guard scoped to issues STILL parked at the question, which is also the whole of its idempotency: the fallback transition moves the issue off `needs_info`, so a row that has been handled stops matching and is never reconsidered. No marker column, and no second dispatch for one answer.
// cm:guard acts on `gone` ONLY. `unknown` is a lapsed episode with the runner online and silent, and dispatching on it would put a second agent on a worktree whose session may have consumed the answer already — the race RFC 0003's three outcomes exist to keep apart. An `unknown` resolves when the session goes terminal, which the residency deadline guarantees it eventually does.
export async function resumeLapsedAnswers(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  // cm:guard the ORIGINAL commenter carries the fallback transition, recovered by joining on `intentId` — which is the comment id, the same idempotency key the send was opened under. A transition attributed to anyone else would put a status move in someone's activity feed that they did not make.
  // cm:guard the cast is REQUIRED and its absence is a runtime error, not a type error: `intent_id` is `text` because an intent is not always a comment, and Postgres has no `uuid = text` operator. An INNER join that throws would take the whole hop down, not just this row.
  const rows = await db
    .select({ inbox: sessionInbox, issueId: jobs.issueId, authorId: comments.authorId })
    .from(sessionInbox)
    .innerJoin(jobs, eq(jobs.agentSessionId, sessionInbox.agentSessionId))
    .innerJoin(issues, eq(issues.id, jobs.issueId))
    .innerJoin(comments, sql`${comments.id}::text = ${sessionInbox.intentId}`)
    .where(
      and(
        eq(sessionInbox.kind, 'answer'),
        // cm:guard an APPLIED message was read by the model, and it is excluded HERE rather than in the loop below: a second check there would be a line no assertion could turn red, since a row this predicate drops never reaches it. Re-dispatching one would answer the same question twice — once in the session that consumed it, once in a fresh job that has no idea it happened.
        isNull(sessionInbox.appliedAt),
        eq(issues.status, QUESTION_STATUS),
        scope.projectId ? eq(issues.projectId, scope.projectId) : sql`true`,
      ),
    );

  let resumed = 0;
  for (const { inbox, issueId, authorId } of rows) {
    const { outcome } = await resolveSessionSend(inbox, now.getTime());
    if (outcome !== 'gone' || !issueId) continue;
    const issue = await resumableIssue(issueId);
    if (!issue) continue;
    await transitionIssueStatus(issue, AUTONOMOUS_ENTRY_STATUS, { type: 'user', id: authorId });
    resumed += 1;
    logger.info(
      { issueId, agentSessionId: inbox.agentSessionId, seq: inbox.seq },
      'answer-resume: the session that asked is gone, returning the issue to the driver',
    );
  }
  return resumed;
}
