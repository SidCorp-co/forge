// The questions a requirement's page reads: those asked of it (a BA clarification, or an open
// question of a revision's spec, on `requirement_id`), those its asker named as about it (`about`),
// and the answered ones on the issues that deliver it, which its Decisions tab rolls up.

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { agentQuestions, type QuestionStatus, type QuestionStep } from '../db/schema-questions.js';
import { issueDisplayIds } from '../issues/index.js';
import { answeredBody } from './write.js';

export interface RequirementQuestionRow {
  id: string;
  status: QuestionStatus;
  prompt: string;
  /** Null when it was asked of the requirement itself or by a run on no issue. */
  issue: { id: string; key: string; title: string } | null;
  onRequirement: boolean;
  round: number;
  askedAt: string;
  answer: { text: string; at: string; by: string | null } | null;
}

const columns = {
  id: agentQuestions.id,
  status: agentQuestions.status,
  requirementId: agentQuestions.requirementId,
  issueId: agentQuestions.issueId,
  createdAt: agentQuestions.createdAt,
  steps: agentQuestions.steps,
};

type Row = {
  id: string;
  status: QuestionStatus;
  requirementId: string | null;
  issueId: string | null;
  createdAt: Date;
  steps: QuestionStep[];
};

async function shaped(rows: Row[], executor: Tx): Promise<RequirementQuestionRow[]> {
  const issueIds = [...new Set(rows.map((r) => r.issueId).filter((i): i is string => !!i))];
  const [keys, titles] = await Promise.all([
    issueDisplayIds(issueIds, executor),
    issueIds.length
      ? executor
          .select({ id: issues.id, title: issues.title })
          .from(issues)
          .where(inArray(issues.id, issueIds))
      : Promise.resolve([]),
  ]);
  const titleOf = new Map(titles.map((t) => [t.id, t.title]));
  return rows.map((r) => {
    const current = r.steps.at(-1);
    const answered = r.steps.filter((s) => s.answeredAt).at(-1);
    return {
      id: r.id,
      status: r.status,
      prompt: current?.prompt ?? '',
      issue: r.issueId
        ? {
            id: r.issueId,
            key: keys.get(r.issueId) ?? r.issueId,
            title: titleOf.get(r.issueId) ?? '',
          }
        : null,
      onRequirement: r.requirementId !== null,
      round: current?.round ?? 1,
      askedAt: r.steps[0]?.askedAt ?? r.createdAt.toISOString(),
      answer: answered?.answeredAt
        ? { text: answeredBody(answered), at: answered.answeredAt, by: answered.answeredBy ?? null }
        : null,
    };
  });
}

/** Every question asked of the requirement or named as about it, newest first; questionnaire items are their batch's. */
export async function questionsOnRequirement(
  requirementId: string,
  executor: Tx = db,
): Promise<RequirementQuestionRow[]> {
  const rows = await executor
    .select(columns)
    .from(agentQuestions)
    .where(
      and(
        or(
          eq(agentQuestions.requirementId, requirementId),
          and(
            sql`${agentQuestions.about} ->> 'kind' = 'requirement'`,
            sql`${agentQuestions.about} ->> 'requirementId' = ${requirementId}`,
          ),
        ),
        sql`${agentQuestions.batchId} is null`,
      ),
    )
    .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id));
  return shaped(rows, executor);
}

/** The answered questions on the issues that deliver the requirement, newest first. */
export async function answeredOnIssuesOf(
  requirementId: string,
  executor: Tx = db,
): Promise<RequirementQuestionRow[]> {
  const rows = await executor
    .select(columns)
    .from(agentQuestions)
    .innerJoin(issues, eq(issues.id, agentQuestions.issueId))
    .where(and(eq(issues.requirementId, requirementId), eq(agentQuestions.status, 'answered')))
    .orderBy(desc(agentQuestions.updatedAt), desc(agentQuestions.id));
  return shaped(rows, executor);
}

/** The open questions among `ids`; the agree reads the blocking ones its head names. */
export async function openAmong(ids: readonly string[], executor: Tx = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await executor
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(inArray(agentQuestions.id, [...ids]), eq(agentQuestions.status, 'open')));
  return new Set(rows.map((r) => r.id));
}
