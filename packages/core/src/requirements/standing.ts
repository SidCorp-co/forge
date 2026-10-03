/**
 * Where a requirement stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, the facts the list's secondary line prints,
 * and each business criterion's coverage by issue verdicts. Pure, so every rule below is a unit
 * test; `standing-read.ts` gathers the facts.
 */

import type {
  BcVerdict,
  CoverageIssue,
  RequirementAttentionGroup,
  RequirementCoverage,
  RequirementStanding,
  RequirementState,
  RequirementWaitingOn,
} from '@forge/contracts/requirements';
import type { DeliveryPhase, RequirementStatus, RevisionState } from '../db/schema-requirements.js';

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
  updatedAt: Date;
  /** Its plan was written against another revision than the current one. */
  changedSincePlan: boolean;
}

export interface StandingIssueCriterion {
  issueId: string;
  n: number;
  requirementCriterionId: string;
  verdict: CoverageIssue['verdict'];
}

export interface StandingInput {
  status: RequirementStatus;
  phase: DeliveryPhase | null;
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
  /** The latest baseline's design pins whose design is now approved at a newer revision. */
  stalePins: readonly { flow: string; pinned: number; approved: number }[];
  updatedAt: Date;
  now: Date;
}

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

const wait = (
  kind: RequirementWaitingOn['kind'],
  who: string,
  act: string,
  rule: string,
): RequirementWaitingOn => ({ kind, who, act, rule });

const signerWait = (viewer: StandingInput['viewer'], act: string, rule: string) =>
  viewer?.canSignOff
    ? { group: 'needs_you' as const, waitingOn: wait('you', 'You', act, rule) }
    : { group: 'others' as const, waitingOn: wait('person', SIGNER, act, rule) };

interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: RequirementWaitingOn;
}

// cm:why whose turn it is, first rule that holds wins: 1. accepted or dropped → done; 2. a proposed
// revision → a signer; 3. a draft revision → its author; 4. a draft requirement, head current → a
// signer agrees it; 5. every issue closed and every BC proven → a signer accepts the delivery, a BC
// unproven → the master proves it; 6. an open breakdown → a signer; 7. an issue planned against an
// earlier revision → the master re-plans it; 8. no issue → the master breaks it down; 9. only
// drafts → a person promotes them; 10. otherwise moving. Then, unless it needs you: no owner, or
// untouched for STUCK_AFTER_DAYS → stuck.
function turnOf(
  input: StandingInput,
  live: readonly StandingIssue[],
  coverage: readonly RequirementCoverage[],
): Turn {
  const { status, viewer } = input;
  if (status === 'accepted' || status === 'dropped') {
    return { group: 'done', waitingOn: wait('none', '—', '', `the requirement is ${status}`) };
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
      group: 'others',
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
  if (input.phase === 'delivered' && live.length > 0) {
    return signerWait(viewer, 'accept delivery', 'every linked issue is closed');
  }
  const unproven = coverage.filter((c) => c.verdict !== 'passing').map((c) => c.code);
  if (live.length > 0 && live.every((i) => i.status === 'closed') && unproven.length > 0) {
    return {
      group: 'others',
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
      group: 'others',
      waitingOn: wait(
        'agent',
        'Master',
        `re-plan ${replan.map((i) => i.displayId).join(', ')}`,
        `planned against an earlier revision than r${input.currentRevision ?? '?'} (REQUIREMENT_CHANGED_SINCE_PLAN)`,
      ),
    };
  }
  if (live.length === 0) {
    return {
      group: 'others',
      waitingOn: wait('agent', 'Master', 'break down', 'agreed with no linked issue'),
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
      'issues',
      'Issues',
      running > 0 ? `Running ${running} of ${live.length}` : `Done ${done} of ${live.length}`,
      'agreed and its issues are being worked',
    ),
  };
}

export function touchedAt(input: StandingInput): Date {
  const times = [
    input.updatedAt,
    ...input.revisions.flatMap((r) => [r.createdAt, r.proposedAt, r.decidedAt]),
    ...input.issues.map((i) => i.updatedAt),
  ].filter((t): t is Date => t !== null);
  return new Date(Math.max(...times.map((t) => t.getTime())));
}

// cm:guard workflow requirement-to-delivery step `rollup`: delivered needs every live issue closed
// AND every current BC covered by a passing verdict; the view counts issue statuses only, so a
// closed set with an unproven BC reads in_delivery here
export function provenPhase(
  phase: DeliveryPhase | null,
  coverage: readonly RequirementCoverage[],
): DeliveryPhase | null {
  if (phase !== 'delivered') return phase;
  return coverage.every((c) => c.verdict === 'passing') ? 'delivered' : 'in_delivery';
}

export function deriveStanding(raw: StandingInput): RequirementStanding {
  const live = raw.issues.filter((i) => i.status !== 'dropped');
  const shownRevision = raw.currentRevision ?? raw.revisions[0]?.revision ?? null;
  const coverage = coverageOf(raw, shownRevision);
  const input = { ...raw, phase: provenPhase(raw.phase, coverage) };
  const touched = touchedAt(input);
  let { group, waitingOn } = turnOf(input, live, coverage);
  if (group !== 'needs_you' && group !== 'done') {
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
    },
    shownRevision,
    coverage,
    owner: input.owner,
    touchedAt: touched.toISOString(),
  };
}
