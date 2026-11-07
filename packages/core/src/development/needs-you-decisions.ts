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

import { NEEDS_YOU_AREAS, type NeedsYouAreaKey } from '@forge/contracts/needs-you';
import {
  type DecisionOpens,
  isDecisionActOn,
  type NeedsYouDecision,
  type NeedsYouNotDecisionReason,
  type NotDecisionItem,
  rowSpaceOf,
} from '@forge/contracts/needs-you-decisions';
import type { NeedsYouTopic } from '@forge/contracts/needs-you-proposal';
import { FEEDBACK_TRIAGE_ACTS } from '@forge/contracts/steward';
import { type OpenPersonQuestion, readOpenPersonQuestions } from '../questions/index.js';
import { type Attention, type AttentionRow, owedOf } from './needs-you.js';
import { acceptDecision, repinDecision } from './needs-you-accept-builders.js';
import {
  agreeDecision,
  type ContractFacts,
  type CuttableRelease,
  contractDecision,
  cutDecision,
  designDecision,
  type ReleaseFacts,
  releaseDecision,
  releaseFactsOf,
  revisionDecision,
} from './needs-you-approve-builders.js';
import {
  type Built,
  type DecisionBody,
  feedbackDecision,
  prefilledReason,
} from './needs-you-decision-builders.js';
import { draftApprovalDecision } from './needs-you-draft-approval.js';
import { asked } from './needs-you-escalation.js';
import { repinDecision as designRepinDecision } from './needs-you-repin.js';
import { revisionWordsOf } from './needs-you-signoff-words.js';
import { type DesignRepinGroup, releaseApprovalsOfRuns } from './ports.js';

/** The said act keys whose row is the viewer's own work to finish, never a choice. */
const OWN_WORK: ReadonlySet<string> = new Set([
  'standing.act.proposeR',
  'standing.act.reviseReturned',
  'standing.act.finishDraft',
  'standing.act.reviseThenProposeOrDrop',
  'standing.act.writeRevision',
]);

/** A feedback item's triage the viewer holds: their choice, made on the item's page, no one-click answer (ISS-924). */
const TRIAGE: ReadonlySet<string> = new Set(FEEDBACK_TRIAGE_ACTS);

/** A requirement holding a question a person owes, the steward's decision or any other (REQ-48 BC-5, REQ-68 BC-9): its question is the decision. */
const REQUIREMENT_ASKED = new Set(['standing.act.answerSteward', 'standing.act.answerQuestion']);

/** A design revision proposed to its approver (`workflows/design-standing.ts:proposedWait`). */
const DESIGN_PROPOSED = 'designs.act.approveOrReturn';

/** A contract version proposed to its approver (`ecosystem/standing/standing.ts:providedTurn`). */
const CONTRACT_PROPOSED = 'contracts.act.approveOrReturn';

/** The issue acts a requirement waits on as the answer to a run's question on one of its issues. */
const ANSWER_ACTS: ReadonlySet<string> = new Set([
  'issues.standing.act.answer',
  'issues.standing.act.answerOther',
  'issues.standing.act.decide',
  'issues.standing.act.supply',
]);

/** A reporter's verify of a shipped fix (`feedback/standing.ts`). */
const VERIFY_FIX: ReadonlySet<string> = new Set([
  'standing.act.verifyFix',
  'standing.act.verifyFixIn',
]);

/**
 * A suggestion a signer decides on a requirement: its breakdown, or a revision it suggested. The
 * suggestion is its own decision, folded from the suggestions read (`needs-you-fold.ts`) with what it
 * proposes, so the requirement's row is not a second one.
 */
const SUGGESTION_ACTS: ReadonlySet<string> = new Set([
  'standing.act.reviewBreakdown',
  'standing.act.reviewSuggestedRevision',
]);

/** A moved design's pin-only dependents, cleared by the one re-pin act (`needs-you-repin.ts`). */
const REPIN_BATCH = 'designs.act.repinBatch';

/** A draft release no gate holds, which its admins cut where the master does not (`release-batch/release-view.ts:draftTurn`). */
const RELEASE_CUT = 'standing.act.cut';
const RELEASE_DRAFT_DECIDE = 'standing.act.approveDraftOrReturn';

type Classified = Built | { reason: NeedsYouNotDecisionReason } | { folded: true };

interface Facts {
  questions: OpenPersonQuestion[];
  issueIdOf: ReadonlyMap<string, string>;
  requirementOf: ReadonlyMap<
    string,
    {
      id: string;
      proposed: number | null;
      head: number | null;
      current: number | null;
      criteria: { passing: number; total: number };
      /** The proposed and the current revision's own words, what a sign-off's press records (REQ-4 BC-16). */
      proposedWords: string | null;
      currentWords: string | null;
    }
  >;
  /** Each moved design's re-pin group, by the base's flow. */
  repinOf: ReadonlyMap<string, DesignRepinGroup>;
  releaseOf: ReadonlyMap<string, ReleaseFacts>;
  /** Each draft release the viewer may cut, by version. */
  cutOf: ReadonlyMap<string, CuttableRelease>;
  approvalOf: ReadonlyMap<string, string>;
  feedbackAnswerOf: ReadonlyMap<string, string | null>;
  /** Each design whose proposed revision waits on a person, by flow. */
  designOf: ReadonlyMap<string, { workflowId: string; revision: number; title: string }>;
  /** Each provided contract whose proposed version waits on a person, by its ref. */
  contractOf: ReadonlyMap<string, ContractFacts>;
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

/** The open question a row waits on: the question the row is, the requirement's, or its issue's. */
function questionOf(
  row: AttentionRow,
  f: Facts,
  issueKey: string | null,
): OpenPersonQuestion | null {
  if (row.entity === 'question') return f.questions.find((q) => q.id === row.key) ?? null;
  if (row.entity === 'requirement' && issueKey === null) {
    const id = f.requirementOf.get(row.key)?.id;
    return id ? (f.questions.filter((q) => q.requirementId === id).at(-1) ?? null) : null;
  }
  const issueId = issueKey ? f.issueIdOf.get(issueKey) : undefined;
  if (!issueId) return null;
  // the newest round waiting on the issue is the one its standing reads
  return f.questions.filter((q) => q.issueId === issueId).at(-1) ?? null;
}

/**
 * The product item a question row opens: the feedback item it is about, else the requirement it is
 * about, else the item the issue it is asked on serves; null where it names none (a run's question
 * attached to nothing, or on an issue serving no item).
 */
function itemOfQuestion(q: OpenPersonQuestion): DecisionOpens | null {
  if (q.aboutFeedback) return { kind: 'feedback', key: q.aboutFeedback };
  if (q.subject?.kind === 'requirement') return { kind: 'requirement', key: q.subject.key };
  return q.issueItem;
}

/** What one row the viewer owes is: a decision built from its record, or the reason it is not one. */
function classify(row: AttentionRow, area: NeedsYouAreaKey, f: Facts): Classified {
  const act = actOf(row);
  if (OWN_WORK.has(act.key)) return { reason: 'own_work' };
  if (row.entity === 'feedback' && TRIAGE.has(act.key)) return { reason: 'triage' };
  // a row the viewer owes whose act no person decides by one press: theirs to carry out on its page
  if (row.entity !== 'question' && !isDecisionActOn(row.entity, row.standing.waitingOn.says.act)) {
    return { reason: 'work' };
  }
  if (REQUIREMENT_ASKED.has(act.key) && row.entity === 'requirement') {
    const q = questionOf(row, f, null);
    if (!q) return { reason: 'work' };
    return asked(row, area, q, { kind: 'requirement', key: row.key }, f.projectId);
  }
  if (row.entity === 'question') {
    const q = questionOf(row, f, null);
    if (!q) return { reason: 'work' };
    return asked(row, area, q, itemOfQuestion(q), f.projectId);
  }
  // a question on one of the requirement's issues is a decision on the requirement (REQ-68 BC-4)
  if (act.key === 'standing.act.onIssue' && act.inner && act.ref && row.entity === 'requirement') {
    if (!ANSWER_ACTS.has(act.inner)) return { reason: 'work' };
    const q = questionOf(row, f, act.ref);
    if (!q) return { reason: 'work' };
    return asked(row, area, q, { kind: 'requirement', key: row.key }, f.projectId);
  }
  if (row.entity === 'requirement') {
    const req = f.requirementOf.get(row.key);
    if (act.key === 'standing.act.acceptR' && req?.proposed) {
      return revisionDecision(row, area, f.projectId, req.proposed, req.proposedWords);
    }
    // an agree pins the current revision, never a newer withdrawn one (`rules.ts:agreeRefusals`)
    if (act.key === 'standing.act.agreeR' && req?.current) {
      return agreeDecision(row, area, f.projectId, req.current, req.currentWords);
    }
    if (act.key === 'standing.acts' && req?.head) {
      return repinDecision(row, area, f.projectId, req.head);
    }
    if (SUGGESTION_ACTS.has(act.key)) return { folded: true };
    if (act.key === 'standing.act.check' && req?.current) {
      return acceptDecision(row, area, f.projectId, req.current, req.criteria);
    }
    return { reason: 'work' };
  }
  if (row.entity === 'release' && act.key === RELEASE_CUT) {
    const cut = f.cutOf.get(row.key);
    if (!cut) return { reason: 'work' };
    return cutDecision(row, area, f.projectId, cut);
  }
  if (row.entity === 'release' && act.key === RELEASE_DRAFT_DECIDE) {
    if (row.standing.waitingOn.kind !== 'you') return { reason: 'work' };
    return draftApprovalDecision(row, area, f.projectId);
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
  if (row.entity === 'workflow' && act.key === REPIN_BATCH) {
    const group = f.repinOf.get(row.key);
    if (!group || row.standing.waitingOn.kind !== 'you') return { reason: 'work' };
    return designRepinDecision(row, area, f.projectId, group);
  }
  if (row.entity === 'workflow' && act.key === DESIGN_PROPOSED) {
    const design = f.designOf.get(row.key);
    if (!design || row.standing.waitingOn.kind !== 'you') return { reason: 'work' };
    return designDecision(row, area, f.projectId, design);
  }
  if (row.entity === 'contract' && act.key === CONTRACT_PROPOSED) {
    const contract = f.contractOf.get(row.key);
    if (!contract || row.standing.waitingOn.kind !== 'you') return { reason: 'work' };
    return contractDecision(row, area, f.projectId, contract);
  }
  if (row.entity === 'feedback' && act.key === 'standing.act.confirmAnswer') {
    return feedbackDecision(row, area, f.projectId, f.feedbackAnswerOf.get(row.key) ?? null);
  }
  if (row.entity === 'feedback' && VERIFY_FIX.has(act.key)) {
    return feedbackDecision(row, area, f.projectId, null, 'fix');
  }
  return { reason: 'work' };
}

/** The page group a decision its builder did not place is read under, by what it decides. */
function topicOf(d: DecisionBody): NeedsYouTopic {
  if (d.group === 'answer' || d.entity === 'question') return 'question';
  if (d.entity === 'feedback') return 'feedback';
  if (d.entity === 'release') return 'release';
  if (d.entity === 'workflow') return 'design';
  return 'requirement';
}

/** A built decision with its id, page group and proposal, and whether its item is stuck and due. */
function completed(
  d: DecisionBody,
  due: { stuck: boolean; dueAt: string | null },
): NeedsYouDecision {
  return {
    ...prefilledReason(d),
    ...due,
    id: d.id ?? `${d.entity}:${d.key}:${d.answers[0]?.act ?? 'none'}`,
    topic: d.topic ?? topicOf(d),
    proposal: d.proposal ?? null,
  };
}

/** Whether the row's item reads stuck and when its act falls due: what orders Needs you (BC-11). */
function dueOfRow(row: AttentionRow): { stuck: boolean; dueAt: string | null } {
  const dueAt = row.due?.dueAt ?? row.standing.waitingOn.dueAt ?? null;
  return { stuck: row.due?.stuck ?? false, dueAt: dueAt ? new Date(dueAt).toISOString() : null };
}

const OPENS_KIND: Partial<Record<AttentionRow['entity'], DecisionOpens['kind']>> = {
  requirement: 'requirement',
  feedback: 'feedback',
  workflow: 'workflow',
  release: 'release',
  contract: 'contract',
};

/** A row that is not a decision, named in plain words with the step it waits on (REQ-48 r3 BC-17). */
function leftItem(row: AttentionRow): NotDecisionItem {
  const kind = OPENS_KIND[row.entity];
  const next = row.standing.waitingOn.act.trim();
  return {
    key: row.key,
    title: (row.title || row.key).slice(0, 500),
    next: next ? next.slice(0, 300) : null,
    opens: kind ? { kind, key: row.key } : null,
  };
}

/** Whose list one row is on (`rowSpaceOf`): its area's, or a member's ask where it is a person's decision. */
export const spaceOf = (area: NeedsYouAreaKey, row: AttentionRow) =>
  rowSpaceOf(area, row.entity, row.standing.waitingOn.says.act);

/** One row the viewer owes, built into the decision it is. */
export interface OwedDecision {
  area: NeedsYouAreaKey;
  row: AttentionRow;
  decision: NeedsYouDecision;
}

export type { Attention };

/** The owed rows listed (each a decision or left out by why) and every owed row, ops ones too. */
interface Classification {
  owed: OwedDecision[];
  left: Map<NeedsYouNotDecisionReason, NotDecisionItem[]>;
  listed: { area: NeedsYouAreaKey; row: AttentionRow }[];
  owedRows: Record<NeedsYouAreaKey, AttentionRow[]>;
}

/**
 * The viewer's owed rows of one attention read, each a decision or counted under why it is not one:
 * the one classification the needs-me read and the approval inbox both take.
 */
export async function decisionsOf(
  projectId: string,
  attention: Attention,
): Promise<Classification> {
  const owedRows = owedOf(attention.rows);
  const runIds = attention.releases.releases.flatMap((r) =>
    r.state === 'awaiting_approval' && r.runId ? [r.runId] : [],
  );
  const signed = attention.requirements.flatMap((r) =>
    [r.standing.facts.proposedRevision, r.currentRevision].flatMap((n) =>
      n === null ? [] : [{ requirementId: r.id, revision: n }],
    ),
  );
  const [questions, approvals, wordsOf] = await Promise.all([
    readOpenPersonQuestions(projectId),
    releaseApprovalsOfRuns(runIds),
    revisionWordsOf(signed),
  ]);
  const facts: Facts = {
    projectId,
    questions,
    issueIdOf: new Map(attention.issues.issues.map((i) => [i.key, i.id])),
    requirementOf: new Map(
      attention.requirements.map((r) => [
        r.key,
        {
          id: r.id,
          proposed: r.standing.facts.proposedRevision,
          head: r.latestRevision?.revision ?? r.currentRevision,
          current: r.currentRevision,
          criteria: { passing: r.standing.facts.passing, total: r.standing.facts.criteria },
          proposedWords: wordsOf(r.id, r.standing.facts.proposedRevision),
          currentWords: wordsOf(r.id, r.currentRevision),
        },
      ]),
    ),
    repinOf: new Map(attention.repins.groups.map((g) => [g.flow, g])),
    releaseOf: new Map(attention.releases.releases.map((r) => [r.version, releaseFactsOf(r)])),
    cutOf: new Map(
      attention.releases.releases.flatMap((r) =>
        r.can.cut
          ? [[r.version, { version: r.version, contents: r.contents, criteria: r.criteria }]]
          : [],
      ),
    ),
    approvalOf: new Map(approvals.filter((a) => a.decision === null).map((a) => [a.runId, a.id])),
    feedbackAnswerOf: new Map(attention.feedback.map((f) => [f.key, f.route?.answer ?? null])),
    contractOf: new Map(
      attention.contracts.contracts.flatMap((c) =>
        c.direction === 'provided' && c.pending
          ? [
              [
                c.ref,
                {
                  slug: c.slug,
                  title: c.title.trim() || c.ref,
                  version: c.pending.version,
                  classification: c.pending.classification,
                  queued: c.queued,
                },
              ],
            ]
          : [],
      ),
    ),
    designOf: new Map(
      [...attention.health.values()].flatMap((h) =>
        h.proposal
          ? [
              [
                h.flow,
                {
                  workflowId: h.workflowId,
                  revision: h.proposal.revision,
                  title: h.proposal.title.trim() || h.flow,
                },
              ],
            ]
          : [],
      ),
    ),
  };
  const owed: OwedDecision[] = [];
  const listed: { area: NeedsYouAreaKey; row: AttentionRow }[] = [];
  const asked = new Set<string>();
  const left = new Map<NeedsYouNotDecisionReason, NotDecisionItem[]>();
  const asks = NEEDS_YOU_AREAS.flatMap((area) =>
    owedRows[area].flatMap((row) => (spaceOf(area, row) === 'asks' ? [{ area, row }] : [])),
  );
  // a question's own row answers it before a requirement its issue holds up names the same one
  const heldUp = (r: AttentionRow) => actOf(r).key === 'standing.act.onIssue';
  for (const { area, row } of [
    ...asks.filter((a) => !heldUp(a.row)),
    ...asks.filter((a) => heldUp(a.row)),
  ]) {
    const c = classify(row, area, facts);
    if ('folded' in c) continue;
    if ('reason' in c) {
      left.set(c.reason, [...(left.get(c.reason) ?? []), leftItem(row)]);
      listed.push({ area, row });
      continue;
    }
    // a requirement held up by an issue's question and the issue itself are one decision
    if (c.questionId && asked.has(c.questionId)) continue;
    if (c.questionId) asked.add(c.questionId);
    owed.push({ area, row, decision: completed(c.decision, dueOfRow(row)) });
    listed.push({ area, row });
  }
  return { owed, left, listed, owedRows };
}
