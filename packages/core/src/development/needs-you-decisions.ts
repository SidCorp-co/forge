/**
 * The needs-me read (REQ-41 BC-1, BC-2): the rows the one Needs you read lists for the viewer
 * (`needs-you.ts:readAttention` under `needsViewer`), split into the decisions only a person can make
 * and the rest. A decision is built from its record's own data: the question and round a run asked,
 * the revision proposed, the release approval asked, the answer given on a feedback item; each with
 * the answer recommended and the buttons that send it, through the route the record's own page
 * calls (`@forge/contracts/needs-you-decisions:DECISION_ACTS`). Every other row is counted under the
 * reason it is not a decision, so a reply names what it left out and nothing is dropped in silence.
 * The answer is parsed against its contract before it leaves: a decision with a hole is a defect
 * here, never a button that posts to nowhere.
 */

import {
  NEEDS_YOU_AREA_SPACE,
  NEEDS_YOU_AREAS,
  type NeedsYouAreaKey,
} from '@forge/contracts/needs-you';
import {
  byDecisionOrder,
  type NeedsYouDecision,
  type NeedsYouDecisions,
  type NeedsYouNotDecisionReason,
  needsYouDecisionsSchema,
} from '@forge/contracts/needs-you-decisions';
import { type OpenPersonQuestion, readOpenPersonQuestions } from '../questions/index.js';
import { approvalsOfRuns } from '../release-batch/approvals.js';
import { type AttentionRow, type NeedsYouViewer, owedOf, readAttention } from './needs-you.js';
import {
  agreeDecision,
  type Built,
  feedbackDecision,
  questionDecision,
  releaseDecision,
  revisionDecision,
} from './needs-you-decision-builders.js';

/** How many decisions one answer carries; `total` counts them all. */
const DECISIONS_MAX = 200;
const NOT_DECISION_KEYS_MAX = 20;

/** The said act keys whose row is the viewer's own work to finish, never a choice. */
const OWN_WORK: ReadonlySet<string> = new Set([
  'standing.act.proposeR',
  'standing.act.reviseReturned',
  'standing.act.finishDraft',
  'standing.act.reviseThenProposeOrDrop',
  'issues.standing.act.reviseDesign',
]);

/** A draft nobody has proposed merging or dropping yet (BC-12): not a decision until the assistant asks it. */
const AWAITING_PROPOSAL: ReadonlySet<string> = new Set(['issues.standing.act.takeOnOrDrop']);

/** The issue acts a person owes as the answer to a run's question. */
const ANSWER_ACTS: ReadonlySet<string> = new Set([
  'issues.standing.act.answer',
  'issues.standing.act.answerOther',
  'issues.standing.act.decide',
]);

type Classified = Built | { reason: NeedsYouNotDecisionReason };

interface Facts {
  questions: OpenPersonQuestion[];
  issueIdOf: ReadonlyMap<string, string>;
  requirementOf: ReadonlyMap<string, { proposed: number | null; head: number | null }>;
  releaseOf: ReadonlyMap<string, { runId: string | null; failing: number; total: number }>;
  approvalOf: ReadonlyMap<string, string>;
  feedbackAnswerOf: ReadonlyMap<string, string | null>;
  projectId: string;
}

/** The said act's key, and for a requirement that waits on an issue, the issue's act key and key. */
function actOf(row: AttentionRow): { key: string; inner: string | null; ref: string | null } {
  const act = row.standing.waitingOn.says.act;
  if (act.key !== 'standing.act.onIssue') return { key: act.key, inner: null, ref: null };
  const inner = act.vars?.act;
  const ref = act.vars?.key;
  return {
    key: act.key,
    inner: inner && typeof inner === 'object' && 'key' in inner ? inner.key : null,
    ref: typeof ref === 'string' ? ref : null,
  };
}

/** The open question a row waits on: the issue's, or the question the row is. */
function questionOf(
  row: AttentionRow,
  f: Facts,
  issueKey: string | null,
): OpenPersonQuestion | null {
  if (row.entity === 'question') return f.questions.find((q) => q.id === row.key) ?? null;
  const issueId = issueKey ? f.issueIdOf.get(issueKey) : undefined;
  if (!issueId) return null;
  // the newest round waiting on the issue is the one its standing reads
  return f.questions.filter((q) => q.issueId === issueId).at(-1) ?? null;
}

/** What one row the viewer owes is: a decision built from its record, or the reason it is not one. */
function classify(row: AttentionRow, area: NeedsYouAreaKey, f: Facts): Classified {
  const act = actOf(row);
  if (OWN_WORK.has(act.key)) return { reason: 'own_work' };
  if (AWAITING_PROPOSAL.has(act.key)) return { reason: 'awaiting_proposal' };
  if (row.entity === 'question' || (row.entity === 'issue' && ANSWER_ACTS.has(act.key))) {
    const q = questionOf(row, f, row.entity === 'issue' ? row.key : null);
    if (!q) return { reason: 'work' };
    const opens = row.entity === 'issue' ? { kind: 'issue' as const, key: row.key } : null;
    return questionDecision(row, area, q, opens);
  }
  if (act.key === 'standing.act.onIssue' && act.inner && act.ref) {
    if (!ANSWER_ACTS.has(act.inner)) return { reason: 'work' };
    const q = questionOf(row, f, act.ref);
    if (!q) return { reason: 'work' };
    return questionDecision(row, area, q, { kind: 'issue', key: act.ref });
  }
  if (row.entity === 'requirement') {
    const req = f.requirementOf.get(row.key);
    if (act.key === 'standing.act.acceptR' && req?.proposed) {
      return revisionDecision(row, area, f.projectId, req.proposed);
    }
    if ((act.key === 'standing.act.agreeR' || act.key === 'standing.act.agreeIt') && req?.head) {
      return agreeDecision(row, area, f.projectId, req.head);
    }
    return { reason: 'work' };
  }
  if (row.entity === 'release' && act.key === 'standing.act.approveOrReturn') {
    const release = f.releaseOf.get(row.key);
    const approvalId = release?.runId ? f.approvalOf.get(release.runId) : undefined;
    if (!release?.runId || !approvalId) return { reason: 'work' };
    return releaseDecision(
      row,
      area,
      f.projectId,
      { ...release, runId: release.runId },
      approvalId,
    );
  }
  if (row.entity === 'feedback' && act.key === 'standing.act.confirmAnswer') {
    return feedbackDecision(row, area, f.projectId, f.feedbackAnswerOf.get(row.key) ?? null);
  }
  return { reason: 'work' };
}

export async function readNeedsYouDecisions(
  projectId: string,
  viewer: NeedsYouViewer,
  now: Date = new Date(),
): Promise<NeedsYouDecisions> {
  const attention = await readAttention(projectId, viewer, now);
  const owed = owedOf(attention.rows);
  const runIds = attention.releases.releases.flatMap((r) =>
    r.state === 'awaiting_approval' && r.runId ? [r.runId] : [],
  );
  const [questions, approvals] = await Promise.all([
    readOpenPersonQuestions(projectId),
    approvalsOfRuns(runIds),
  ]);
  const facts: Facts = {
    projectId,
    questions,
    issueIdOf: new Map(attention.issues.issues.map((i) => [i.key, i.id])),
    requirementOf: new Map(
      attention.requirements.map((r) => [
        r.key,
        {
          proposed: r.standing.facts.proposedRevision,
          head: r.latestRevision?.revision ?? r.currentRevision,
        },
      ]),
    ),
    releaseOf: new Map(
      attention.releases.releases.map((r) => [
        r.version,
        { runId: r.runId, failing: r.criteria.failing, total: r.criteria.total },
      ]),
    ),
    approvalOf: new Map(approvals.filter((a) => a.decision === null).map((a) => [a.runId, a.id])),
    feedbackAnswerOf: new Map(attention.feedback.map((f) => [f.key, f.route?.answer ?? null])),
  };
  const decisions: NeedsYouDecision[] = [];
  const asked = new Set<string>();
  const left = new Map<NeedsYouNotDecisionReason, string[]>();
  const asks = NEEDS_YOU_AREAS.filter((a) => NEEDS_YOU_AREA_SPACE[a] === 'asks').flatMap((area) =>
    owed[area].map((row) => ({ area, row })),
  );
  // an issue's own row answers its question before a requirement it holds up names the same one
  const heldUp = (r: AttentionRow) => actOf(r).key === 'standing.act.onIssue';
  for (const { area, row } of [
    ...asks.filter((a) => !heldUp(a.row)),
    ...asks.filter((a) => heldUp(a.row)),
  ]) {
    const c = classify(row, area, facts);
    if ('reason' in c) {
      left.set(c.reason, [...(left.get(c.reason) ?? []), row.key]);
      continue;
    }
    // a requirement held up by an issue's question and the issue itself are one decision
    if (c.questionId && asked.has(c.questionId)) continue;
    if (c.questionId) asked.add(c.questionId);
    decisions.push(c.decision);
  }
  decisions.sort(byDecisionOrder);
  return needsYouDecisionsSchema.parse({
    generatedAt: now.toISOString(),
    decisions: decisions.slice(0, DECISIONS_MAX),
    total: decisions.length,
    notDecisions: [...left].map(([reason, keys]) => ({
      reason,
      count: keys.length,
      keys: keys.slice(0, NOT_DECISION_KEYS_MAX),
    })),
  });
}
