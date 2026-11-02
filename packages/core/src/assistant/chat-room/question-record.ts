// What the record already says about a parked run's question, and the one door through which the
// room's agent answers it from there (ISS-873). Before anyone is asked, the agent reads the question's
// issue, its requirement, the feedback linked to it with its decisions, messages and attached files,
// and the questions already answered on that issue; where those settle it, it answers through
// `answer_from_record`, citing where, and the room is told nothing. The answer is the project's agent
// account's, recorded with the citation as the agent's reason (REQ-79 BC-14).

import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import {
  feedback,
  feedbackAttachments,
  feedbackDecisions,
  feedbackMessages,
  feedbackRouteIssues,
} from '../../db/schema-feedback.js';
import { agentQuestions, isChoiceStep, type QuestionStep } from '../../db/schema-questions.js';
import { requirements } from '../../db/schema-requirements.js';
import { logger } from '../../lib/logger.js';
import { isRefusal } from '../../lib/refusal.js';
import { answerAs } from '../../questions/index.js';
import { stewardAccountOf } from '../../steward/index.js';
import type { ChatToolset } from '../tools/mcp-adapter.js';

export const READ_RECORD_TOOL = 'read_record';
export const ANSWER_FROM_RECORD_TOOL = 'answer_from_record';

const clip = (text: string | null | undefined, max: number): string | null =>
  text ? (text.length > max ? `${text.slice(0, max)}…` : text) : null;

const said = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

const refused = (code: string, path: string, detail: string) =>
  said({ refused: [{ code, path, detail }] }, true);

/** What an answered round settled, as the record shows it. */
function answerOf(step: QuestionStep | undefined): string | null {
  if (!step) return null;
  if (isChoiceStep(step)) {
    return step.options.find((o) => o.id === step.chosenOptionId)?.label ?? null;
  }
  return step.answerText ?? null;
}

/** The feedback of the issue: filed on it, routed to it, or filed on its requirement. */
async function feedbackOf(issueId: string, requirementId: string | null) {
  const routed = db
    .select({ id: feedbackRouteIssues.feedbackId })
    .from(feedbackRouteIssues)
    .where(eq(feedbackRouteIssues.issueId, issueId));
  const rows = await db
    .select({
      id: feedback.id,
      fbSeq: feedback.fbSeq,
      title: feedback.title,
      body: feedback.body,
      status: feedback.status,
    })
    .from(feedback)
    .where(
      or(
        eq(feedback.issueId, issueId),
        inArray(feedback.id, routed),
        ...(requirementId ? [eq(feedback.requirementId, requirementId)] : []),
      ),
    )
    .orderBy(desc(feedback.fbSeq))
    .limit(10);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [decisions, messages, files] = await Promise.all([
    db
      .select({
        feedbackId: feedbackDecisions.feedbackId,
        decision: feedbackDecisions.decision,
        reason: feedbackDecisions.reason,
        agency: feedbackDecisions.decidedAgency,
        at: feedbackDecisions.decidedAt,
      })
      .from(feedbackDecisions)
      .where(inArray(feedbackDecisions.feedbackId, ids))
      .orderBy(feedbackDecisions.decidedAt),
    db
      .select({
        feedbackId: feedbackMessages.feedbackId,
        body: feedbackMessages.body,
        agency: feedbackMessages.sentAgency,
        at: feedbackMessages.createdAt,
      })
      .from(feedbackMessages)
      .where(inArray(feedbackMessages.feedbackId, ids))
      .orderBy(feedbackMessages.createdAt),
    db
      .select({
        feedbackId: feedbackAttachments.feedbackId,
        name: feedbackAttachments.name,
        mime: feedbackAttachments.mime,
      })
      .from(feedbackAttachments)
      .where(inArray(feedbackAttachments.feedbackId, ids)),
  ]);
  return rows.map((r) => ({
    key: `FB-${r.fbSeq}`,
    title: r.title,
    body: clip(r.body, 1500),
    status: r.status,
    decisions: decisions
      .filter((d) => d.feedbackId === r.id)
      .map((d) => ({ decision: d.decision, by: d.agency, reason: clip(d.reason, 400) })),
    messages: messages
      .filter((m) => m.feedbackId === r.id)
      .slice(-5)
      .map((m) => ({ by: m.agency, text: clip(m.body, 600) })),
    attachments: files
      .filter((f) => f.feedbackId === r.id)
      .map((f) => ({ name: f.name, type: f.mime })),
  }));
}

/** The record around a question: its issue, requirement, linked feedback and earlier answers. */
export async function questionRecord(questionId: string): Promise<Record<string, unknown>> {
  const [q] = await db
    .select({ issueId: agentQuestions.issueId, projectId: agentQuestions.projectId })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!q?.issueId) {
    return {
      issue: null,
      note: 'this question names no issue, so the record holds nothing about it',
    };
  }
  const [issue] = await db
    .select({
      issSeq: issues.issSeq,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      requirementId: issues.requirementId,
    })
    .from(issues)
    .where(eq(issues.id, q.issueId))
    .limit(1);
  if (!issue) return { issue: null, note: 'the issue this question was asked on is gone' };
  const [requirement] = issue.requirementId
    ? await db
        .select({ reqSeq: requirements.reqSeq, title: requirements.title })
        .from(requirements)
        .where(eq(requirements.id, issue.requirementId))
        .limit(1)
    : [];
  const earlier = await db
    .select({ steps: agentQuestions.steps })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.issueId, q.issueId),
        eq(agentQuestions.status, 'answered'),
        ne(agentQuestions.id, questionId),
      ),
    )
    .orderBy(desc(agentQuestions.createdAt))
    .limit(10);
  return {
    issue: {
      key: `ISS-${issue.issSeq}`,
      title: issue.title,
      status: issue.status,
      description: clip(issue.description, 3000),
    },
    requirement: requirement
      ? { key: `REQ-${requirement.reqSeq}`, title: requirement.title }
      : null,
    feedback: await feedbackOf(q.issueId, issue.requirementId),
    earlierAnswers: earlier
      .map((e) => e.steps.at(-1))
      .map((s) => ({ question: s?.prompt ?? null, answer: answerOf(s) }))
      .filter((a) => a.answer !== null),
  };
}

export interface RecordTools {
  toolset: ChatToolset;
  /** Whether this turn recorded an answer from the record. */
  answered: () => boolean;
}

function argsOf(argsJson: string): Record<string, unknown> | null {
  try {
    const v = argsJson.trim() ? (JSON.parse(argsJson) as unknown) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The answer the call names for this round, or the refusal naming the shape that passes. */
function answerNamed(
  step: QuestionStep,
  args: Record<string, unknown>,
): { kind: 'option'; optionId: string } | { kind: 'text'; text: string } | string {
  if (!isChoiceStep(step)) {
    const text = typeof args.answer === 'string' ? args.answer.trim() : '';
    if (args.option !== undefined || !text) {
      return 'this round asks for an answer in words: pass `answer` (the words the record gives) and no `option`';
    }
    return { kind: 'text', text };
  }
  const option = step.options.find((o) => o.id === args.option);
  if (!option) {
    return `this round is a choice: pass \`option\`, one of ${step.options.map((o) => o.id).join(', ')}`;
  }
  return { kind: 'option', optionId: option.id };
}

/**
 * The tools an asking turn is offered: read the record, and answer the round from it, citing where.
 */
export function recordTools(c: {
  questionId: string;
  projectId: string;
  round: number;
}): RecordTools {
  let answered = false;
  let answeredAs: string | null = null;
  const toolset: ChatToolset = {
    tools: [
      {
        type: 'function',
        function: {
          name: READ_RECORD_TOOL,
          description:
            "Read what the record holds about this question: its issue, the issue's requirement, the feedback linked to it (decisions, messages, attached files) and the questions already answered on that issue.",
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      {
        type: 'function',
        function: {
          name: ANSWER_FROM_RECORD_TOOL,
          description:
            'Answer the question from the record, only where the record settles it. `source` says where you found it (for example the feedback item and the file attached to it, or the earlier answer). For a choice pass `option`, the id of the option the record settles; for a question asked in words pass `answer`. Once it is answered, write nothing.',
          parameters: {
            type: 'object',
            properties: {
              source: { type: 'string', description: 'Where in the record the answer is.' },
              option: { type: 'string', description: 'The id of the option the record settles.' },
              answer: {
                type: 'string',
                description: 'The answer in words, as the record gives it.',
              },
            },
            required: ['source'],
            additionalProperties: false,
          },
        },
      },
    ],
    execute: async (name, argsJson) => {
      if (name === READ_RECORD_TOOL) return said(await questionRecord(c.questionId));
      if (name !== ANSWER_FROM_RECORD_TOOL) {
        return refused('TOOL_UNKNOWN', '', `${name} is not offered here`);
      }
      const args = argsOf(argsJson);
      if (!args) return refused('ARGS_INVALID', '', 'the arguments were not a JSON object');
      if (answered) {
        return refused('QUESTION_ALREADY_ANSWERED', '', 'this turn already recorded the answer.');
      }
      const source = typeof args.source === 'string' ? args.source.trim() : '';
      if (!source) {
        return refused(
          'QUESTION_SOURCE_REQUIRED',
          '/source',
          'say where in the record the answer is (the feedback item, its attached file, the earlier answer). Nothing was recorded.',
        );
      }
      const [question] = await db
        .select({ status: agentQuestions.status, steps: agentQuestions.steps })
        .from(agentQuestions)
        .where(eq(agentQuestions.id, c.questionId))
        .limit(1);
      const step = question?.steps.at(-1);
      if (question?.status !== 'open' || !step || step.round !== c.round) {
        return refused(
          'QUESTION_NOT_OPEN',
          '',
          `this round is ${question?.status === 'open' ? 'superseded by a later one' : (question?.status ?? 'gone')}, so nothing can be answered on it. Nothing was recorded.`,
        );
      }
      const answer = answerNamed(step, args);
      if (typeof answer === 'string') {
        return refused(
          'QUESTION_ANSWER_WRONG_SHAPE',
          '/option',
          `${answer}. Nothing was recorded.`,
        );
      }
      try {
        answeredAs = await stewardAccountOf(c.projectId);
        await answerAs({
          questionId: c.questionId,
          answer,
          round: c.round,
          userId: answeredAs,
          agency: 'agent',
          note: `Answered from the record: ${source}`,
          via: 'assistant',
        });
      } catch (err) {
        if (isRefusal(err)) return said({ refused: err.refusals }, true);
        logger.error(
          { err, questionId: c.questionId, round: c.round },
          'chat-room.question: recording the answer from the record failed',
        );
        return refused(
          'QUESTION_ANSWER_UNWRITTEN',
          '',
          'the answer could not be written. Nothing changed.',
        );
      }
      answered = true;
      logger.info(
        { questionId: c.questionId, round: c.round, source },
        'chat-room.question: answered from the record; nothing is posted',
      );
      return said({ recorded: true, note: 'The run that asked is woken. Write nothing.' });
    },
    // the project's agent account answers; reading the record acts as nobody
    ranAs: (name) => (name === ANSWER_FROM_RECORD_TOOL ? answeredAs : null),
  };
  return { toolset, answered: () => answered };
}
