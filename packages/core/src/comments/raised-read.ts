/**
 * The questions people raised on a project, as `question` comments on its issues, requirements,
 * workflows and feedback, each read as owed, answered or closed. A question is answered once
 * somebody other than its asker replies under it: a reply threaded on it, or, for a question that is
 * itself a reply, a later reply beside it in the same thread. Unanswered, it is owed while what it
 * sits on is live, and closed on an issue that has ended (closed, dropped or archived): nobody takes
 * it there, the rule `devices/comment-inbox.ts:readOwedComments` reads the master's owed questions by.
 * A row carries the question's short form, never its body (`@forge/contracts/title-text:shortForm`).
 */

import {
  type CommentAuthorView,
  RAISED_QUESTION_SUMMARY_MAX,
  type RaisedQuestionAsker,
  type RaisedQuestionOwer,
  type RaisedQuestionsResponse,
  type RaisedQuestionView,
} from '@forge/contracts/comments';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { shortForm } from '@forge/contracts/title-text';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { comments, issues, users } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { activeIssuePrefix } from '../issues/index.js';
import { peopleOf } from '../lib/people.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  type EntityCommentActor,
  egressOfScopes,
  entityCommentColumns,
  entityCommentView,
  MADE_BY_A_PERSON,
  type ReadDoor,
  targetOfRow,
} from './entity-read.js';
import { scopeOfArc } from './entity-rules.js';

/** The most raised questions one read lists; `owed`, `answered` and `closed` still count them all. */
export const RAISED_QUESTIONS_LIMIT = 200;

/** Whether the issue a question sits on has ended: closed, dropped, or archived. */
export function issueEnded(issue: { status: string | null; archivedAt: Date | null }): boolean {
  return (
    issue.archivedAt !== null ||
    (ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status ?? '')
  );
}

/** Who owes an owed question its reply, by what it sits on. */
export const owerOf = (scope: string): RaisedQuestionOwer =>
  scope === 'issue' ? 'agent' : 'members';

const summaryOf = (text: string) => shortForm(text, RAISED_QUESTION_SUMMARY_MAX);

interface AnswerRow {
  question_id: string;
  id: string;
  body: string;
  author_id: string;
  by_device: boolean;
  created_at: string | Date;
}

/** Each question's first reply by somebody other than its asker, by question id. */
async function answersOf(ids: readonly string[]): Promise<Map<string, AnswerRow>> {
  if (ids.length === 0) return new Map();
  const rows = rowsOf<AnswerRow>(
    await db.execute(sql`
      SELECT DISTINCT ON (q.id) q.id AS question_id, a.id, a.body, a.author_id,
             (a.author_device_id IS NOT NULL) AS by_device, a.created_at
        FROM comments q
        JOIN comments a
          ON a.author_id <> q.author_id
         AND (a.parent_id = q.id
              OR (q.parent_id IS NOT NULL AND a.parent_id = q.parent_id
                  AND a.created_at > q.created_at))
       WHERE q.id IN (${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `,
       )})
       ORDER BY q.id, a.created_at, a.id`),
  );
  return new Map(rows.map((r) => [r.question_id, r]));
}

export async function listRaisedQuestionsAs(
  actor: EntityCommentActor,
  projectId: string,
  query: { by?: RaisedQuestionAsker | undefined } = {},
  door: ReadDoor = {},
): Promise<RaisedQuestionsResponse> {
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const by = query.by ?? 'me';
  const inProject = or(
    eq(issues.projectId, projectId),
    eq(requirements.projectId, projectId),
    eq(projectWorkflows.projectId, projectId),
    eq(feedback.projectId, projectId),
  );
  const rows = await db
    .select({
      ...entityCommentColumns,
      issueSeq: issues.issSeq,
      issueTitle: issues.title,
      issueStatus: issues.status,
      issueArchivedAt: issues.archivedAt,
      reqSeq: requirements.reqSeq,
      reqTitle: requirements.title,
      flow: projectWorkflows.flow,
      flowDocument: projectWorkflows.document,
      fbSeq: feedback.fbSeq,
      fbTitle: feedback.title,
    })
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .leftJoin(issues, eq(comments.issueId, issues.id))
    .leftJoin(requirements, eq(comments.requirementId, requirements.id))
    .leftJoin(projectWorkflows, eq(comments.workflowId, projectWorkflows.id))
    .leftJoin(feedback, eq(comments.feedbackId, feedback.id))
    .where(
      and(
        eq(comments.intent, 'question'),
        inProject,
        MADE_BY_A_PERSON,
        by === 'me' ? eq(comments.authorId, actor.userId) : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id));
  const answers = await answersOf(rows.map((r) => r.id));
  const [authors, prefix, egress] = await Promise.all([
    peopleOf([...rows.map((r) => r.authorId), ...[...answers.values()].map((a) => a.author_id)]),
    activeIssuePrefix(projectId),
    egressOfScopes(projectId, actor, door),
  ]);
  const authorOf = (id: string, byDevice: boolean): CommentAuthorView => {
    const person = authors.get(id);
    return {
      id,
      name: person?.name ?? null,
      agency: byDevice ? 'agent' : (person?.kind ?? 'human'),
    };
  };
  const all = rows.map((r): RaisedQuestionView => {
    const scope = scopeOfArc(r);
    if (!scope)
      throw new Error(`comment ${r.id} breaks comments_scope_chk: it names no single target`);
    const view = entityCommentView(r, targetOfRow(scope, r, prefix), authors, egress[scope]);
    const a = answers.get(r.id);
    const ended =
      scope === 'issue' && issueEnded({ status: r.issueStatus, archivedAt: r.issueArchivedAt });
    const state = a ? 'answered' : ended ? 'closed' : 'owed';
    return {
      id: r.id,
      target: view.target,
      summary: view.body === null ? null : summaryOf(view.body),
      author: view.author,
      askedAt: view.createdAt,
      state,
      answer: a
        ? {
            id: a.id,
            summary: view.withheld ? null : summaryOf(a.body),
            author: authorOf(a.author_id, a.by_device),
            at: new Date(a.created_at).toISOString(),
          }
        : null,
      owedBy: state === 'owed' ? owerOf(scope) : null,
      withheld: view.withheld,
    };
  });
  // owed first, oldest first (the longest waiting leads), then answered, then closed, newest first
  const owed = all.filter((q) => q.state === 'owed').reverse();
  const answered = all.filter((q) => q.state === 'answered');
  const closed = all.filter((q) => q.state === 'closed');
  return {
    questions: [...owed, ...answered, ...closed].slice(0, RAISED_QUESTIONS_LIMIT),
    owed: owed.length,
    answered: answered.length,
    closed: closed.length,
    by,
  };
}
