import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { requestSessionSend, resolveSessionSend } from '../agent-sessions/session-send.js';
import { db } from '../db/client.js';
import {
  agentSessions,
  type IssueStatus,
  issues,
  jobs,
  terminalAgentSessionStatuses,
} from '../db/schema.js';
import { agentQuestions, questionWaiters } from '../db/schema-questions.js';
import { sessionInbox } from '../db/schema-session-inbox.js';
import { accountActor } from '../issues/account-actor.js';
import { TransitionError, transitionIssueStatus } from '../issues/apply-transition.js';
import { readWorkState } from '../issues/work-state.js';
import type { LoopScope } from '../jobs/loop-monitor.js';
import { logger } from '../logger.js';
import { AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
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
 * Where an answered park goes: back to the status it left (`issue_work_state.left_status`), never
 * guessed (workflow `issue-lifecycle`). A park that recorded none waits for a person to move it.
 */
async function answeredTarget(issueId: string): Promise<IssueStatus | null> {
  const work = await readWorkState(db, issueId);
  return (work?.leftStatus ?? null) as IssueStatus | null;
}

/** Resume, unless a question on the issue is still open once the transition has the row locked. */
async function resumeUnasked(
  issue: NonNullable<Awaited<ReturnType<typeof resumableIssue>>>,
  answeredBy: string,
): Promise<boolean> {
  const target = await answeredTarget(issue.id);
  if (target === null) {
    logger.info(
      { issueId: issue.id },
      'answer-resume: this park recorded no status it left, so a person moves it on',
    );
    return false;
  }
  try {
    await transitionIssueStatus(issue, target, await accountActor(answeredBy), {
      requireNoOpenQuestions: true,
    });
    return true;
  } catch (err) {
    if (!(err instanceof TransitionError) || err.code !== 'OPEN_QUESTIONS') throw err;
    logger.info(
      { issueId: issue.id },
      'answer-resume: another question on this issue is still open, so it waits on that one',
    );
    return false;
  }
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
        if (!(await resumeUnasked(issue, p.answeredBy))) return;
        logger.info(
          { issueId, questionId: p.questionId },
          'answer-resume: the last open question was answered, and the park went back to the status it left',
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
    if (!(await resumeUnasked(issue, authorId))) continue;
    resumed += 1;
    logger.info(
      { issueId, agentSessionId: inbox.agentSessionId, seq: inbox.seq },
      'answer-resume: the session that asked is gone, so the park moved on',
    );
  }
  return resumed;
}
