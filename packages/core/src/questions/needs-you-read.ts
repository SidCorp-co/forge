// The open questions a person owes, read once for Needs you. A question on an issue is that issue's
// standing (`holdsOpenHumanQuestion`), and one on a requirement is the requirement's
// (`requirements/steward-asked.ts`). One that stands on no issue, requirement, feedback item or
// questionnaire is shown by no list of work, so Needs you reads it from here and Approvals answers
// it (REQ-68 BC-9).

import type { QuestionSuggestion } from '@forge/contracts/question-suggestion';
import type { QuestionSubject } from '@forge/contracts/questions';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedRead, primeReads } from '../db/read-memo.js';
import { agentQuestions, type QuestionStep } from '../db/schema-questions.js';
import { requirementOf } from './decision-age.js';
import { itemLastMovedAt, movedSinceAsked } from './moved-decisions.js';
import { subjectsOf } from './subject.js';

export interface DetachedQuestionRow {
  id: string;
  /** The current round's prompt, as the run wrote it. */
  prompt: string;
  /** When the current round was asked, else when the question was written. */
  at: string;
}

/** Every open `human` question of these projects attached to nothing, newest first. */
function detachedRowsOf(projectIds: readonly string[]) {
  return db
    .select({
      id: agentQuestions.id,
      projectId: agentQuestions.projectId,
      createdAt: agentQuestions.createdAt,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
      movedAt: itemLastMovedAt,
      escalatedAt: agentQuestions.escalatedAt,
      requirementKey: sql<
        string | null
      >`(select 'REQ-' || r.req_seq from requirements r where r.id = ${requirementOf})`,
      requirementStatus: sql<
        string | null
      >`(select r.status from requirements r where r.id = ${requirementOf})`,
    })
    .from(agentQuestions)
    .where(
      and(
        inArray(agentQuestions.projectId, [...projectIds]),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.issueId),
        isNull(agentQuestions.requirementId),
        isNull(agentQuestions.feedbackId),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
}

const detachedKey = (projectId: string) => `detachedOpenQuestions:${projectId}`;

/** Every open `human` question of the project attached to nothing, newest first. */
export async function readDetachedOpenQuestions(projectId: string): Promise<DetachedQuestionRow[]> {
  const rows = await memoizedRead(detachedKey(projectId), () => detachedRowsOf([projectId]));
  return rows.map((r) => ({
    id: r.id,
    prompt: r.current?.prompt ?? '',
    at: r.current?.askedAt ?? r.createdAt.toISOString(),
  }));
}

/** An open question a person owes, with the round it is on: what the needs-me read builds a decision from. */
export interface OpenPersonQuestion {
  id: string;
  issueId: string | null;
  /** The issue it is asked on, by key: a steward decision's buttons name the issue they move. */
  issueKey: string | null;
  requirementId: string | null;
  feedbackId: string | null;
  /** The feedback item a steward decision is about (`about`), by key: it stands on no item itself. */
  aboutFeedback: string | null;
  /** What it is about, as the person answering reads it (ISS-583); null where it names nothing. */
  subject: QuestionSubject | null;
  /**
   * The product item the issue it is asked on serves: the requirement it delivers, else the oldest
   * feedback item it carries; null off an issue or on one serving neither. A person reads a question
   * on an issue on that item (REQ-68 BC-4).
   */
  issueItem: { kind: 'requirement' | 'feedback'; key: string } | null;
  /** The round being asked, as written; null only on a row with no steps, which the read refuses. */
  current: QuestionStep;
  /** The assistant's record for a round, or null; the round it was drafted for decides whether it stands. */
  suggestion: QuestionSuggestion | null;
  /** When the current round was asked, else when the question was written. */
  at: string;
  /**
   * Set once the round waited 14 days and the agent proposed what to do (REQ-68 BC-8): with the
   * requirement it holds up, whose status decides whether a defer or a drop applies, or with none,
   * where the round's own drop is the proposal; null before that.
   */
  escalated: { requirement: { key: string; status: string } | null } | null;
}

/** Every open `human` question of these projects outside a questionnaire, oldest first. */
function openPersonRowsOf(projectIds: readonly string[]) {
  return db
    .select({
      id: agentQuestions.id,
      projectId: agentQuestions.projectId,
      issueId: agentQuestions.issueId,
      // the display key `issues/display-ids.ts:issueDisplayIds` writes: the project's prefix, else ISS
      issueKey: sql<string | null>`(SELECT coalesce(p.issue_prefix, 'ISS') || '-' || i.iss_seq
        FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = ${agentQuestions.issueId})`,
      requirementId: agentQuestions.requirementId,
      feedbackId: agentQuestions.feedbackId,
      aboutFeedback: sql<string | null>`(SELECT 'FB-' || f.fb_seq FROM feedback f
        WHERE ${agentQuestions.about} ->> 'kind' = 'feedback'
          AND f.id = (${agentQuestions.about} ->> 'feedbackId')::uuid)`,
      about: agentQuestions.about,
      issueRequirement: sql<string | null>`(SELECT 'REQ-' || r.req_seq FROM issues i
        JOIN requirements r ON r.id = i.requirement_id WHERE i.id = "agent_questions"."issue_id")`,
      issueFeedback: sql<string | null>`(SELECT 'FB-' || f.fb_seq FROM feedback_route_issues ri
        JOIN feedback f ON f.id = ri.feedback_id WHERE ri.issue_id = "agent_questions"."issue_id"
        ORDER BY f.fb_seq LIMIT 1)`,
      createdAt: agentQuestions.createdAt,
      suggestion: agentQuestions.suggestion,
      current: sql<QuestionStep | null>`${agentQuestions.steps} -> -1`,
      movedAt: itemLastMovedAt,
      escalatedAt: agentQuestions.escalatedAt,
      requirementKey: sql<
        string | null
      >`(select 'REQ-' || r.req_seq from requirements r where r.id = ${requirementOf})`,
      requirementStatus: sql<
        string | null
      >`(select r.status from requirements r where r.id = ${requirementOf})`,
    })
    .from(agentQuestions)
    .where(
      and(
        inArray(agentQuestions.projectId, [...projectIds]),
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.batchId),
      ),
    )
    .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id));
}

const openPersonKey = (projectId: string) => `openPersonQuestions:${projectId}`;

/**
 * Both open-question reads of every project in `projectIds`, one statement each, answering each
 * project's own read later in the request (`db/read-memo.ts:primeReads`).
 */
export function primeOpenQuestionReads(projectIds: readonly string[]): void {
  primeReads(projectIds, detachedKey, detachedRowsOf, (r) => r.projectId);
  primeReads(projectIds, openPersonKey, openPersonRowsOf, (r) => r.projectId);
}

/**
 * Every open `human` question of the project outside a questionnaire, oldest first: the answer a
 * person owes on an issue, a requirement, a feedback item or nothing, read once so each needs-me
 * decision answers the round it shows. A row with no round is a broken row and refused by id.
 */
export async function readOpenPersonQuestions(projectId: string): Promise<OpenPersonQuestion[]> {
  const read = await memoizedRead(openPersonKey(projectId), () => openPersonRowsOf([projectId]));
  // a steward decision whose item moved since it was asked is gone already, before the sweep voids it
  const rows = read.filter(
    (r) =>
      !r.current || !movedSinceAsked({ ...r, at: r.current.askedAt ?? r.createdAt.toISOString() }),
  );
  const subjects = await subjectsOf(rows.map((r) => r.about));
  return rows.map((r, i) => {
    if (!r.current) throw new Error(`questions: open question ${r.id} holds no round to answer`);
    const at = r.current.askedAt ?? r.createdAt.toISOString();
    return {
      id: r.id,
      issueId: r.issueId,
      issueKey: r.issueKey,
      requirementId: r.requirementId,
      feedbackId: r.feedbackId,
      aboutFeedback: r.aboutFeedback,
      subject: subjects[i] ?? null,
      issueItem: r.issueRequirement
        ? { kind: 'requirement', key: r.issueRequirement }
        : r.issueFeedback
          ? { kind: 'feedback', key: r.issueFeedback }
          : null,
      current: r.current,
      suggestion: r.suggestion,
      at,
      escalated:
        r.escalatedAt && r.escalatedAt >= new Date(at)
          ? {
              requirement:
                r.requirementKey && r.requirementStatus
                  ? { key: r.requirementKey, status: r.requirementStatus }
                  : null,
            }
          : null,
    };
  });
}
