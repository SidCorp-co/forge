/**
 * Where a requirement stands, derived from what was read and nothing else: the attention group the
 * list puts it under, whom it waits on and for what, the facts the list's secondary line prints,
 * and each business criterion's coverage by issue verdicts. Pure, so every rule below is a unit
 * test; `standing-read.ts` gathers the facts.
 */

import type { IssueStatusTone } from '@forge/contracts/issue-vocabulary';
import type { PolicyQaMode } from '@forge/contracts/project-config';
import {
  type BcVerdict,
  BREAKDOWN_SLA_WORKING_DAYS,
  CHECK_SLA_WORKING_DAYS,
  type CoverageIssue,
  criteriaCoverageOf,
  type DeliveryPhase,
  draftIssuesToPromote,
  type RequirementAttentionGroup,
  type RequirementCoverage,
  type RequirementDelivery,
  type RequirementStanding,
  type RequirementState,
  type RequirementWaitingKind,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { type WaitingOn, type WaitingSays, waitingOn } from '@forge/contracts/standing';
import type { RequirementStatus } from '../db/schema-requirements.js';
import { liveAt } from './rules.js';
import { designTurn, draftTurn, type StandingRevision } from './standing-draft.js';
import { updateToApprovedAct, updateToApprovedEffect } from './standing-follow.js';
import { proofTurn } from './standing-proof.js';
import { breakdownTaskOf, checkTaskOf, replanTasksOf, tasksOf } from './standing-tasks.js';

/** Untouched this long, an open requirement is listed as stuck. */
const STUCK_AFTER_DAYS = 21;
const DAY_MS = 86_400_000;

interface StandingCriterion {
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
  /**
   * Null for a reader with no person behind it; nothing then reads as theirs. `canAdmit` is
   * issues.admit, which the promote of a draft needs beside the sign-off.
   */
  viewer: { userId: string; canSignOff: boolean; canAdmit: boolean } | null;
  revisions: readonly StandingRevision[];
  currentRevision: number | null;
  criteria: readonly StandingCriterion[];
  issues: readonly StandingIssue[];
  issueCriteria: readonly StandingIssueCriterion[];
  /** Kinds of the suggestions still `proposed` on this requirement. */
  openSuggestionKinds: readonly string[];
  /** Per BC code, why the newest accepted breakdown naming it left it uncovered. */
  uncovered?: ReadonlyMap<string, string>;
  /** Linked designs the latest baseline leaves unpinned or pins below their approved revision. */
  stalePins: readonly { flow: string; title: string; pinned: number | null; approved: number }[];
  staleContractPins: readonly { contract: string; pinned: string | null; current: string }[];
  /** Linked designs holding no approved revision, which an agree refuses (REQUIREMENT_DESIGN_UNAPPROVED). */
  unapprovedDesigns: readonly { flow: string; title: string; designStatus: string | null }[];
  feedback: { open: number; untriaged: readonly string[] };
  /** Who judges an issue's criteria: its own runs (`self`) or a judge apart from them (`independent`), the policy's `qa`; null where no policy is declared. */
  judge: PolicyQaMode | null;
  /** When the current revision was first agreed: its first baseline. */
  agreedAt: Date | null;
  updatedAt: Date;
  now: Date;
}

/** What the delivery phase and coverage read, and nothing else. */
type ProofInput = Pick<
  StandingInput,
  'status' | 'criteria' | 'issues' | 'issueCriteria' | 'uncovered'
>;

/** The input with its delivery phase read (`deliveryOf`). */
export type Phased = StandingInput & { phase: DeliveryPhase | null };

const SIGNER = say('standing.who.baOrOwner');
const ADMITTER = say('standing.who.signerAdmitter');

function stateOf(status: RequirementStatus, phase: DeliveryPhase | null): RequirementState {
  if (status !== 'agreed') return status;
  return phase === 'in_delivery' || phase === 'delivered' ? phase : 'agreed';
}

// A business criterion is proven by the issue criteria that trace to it
// (issue_criteria.requirement_criterion_id, ISS-55). Only links to the wording live at the shown
// revision count as proof; a link to an earlier wording of the same code is stale evidence. Over
// the live links: any latest verdict `fail` → failing; every one `pass` or `short` → passing;
// otherwise (none yet, or `skipped`) → not judged. No live link but an earlier one → stale; no link
// at all → gap, carrying the reason an accepted breakdown gave for leaving it uncovered. A dropped
// issue proves nothing and is left out.
function coverageOf(input: ProofInput, shownRevision: number | null): RequirementCoverage[] {
  if (shownRevision === null) return [];
  const live = liveAt(input.criteria, shownRevision);
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
          verdictAt: ic.verdictAt?.toISOString() ?? null,
          stale: wording.id !== bc.id,
        } satisfies CoverageIssue,
      ];
    });
    const verdict = verdictOf(links);
    const why = verdict === 'gap' ? (input.uncovered?.get(bc.code) ?? null) : null;
    return { code: bc.code, body: bc.body, verdict, issues: links, uncoveredReason: why };
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
  who: Said,
  act: Said,
  rule: Said,
  more: Partial<Pick<WaitingSays, 'effect'>> & { dueAt?: string | null } = {},
): RequirementWaitingOn =>
  waitingOn(
    kind,
    { who, act, rule, ...(more.effect ? { effect: more.effect } : {}) },
    { dueAt: more.dueAt ?? null },
  );

const YOU = say('standing.who.you');
const MASTER = say('standing.who.master');
const NONE = say('standing.who.dash');

const signerWait = (viewer: StandingInput['viewer'], act: Said, rule: Said) =>
  viewer?.canSignOff
    ? { group: 'needs_you' as const, waitingOn: wait('you', YOU, act, rule) }
    : { group: 'waiting' as const, waitingOn: wait('person', SIGNER, act, rule) };

interface Turn {
  group: RequirementAttentionGroup;
  waitingOn: RequirementWaitingOn;
}

function feedbackTurn(input: StandingInput): Turn | null {
  const untriaged = input.feedback.untriaged;
  if (untriaged.length === 0) return null;
  const [one] = untriaged;
  return signerWait(
    input.viewer,
    untriaged.length === 1 && one !== undefined
      ? say('standing.act.triage', { what: one })
      : say('standing.act.triageMany', { n: untriaged.length }),
    say('requirements.rule.feedbackWaits', { keys: untriaged.join(', ') }),
  );
}

// Whose turn it is, first rule wins: 1. dropped or deferred → nobody (ISS-85), accepted →
// done unless feedback waits on triage; 2. a proposed revision → a signer; 3. a draft revision →
// its author; 4. a draft requirement → a signer agrees it; 4b. untriaged feedback → a signer
// triages it (ISS-79); 5. a design approved past the pin → a signer re-pins it (ISS-86); 6. every
// issue closed and every BC proven → the BA's check task, a BC unproven → whoever owes its proof
// (`proofTurn`); 7. an open breakdown → a signer; 8. an issue planned on an earlier revision or baseline → the master
// re-plans it (its re-plan tasks); 9. no issue → the master breaks it down; 10. only drafts → a signer who can
// admit promotes them (only they are asked: question 3b8292dc);
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
        waitingOn: wait(
          'none',
          NONE,
          say('standing.act.none'),
          say('requirements.rule.ended', { status }),
        ),
      }
    );
  }
  if (status === 'deferred') {
    return {
      group: 'deferred',
      waitingOn: wait('none', NONE, say('standing.act.none'), say('requirements.rule.deferred')),
    };
  }
  const proposed = input.revisions.find((r) => r.state === 'proposed');
  if (proposed) {
    return signerWait(
      viewer,
      say('standing.act.acceptR', { r: proposed.revision }),
      say('requirements.rule.proposed'),
    );
  }
  const draft = input.revisions.find((r) => r.state === 'draft');
  if (draft) return draftTurn(draft, viewer);
  if (status === 'draft') {
    const head = input.currentRevision;
    const designs = designTurn(input.unapprovedDesigns, head);
    if (designs) return designs;
    return signerWait(
      viewer,
      head === null ? say('standing.act.agreeIt') : say('standing.act.agreeR', { r: head }),
      say('requirements.rule.unagreed'),
    );
  }
  const triage = feedbackTurn(input);
  if (triage) return triage;
  if (input.stalePins.length > 0 || input.staleContractPins.length > 0) {
    const act = updateToApprovedAct(input.stalePins, input.staleContractPins);
    const rule = say('requirements.rule.pinBehind');
    const effect = updateToApprovedEffect(input.stalePins, input.staleContractPins);
    if (viewer?.canSignOff) {
      return { group: 'needs_you', waitingOn: wait('you', YOU, act, rule, { effect }) };
    }
    const owner = input.owner?.kind === 'human' ? input.owner.name : null;
    return {
      group: 'waiting',
      waitingOn: wait(
        'person',
        owner ? say('standing.who.named', { name: owner }) : SIGNER,
        act,
        rule,
        { effect },
      ),
    };
  }
  const check = checkTaskOf(input, live);
  if (check) {
    const date = check.dueAt.slice(0, 10);
    const act = say('standing.act.check', {
      codes: coverage.map((c) => c.code).join(', '),
      when: say(check.overdue ? 'standing.overdueSince' : 'standing.due', { date }),
    });
    const rule = say('requirements.rule.check', {
      r: check.revision,
      date,
      days: CHECK_SLA_WORKING_DAYS,
      overdue: check.overdue ? say('requirements.rule.overdue') : null,
    });
    return viewer?.canSignOff
      ? { group: 'needs_you', waitingOn: wait('you', YOU, act, rule, { dueAt: check.dueAt }) }
      : {
          group: 'waiting',
          waitingOn: wait('person', say('requirements.who.ba'), act, rule, { dueAt: check.dueAt }),
        };
  }
  const proof = proofTurn(input.judge, live, coverage);
  if (proof) return proof;
  if (input.openSuggestionKinds.includes('breakdown')) {
    return signerWait(
      viewer,
      say('standing.act.reviewBreakdown'),
      say('requirements.rule.breakdownWaits'),
    );
  }
  const replan = replanTasksOf(input, live);
  if (replan.length > 0) {
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        MASTER,
        say('standing.act.replan', { keys: replan.map((t) => t.displayId).join(', ') }),
        input.currentRevision === null
          ? say('requirements.rule.replanUnknown')
          : say('requirements.rule.replan', { r: input.currentRevision }),
      ),
    };
  }
  if (live.length === 0) {
    const task = breakdownTaskOf(input, live);
    return {
      group: 'waiting',
      waitingOn: wait(
        'agent',
        MASTER,
        task
          ? say('standing.act.breakDownBy', {
              when: say(task.overdue ? 'standing.overdueSince' : 'standing.due', {
                date: task.dueAt.slice(0, 10),
              }),
            })
          : say('standing.act.breakDown'),
        task
          ? say('requirements.rule.breakdownDue', {
              date: task.dueAt.slice(0, 10),
              days: BREAKDOWN_SLA_WORKING_DAYS,
            })
          : say('requirements.rule.noIssue'),
        { dueAt: task?.dueAt ?? null },
      ),
    };
  }
  const drafts = draftIssuesToPromote(status, live);
  if (drafts.length === live.length) {
    const act =
      drafts.length === 1
        ? say('standing.act.promoteDraft')
        : say('standing.act.promoteDrafts', { n: drafts.length });
    const rule = say('requirements.rule.onlyDrafts');
    return viewer?.canSignOff && viewer.canAdmit
      ? { group: 'needs_you', waitingOn: wait('you', YOU, act, rule) }
      : { group: 'waiting', waitingOn: wait('person', ADMITTER, act, rule) };
  }
  const running = live.filter((i) => i.status === 'in_progress').length;
  const shipped = live.filter((i) => i.status === 'closed').length;
  return {
    group: 'moving',
    waitingOn: wait(
      'issue',
      say('standing.who.issues'),
      running > 0
        ? say('standing.act.running', { a: running, b: live.length })
        : say('standing.act.shippedOf', { a: shipped, b: live.length }),
      say('requirements.rule.moving'),
    ),
  };
}

function touchedAt(input: StandingInput): Date {
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
function deliveryOf(
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
    criteriaCoverage: criteriaCoverageOf(coverage),
  };
}

/** The delivery phase and BC coverage at `revision`: the one computation the standing and the accept read. */
export function deliveryAt(input: ProofInput, revision: number | null) {
  const live = input.issues.filter((i) => i.status !== 'dropped');
  const coverage = coverageOf(input, revision);
  return { live, coverage, delivery: deliveryOf(input.status, live, coverage) };
}

/** The same wait under another rule. */
const waitingOn_ = (w: RequirementWaitingOn, rule: Said): RequirementWaitingOn =>
  waitingOn(w.kind, { ...w.says, rule }, { ref: w.ref, dueAt: w.dueAt });

export function deriveStanding(raw: StandingInput): RequirementStanding {
  const shownRevision = raw.currentRevision ?? raw.revisions[0]?.revision ?? null;
  const { live, coverage, delivery } = deliveryAt(raw, shownRevision);
  const input = { ...raw, phase: delivery.phase };
  const touched = touchedAt(input);
  let { group, waitingOn } = turnOf(input, live, coverage);
  if (group !== 'needs_you' && group !== 'done' && group !== 'deferred') {
    if (input.owner === null) {
      group = 'stuck';
      waitingOn = wait(
        'none',
        say('requirements.who.noOwner'),
        say('requirements.act.assignOwner'),
        say('requirements.rule.noOwner'),
      );
    } else if (input.now.getTime() - touched.getTime() >= STUCK_AFTER_DAYS * DAY_MS) {
      group = 'stuck';
      waitingOn = waitingOn_(
        waitingOn,
        say('requirements.rule.untouched', { days: STUCK_AFTER_DAYS }),
      );
    }
  }
  return {
    state: stateOf(input.status, input.phase),
    delivery,
    attentionGroup: group,
    waitingOn,
    facts: {
      ...delivery.criteriaCoverage,
      issuesRunning: live.filter((i) => i.status === 'in_progress').length,
      issuesTotal: live.length,
      proposedRevision: input.revisions.find((r) => r.state === 'proposed')?.revision ?? null,
      draftRevision: input.revisions.find((r) => r.state === 'draft')?.revision ?? null,
      stalePins: [...input.stalePins],
      staleContractPins: [...input.staleContractPins],
      unapprovedDesigns: [...input.unapprovedDesigns],
      feedbackOpen: input.feedback.open,
      feedbackUntriaged: input.feedback.untriaged.length,
    },
    tasks: tasksOf(input, live),
    shownRevision,
    coverage,
    owner: input.owner,
    touchedAt: touched.toISOString(),
  };
}
