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
  type DecisionOpens,
  isDecisionActOn,
  type NeedsYouDecision,
  type NeedsYouDecisions,
  type NeedsYouNotDecisionReason,
  type NotDecisionItem,
  needsYouDecisionsSchema,
} from '@forge/contracts/needs-you-decisions';
import type { NeedsYouTopic } from '@forge/contracts/needs-you-proposal';
import type { ProjectAccess } from '../lib/authz.js';
import { type OpenPersonQuestion, readOpenPersonQuestions } from '../questions/index.js';
import { type AttentionRow, type NeedsYouViewer, owedOf, readAttention } from './needs-you.js';
import { acceptDecision, admitDecision, repinDecision } from './needs-you-accept-builders.js';
import {
  agreeDecision,
  type CuttableRelease,
  cutDecision,
  designDecision,
  releaseDecision,
  revisionDecision,
} from './needs-you-approve-builders.js';
import {
  type Built,
  type DecisionBody,
  feedbackDecision,
  questionDecision,
} from './needs-you-decision-builders.js';
import { type EvidenceGroup, withEvidence } from './needs-you-evidence.js';
import { foldedDecisions } from './needs-you-fold.js';
import { repinDecision as designRepinDecision } from './needs-you-repin.js';
import { type DesignRepinGroup, releaseApprovalsOfRuns } from './ports.js';

/** How many decisions one answer carries; `total` counts them all. */
const DECISIONS_MAX = 200;
const NOT_DECISION_ITEMS_MAX = 20;

/** The said act keys whose row is the viewer's own work to finish, never a choice. */
const OWN_WORK: ReadonlySet<string> = new Set([
  'standing.act.proposeR',
  'standing.act.reviseReturned',
  'standing.act.finishDraft',
  'standing.act.reviseThenProposeOrDrop',
  'issues.standing.act.reviseDesign',
  'standing.act.writeRevision',
]);

/** A draft nobody has asked to merge, drop or keep yet (BC-12): not a decision until the steward asks it. */
const AWAITING_PROPOSAL: ReadonlySet<string> = new Set(['issues.standing.act.takeOnOrDrop']);

/** A requirement the steward asked a decision on (REQ-48 BC-5): its question is the decision. */
const STEWARD_ASKED = 'standing.act.answerSteward';

/** A design revision proposed to its approver (`workflows/design-standing.ts:proposedWait`). */
const DESIGN_PROPOSED = 'designs.act.approveOrReturn';

/** The issue acts a person owes as the answer to a run's question. */
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

/** A draft release no gate holds, which only an admin cuts (`release-batch/release-view.ts:draftTurn`). */
const RELEASE_CUT = 'standing.act.cut';

/** A requirement whose only issues are drafts asks them taken on (`requirements/standing.ts`). */
const PROMOTE_DRAFTS: ReadonlySet<string> = new Set([
  'standing.act.promoteDraft',
  'standing.act.promoteDrafts',
]);

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
    }
  >;
  /** Each requirement's draft issues, by requirement key. */
  draftsOf: ReadonlyMap<string, { id: string; key: string }[]>;
  /** Each moved design's re-pin group, by the base's flow. */
  repinOf: ReadonlyMap<string, DesignRepinGroup>;
  releaseOf: ReadonlyMap<string, { runId: string | null; failing: number; total: number }>;
  /** Each draft release the viewer may cut, by version. */
  cutOf: ReadonlyMap<string, CuttableRelease>;
  approvalOf: ReadonlyMap<string, string>;
  feedbackAnswerOf: ReadonlyMap<string, string | null>;
  /** Each design whose proposed revision waits on a person, by flow. */
  designOf: ReadonlyMap<string, { workflowId: string; revision: number; title: string }>;
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
  if (row.entity === 'requirement') {
    const id = f.requirementOf.get(row.key)?.id;
    return id ? (f.questions.filter((q) => q.requirementId === id).at(-1) ?? null) : null;
  }
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
  // a row whose act no person decides is an agent's to take (`isDecisionAct`); slices never group it
  // needs_you, so one reaching here is a question row or a slice outside the three
  if (row.entity !== 'question' && !isDecisionActOn(row.entity, row.standing.waitingOn.says.act)) {
    return { reason: 'work' };
  }
  if (act.key === STEWARD_ASKED && row.entity === 'requirement') {
    const q = questionOf(row, f, null);
    if (!q) return { reason: 'work' };
    return questionDecision(row, area, q, { kind: 'requirement', key: row.key });
  }
  if (row.entity === 'question' || (row.entity === 'issue' && ANSWER_ACTS.has(act.key))) {
    const q = questionOf(row, f, row.entity === 'issue' ? row.key : null);
    if (!q) return { reason: 'work' };
    // a steward decision about a feedback item stands on no item, and opens the item it names
    const opens =
      row.entity === 'issue'
        ? { kind: 'issue' as const, key: row.key }
        : q.aboutFeedback
          ? { kind: 'feedback' as const, key: q.aboutFeedback }
          : null;
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
    // an agree pins the current revision, never a newer withdrawn one (`rules.ts:agreeRefusals`)
    if (act.key === 'standing.act.agreeR' && req?.current) {
      return agreeDecision(row, area, f.projectId, req.current);
    }
    if (act.key === 'standing.acts' && req?.head) {
      return repinDecision(row, area, f.projectId, req.head);
    }
    if (SUGGESTION_ACTS.has(act.key)) return { folded: true };
    if (act.key === 'standing.act.check' && req?.current) {
      return acceptDecision(row, area, f.projectId, req.current, req.criteria);
    }
    const drafts = f.draftsOf.get(row.key) ?? [];
    if (PROMOTE_DRAFTS.has(act.key) && drafts.length > 0) return admitDecision(row, area, drafts);
    return { reason: 'work' };
  }
  if (row.entity === 'release' && act.key === RELEASE_CUT) {
    const cut = f.cutOf.get(row.key);
    if (!cut) return { reason: 'work' };
    return cutDecision(row, area, f.projectId, cut);
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
    ...d,
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

/** Each requirement's draft issues, by its key. */
function draftsByRequirement(
  issues: readonly {
    id: string;
    key: string;
    status: string;
    standing: { requirement: { key: string } | null };
  }[],
): Map<string, { id: string; key: string }[]> {
  const out = new Map<string, { id: string; key: string }[]>();
  for (const i of issues) {
    const req = i.standing.requirement?.key;
    if (i.status !== 'draft' || !req) continue;
    out.set(req, [...(out.get(req) ?? []), { id: i.id, key: i.key }]);
  }
  return out;
}

const OPENS_KIND: Partial<Record<AttentionRow['entity'], DecisionOpens['kind']>> = {
  issue: 'issue',
  requirement: 'requirement',
  feedback: 'feedback',
  workflow: 'workflow',
  release: 'release',
  lesson: 'lesson',
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

/** One row the viewer owes, built into the decision it is. */
export interface OwedDecision {
  area: NeedsYouAreaKey;
  row: AttentionRow;
  decision: NeedsYouDecision;
}

type Attention = Awaited<ReturnType<typeof readAttention>>;

/**
 * The viewer's owed rows of one attention read, each a decision or counted under why it is not one:
 * the one classification the needs-me read and the approval inbox both take.
 */
export async function decisionsOf(
  projectId: string,
  attention: Attention,
): Promise<{ owed: OwedDecision[]; left: Map<NeedsYouNotDecisionReason, NotDecisionItem[]> }> {
  const owedRows = owedOf(attention.rows);
  const runIds = attention.releases.releases.flatMap((r) =>
    r.state === 'awaiting_approval' && r.runId ? [r.runId] : [],
  );
  const [questions, approvals] = await Promise.all([
    readOpenPersonQuestions(projectId),
    releaseApprovalsOfRuns(runIds),
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
        },
      ]),
    ),
    draftsOf: draftsByRequirement(attention.issues.issues),
    repinOf: new Map(attention.repins.groups.map((g) => [g.flow, g])),
    releaseOf: new Map(
      attention.releases.releases.map((r) => [
        r.version,
        { runId: r.runId, failing: r.criteria.failing, total: r.criteria.total },
      ]),
    ),
    cutOf: new Map(
      attention.releases.releases.flatMap((r) =>
        r.can.cut
          ? [[r.version, { version: r.version, contents: r.contents, criteria: r.criteria }]]
          : [],
      ),
    ),
    approvalOf: new Map(approvals.filter((a) => a.decision === null).map((a) => [a.runId, a.id])),
    feedbackAnswerOf: new Map(attention.feedback.map((f) => [f.key, f.route?.answer ?? null])),
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
  const asked = new Set<string>();
  const left = new Map<NeedsYouNotDecisionReason, NotDecisionItem[]>();
  const asks = NEEDS_YOU_AREAS.filter((a) => NEEDS_YOU_AREA_SPACE[a] === 'asks').flatMap((area) =>
    owedRows[area].map((row) => ({ area, row })),
  );
  // an issue's own row answers its question before a requirement it holds up names the same one
  const heldUp = (r: AttentionRow) => actOf(r).key === 'standing.act.onIssue';
  for (const { area, row } of [
    ...asks.filter((a) => !heldUp(a.row)),
    ...asks.filter((a) => heldUp(a.row)),
  ]) {
    const c = classify(row, area, facts);
    if ('folded' in c) continue;
    if ('reason' in c) {
      left.set(c.reason, [...(left.get(c.reason) ?? []), leftItem(row)]);
      continue;
    }
    // a requirement held up by an issue's question and the issue itself are one decision
    if (c.questionId && asked.has(c.questionId)) continue;
    if (c.questionId) asked.add(c.questionId);
    owed.push({ area, row, decision: completed(c.decision, dueOfRow(row)) });
  }
  return { owed, left };
}

/** Every decision of one attention read, in the list's order, and what was left out by why. */
async function allDecisionsOf(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  attention: Attention,
) {
  const [{ owed, left }, folded] = await Promise.all([
    decisionsOf(projectId, attention),
    foldedDecisions(projectId, viewer, access, attention),
  ]);
  if (folded.unreadable.length > 0) {
    // a record no decision could be made of is opened on its own page, named by its key alone
    left.set(
      'unreadable',
      folded.unreadable.map((key) => ({
        key,
        title: key,
        next: 'open it on its own page',
        opens: null,
      })),
    );
  }
  const decisions = uniqueIds([...owed.map((o) => o.decision), ...folded.decisions]).sort(
    byDecisionOrder,
  );
  const ids: EvidenceGroup['ids'] = {
    issue: new Map(attention.issues.issues.map((i) => [i.key, i.id])),
    requirement: new Map(attention.requirements.map((r) => [r.key, r.id])),
  };
  return { decisions, left, ids };
}

/** The viewer's whole Needs you from an attention read already made: what the status report counts. */
export async function needsYouDecisionsOf(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  attention: Attention,
): Promise<NeedsYouDecision[]> {
  return (await allDecisionsOf(projectId, viewer, access, attention)).decisions;
}

/** Each decision's id once in the read, a second built for the same record numbered after it. */
function uniqueIds(decisions: NeedsYouDecision[]): NeedsYouDecision[] {
  const seen = new Map<string, number>();
  return decisions.map((d) => {
    const n = (seen.get(d.id) ?? 0) + 1;
    seen.set(d.id, n);
    return n === 1 ? d : { ...d, id: `${d.id}#${n}` };
  });
}

/**
 * One project's Needs you read without the evidence each decision rests on, and the ids its evidence
 * is read by: the cross-project read reads every project's evidence in one call after it.
 */
export async function readNeedsYouDecisionsBare(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<{ read: NeedsYouDecisions; ids: EvidenceGroup['ids'] }> {
  const attention = await readAttention(projectId, viewer, now);
  const { decisions, left, ids } = await allDecisionsOf(projectId, viewer, access, attention);
  const read = needsYouDecisionsSchema.parse({
    generatedAt: now.toISOString(),
    decisions: decisions.slice(0, DECISIONS_MAX),
    total: decisions.length,
    notDecisions: [...left].map(([reason, items]) => ({
      reason,
      count: items.length,
      items: items.slice(0, NOT_DECISION_ITEMS_MAX),
    })),
  });
  return { read, ids };
}

/**
 * The one Needs you read (REQ-48 BC-11): the viewer's decisions from their owed rows, and every
 * agent's proposal, mockup and preview waiting on them folded in, each with the evidence it rests on
 * (r3 BC-15). The page, the Dashboard, /attention, the nav and the chat all count `total` from here,
 * so no two surfaces count their own.
 */
export async function readNeedsYouDecisions(
  projectId: string,
  viewer: NeedsYouViewer,
  access: ProjectAccess,
  now: Date = new Date(),
): Promise<NeedsYouDecisions> {
  const { read, ids } = await readNeedsYouDecisionsBare(projectId, viewer, access, now);
  const [decisions = []] = await withEvidence([{ decisions: read.decisions, ids }]);
  return needsYouDecisionsSchema.parse({ ...read, decisions });
}
