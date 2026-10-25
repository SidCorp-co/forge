/**
 * The intake assistant's act (REQ-34 BC-4, BC-10; feedback-triage r16 `intake` -> `dedup` ->
 * `suggest`, requirement-lifecycle r15 `start` -> `draft`): when a requirement is created or a
 * feedback item filed, the outbox hands it to `intake-assistant`, which drafts it with no chat and
 * writes the draft where the item's own flow reads it (`apply.ts`); a feedback item's triage
 * suggestion also takes it off the master's owed triage. The draft itself, or the code it could not
 * be made under, is kept on the item. A miss worth trying again is delivered again by the outbox,
 * with its backoff, up to `INTAKE_DRAFT_ATTEMPTS` tries; an item the assistant could not draft stays
 * owed to its master (feedback-triage `master-draft`).
 *
 * The draft carries the item's value check (REQ-65 BC-1). A check a blocking question holds is drafted
 * once more when its last such question is answered (`intake.answered`), with the answers among the
 * item's own words; any other draft stands.
 */

import {
  INTAKE_DRAFT_ATTEMPTS,
  INTAKE_RETRYABLE_CODES,
  type IntakeDraftApplied,
  type IntakeDraftCode,
  type IntakeItemKind,
  type ValueEffect,
} from '@forge/contracts/intake-drafts';
import { eq } from 'drizzle-orm';
import { recordModelCallUsage } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { intakeDrafts } from '../db/schema-intake.js';
import { completeOnce } from '../integrations/llm/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { readContentLanguage } from '../project-config/index.js';
import { applyDraft, triageJudgeFor } from './apply.js';
import { type DraftDeps, type DraftOutcome, draftIntake, type Spent } from './draft.js';
import { dbIntakeReads, type IntakeItem } from './reads.js';
import { answersOf, draftRowOf, heldBy, questionsOf, valueStateOf } from './value.js';

export type IntakeResult =
  | { kind: 'drafted'; applied: IntakeDraftApplied }
  | { kind: 'failed'; key: string; code: IntakeDraftCode; attempts: number; retry: boolean }
  | { kind: 'not_owed'; why: string };

/**
 * What a consumer throws for a miss another try is owed for, so the outbox delivers the item's event
 * again with its backoff (the delivery's own retry, `outbox/queues.ts`). It is thrown at most
 * `INTAKE_DRAFT_ATTEMPTS - 1` times for one item, far inside the delivery's own attempt limit.
 */
const retryOwed = (key: string, code: IntakeDraftCode, attempts: number) =>
  new Error(
    `intake: ${key} was not drafted (${code}), try ${attempts} of ${INTAKE_DRAFT_ATTEMPTS}; the outbox delivers it again`,
  );

const arcOf = (kind: IntakeItemKind, id: string) =>
  kind === 'requirement' ? eq(intakeDrafts.requirementId, id) : eq(intakeDrafts.feedbackId, id);

async function standingOf(kind: IntakeItemKind, id: string) {
  return draftRowOf(kind, id);
}

/**
 * Whether a held check is owed its next draft: every question that held it is answered (REQ-65
 * BC-3). A draft that failed is owed by its own retry rule.
 */
async function answeredOut(row: NonNullable<Awaited<ReturnType<typeof standingOf>>>) {
  if (row.outcome !== 'drafted' || row.valueOutcome !== 'held') return false;
  return heldBy(questionsOf(row), await answersOf(db, row)).length === 0;
}

/** Why `standing` owes no new draft, or null when one is owed. */
async function settled(standing: Awaited<ReturnType<typeof standingOf>>): Promise<string | null> {
  if (!standing) return null;
  if (standing.outcome === 'drafted') {
    return (await answeredOut(standing)) ? null : 'it is drafted';
  }
  if (standing.code && !INTAKE_RETRYABLE_CODES.includes(standing.code))
    return `its draft ended as ${standing.code}`;
  if (standing.attempts >= INTAKE_DRAFT_ATTEMPTS)
    return `its draft failed ${standing.attempts} times`;
  return null;
}

async function recordSpend(projectId: string, spent: readonly Spent[]): Promise<void> {
  const last = spent.at(-1);
  if (!last) return;
  const sum = (key: keyof Spent['usage']) => spent.reduce((n, s) => n + (s.usage[key] ?? 0), 0);
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
    logger.warn({ err, projectId }, 'intake: the usage of the draft call was not recorded');
  }
}

/**
 * Keeps `out` as the item's one draft, unless another delivery drafted it meanwhile (null). A miss
 * worth trying again, with tries left, is kept with another try owed.
 */
async function keep(
  item: IntakeItem,
  out: DraftOutcome,
  applied: IntakeDraftApplied | null,
  effect: ValueEffect | null = null,
  /** The drafted_at of the held draft this one follows, which it alone may replace. */
  follows: Date | null = null,
): Promise<{ attempts: number; retry: boolean } | null> {
  return db.transaction(async (tx) => {
    await lockXact(tx, 'intakeDrafts', item.id);
    const [held] = await tx
      .select({
        id: intakeDrafts.id,
        outcome: intakeDrafts.outcome,
        attempts: intakeDrafts.attempts,
        draftedAt: intakeDrafts.draftedAt,
      })
      .from(intakeDrafts)
      .where(arcOf(item.kind, item.id))
      .limit(1);
    const replaces = follows !== null && held?.draftedAt.getTime() === follows.getTime();
    if (held?.outcome === 'drafted' && !replaces) return null;
    // a redraft after answers starts its own count of tries
    const attempts = held && !replaces ? held.attempts + 1 : 1;
    const retry =
      out.outcome === 'failed' &&
      INTAKE_RETRYABLE_CODES.includes(out.code) &&
      attempts < INTAKE_DRAFT_ATTEMPTS;
    const values = {
      outcome: out.outcome,
      code: out.outcome === 'failed' ? out.code : null,
      detail: out.outcome === 'failed' ? out.detail : null,
      model: out.model,
      read: out.read,
      body:
        out.outcome === 'drafted'
          ? {
              links: out.draft.links,
              notAffected: out.draft.notAffected,
              assumptions: out.draft.assumptions,
              questions: out.draft.questions,
              nothingToAsk: out.draft.nothingToAsk,
            }
          : null,
      value: out.outcome === 'drafted' ? { ...out.draft.value, effect } : null,
      valueOutcome: out.outcome === 'drafted' ? valueStateOf(out.draft.value) : null,
      applied,
      attempts,
      retryOwed: retry,
      draftedAt: new Date(),
    };
    if (held) {
      await tx.update(intakeDrafts).set(values).where(eq(intakeDrafts.id, held.id));
    } else {
      await tx.insert(intakeDrafts).values({
        ...values,
        projectId: item.projectId,
        requirementId: item.kind === 'requirement' ? item.id : null,
        feedbackId: item.kind === 'feedback' ? item.id : null,
      });
    }
    return { attempts, retry };
  });
}

/** A delivery that died owes no further try: its draft says it gave up rather than retrying. */
async function settleRetry(kind: IntakeItemKind, id: string): Promise<void> {
  await db.update(intakeDrafts).set({ retryOwed: false }).where(arcOf(kind, id));
}

/** What a live draft of `item` is made with: the database reads and the deployment's model. */
async function liveDeps(item: IntakeItem): Promise<DraftDeps> {
  const [level, language, triageFault] = await Promise.all([
    dataPolicyOf(item.projectId),
    readContentLanguage(item.projectId),
    triageJudgeFor(item),
  ]);
  return { reads: dbIntakeReads, complete: completeOnce, level, language, triageFault };
}

/**
 * Drafts one item and writes the draft where its flow reads it. A miss is kept by code, with whether
 * another try is owed, and nothing here throws for it: the consumer decides (`registerIntakeAssistant`).
 * A database error does throw, and the outbox retries the delivery.
 */
export async function draftIntakeFor(
  kind: IntakeItemKind,
  id: string,
  deps?: DraftDeps,
): Promise<IntakeResult> {
  const standing = await standingOf(kind, id);
  const done = await settled(standing);
  if (done) return { kind: 'not_owed', why: done };
  // a held check answered out is drafted again in its place, and nothing else may replace a draft
  const follows = standing?.outcome === 'drafted' ? standing.draftedAt : null;
  const reads = deps?.reads ?? dbIntakeReads;
  const item = await reads.item(kind, id);
  if (!item) return { kind: 'not_owed', why: `there is no such ${kind}` };
  const out = await draftIntake(item, deps ?? (await liveDeps(item)));
  await recordSpend(item.projectId, out.spent);
  if (out.outcome === 'failed') {
    // a failed redraft takes the held draft's place and is retried as any miss is; the answers stay
    const kept = await keep(item, out, null, null, follows);
    if (!kept) return { kind: 'not_owed', why: 'another delivery drafted it' };
    logger.info(
      { key: item.key, code: out.code, attempts: kept.attempts, retry: kept.retry },
      'intake: the item was not drafted',
    );
    return { kind: 'failed', key: item.key, code: out.code, ...kept };
  }
  const { applied, effect } = await applyDraft(item, out.draft, out.model);
  await keep(item, out, applied, effect, follows);
  return { kind: 'drafted', applied };
}

/** Drafts one delivered item, and throws where another try is owed so the outbox delivers it again. */
async function deliver(kind: IntakeItemKind, id: string): Promise<void> {
  const result = await draftIntakeFor(kind, id);
  if (result.kind === 'failed' && result.retry) {
    throw retryOwed(result.key, result.code, result.attempts);
  }
}

/** The consumer of a requirement's creation and a feedback item's filing (REQ-34 BC-10). */
export function registerIntakeAssistant(): void {
  consume('requirement.created', {
    name: 'intake-assistant',
    handle: (p) => deliver('requirement', p.requirementId),
    onDeadLetter: (p) => settleRetry('requirement', p.requirementId),
  });
  consume('feedback.filed', {
    name: 'intake-assistant',
    handle: (p) => deliver('feedback', p.feedbackId),
    onDeadLetter: (p) => settleRetry('feedback', p.feedbackId),
  });
  consume('intake.answered', {
    name: 'intake-assistant',
    handle: (p) => deliver(p.kind, p.itemId),
    onDeadLetter: (p) => settleRetry(p.kind, p.itemId),
  });
}
