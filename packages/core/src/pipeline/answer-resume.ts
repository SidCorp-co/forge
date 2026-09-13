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

// cm:guard `needs_info` ONLY, never the other two parks a PERSON entered — `waiting` (which the vocabulary also renders as needs_human) and `on_hold` (which renders as `paused` since ISS-970) are stopped by a person, and a comment on one is discussion, not permission to restart. Since ISS-886 that is true by construction rather than by convention: an agent can no longer reach `waiting` on this mode (issues/autonomous-park.ts rewrites it here), so the only one left on this mode is a human's own pause.
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
// cm:guard NO `actor`, which means no intervention row, and that is the opposite of what a human-initiated send does. Every `job_events kind='intervention'` lands in the `issue_intervention_events` view, i.e. VISION §1 metric ② — and answering a question the AGENT asked is the pipeline working, not someone stepping in. Auditing it would make the north-star metric climb on the exact path meant to lower it, and asymmetrically: the identical answer records nothing when no session happens to be parked, so the number would measure duplex adoption rather than interventions. Provenance is not lost — `intentId` IS the comment id.
// cm:guard `published: false` is the ONLY synchronous fallback. Anything else — a runner that is silent, an ack that never comes — resolves through `resolveSessionSend`, because acting on a message that was in fact consumed puts a second agent on the same worktree.
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
// cm:guard keyed on the QUESTION, never on "does this issue carry an open question": by the time this runs the question is `answered` by construction, so an open-question predicate answers false for every box-minted one and core dispatches a second agent onto the worktree the first still holds (ISS-996).
// cm:guard this is the code behind the `answer-resume-park` protection core advertises at `GET /me/protections`, and `questions/park-protections.test.ts` reads this file for it. A box releases its process on that advertisement; renaming this without moving the proof leaves the promise pointing at nothing (ISS-964 criterion 27).
// cm:guard the question id and the issue id on this event come from ONE row, so they agree by construction — which is why no project join is needed here and its absence is not the ISS-989 hazard it would be on a predicate keyed off the issue alone.
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
  // cm:guard the ONLY way an answer to a park's own question reaches the work. A question the RUNNER minted registers a waiter and the box reads the answer back itself; a park mints its question inside the transition with no box on the other end, so without this the issue sits at the question status with an answered question on it (ISS-996).
  // cm:guard the same three hops, in the same order, as the comment subscriber above: send to a live session, stand down for a box that will come back, dispatch otherwise. A fourth shape here would be a second answer to what "resumed" means.
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
// cm:guard scoped to issues STILL parked at the question, which is also the whole of its idempotency: the fallback transition moves the issue off `needs_info`, so a row that has been handled stops matching and is never reconsidered. No marker column, and no second dispatch for one answer.
// cm:guard acts on `gone` ONLY. `unknown` is a lapsed episode with the runner online and silent, and dispatching on it would put a second agent on a worktree whose session may have consumed the answer already — the race RFC 0003's three outcomes exist to keep apart. An `unknown` resolves when the session goes terminal, which the residency deadline guarantees it eventually does.
export async function resumeLapsedAnswers(
  now: Date = new Date(),
  scope: LoopScope = {},
): Promise<number> {
  // cm:guard the person who ANSWERED carries the fallback transition, recovered by joining `agent_questions` on `intentId` — which is the question id, the same idempotency key the send was opened under. This joined `comments` on the comment id until ISS-996 cut the comment lane, and leaving it there would have dropped every row on the one lane that remains: an answer's `intentId` is a question id, and no comment has it.
  // cm:guard `answeredBy` is read off the LAST step rather than a column, because an answer lives in `steps`. A question with no answered step yields NULL and the row falls out of the INNER join, which is correct — an unanswered question opened no send.
  // cm:guard the cast is REQUIRED and its absence is a runtime error, not a type error: `intent_id` is `text` because an intent is not always a uuid, and Postgres has no `uuid = text` operator. An INNER join that throws would take the whole hop down, not just this row.
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
        // cm:guard an APPLIED message was read by the model, and it is excluded HERE rather than in the loop below: a second check there would be a line no assertion could turn red, since a row this predicate drops never reaches it. Re-dispatching one would answer the same question twice — once in the session that consumed it, once in a fresh job that has no idea it happened.
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
