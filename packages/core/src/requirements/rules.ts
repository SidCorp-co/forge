/**
 * The guards of workflow `requirement-lifecycle` rev 3, as pure functions over what the service
 * read: who may sign a requirement off, which revision may move where, what an agree pins, and the
 * BC codes a criteria list keeps or takes. Every refusal is named; the service answers it with
 * nothing written.
 */

import {
  type BaselineReadiness,
  DEFERRABLE_STATUSES,
  type RequirementReadinessGate,
} from '@forge/contracts/requirements';
import type { ProjectMemberRole } from '../db/schema.js';
import type { CriterionForm, RequirementStatus, RevisionState } from '../db/schema-requirements.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { personActRefusal } from '../lib/person-act.js';

export type RequirementRefusalCode =
  | 'REQUIREMENT_SIGNOFF_FORBIDDEN'
  | 'REQUIREMENT_REVISION_STALE'
  | 'REQUIREMENT_REVISION_NOT_CURRENT'
  | 'REQUIREMENT_REVISION_NOT_DRAFT'
  | 'REQUIREMENT_REVISION_NOT_PROPOSED'
  | 'REQUIREMENT_REVISION_OPEN'
  | 'REQUIREMENT_DESIGN_UNAPPROVED'
  | 'REQUIREMENT_NOT_AGREED'
  | 'REQUIREMENT_ALREADY_AGREED'
  | 'REQUIREMENT_NOT_READY'
  | 'REQUIREMENT_ISSUE_LINKED_ELSEWHERE'
  | 'REQUIREMENT_NO_PLAN_TO_ADOPT'
  | 'REQUIREMENT_DEFERRED'
  | 'REQUIREMENT_DEFER_REASON_REQUIRED'
  | 'REQUIREMENT_NOT_DEFERRABLE'
  | 'REQUIREMENT_NOT_DEFERRED'
  | 'REQUIREMENT_HAS_LIVE_ISSUES'
  | 'REQUIREMENT_PINS_CURRENT'
  | 'REVISION_REASON_REQUIRED'
  | 'CRITERION_CODE_UNKNOWN'
  | 'CRITERION_CODE_DUPLICATE'
  | 'CRITERION_SCENARIO_UNPARSEABLE';

export interface RequirementRefusal {
  code: RequirementRefusalCode;
  path: string;
  detail: string;
}

export interface SignerFacts {
  userId: string;
  agency: ActorAgency;
  role: ProjectMemberRole | null;
}

// cm:guard accept, return and agree are a person's acts on this project (S0 agency): an agent, a
// master or another project's account drafts and proposes, never signs off (REQUIREMENT_SIGNOFF_FORBIDDEN)
export function signoffRefusal(
  facts: SignerFacts,
  projectId: string,
  act: string,
): RequirementRefusal | null {
  return personActRefusal(facts, projectId, act, 'REQUIREMENT_SIGNOFF_FORBIDDEN');
}

export function reasonRefusal(reason: string | null | undefined): RequirementRefusal | null {
  if (reason?.trim()) return null;
  return {
    code: 'REVISION_REASON_REQUIRED',
    path: '/reason',
    detail: 'a revision carries why it was written, so its reviewer and every later reader know.',
  };
}

/** A revision may be written only while no other revision of the requirement is open. */
export function openRevisionRefusal(
  open: { revision: number; state: RevisionState } | null,
): RequirementRefusal | null {
  if (!open) return null;
  return {
    code: 'REQUIREMENT_REVISION_OPEN',
    path: '/baseRevision',
    detail: `revision ${open.revision} is ${open.state}; a requirement has one open revision at a time. Edit or propose that one, or have it accepted or returned first.`,
  };
}

/** The base a new or proposed revision names must still be the head. */
export function staleBaseRefusal(
  base: number | null,
  head: number | null,
  path = '/baseRevision',
): RequirementRefusal | null {
  if (base === head) return null;
  return {
    code: 'REQUIREMENT_REVISION_STALE',
    path,
    detail: `the revision is based on ${base === null ? 'no revision' : `revision ${base}`}, but the head is ${head === null ? 'none yet' : `revision ${head}`}; read the head and write against it.`,
  };
}

export function stateRefusal(
  revision: number,
  state: RevisionState,
  want: 'draft' | 'proposed',
): RequirementRefusal | null {
  if (state === want) return null;
  return want === 'draft'
    ? {
        code: 'REQUIREMENT_REVISION_NOT_DRAFT',
        path: '/revision',
        detail: `revision ${revision} is ${state}; only a draft is edited or proposed. Write a new revision to change what it says.`,
      }
    : {
        code: 'REQUIREMENT_REVISION_NOT_PROPOSED',
        path: '/revision',
        detail: `revision ${revision} is ${state}; only a proposed revision is accepted or returned.`,
      };
}

export interface LinkedDesign {
  workflowId: string;
  flow: string;
  designStatus: string | null;
  approvedRevision: number | null;
}

// cm:guard an agree reads the current head and pins only current revisions: the named revision must
// be the head (REQUIREMENT_REVISION_STALE), the head must be current (REQUIREMENT_REVISION_NOT_CURRENT),
// and every linked design must hold an approved revision, each one named (REQUIREMENT_DESIGN_UNAPPROVED, Q10)
// cm:guard the pin is the design's approved revision, as the build gate reads it; a newer revision only
// proposed does not unapprove the one already approved (HOP REQ-1 accept refused while rev 5 was proposed)
export function agreeRefusals(input: {
  status: RequirementStatus;
  named: number;
  head: number | null;
  headState: RevisionState | null;
  designs: readonly LinkedDesign[];
  /** true when re-baselining a revision accepted after agreed; false for draft → agreed. */
  rebaseline: boolean;
}): RequirementRefusal[] {
  const out: RequirementRefusal[] = [];
  if (!input.rebaseline && input.status !== 'draft') {
    out.push({
      code: 'REQUIREMENT_ALREADY_AGREED',
      path: '/revision',
      detail: `the requirement is ${input.status}; a change after the agree is a new revision, and accepting it re-baselines.`,
    });
    return out;
  }
  if (input.head === null || input.headState !== 'current') {
    out.push({
      code: 'REQUIREMENT_REVISION_NOT_CURRENT',
      path: '/revision',
      detail:
        input.head === null
          ? 'the requirement has no current revision yet; a person accepts a proposed revision before it can be agreed.'
          : `revision ${input.head} is ${input.headState ?? 'unknown'}, not current; only a current revision is pinned in a baseline.`,
    });
  } else if (input.named !== input.head) {
    out.push(staleBaseRefusal(input.named, input.head, '/revision') as RequirementRefusal);
  }
  const unapproved = input.designs.filter((d) => d.approvedRevision === null);
  if (unapproved.length > 0) {
    out.push({
      code: 'REQUIREMENT_DESIGN_UNAPPROVED',
      path: '/workflows',
      detail: `every linked design is approved before the agree pins it; not approved: ${unapproved
        .map((d) => `"${d.flow}" (${d.workflowId}, ${d.designStatus ?? 'no design lifecycle'})`)
        .join(', ')}.`,
    });
  }
  return out;
}

export interface ReadinessAtHead {
  suggestionId: string;
  failed: string[];
}

export function baselineReadiness(
  gate: RequirementReadinessGate,
  read: ReadinessAtHead | null,
): BaselineReadiness | null {
  if (gate === 'off') return null;
  return {
    gate,
    suggestionId: read?.suggestionId ?? null,
    ready: read !== null && read.failed.length === 0,
    failed: read?.failed ?? [],
  };
}

// cm:guard at `requirements.readinessGate: block` an agree needs an accepted readiness result at the
// head with every check passing; one missing or failing is refused by name (REQUIREMENT_NOT_READY)
export function readinessRefusal(
  recorded: BaselineReadiness | null,
  head: number | null,
): RequirementRefusal | null {
  if (recorded?.gate !== 'block' || recorded.ready) return null;
  return {
    code: 'REQUIREMENT_NOT_READY',
    path: '/revision',
    detail:
      recorded.suggestionId === null
        ? `this project's requirements.readinessGate is block, and revision ${head ?? '(none)'} has no accepted readiness result; accept a readiness suggestion on it first.`
        : `this project's requirements.readinessGate is block, and the readiness result at revision ${head ?? '(none)'} (suggestion ${recorded.suggestionId}) failed: ${recorded.failed.join(', ')}.`,
  };
}

/** Linking an issue reads an agreed requirement: a draft or dropped one has nothing to deliver. */
export function linkIssueRefusal(status: RequirementStatus): RequirementRefusal | null {
  if (status === 'agreed' || status === 'accepted') return null;
  if (status === 'deferred') return deferredRefusal(status, 'linking an issue', '/issue');
  return {
    code: 'REQUIREMENT_NOT_AGREED',
    path: '/issue',
    detail: `the requirement is ${status}; an issue links to a requirement once a person has agreed it.`,
  };
}

// cm:why scenario form is optional per project (Q12); when chosen, the body must read as
// Given … When … Then, each keyword starting a line, or it is refused rather than stored unparsed
export function scenarioParses(body: string): boolean {
  const starts = body.split('\n').map((l) => l.trim().split(/\s+/)[0]?.toLowerCase() ?? '');
  const g = starts.indexOf('given');
  const w = starts.indexOf('when');
  const t = starts.indexOf('then');
  return g !== -1 && w > g && t > w;
}

export interface CriterionInput {
  code?: string | undefined;
  body: string;
  form?: CriterionForm | undefined;
}

export interface LiveCriterion {
  id: string;
  code: string;
  body: string;
  form: CriterionForm;
}

export interface CriteriaPlan {
  /** Rows of the base revision this revision keeps unchanged. */
  keep: string[];
  /** Rows of the base revision this revision retires (reworded or removed). */
  retire: string[];
  /** New wordings, each under a stable code: a reworded code keeps its code, a new one takes the next. */
  insert: { code: string; body: string; form: CriterionForm }[];
}

const codeNumber = (code: string) => Number(code.slice(3));

/**
 * How a revision's criteria list becomes rows: a criterion naming a live code keeps it (unchanged,
 * or retired and re-worded under the same code), one naming no code takes the next code never used,
 * and a live code the list leaves out is retired. `ownCodes` are the codes a draft being rewritten
 * gave its new criteria on its earlier write; naming one keeps that code (FB-59).
 */
export function planCriteria(
  input: readonly CriterionInput[],
  live: readonly LiveCriterion[],
  highestCodeEver: number,
  ownCodes: ReadonlySet<string> = new Set(),
): { ok: true; plan: CriteriaPlan } | { ok: false; refusals: RequirementRefusal[] } {
  const refusals: RequirementRefusal[] = [];
  const byCode = new Map(live.map((c) => [c.code, c]));
  const seen = new Set<string>();
  const plan: CriteriaPlan = { keep: [], retire: [], insert: [] };
  const kept = input
    .map((c) => c.code)
    .filter(
      (code): code is string => code !== undefined && ownCodes.has(code) && !byCode.has(code),
    );
  let next = Math.max(highestCodeEver, ...kept.map(codeNumber));
  input.forEach((c, i) => {
    const form = c.form ?? 'statement';
    const body = c.body.trim();
    if (form === 'scenario' && !scenarioParses(body)) {
      refusals.push({
        code: 'CRITERION_SCENARIO_UNPARSEABLE',
        path: `/criteria/${i}/body`,
        detail:
          'a scenario criterion reads Given …, When …, Then …, each keyword starting a line, in that order; write it as a statement otherwise.',
      });
    }
    if (c.code === undefined) {
      next += 1;
      plan.insert.push({ code: `BC-${next}`, body, form });
      return;
    }
    if (seen.has(c.code)) {
      refusals.push({
        code: 'CRITERION_CODE_DUPLICATE',
        path: `/criteria/${i}/code`,
        detail: `${c.code} appears twice; a code names one criterion.`,
      });
      return;
    }
    seen.add(c.code);
    const prior = byCode.get(c.code);
    if (!prior && ownCodes.has(c.code)) {
      plan.insert.push({ code: c.code, body, form });
      return;
    }
    if (!prior) {
      const known = [...byCode.keys(), ...ownCodes].filter((k, n, all) => all.indexOf(k) === n);
      refusals.push({
        code: 'CRITERION_CODE_UNKNOWN',
        path: `/criteria/${i}/code`,
        detail: `${c.code} is neither a live criterion of the revision this one is based on nor one this draft holds (${known.sort((a, b) => codeNumber(a) - codeNumber(b)).join(', ') || 'none'}); a new criterion names no code and is given the next one.`,
      });
      return;
    }
    if (prior.body === body && prior.form === form) {
      plan.keep.push(prior.id);
    } else {
      plan.retire.push(prior.id);
      plan.insert.push({ code: c.code, body, form });
    }
  });
  for (const c of live) if (!seen.has(c.code)) plan.retire.push(c.id);
  if (refusals.length) return { ok: false, refusals };
  plan.insert.sort((a, b) => codeNumber(a.code) - codeNumber(b.code));
  return { ok: true, plan };
}

// cm:why the flag is read, never stored: an issue's plan names the revision and the baseline it was
// written against, and the requirement has changed since when its head is another revision, or
// when that revision was re-pinned onto newly approved designs after the plan (ISS-86)
export function changedSincePlan(input: {
  plan: string | null;
  plannedRevision: number | null;
  currentRevision: number | null;
  plannedBaselineSeq?: number | null | undefined;
  latestBaselineSeq?: number | null | undefined;
}): boolean {
  if (!input.plan?.trim()) return false;
  if (input.plannedRevision !== input.currentRevision) return true;
  return (input.latestBaselineSeq ?? 1) > (input.plannedBaselineSeq ?? 1);
}

export interface BaselinePin {
  workflowId: string;
  designRevision: number;
}

export interface PinPosition {
  flow: string;
  pinned: number | null;
  approved: number | null;
}

// cm:why the one detector of a pin that has fallen behind (D14, ISS-86): the standing reads it to
// say "re-pin" and the re-pin act reads it to refuse when nothing moved, so the two cannot disagree
export function stalePinsOf(
  positions: readonly PinPosition[],
): { flow: string; pinned: number; approved: number }[] {
  return positions.flatMap((p) =>
    p.approved !== null && p.pinned !== null && p.approved > p.pinned
      ? [{ flow: p.flow, pinned: p.pinned, approved: p.approved }]
      : [],
  );
}

// cm:guard a re-pin writes a baseline of the head with no text revision (ISS-86): an agreed
// requirement (an accepted one is delivered, and a draft has nothing to move), the head named and
// current, every linked design approved (the agree's own guards), and at least one design approved
// past what the latest baseline pins, else REQUIREMENT_PINS_CURRENT
export function repinRefusals(input: {
  status: RequirementStatus;
  named: number;
  head: number | null;
  headState: RevisionState | null;
  designs: readonly LinkedDesign[];
  pins: readonly BaselinePin[] | null;
  mockupsMoved?: boolean;
}): RequirementRefusal[] {
  const deferred = deferredRefusal(input.status, 're-pinning it', '/revision');
  if (deferred) return [deferred];
  if (input.status !== 'agreed') {
    return [
      {
        code: 'REQUIREMENT_NOT_AGREED',
        path: '/revision',
        detail: `the requirement is ${input.status}; a re-pin moves the baseline of an agreed requirement, so a draft is agreed first and an accepted one is delivered.`,
      },
    ];
  }
  const guards = agreeRefusals({ ...input, rebaseline: true });
  if (guards.length) return guards;
  if (input.pins === null) {
    return [
      {
        code: 'REQUIREMENT_NOT_AGREED',
        path: '/revision',
        detail: `revision ${input.named} has no baseline to re-pin; accepting it re-baselines.`,
      },
    ];
  }
  const pins = input.pins;
  const positions = input.designs.flatMap((d) => {
    const pin = pins.find((p) => p.workflowId === d.workflowId);
    return pin ? [{ flow: d.flow, pinned: pin.designRevision, approved: d.approvedRevision }] : [];
  });
  if (stalePinsOf(positions).length === 0 && !input.mockupsMoved) {
    return [
      {
        code: 'REQUIREMENT_PINS_CURRENT',
        path: '/revision',
        detail: `the latest baseline of revision ${input.named} already pins every linked design at its approved revision and every accepted mockup; there is nothing to re-pin.`,
      },
    ];
  }
  return [];
}

// cm:guard a deferred requirement is out of the current release: nothing is signed off, agreed,
// re-pinned or linked to it until a person undefers it (REQUIREMENT_DEFERRED, ISS-85)
export function deferredRefusal(
  status: RequirementStatus,
  act: string,
  path = '',
): RequirementRefusal | null {
  if (status !== 'deferred') return null;
  return {
    code: 'REQUIREMENT_DEFERRED',
    path,
    detail: `the requirement is deferred out of the current release, so ${act} waits; a person undefers it first.`,
  };
}

// cm:guard a defer is a person's act with a reason, from draft or agreed only, and never while a
// linked issue is in work: those are dropped, unlinked or left at draft first, each one named
export function deferRefusals(input: {
  status: RequirementStatus;
  reason: string | null | undefined;
  workingIssues: readonly string[];
}): RequirementRefusal[] {
  const out: RequirementRefusal[] = [];
  const deferred = deferredRefusal(input.status, 'deferring it again');
  if (deferred) return [deferred];
  if (!(DEFERRABLE_STATUSES as readonly string[]).includes(input.status)) {
    out.push({
      code: 'REQUIREMENT_NOT_DEFERRABLE',
      path: '',
      detail: `the requirement is ${input.status}; only a draft or agreed requirement is deferred out of the current release.`,
    });
  }
  if (!input.reason?.trim()) {
    out.push({
      code: 'REQUIREMENT_DEFER_REASON_REQUIRED',
      path: '/reason',
      detail:
        'a deferred requirement says why it left the current release, so nobody re-proposes it.',
    });
  }
  if (input.workingIssues.length) {
    out.push({
      code: 'REQUIREMENT_HAS_LIVE_ISSUES',
      path: '',
      detail: `linked issues are past draft and not closed: ${input.workingIssues.join(', ')}; drop or unlink them, or leave them at draft, before the requirement leaves the release.`,
    });
  }
  return out;
}

export function undeferRefusal(status: RequirementStatus): RequirementRefusal | null {
  if (status === 'deferred') return null;
  return {
    code: 'REQUIREMENT_NOT_DEFERRED',
    path: '',
    detail: `the requirement is ${status}, not deferred; only a deferred requirement is undeferred.`,
  };
}
