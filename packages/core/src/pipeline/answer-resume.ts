import { TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { AnswerOutcome } from '@forge/contracts/questions';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
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
import { accountActor, readWorkState, transitionIssueStatus } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { isRefusal, type Refusal } from '../lib/refusal.js';
import { SEND_UNDELIVERED_DEADLINE_MS } from '../lib/session-send-deadline.js';
import { consume } from '../outbox/index.js';
import { AUTONOMOUS_QUESTION_STATUS } from './autonomous-mode.js';
import { isAutonomousProject } from './autonomous-project.js';
import {
  answeredHoldOf,
  type LoopScope,
  postIssueNoticeOnce,
  recordAnswerResume,
  requestSessionSend,
  resolveSessionSend,
} from './ports.js';

/** The issue this answer stopped, while it is still parked for it; null once anything moved it. */
async function parkedIssue(issueId: string) {
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
  return issue;
}

type ParkedIssue = NonNullable<Awaited<ReturnType<typeof parkedIssue>>>;

/**
 * Where an answered park goes: back to the status it left (`issue_work_state.left_status`), never
 * guessed (workflow `issue-lifecycle`). A park that recorded none waits for a person to move it.
 */
async function answeredTarget(issueId: string): Promise<IssueStatus | null> {
  const work = await readWorkState(db, issueId);
  return (work?.leftStatus ?? null) as IssueStatus | null;
}

/**
 * Return the park to the status it left, unless a question on the issue is still open once the
 * transition has the row locked. Any refusal is the outcome, named, never a dead delivery: under
 * `key_strict_fifo` a dead one would hold every later answer on this issue (ISS-258).
 */
async function resumeUnasked(
  issue: ParkedIssue,
  target: IssueStatus | null,
  answeredBy: string,
): Promise<AnswerOutcome> {
  if (target === null) return { kind: 'no_left_status' };
  try {
    await transitionIssueStatus(issue, target, await accountActor(answeredBy), {
      requireNoOpenQuestions: true,
    });
    return { kind: 'resumed', to: target };
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const lead = err.refusals[0] as (Refusal & { openQuestionIds?: unknown }) | undefined;
    if (err.refusals.some((r) => r.code === 'OPEN_QUESTIONS')) {
      const ids = Array.isArray(lead?.openQuestionIds) ? lead.openQuestionIds.map(String) : [];
      return { kind: 'other_question', questionIds: ids };
    }
    return {
      kind: 'refused',
      code: lead?.code ?? err.fallbackCode,
      detail: lead?.detail ?? err.message,
    };
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
 * Deliver the answer to the session that asked, if there is one: the session it went to when core
 * has handed it to a runner and must wait for the episode to resolve rather than dispatch.
 */
async function deliverToPark(
  issueId: string,
  commentId: string,
  body: string,
): Promise<string | null> {
  const agentSessionId = await parkedSessionFor(issueId);
  if (!agentSessionId) return null;
  const { published } = await requestSessionSend({
    agentSessionId,
    kind: 'answer',
    intentId: commentId,
    body,
  });
  return published ? agentSessionId : null;
}

/**
 * Whether a box registered itself to read THIS answer back.
 */
async function aBoxWillReadThisAnswer(questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: questionWaiters.id })
    .from(questionWaiters)
    .where(eq(questionWaiters.questionId, questionId))
    .limit(1);
  return row !== undefined;
}

/**
 * What one answer does to the park it stopped. An answer that says the issue still waits holds it
 * where it is, unless it named a blocker whose `blocks` edge withholds the status the park returns
 * to (ISS-257); otherwise the answer goes to whoever asked, or the park returns where it left.
 */
async function answerThePark(
  issue: ParkedIssue,
  p: { questionId: string; body: string; answeredBy: string },
): Promise<AnswerOutcome> {
  if (!(await isAutonomousProject(issue.projectId))) return { kind: 'staged' };
  const target = await answeredTarget(issue.id);
  const hold = await answeredHoldOf(p.questionId);
  if (hold) {
    const edgeHolds =
      hold.blockedBy !== undefined && target !== null && TAKEABLE_STATUSES.includes(target);
    return edgeHolds ? resumeUnasked(issue, target, p.answeredBy) : { kind: 'held' };
  }
  const sessionId = await deliverToPark(issue.id, p.questionId, p.body);
  if (sessionId) return { kind: 'sent_to_run', sessionId };
  if (await aBoxWillReadThisAnswer(p.questionId)) return { kind: 'box_reads' };
  return resumeUnasked(issue, target, p.answeredBy);
}

/**
 * Register the answer-resume subscriber. Called once at boot from `src/index.ts`. A staged
 * project's answer moves nothing, and that too is recorded on the answer.
 */
export function registerAnswerResume(): void {
  consume('question.answered', {
    name: 'answer-resume',
    handle: async (p) => {
      if (!p.issueId) return;
      const issueId = p.issueId;
      try {
        const issue = await parkedIssue(issueId);
        if (!issue) return;
        const outcome = await answerThePark(issue, p);
        await recordAnswerResume(p.questionId, { ...outcome, at: new Date().toISOString() });
        logger.info(
          { issueId, questionId: p.questionId, outcome: outcome.kind },
          'answer-resume: recorded what the answer did to its park',
        );
      } catch (err) {
        logger.error({ err, issueId }, 'answer-resume: resuming on an answer failed');
        throw err;
      }
    },
  });
}

/**
 * An answer a live session never confirmed past the declared deadline is not waited on any
 * longer: the issue says so, by name, once, and the park moves on like a gone session's.
 */
async function sayAnswerUndelivered(
  inbox: typeof sessionInbox.$inferSelect,
  issueId: string,
  authorId: string,
): Promise<void> {
  const minutes = Math.round(SEND_UNDELIVERED_DEADLINE_MS / 60_000);
  logger.warn(
    { issueId, agentSessionId: inbox.agentSessionId, seq: inbox.seq },
    'answer-resume: the answer was never confirmed by the session that asked, past the deadline',
  );
  const marker = `answer-undelivered:${inbox.agentSessionId}:${inbox.seq}`;
  const body =
    `Your answer was not confirmed by the session that asked within ${minutes} minutes ` +
    '(the pane refused it or the box said nothing), so the issue moves on without that session: ' +
    'the answer is acted on by a new run instead. (' +
    marker +
    ')';
  await postIssueNoticeOnce({
    issueId,
    authorId,
    body,
    marker,
  });
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
    if ((outcome !== 'gone' && outcome !== 'undelivered') || !issueId || !authorId) continue;
    if (outcome === 'undelivered') await sayAnswerUndelivered(inbox, issueId, authorId);
    const issue = await parkedIssue(issueId);
    if (!issue || !(await isAutonomousProject(issue.projectId))) continue;
    const resume = await resumeUnasked(issue, await answeredTarget(issue.id), authorId);
    await recordAnswerResume(inbox.intentId, { ...resume, at: now.toISOString() });
    if (resume.kind !== 'resumed') continue;
    resumed += 1;
    logger.info(
      { issueId, agentSessionId: inbox.agentSessionId, seq: inbox.seq },
      'answer-resume: the session that asked is gone, so the park moved on',
    );
  }
  return resumed;
}
