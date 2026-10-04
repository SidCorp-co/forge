/**
 * Where a requirement stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, the facts the list's secondary line prints,
 * and each business criterion's coverage by issue verdicts. Pure, so every rule below is a unit
 * test; `standing-read.ts` gathers the facts.
 */

import type { IssueStatusTone } from '@forge/contracts/issue-vocabulary';
import {
  type BcVerdict,
  BREAKDOWN_SLA_WORKING_DAYS,
  CHECK_SLA_WORKING_DAYS,
  type CoverageIssue,
  type DeliveryPhase,
  type RequirementDelivery,
  type RequirementAttentionGroup,
  type RequirementCoverage,
  type RequirementStanding,
  type RequirementState,
  type RequirementTask,
  type RequirementWaitingKind,
} from '@forge/contracts/requirements';
import type { WaitingOn } from '@forge/contracts/standing';
import type { RequirementStatus, RevisionState } from '../db/schema-requirements.js';
import { addWorkingDays } from '../lib/working-days.js';

/** Untouched this long, an open requirement is listed as stuck. */
export const STUCK_AFTER_DAYS = 21;
const DAY_MS = 86_400_000;

export interface StandingRevision {
  revision: number;
  state: RevisionState;
  authorId: string;
  authorName: string | null;
  authorKind: 'human' | 'agent';
  createdAt: Date;
  proposedAt: Date | null;
  decidedAt: Date | null;
}

export interface StandingCriterion {
  id: string;
  code: string;
  body: string;
  sinceRevision: number;
  retiredRevision: number | null;
}

export interface StandingIssue {
  id: string;
  displayId: string;
  title: string;
  status: string;
  /** The status's tone on this project; awaiting_release is amber only where a release needs approval. */
  tone: IssueStatusTone;
  updatedAt: Date;
  /** When it last moved to closed; null while it is not closed. */
  closedAt: Date | null;
  /** Its plan was written against another revision than the current one. */
  changedSincePlan: boolean;
}

export interface StandingIssueCriterion {
  issueId: string;
  n: number;
  requirementCriterionId: string;
  verdict: CoverageIssue['verdict'];
  verdictAt: Date | null;
}

export interface StandingInput {
  status: RequirementStatus;
  owner: RequirementStanding['owner'];
  /** Null for a reader with no person behind it; nothing then reads as theirs. */
  viewer: { userId: string; canSignOff: boolean } | null;
  revisions: readonly StandingRevision[];
  currentRevision: number | null;
  criteria: readonly StandingCriterion[];
  issues: readonly StandingIssue[];
  issueCriteria: readonly StandingIssueCriterion[];
  /** Kinds of the suggestions still `proposed` on this requirement. */
  openSuggestionKinds: readonly string[];
  /** Linked designs the latest baseline leaves unpinned or pins below their approved revision. */
  stalePins: readonly { flow: string; pinned: number | null; approved: number }[];
  staleContractPins: readonly { contract: string; pinned: string | null; current: string }[];
  feedback: { open: number; untriaged: readonly string[] };
  /** When the current revision was first agreed: its first baseline. */
  agreedAt: Date | null;
  updatedAt: Date;
  now: Date;
}

/** The input with its delivery phase read (`deliveryOf`). */
type Phased = StandingInput & { phase: DeliveryPhase | null };

const SIGNER = 'BA or owner';

export function stateOf(status: RequirementStatus, phase: DeliveryPhase | null): RequirementState {
  if (status !== 'agreed') return status;
  return phase === 'in_delivery' || phase === 'delivered' ? phase : 'agreed';
}

const wordingsAt = (criteria: readonly StandingCriterion[], revision: number) =>
  criteria
    .filter(
      (c) =>
        c.sinceRevision <= revision && (c.retiredRevision === null || c.retiredRevision > revision),
    )
    .sort((a, b) => Number(a.code.slice(3)) - Number(b.code.slice(3)));

// cm:why a business criterion is proven by the issue criteria that trace to it
// (issue_criteria.requirement_criterion_id, ISS-55). Only links to the wording live at the shown
// revision count as proof; a link to an earlier wording of the same code is stale evidence. Over
// the live links: any latest verdict `fail` → failing; every one `pass` or `short` → passing;
// otherwise (none yet, or `skipped`) → not judged. No live link but an earlier one → stale; no link
// at all → gap. A dropped issue proves nothing and is left out.
export function coverageOf(
  input: StandingInput,
  shownRevision: number | null,
): RequirementCoverage[] {
  if (shownRevision === null) return [];
  const live = wordingsAt(input.criteria, shownRevision);
  const byId = new Map(input.criteria.map((c) => [c.id, c]));
  const issues = new Map(
    input.issues.filter((i) => i.status !== 'dropped').map((i) => [i.id, i] as const),
  );
  return live.map((bc) => {
    const links = input.issueCriteria.flatMap((ic) => {
      const wording = byId.get(ic.requirementCriterionId);
      const issue = issues.get(ic.issueId);
      if (!wording || wording.code !== bc.code || !issue) return [];
      return [
        {
          issueId: issue.id,
          displayId: issue.displayId,
          title: issue.title,
          status: issue.status,
          tone: issue.tone,
          criterion: ic.n,
          verdict: ic.verdict,
          stale: wording.id !== bc.id,
        } satisfies CoverageIssue,
      ];
    });
    return { code: bc.code, body: bc.body, verdict: verdictOf(links), issues: links };
  });
}

function verdictOf(links: readonly CoverageIssue[]): BcVerdict {
  if (links.length === 0) return 'gap';
  const current = links.filter((l) => !l.stale);
  if (current.length === 0) return 'stale';
  if (current.some((l) => l.verdict === 'fail')) return 'failing';
  if (current.every((l) => l.verdict === 'pass' || l.verdict === 'short')) return 'passing';
  return 'not_judged';
}

type RequirementWaitingOn = WaitingOn<RequirementWaitingKind>;

const wait = (
  kind: RequirementWaitingKind,
  who: string,
  act: string,
  rule: string,
): RequirementWaitingOn => ({ kind, who, act, rule, ref: null, dueAt: null });

const signerWait = (viewer: StandingInput['viewer'], act: string, rule: string) =>
  viewer?.canSignOff
    ? { group: 'needs_you' as const, waitingOn: wait('you', 'You', act, rule) }
    : { group: 'waiting' as const, waitingOn: wait('person', SIGNER, act, rule) };

interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: RequirementWaitingOn;
}

function feedbackTurn(input: StandingInput): Turn | null {
  const untriaged = input.feedback.untriaged;
  if (untriaged.length === 0) return null;
  return signerWait(
    input.viewer,
    untriaged.length === 1 ? `triage ${untriaged[0]}` : `triage ${untriaged.length} feedback items`,
    `feedback about it waits on a person to pick its route: ${untriaged.join(', ')}`,
  );
}

// cm:why whose turn it is, first rule wins: 1. dropped or deferred → nobody (ISS-85), accepted →
// done unless feedback waits on triage; 2. a proposed revision → a signer; 3. a draft revision →
// its author; 4. a draft requirement → a signer agrees it; 4b. untriaged feedback → a signer
// triages it (ISS-79); 5. a design approved past the pin → a signer re-pins it (ISS-86); 6. every
// issue closed and every BC proven → the BA's check task, a BC unproven → the master proves it; 7. an open
// breakdown → a signer; 8. an issue planned on an earlier revision or baseline → the master
// re-plans it; 9. no issue → the master breaks it down; 10. only drafts → a person promotes them;
// 11. else moving. Unless it needs you: no owner, or untouched STUCK_AFTER_DAYS → stuck.
function turnOf(
  input: Phased,
  live: readonly StandingIssue[],
  coverage: readonly RequirementCoverage[],
): Turn {
  const { status, viewer } = input;
  if (status === 'accepted' || status === 'dropped') {
    const triage = status === 'accepted' ? feedbackTurn(input) : null;
    return (
      triage ?? {
        group: 'done',
        waitingOn: wait('none', '—', '', `the requirement is ${status}`),
      }
    );
  }
  if (status === 'deferred') {
    return {
      group: 'deferred',
      waitingOn: wait('none', '—', '', 'deferred out of the current release; it waits on nobody'),
    };
  }
  const proposed = input.revisions.find((r) => r.state === 'proposed');
  if (proposed) {
    return signerWait(
      viewer,
      `accept r${proposed.revision}`,
      'a proposed revision waits on a sign-off',
    );
  }
  const draft = input.revisions.find((r) => r.state === 'draft');
  if (draft) {
    const rule = 'an open draft revision waits on its author to propose it';
    if (viewer && draft.authorId === viewer.userId) {
      return {
        group: 'needs_you',
        waitingOn: wait('you', 'You', `propose r${draft.revision}`, rule),
      };
    }
    const kind = draft.authorKind === 'agent' ? 'agent' : 'person';
    return {
      group: 'waiting',
      waitingOn: wait(kind, draft.authorName ?? 'Its author', 'finish draft', rule),
    };
  }
  if (status === 'draft') {
    const head = input.currentRevision;
    return signerWait(
      viewer,
      head === null ? 'agree it' : `agree r${head}`,
      'a current revision not yet agreed waits on a sign-off',
    );
  }
  const triage = feedbackTurn(input);
  if (triage) return triage;
  if (input.stalePins.length > 0 || input.staleContractPins.length > 0) {
    const act = `re-pin ${[
      ...input.stalePins.map((p) => `${p.flow} r${p.approved}`),
      ...input.staleContractPins.map((p) => `${p.contract}@${p.current}`),
    ].join(', ')}`;
    const rule =
      'a linked design is unpinned or approved past the revision the agreed baseline pins, or a linked contract has a current version it does not pin';
    if (viewer?.canSignOff) return { group: 'needs_you', waitingOn: wait('you', 'You', act, rule) };
    const owner = input.owner?.kind === 'human' ? input.owner.name : null;
    return { group: 'waiting', waitingOn: wait('person', owner ?? SIGNER, act, rule) };
  }
  const check = checkTaskOf(input, live);
  if (check) {
    const act = `check ${coverage.map((c) => c.code).join(', ')} against the traceability matrix, ${check.overdue ? 'overdue since' : 'due'} ${check.dueAt.slice(0, 10)}`;
    const rule = `delivered at r${check.revision}; the BA checks the business criteria by ${check.dueAt.slice(0, 10)}, ${CHECK_SLA_WORKING_DAYS} working days after delivery${check.overdue ? ', and it is overdue' : ''}`;
    return viewer?.canSignOff
      ? { group: 'needs_you', waitingOn: { ...wait('you', 'You', act, rule), dueAt: check.dueAt } }
      : { group: 'waiting', waitingOn: { ...wait('person', 'BA', act, rule), dueAt: check.dueAt } };
  }
  const unproven = coverage.filter((c) => c.verdict !== 'passing').map((c) => c.code);
  if (live.length > 0 && live.every((i) => i.status === 'closed') && unproven.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        'Master',
        `prove ${unproven.join(', ')}`,
        'every linked issue is closed, but these BCs hold no passing traced verdict, so it is not delivered',
      ),
    };
  }
  if (input.openSuggestionKinds.includes('breakdown')) {
    return signerWait(viewer, 'approve breakdown', 'a breakdown suggestion waits on a person');
  }
  const replan = live.filter((i) => i.changedSincePlan);
  if (replan.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        'Master',
        `re-plan ${replan.map((i) => i.displayId).join(', ')}`,
        `planned against an earlier revision than r${input.currentRevision ?? '?'} (REQUIREMENT_CHANGED_SINCE_PLAN)`,
      ),
    };
  }
  if (live.length === 0) {
    const task = breakdownTaskOf(input, live);
    return {
      group: 'waiting',
      waitingOn: {
        ...wait(
          'agent',
          'Master',
          task
            ? `break down, ${task.overdue ? 'overdue since' : 'due'} ${task.dueAt.slice(0, 10)}`
            : 'break down',
          task
            ? `agreed with no linked issue; the breakdown is due ${task.dueAt.slice(0, 10)}, ${BREAKDOWN_SLA_WORKING_DAYS} working days after the agree`
            : 'agreed with no linked issue',
        ),
        dueAt: task?.dueAt ?? null,
      },
    };
  }
  if (live.every((i) => i.status === 'draft')) {
    return signerWait(
      viewer,
      `promote ${live.length} draft issue${live.length === 1 ? '' : 's'}`,
      'its only live issues are drafts, which nothing works until a person promotes them',
    );
  }
  const running = live.filter((i) => i.status === 'in_progress').length;
  const done = live.filter((i) => i.status === 'closed').length;
  return {
    group: 'moving',
    waitingOn: wait(
      'issue',
      'Issues',
      running > 0 ? `Running ${running} of ${live.length}` : `Done ${done} of ${live.length}`,
      'agreed and its issues are being worked',
    ),
  };
}

const taskOf = (
  kind: RequirementTask['kind'],
  owner: RequirementTask['owner'],
  revision: number,
  openedAt: Date,
  days: number,
  now: Date,
): RequirementTask => {
  const due = addWorkingDays(openedAt, days);
  return {
    kind,
    owner,
    revision,
    openedAt: openedAt.toISOString(),
    dueAt: due.toISOString(),
    overdue: now.getTime() > due.getTime(),
  };
};

// workflow requirement-to-delivery step `breakdown`: the project master proposes the breakdown of
// an agreed revision within 2 working days; the task is open while the revision has no live issue
// and no open breakdown suggestion
export function breakdownTaskOf(
  input: StandingInput,
  live: readonly StandingIssue[],
): RequirementTask | null {
  if (input.status !== 'agreed' || input.currentRevision === null || !input.agreedAt) return null;
  if (live.length > 0 || input.openSuggestionKinds.includes('breakdown')) return null;
  return taskOf(
    'breakdown',
    'Project master',
    input.currentRevision,
    input.agreedAt,
    BREAKDOWN_SLA_WORKING_DAYS,
    input.now,
  );
}

// workflow requirement-to-delivery step `check`: a requirement delivered at its current revision holds
// one acceptance check for that revision, owned by the BA and due 5 working days after the evidence
// completed (the last live issue closed, or the newest passing traced verdict). `input.phase` is
// `deliveryOf`'s, so the task is read from the same computation as delivered
export function checkTaskOf(
  input: Phased,
  live: readonly StandingIssue[],
): RequirementTask | null {
  if (input.status !== 'agreed' || input.phase !== 'delivered') return null;
  if (input.currentRevision === null || live.length === 0) return null;
  const ids = new Set(live.map((i) => i.id));
  const times = [
    ...live.map((i) => i.closedAt ?? i.updatedAt),
    ...input.issueCriteria
      .filter((c) => ids.has(c.issueId) && c.verdict === 'pass')
      .flatMap((c) => (c.verdictAt ? [c.verdictAt] : [])),
  ];
  const openedAt = new Date(Math.max(...times.map((t) => t.getTime())));
  return taskOf('check', 'BA', input.currentRevision, openedAt, CHECK_SLA_WORKING_DAYS, input.now);
}

export function touchedAt(input: StandingInput): Date {
  const times = [
    input.updatedAt,
    ...input.revisions.flatMap((r) => [r.createdAt, r.proposedAt, r.decidedAt]),
    ...input.issues.map((i) => i.updatedAt),
  ].filter((t): t is Date => t !== null);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

// workflow requirement-to-delivery step `rollup`, the one computation of the delivery phase: only an
// agreed or accepted requirement has one; no live issue → agreed; every live issue closed AND every
// current BC covered by a passing verdict → delivered, a closed set with an unproven BC → in_delivery;
// a live issue past draft and open → in_delivery; else agreed
export function deliveryOf(
  status: RequirementStatus,
  live: readonly StandingIssue[],
  coverage: readonly RequirementCoverage[],
): RequirementDelivery {
  const started = live.filter((i) => i.status !== 'draft' && i.status !== 'open').length;
  const closed = live.filter((i) => i.status === 'closed').length;
  const proven = coverage.every((c) => c.verdict === 'passing');
  let phase: DeliveryPhase | null = null;
  if (status === 'agreed' || status === 'accepted') {
    if (live.length === 0) phase = 'agreed';
    else if (closed === live.length) phase = proven ? 'delivered' : 'in_delivery';
    else phase = started > 0 ? 'in_delivery' : 'agreed';
  }
  return {
    phase,
    liveIssues: live.length,
    startedIssues: started,
    closedIssues: closed,
    criteriaCoverage: {
      criteria: coverage.length,
      passing: coverage.filter((c) => c.verdict === 'passing').length,
      judged: coverage.filter((c) => c.verdict === 'passing' || c.verdict === 'failing').length,
    },
  };
}

export function deriveStanding(raw: StandingInput): RequirementStanding {
  const live = raw.issues.filter((i) => i.status !== 'dropped');
  const shownRevision = raw.currentRevision ?? raw.revisions[0]?.revision ?? null;
  const coverage = coverageOf(raw, shownRevision);
  const delivery = deliveryOf(raw.status, live, coverage);
  const input = { ...raw, phase: delivery.phase };
  const touched = touchedAt(input);
  let { group, waitingOn } = turnOf(input, live, coverage);
  if (group !== 'needs_you' && group !== 'done' && group !== 'deferred') {
    if (input.owner === null) {
      group = 'stuck';
      waitingOn = wait('none', 'No owner', 'assign one', 'no owner is set');
    } else if (input.now.getTime() - touched.getTime() >= STUCK_AFTER_DAYS * DAY_MS) {
      group = 'stuck';
      waitingOn = { ...waitingOn, rule: `untouched for ${STUCK_AFTER_DAYS} days or more` };
    }
  }
  return {
    state: stateOf(input.status, input.phase),
    delivery,
    attentionGroup: group,
    waitingOn,
    facts: {
      passing: coverage.filter((c) => c.verdict === 'passing').length,
      judged: coverage.filter((c) => c.verdict === 'passing' || c.verdict === 'failing').length,
      criteria: coverage.length,
      issuesDone: live.filter((i) => i.status === 'closed').length,
      issuesRunning: live.filter((i) => i.status === 'in_progress').length,
      issuesTotal: live.length,
      proposedRevision: input.revisions.find((r) => r.state === 'proposed')?.revision ?? null,
      draftRevision: input.revisions.find((r) => r.state === 'draft')?.revision ?? null,
      stalePins: [...input.stalePins],
      staleContractPins: [...input.staleContractPins],
      feedbackOpen: input.feedback.open,
      feedbackUntriaged: input.feedback.untriaged.length,
    },
    tasks: [breakdownTaskOf(input, live), checkTaskOf(input, live)].filter(
      (t): t is RequirementTask => t !== null,
    ),
    shownRevision,
    coverage,
    owner: input.owner,
    touchedAt: touched.toISOString(),
  };
}
