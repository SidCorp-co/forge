import { randomUUID } from 'node:crypto';
import {
  AUTONOMOUS_QUESTION_STATUS,
  ISSUE_TERMINAL_STATUSES,
} from '@forge/contracts/issue-machine';
import type { QuestionAboutRequest } from '@forge/contracts/questions';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { type IssueStatus, issues, type WaitingKind } from '../db/schema.js';
import { LEGACY_ISSUE_PREFIX } from '../lib/issue-ref.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';
import type { DrizzleTx } from './dependency-executor.js';
import { landedSql } from './host-landing.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import { issuesNamedBy, type ParkBlockerKind, parkOwedBy, seqOfNamed } from './park-owed.js';
import { askParkQuestion, pendingDesignOfPark, personOwesAnAnswer } from './ports.js';

const DECISION_KIND: WaitingKind = 'needs_decision';

/** A design revision a park waits on: its approver's decision answers the question minted for it. */
export interface AwaitedDesignRef {
  workflowId: string;
  revision: number;
}

/** The question a park minted, as the stall it starts names it (REQ-67 BC-6), and who owes it and
 *  why, as the transition's answer says (ISS-1292). */
export type ParkQuestion = { id: string; text: string; owedBy: ParkBlockerKind; because: string };

/** A design revision's question is its approver's, whom the design's own standing names. */
const DESIGN_OWED = {
  owedBy: 'human',
  because: 'it waits on a design revision, which its approver decides',
} as const;

const NEED_NOT_STATED =
  'the run did not say what would settle this — answer with whatever it needs to carry on';

interface MintParkQuestionInput {
  issue: { id: string; projectId: string };
  toStatus: IssueStatus;
  actor: TransitionActor;
  options: {
    needs?: string | undefined;
    /** Each design revision the park waits on: one question each, so it returns once every one is decided. */
    awaitsDesign?: readonly AwaitedDesignRef[] | undefined;
    awaitsMerge?: { issueId: string } | undefined;
    /** What the question is about (ISS-583): stored on every question the park mints. */
    about?: QuestionAboutRequest | undefined;
    transitionReason?: string | undefined;
    reason?: string | undefined;
    waitingKind?: WaitingKind | undefined;
  };
}

/** Whether a park at this status is answered through a question: `needs_info`, whatever its kind
 *  (the old `waiting` park folded in with its kind, ISS-54). */
function mintsAt(toStatus: IssueStatus): boolean {
  return toStatus === AUTONOMOUS_QUESTION_STATUS;
}

/**
 * Mint the questions this park is answered through — one per design revision it waits on, else one —
 * unless the park names no need, no design revision and no merge mark, and a person already owes the
 * issue an answer, which is the question it waits on. The park returns once every one is answered
 * (`pipeline/answer-resume.ts` resumes only an issue with no open question left).
 */
export async function mintParkQuestion(
  input: MintParkQuestionInput,
  tx: DrizzleTx,
): Promise<ParkQuestion | null> {
  const needs = input.options.needs?.trim();
  if (!mintsAt(input.toStatus)) return null;
  if (actorAgency(input.actor) !== 'agent') return null;
  const awaitsMerge = input.options.awaitsMerge;
  const about = input.options.about;
  const named = input.options.awaitsDesign ?? [];
  // a park naming what it is about asks a person a business question, which no design decision answers
  const linked = named.length > 0 || awaitsMerge || about ? null : await designDrawnHere(input, tx);
  const designs: AwaitedDesignRef[] = linked ? [linked] : [...named];
  if (
    !needs &&
    !about &&
    designs.length === 0 &&
    !awaitsMerge &&
    (await personOwesAnAnswer(tx, input.issue.id))
  )
    return null;
  const prompt = input.options.transitionReason?.trim() || input.options.reason?.trim() || '';
  const owed = await parkOwedOf(input, tx, needs);
  const ask = (
    awaited: Pick<Parameters<typeof askParkQuestion>[1], 'awaitsDesign' | 'awaitsMerge'>,
  ) =>
    askParkQuestion(tx, {
      id: randomUUID(),
      projectId: input.issue.projectId,
      issueId: input.issue.id,
      prompt,
      // a park on a design revision or a merge mark says what settles it by naming it
      needed: needs || (awaited.awaitsDesign || awaited.awaitsMerge ? undefined : NEED_NOT_STATED),
      ...awaited,
      ...(about ? { about } : {}),
      ...(linked ? { linkedUnderIssue: true } : {}),
      ...(awaited.awaitsDesign ? {} : { blockerKind: owed.blockerKind }),
    });
  const first = (q: { id: string; steps: Array<{ prompt: string }> }): ParkQuestion => ({
    id: q.id,
    text: q.steps[0]?.prompt ?? prompt,
    ...(designs.length > 0 ? DESIGN_OWED : { owedBy: owed.blockerKind, because: owed.because }),
  });
  if (designs.length === 0) {
    return first(await ask(awaitsMerge ? { awaitsMerge: { issueId: awaitsMerge.issueId } } : {}));
  }
  let minted: ParkQuestion | null = null;
  for (const d of designs) {
    const q = await ask({ awaitsDesign: { workflowId: d.workflowId, revision: d.revision } });
    minted ??= first(q);
  }
  return minted;
}

/** Who owes the question this park mints, by what it waits on (`park-owed.ts:parkOwedBy`, ISS-1127). */
async function parkOwedOf(input: MintParkQuestionInput, tx: DrizzleTx, needs: string | undefined) {
  const [own] = await tx
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(eq(issues.id, input.issue.id))
    .limit(1);
  const active = await activeIssuePrefix(input.issue.projectId, tx);
  const held = await heldIssuePrefixes(input.issue.projectId, tx);
  const prefixes = [LEGACY_ISSUE_PREFIX, ...(active ? [active] : []), ...held];
  const ownSeq = own?.issSeq ?? 0;
  const named = issuesNamedBy(needs ?? '', prefixes, ownSeq);
  return parkOwedBy({
    waitingKind: input.options.waitingKind,
    needs,
    awaitsMerge: input.options.awaitsMerge !== undefined,
    prefixes,
    ownSeq,
    shipped: await shippedAmong(tx, input.issue.projectId, named),
  });
}

/**
 * Which of the issues a park's `needs` names are no longer delivery to wait on: landed (the one
 * predicate every landed read takes, `host-landing.ts:landedSql`), closed or dropped (ISS-1292). A key
 * naming no issue of the project is none of these, so it still reads as a wait.
 */
async function shippedAmong(
  tx: DrizzleTx,
  projectId: string,
  named: readonly string[],
): Promise<Set<number>> {
  const seqs = [...new Set(named.map(seqOfNamed))];
  if (seqs.length === 0) return new Set();
  const rows = await tx
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        inArray(issues.issSeq, seqs),
        or(inArray(issues.status, [...ISSUE_TERMINAL_STATUSES]), landedSql(sql`"issues"`)),
      ),
    );
  return new Set(rows.map((r) => r.issSeq));
}

/**
 * The revision a decision park that names none waits on: the one proposed under the parking issue
 * and still awaiting its approver. Only a `needs_decision` park is linked — a park for an answer or a
 * resource waits on something a design decision does not supply.
 */
async function designDrawnHere(input: MintParkQuestionInput, tx: DrizzleTx) {
  if (input.options.waitingKind !== DECISION_KIND) return null;
  return pendingDesignOfPark(tx, input.issue.projectId, input.issue.id);
}

/** Why `needs`, `about`, `awaitsDesign` or `awaitsMerge` cannot be taken on this move: each shapes the question an agent's park mints. */
export function needsNotApplicable(input: MintParkQuestionInput): string | null {
  if (input.options.awaitsDesign?.length && input.options.awaitsMerge) {
    return '`awaitsDesign` and `awaitsMerge` were both sent, and a park question waits on one fact — a design decision or a merge mark. Park on the one whose arrival settles this, and say the other in `needs`.';
  }
  if (input.options.awaitsMerge) {
    if (!mintsAt(input.toStatus)) {
      return `\`awaitsMerge\` was sent with \`${input.toStatus}\`, which mints no question — only a park at \`${AUTONOMOUS_QUESTION_STATUS}\` waits on a merge mark.`;
    }
    if (actorAgency(input.actor) !== 'agent') {
      return '`awaitsMerge` was sent on a credential owned by a person, which mints no question for the mark to answer — a person parking their own work owns their own resume. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.';
    }
  }
  if (input.options.awaitsDesign?.length) {
    if (!mintsAt(input.toStatus)) {
      return `\`awaitsDesign\` was sent with \`${input.toStatus}\`, which mints no question — only a park at \`${AUTONOMOUS_QUESTION_STATUS}\` waits on a design revision's decision.`;
    }
    if (actorAgency(input.actor) !== 'agent') {
      return '`awaitsDesign` was sent on a credential owned by a person, which mints no question for the decision to answer — a person parking their own work owns their own resume. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.';
    }
  }
  if (input.options.about) {
    if (!mintsAt(input.toStatus)) {
      return `\`about\` was sent with \`${input.toStatus}\`, which mints no question — only a park at \`${AUTONOMOUS_QUESTION_STATUS}\` asks one, and \`about\` names what it asks about.`;
    }
    if (actorAgency(input.actor) !== 'agent') {
      return '`about` was sent on a credential owned by a person, which mints no question for it to name — a person parking their own work owns their own resume, and asks a business question with POST /api/questions. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.';
    }
  }
  if (!input.options.needs?.trim()) return null;
  if (!mintsAt(input.toStatus)) {
    return `\`needs\` was sent with \`${input.toStatus}\`, which mints no question — only \`${AUTONOMOUS_QUESTION_STATUS}\` does. Put what you need in \`reason\`, or park at \`${AUTONOMOUS_QUESTION_STATUS}\` instead.`;
  }
  if (actorAgency(input.actor) !== 'agent') {
    return `\`needs\` was sent on a credential owned by a person, which mints no question — a person parking their own work owns their own resume. If an agent made this call, it is running on the wrong credential: it wants an agent account or a paired device.`;
  }
  return null;
}
