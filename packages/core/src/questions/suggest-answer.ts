/**
 * The assistant's suggested answer to a person question that came with none (REQ-41 BC-2; owner
 * ruling 2026-10-09: the assistant drafts first from the product record, never the codebase, and
 * only through the gateway). Drafted off the read path: the outbox delivers `question.asked` to
 * `question-suggest`, and a timed sweep drafts the questions no delivery reached (asked before this
 * rule, a later round, a miss worth trying again), a few per tick. One `completeOnce` call, so the
 * deployment's provider and the project's data policy apply as they do to a chat turn; the answer is
 * judged, with one retry carrying the refusal. The outcome is kept on the question for the round it
 * was drafted for: the suggestion, or the named code it could not be drafted under. The asker's own
 * recommendation is never touched and wins wherever it exists, and a suggestion answers nothing:
 * only a person's answer moves the question. The pattern is `release-page/draft.ts:draftHighlights`.
 */

import { contentLanguageBlock } from '@forge/contracts/content-language';
import { feedbackKey } from '@forge/contracts/feedback';
import {
  QUESTION_SUGGESTION_ATTEMPTS,
  QUESTION_SUGGESTION_RETRY_MS,
  QUESTION_SUGGESTION_RETRYABLE,
  QUESTION_SUGGESTION_TEXT_MAX,
  QUESTION_SUGGESTION_WHY_MAX,
  type QuestionSuggestion,
  type QuestionSuggestionCode,
} from '@forge/contracts/question-suggestion';
import { requirementKey } from '@forge/contracts/requirements';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { agentQuestions, type FreeTextStep, isChoiceStep } from '../db/schema-questions.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import {
  type ChatMessage,
  type ChatStreamUsage,
  type CompletionAnswer,
  completeOnce,
} from '../integrations/llm/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { readContentLanguage } from '../project-config/index.js';
import { recordModelCallUsage } from './ports.js';

/** A hung provider cannot hold a delivery longer than this per call. */
const CALL_TIMEOUT_MS = 60_000;
const SWEEP_BATCH = 3;
const FACT_MAX = 1200;
const CRITERIA_MAX = 25;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export type SuggestResult =
  | { kind: 'suggested' }
  | { kind: 'failed'; code: QuestionSuggestionCode }
  | { kind: 'not_owed'; why: string };

/** What the product record says about a question: the lines the model reads, and the keys they came from. */
interface ProductRecord {
  lines: string[];
  from: string[];
  /** Feedback is what people send in: the policy reads it as operational, the rest as product. */
  operational: boolean;
}

async function requirementLines(requirementId: string, out: ProductRecord): Promise<void> {
  const [req] = await db
    .select({
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
    })
    .from(requirements)
    .where(eq(requirements.id, requirementId))
    .limit(1);
  if (!req) return;
  const key = requirementKey(req.reqSeq);
  const [rev] = await db
    .select({ tldr: requirementRevisions.tldr, spec: requirementRevisions.spec })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId))
    .orderBy(desc(requirementRevisions.revision))
    .limit(1);
  const goal = (rev?.spec as { goal?: unknown } | undefined)?.goal;
  const criteria = await db
    .select({ code: requirementCriteria.code, body: requirementCriteria.body })
    .from(requirementCriteria)
    .where(
      and(
        eq(requirementCriteria.requirementId, requirementId),
        isNull(requirementCriteria.retiredRevision),
      ),
    )
    .orderBy(requirementCriteria.createdAt)
    .limit(CRITERIA_MAX);
  out.from.push(key);
  out.lines.push(`Requirement ${key} (${req.status}): ${req.title}`);
  if (rev?.tldr) out.lines.push(`  In short: ${clip(rev.tldr, FACT_MAX)}`);
  if (typeof goal === 'string' && goal.trim()) out.lines.push(`  Goal: ${clip(goal, FACT_MAX)}`);
  for (const c of criteria) out.lines.push(`  ${c.code}: ${clip(c.body, 300)}`);
}

/** The records a question stands on: its issue, the requirement either names, the feedback item. */
async function readRecord(row: typeof agentQuestions.$inferSelect): Promise<ProductRecord> {
  const out: ProductRecord = { lines: [], from: [], operational: false };
  let requirementId = row.requirementId;
  if (!requirementId && row.about?.kind === 'requirement') requirementId = row.about.requirementId;
  if (row.issueId) {
    const [issue] = await db
      .select({
        seq: issues.issSeq,
        title: issues.title,
        description: issues.description,
        requirementId: issues.requirementId,
      })
      .from(issues)
      .where(eq(issues.id, row.issueId))
      .limit(1);
    if (issue) {
      out.from.push(`ISS-${issue.seq}`);
      out.lines.push(`Issue ISS-${issue.seq}: ${issue.title}`);
      if (issue.description?.trim()) out.lines.push(`  ${clip(issue.description, FACT_MAX)}`);
      requirementId ??= issue.requirementId;
    }
  }
  if (requirementId) await requirementLines(requirementId, out);
  if (row.feedbackId) {
    const [fb] = await db
      .select({ seq: feedback.fbSeq, title: feedback.title, body: feedback.body })
      .from(feedback)
      .where(eq(feedback.id, row.feedbackId))
      .limit(1);
    if (fb) {
      const key = feedbackKey(fb.seq);
      out.from.push(key);
      out.operational = true;
      out.lines.push(`Feedback ${key}: ${fb.title}`);
      if (fb.body?.trim()) out.lines.push(`  ${clip(fb.body, FACT_MAX)}`);
    }
  }
  return out;
}

function systemPrompt(language: Parameters<typeof contentLanguageBlock>[0]): string {
  return [
    'A run of the Forge pipeline stopped to ask a person one question and gave no answer of its own. You draft the answer the person is most likely to want, so they can send it with one click.',
    'Your only input is the question and the product record it stands on, below: the issue, the requirement and its criteria, the feedback item. You have not seen the code, so state nothing the record does not hold. Where the record does not settle the question, decline instead of guessing.',
    '',
    'Rules:',
    '- Answer with one JSON object and nothing else.',
    `- To answer: {"answer": "<the answer, written as the person would send it, at most ${QUESTION_SUGGESTION_TEXT_MAX} characters>", "why": "<one line naming the record it rests on, at most ${QUESTION_SUGGESTION_WHY_MAX} characters>"}.`,
    '- To decline: {"decline": "<one line saying what the record lacks>"}.',
    '- The answer is for the person to send as it stands; it makes no promise and takes no action by itself.',
    '',
    contentLanguageBlock(language, 'artifact'),
  ].join('\n');
}

const SHAPE =
  'the answer is not one JSON object {"answer": string, "why": string} or {"decline": string}, within the length limits';

type Drafted = { answer: string; why: string } | { decline: string } | string;

function parseAnswer(text: string): Drafted {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return SHAPE;
  let parsed: { answer?: unknown; why?: unknown; decline?: unknown } | null;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return SHAPE;
  }
  if (typeof parsed?.decline === 'string' && parsed.decline.trim()) {
    return { decline: clip(parsed.decline.trim(), QUESTION_SUGGESTION_WHY_MAX) };
  }
  if (typeof parsed?.answer !== 'string' || typeof parsed.why !== 'string') return SHAPE;
  const answer = parsed.answer.trim();
  const why = parsed.why.trim().replace(/\s+/g, ' ');
  if (!answer || !why) return SHAPE;
  if (answer.length > QUESTION_SUGGESTION_TEXT_MAX || why.length > QUESTION_SUGGESTION_WHY_MAX) {
    return `${SHAPE} (the answer was ${answer.length} characters, the why ${why.length})`;
  }
  return { answer, why };
}

function missOf(answer: Extract<CompletionAnswer, { ok: false }>): {
  code: QuestionSuggestionCode;
  detail: string;
} {
  if (answer.miss === 'unconfigured') {
    return {
      code: 'QUESTION_SUGGESTION_MODEL_UNCONFIGURED',
      detail: 'no chat model is configured on this instance, so no answer was suggested',
    };
  }
  if (answer.miss === 'withheld') {
    return {
      code: 'QUESTION_SUGGESTION_WITHHELD',
      detail:
        "the project's data policy forbids sending this record to a model, so no answer was suggested",
    };
  }
  return {
    code: 'QUESTION_SUGGESTION_MODEL_FAILED',
    detail: `the model call failed (${clip(answer.detail, 160)}); it is tried again later`,
  };
}

async function recordSpend(
  projectId: string,
  spent: readonly { model: string; usage: ChatStreamUsage }[],
): Promise<void> {
  const last = spent.at(-1);
  if (!last) return;
  const sum = (key: keyof ChatStreamUsage) => spent.reduce((n, s) => n + (s.usage[key] ?? 0), 0);
  const cached = sum('cachedPromptTokens');
  try {
    await recordModelCallUsage({
      projectId,
      model: last.model,
      inputTokens: Math.max(0, sum('promptTokens') - cached),
      outputTokens: sum('completionTokens'),
      cacheReadTokens: cached,
      requestCount: spent.length,
      recordedAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, projectId }, 'questions: the usage of the suggestion call was not recorded');
  }
}

/** The free-text round a question owes a suggestion for, or why it owes none. */
function owedRound(row: typeof agentQuestions.$inferSelect): FreeTextStep | string {
  if (row.status !== 'open') return `it is ${row.status}`;
  if (row.blockerKind !== 'human') return 'it is not a person question';
  if (row.batchId) return 'a questionnaire item carries its own inferred default';
  const step = row.steps.at(-1);
  if (!step) return 'it holds no round';
  if (isChoiceStep(step)) return 'its round offers options, each with a recommendation';
  if (step.recommended?.trim()) return 'the asker gave a recommended answer, which wins';
  return step;
}

/** Whether the record on `row` for this round settles it: a suggestion, or a miss not worth another try yet. */
function settledFor(
  existing: QuestionSuggestion | null,
  round: number,
  now: number,
): string | null {
  if (!existing || existing.round !== round) return null;
  if (existing.outcome === 'suggested') return 'it already has a suggestion';
  if (!QUESTION_SUGGESTION_RETRYABLE.includes(existing.code)) {
    return `the draft for this round ended as ${existing.code}`;
  }
  if (existing.attempts >= QUESTION_SUGGESTION_ATTEMPTS) {
    return `the draft for this round failed ${existing.attempts} times`;
  }
  if (now - Date.parse(existing.at) < QUESTION_SUGGESTION_RETRY_MS) {
    return 'the last attempt was a moment ago';
  }
  return null;
}

/** Writes the outcome only while the question is still open on the round it was drafted for. */
async function keep(
  questionId: string,
  round: number,
  suggestion: QuestionSuggestion,
): Promise<boolean> {
  const rows = await db
    .update(agentQuestions)
    .set({ suggestion })
    .where(
      and(
        eq(agentQuestions.id, questionId),
        eq(agentQuestions.status, 'open'),
        sql`(${agentQuestions.steps} -> -1 ->> 'round')::int = ${round}`,
        sql`coalesce(${agentQuestions.steps} -> -1 ->> 'recommended', '') = ''`,
      ),
    )
    .returning({ id: agentQuestions.id });
  return rows.length > 0;
}

/**
 * Drafts and keeps the suggestion for one question's current round. A model that fails, declines or
 * answers outside the shape leaves the question as it was and records which, by code; nothing here
 * throws for a miss, so a delivery is not retried into a storm of calls. A database error does throw.
 */
export async function suggestAnswerFor(questionId: string): Promise<SuggestResult> {
  const [row] = await db
    .select()
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
    .limit(1);
  if (!row) return { kind: 'not_owed', why: 'there is no such question' };
  const step = owedRound(row);
  if (typeof step === 'string') return { kind: 'not_owed', why: step };
  const done = settledFor(row.suggestion, step.round, Date.now());
  if (done) return { kind: 'not_owed', why: done };

  const attempts = row.suggestion?.round === step.round ? row.suggestion.attempts + 1 : 1;
  const miss = async (
    code: QuestionSuggestionCode,
    detail: string,
    from: string[] = [],
    model: string | null = null,
  ): Promise<SuggestResult> => {
    await keep(row.id, step.round, {
      round: step.round,
      by: 'assistant',
      at: new Date().toISOString(),
      from,
      model,
      attempts,
      outcome: 'failed',
      code,
      detail,
    });
    logger.info({ questionId: row.id, code }, 'questions: no answer was suggested');
    return { kind: 'failed', code };
  };

  if (step.sensitive) {
    return miss(
      'QUESTION_SUGGESTION_SENSITIVE',
      'the question is marked sensitive, so it is never sent to a model',
    );
  }
  const record = await readRecord(row);
  if (record.lines.length === 0) {
    return miss(
      'QUESTION_SUGGESTION_NO_RECORD',
      'the question stands on no issue, requirement or feedback item, so there is no product record to read',
    );
  }
  const from = [...new Set(record.from)];
  const language = await readContentLanguage(row.projectId);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(language) },
    {
      role: 'user',
      content: [
        `Question the run asked: ${step.prompt}`,
        `What would settle it: ${step.needed}`,
        '',
        'Product record:',
        ...record.lines,
      ].join('\n'),
    },
  ];
  const scope = {
    surface: record.operational ? ('feedback' as const) : ('issue.questions' as const),
    projectId: row.projectId,
    what: `a suggested answer to question ${row.id}`,
  };
  const spent: { model: string; usage: ChatStreamUsage }[] = [];
  let model: string | null = null;
  try {
    for (const attempt of [1, 2]) {
      const answer = await completeOnce(scope, messages, {
        temperature: 0,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (answer.model) model = answer.model;
      if (!answer.ok) {
        const m = missOf(answer);
        return await miss(m.code, m.detail, from, model);
      }
      spent.push({ model: answer.model, usage: answer.usage });
      const drafted = parseAnswer(answer.text);
      if (typeof drafted === 'string') {
        if (attempt === 2) return await miss('QUESTION_SUGGESTION_SHAPE', drafted, from, model);
        messages.push(
          { role: 'assistant', content: answer.text },
          {
            role: 'user',
            content: `That was refused: ${drafted}. Answer again as one JSON object.`,
          },
        );
        continue;
      }
      if ('decline' in drafted) {
        return await miss('QUESTION_SUGGESTION_DECLINED', drafted.decline, from, model);
      }
      const kept = await keep(row.id, step.round, {
        round: step.round,
        by: 'assistant',
        at: new Date().toISOString(),
        from,
        model,
        attempts,
        outcome: 'suggested',
        text: drafted.answer,
        why: drafted.why,
      });
      return kept
        ? { kind: 'suggested' }
        : { kind: 'not_owed', why: 'the question moved on while the answer was drafted' };
    }
    throw new Error('questions: the suggestion loop ended without an outcome');
  } finally {
    await recordSpend(row.projectId, spent);
  }
}

/** The consumer of `question.asked` that drafts the suggestion for a question that came with none. */
export function registerQuestionSuggest(): void {
  consume('question.asked', {
    name: 'question-suggest',
    handle: async (p) => {
      await suggestAnswerFor(p.questionId);
    },
  });
}

/**
 * The backfill and the catch-up: the oldest open person questions whose current round owes a
 * suggestion and has none (or a miss worth another try), drafted one after another, `limit` per
 * tick so a backlog is drafted once, slowly, and a gateway that is down is not hammered.
 */
export async function sweepQuestionSuggestions(
  limit: number = SWEEP_BATCH,
): Promise<{ suggested: number; failed: number }> {
  const retryable = QUESTION_SUGGESTION_RETRYABLE.map((c) => `'${c}'`).join(', ');
  const rows = await db
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        eq(agentQuestions.blockerKind, 'human'),
        isNull(agentQuestions.batchId),
        sql`${agentQuestions.steps} -> -1 ->> 'answerShape' = 'free_text'`,
        sql`coalesce(${agentQuestions.steps} -> -1 ->> 'recommended', '') = ''`,
        sql`(
          ${agentQuestions.suggestion} is null
          or (${agentQuestions.suggestion} ->> 'round')::int <> (${agentQuestions.steps} -> -1 ->> 'round')::int
          or (
            ${agentQuestions.suggestion} ->> 'outcome' = 'failed'
            and ${agentQuestions.suggestion} ->> 'code' in (${sql.raw(retryable)})
            and (${agentQuestions.suggestion} ->> 'attempts')::int < ${QUESTION_SUGGESTION_ATTEMPTS}
            and (${agentQuestions.suggestion} ->> 'at')::timestamptz < now() - ${QUESTION_SUGGESTION_RETRY_MS / 1000} * interval '1 second'
          )
        )`,
      ),
    )
    .orderBy(agentQuestions.createdAt, agentQuestions.id)
    .limit(limit);
  let suggested = 0;
  let failed = 0;
  for (const { id } of rows) {
    const out = await suggestAnswerFor(id);
    if (out.kind === 'suggested') suggested += 1;
    else if (out.kind === 'failed') failed += 1;
  }
  return { suggested, failed };
}
