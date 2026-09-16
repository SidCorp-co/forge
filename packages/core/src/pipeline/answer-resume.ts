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
import { agentSessions, issues, jobs, terminalAgentSessionStatuses } from '../db/schema.js';
import { agentQuestions, questionWaiters } from '../db/schema-questions.js';
import { sessionInbox } from '../db/schema-session-inbox.js';
import { transitionIssueStatus } from '../issues/apply-transition.js';
import type { LoopScope } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_ENTRY_STATUS, AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
import { isAutonomousProject } from './autonomous-project.js';
import type { HooksBus } from './hooks.js';

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
  if (!issue || issue.status !== AUTONOMOUS_QUESTION_STATUS) return null;
  if (!(await isAutonomousProject(issue.projectId))) return null;
  return issue;
}

/**
 * The session that asked this question, if it is alive and still waiting.
 */
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
async function deliverToPark(issueId: string, commentId: string, body: string): Promise<boolean> {
  const agentSessionId = await parkedSessionFor(issueId);
  if (!agentSessionId) return false;
  const { published } = await requestSessionSend({
    agentSessionId,
    kind: 'answer',
    intentId: commentId,
    body,
  });
  return published;
}

/**
 * Whether a box registered itself to read THIS answer back.
 */
export async function aBoxWillReadThisAnswer(questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: questionWaiters.id })
    .from(questionWaiters)
    .where(eq(questionWaiters.questionId, questionId))
    .limit(1);
  return row !== undefined;
}

/**
 * Register the answer-resume subscriber. Called once at boot from
 * `src/index.ts`, and only meaningful for projects running the autonomous
 * driver — a staged project takes the early return and pays one issue read.
 */
export function registerAnswerResume(bus: HooksBus): void {
  bus.on(
    'questionAnswered',
    async (p) => {
      if (!p.issueId) return;
      const issueId = p.issueId;
      try {
        const issue = await resumableIssue(issueId);
        if (!issue) return;
        if (await deliverToPark(issueId, p.questionId, p.body)) {
          logger.info(
            { issueId, questionId: p.questionId },
            'answer-resume: question answered, sent to the session that asked',
          );
          return;
        }
        if (await aBoxWillReadThisAnswer(p.questionId)) {
          logger.info(
            { issueId, questionId: p.questionId },
            'answer-resume: a box is registered to read this answer back, dispatching nothing',
          );
          return;
        }
        await transitionIssueStatus(issue, AUTONOMOUS_ENTRY_STATUS, {
          type: 'user',
          id: p.answeredBy,
        });
        logger.info(
          { issueId, questionId: p.questionId },
          'answer-resume: question answered, issue returned to the driver',
        );
      } catch (err) {
        logger.error({ err, issueId }, 'answer-resume: resuming on an answer failed');
        throw err;
      }
    },
    { name: 'answer-resume-question' },
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
export async function resumeLapsedAnswers(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  const rows = await db
    .select({
      inbox: sessionInbox,
      issueId: jobs.issueId,
      authorId: sql<string>`${agentQuestions.steps} -> -1 ->> 'answeredBy'`,
    })
    .from(sessionInbox)
    .innerJoin(jobs, eq(jobs.agentSessionId, sessionInbox.agentSessionId))
    .innerJoin(issues, eq(issues.id, jobs.issueId))
    .innerJoin(agentQuestions, sql`${agentQuestions.id}::text = ${sessionInbox.intentId}`)
    .where(
      and(
        eq(sessionInbox.kind, 'answer'),
        isNull(sessionInbox.appliedAt),
        eq(issues.status, AUTONOMOUS_QUESTION_STATUS),
        scope.projectId ? eq(issues.projectId, scope.projectId) : sql`true`,
      ),
    );

  let resumed = 0;
  for (const { inbox, issueId, authorId } of rows) {
    const { outcome } = await resolveSessionSend(inbox, now.getTime());
    if (outcome !== 'gone' || !issueId || !authorId) continue;
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
