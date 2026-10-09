/**
 * The guards of workflow `requirement-lifecycle` rev 8, as pure functions over what the service
 * read: whether the actor holds requirements.approve, which revision may move where, what an agree pins, and the
 * BC codes a criteria list keeps or takes. Every refusal is named; the service answers it with
 * nothing written.
 */

import type {
  BaselineReadiness,
  RequirementDedupCheck,
  RequirementReadinessGate,
  RequirementRefusalCode,
  RequirementSpec,
} from '@forge/contracts/requirements';
import type { CriterionForm, RequirementStatus, RevisionState } from '../db/schema-requirements.js';
import { refuser } from '../lib/refusal.js';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

export const refuseRequirement = refuser<RequirementRefusalCode>('REQUIREMENT_REFUSED');

export interface RequirementRefusal {
  code: RequirementRefusalCode;
  path: string;
  detail: string;
}

// Accept, return, agree, defer, link and repin are approvals (ADR 0007): whoever holds
// requirements.approve signs off, an agent or the revision's author included.
export function signoffRefusal(facts: PermissionFacts, act: string): RequirementRefusal | null {
  return permissionRefusal(facts, 'requirements.approve', act);
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

export interface LinkedContract {
  providerProjectId: string;
  /** `<project>/<contract>`. */
  contract: string;
  contractSlug: string;
  /** The newest approved version; null while none is approved, so nothing is pinned for it yet. */
  currentVersion: string | null;
}

// A requirement links a contract its project publishes or consumes (REQ-5 BC-1, BC-2); any other
// ref names nothing the project builds against.
export function contractLinkRefusal(input: {
  contract: string;
  publishes: readonly string[];
  consumes: readonly string[];
}): RequirementRefusal | null {
  if (input.publishes.includes(input.contract) || input.consumes.includes(input.contract)) {
    return null;
  }
  const known = [...input.publishes, ...input.consumes];
  return {
    code: 'REQUIREMENT_CONTRACT_UNKNOWN',
    path: '/contract',
    detail: `${input.contract} is neither published nor consumed by this project's interface (it names ${known.join(', ') || 'no contract'}); a requirement links a contract its project builds against.`,
  };
}

// An agree reads the current head and pins only current revisions: the named revision must
// be the head (REQUIREMENT_REVISION_STALE), the head must be current (REQUIREMENT_REVISION_NOT_CURRENT),
// and every linked design must hold an approved revision, each one named (REQUIREMENT_DESIGN_UNAPPROVED, Q10)
// The pin is the design's approved revision, as the build gate reads it; a newer revision only
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
  dedup: RequirementDedupCheck,
): BaselineReadiness | null {
  if (gate === 'off' && dedup.ran) return null;
  return {
    gate,
    suggestionId: read?.suggestionId ?? null,
    ready: read !== null && read.failed.length === 0,
    failed: read?.failed ?? [],
    ...(dedup.ran ? {} : { dedup }),
  };
}

// At `requirements.readinessGate: block` an agree needs an accepted readiness result at the
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

// A deferred requirement is out of the current release: nothing is signed off, agreed,
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

// Scenario form is optional per project (Q12); when chosen, the body must read as
// Given … When … Then, each keyword starting a line, or it is refused rather than stored unparsed
function scenarioParses(body: string): boolean {
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

interface CriteriaPlan {
  /** Rows of the base revision this revision keeps unchanged. */
  keep: string[];
  /** Rows of the base revision this revision retires (reworded or removed). */
  retire: string[];
  /** New wordings, each under a stable code: a reworded code keeps its code, a new one takes the next. */
  insert: { code: string; body: string; form: CriterionForm }[];
}

const codeNumber = (code: string) => Number(code.slice(3));

/** The wordings live at `revision`, in code order. */
export const liveAt = <
  T extends { code: string; sinceRevision: number; retiredRevision: number | null },
>(
  criteria: readonly T[],
  revision: number,
): T[] =>
  criteria
    .filter(
      (c) =>
        c.sinceRevision <= revision && (c.retiredRevision === null || c.retiredRevision > revision),
    )
    .sort((a, b) => codeNumber(a.code) - codeNumber(b.code));

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
      const codes = known.sort((a, b) => codeNumber(a) - codeNumber(b)).join(', ') || 'none';
      const where =
        ownCodes.size > 0
          ? 'neither a live criterion of the revision this one is based on nor one this draft holds'
          : 'not a live criterion of the revision this one is based on';
      refusals.push({
        code: 'CRITERION_CODE_UNKNOWN',
        path: `/criteria/${i}/code`,
        detail: `${c.code} is ${where} (${codes}); a new criterion carries no code: leave \`code\` out and it is given the next one when the revision is written.`,
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

interface BaselinePin {
  workflowId: string;
  designRevision: number;
}

interface PinPosition {
  flow: string;
  /** The design's own title, the name a person reads; absent, the flow slug stands in. */
  title?: string | null;
  pinned: number | null;
  approved: number | null;
}

// The one detector of a pin that has fallen behind (D14, ISS-86): the standing reads it to
// say "re-pin" and the re-pin act reads it to refuse when nothing moved, so the two cannot disagree
export function stalePinsOf(
  positions: readonly PinPosition[],
): { flow: string; title: string; pinned: number | null; approved: number }[] {
  return positions.flatMap((p) =>
    p.approved !== null && (p.pinned === null || p.approved > p.pinned)
      ? [{ flow: p.flow, title: p.title ?? p.flow, pinned: p.pinned, approved: p.approved }]
      : [],
  );
}

interface ContractPin {
  providerProjectId: string;
  contractSlug: string;
  contractVersion: string;
}

// The one detector of a contract pin behind its contract: a linked contract whose current version
// is not the one the latest baseline pins, including one approved since the agree pinned none.
export function staleContractPinsOf(
  contracts: readonly LinkedContract[],
  pins: readonly ContractPin[],
): { contract: string; pinned: string | null; current: string }[] {
  return contracts.flatMap((c) => {
    if (c.currentVersion === null) return [];
    const pin = pins.find(
      (p) => p.providerProjectId === c.providerProjectId && p.contractSlug === c.contractSlug,
    );
    return pin?.contractVersion === c.currentVersion
      ? []
      : [{ contract: c.contract, pinned: pin?.contractVersion ?? null, current: c.currentVersion }];
  });
}

// A re-pin writes a baseline of the head with no text revision (ISS-86): an agreed
// requirement (an accepted one is delivered, and a draft has nothing to move), the head named and
// current, every linked design approved (the agree's own guards), and at least one linked design
// unpinned or approved past what the latest baseline pins, else REQUIREMENT_PINS_CURRENT
export function repinRefusals(input: {
  status: RequirementStatus;
  named: number;
  head: number | null;
  headState: RevisionState | null;
  designs: readonly LinkedDesign[];
  pins: readonly BaselinePin[] | null;
  contracts: readonly LinkedContract[];
  contractPins: readonly ContractPin[];
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
  const positions = input.designs.map((d) => ({
    flow: d.flow,
    pinned: pins.find((p) => p.workflowId === d.workflowId)?.designRevision ?? null,
    approved: d.approvedRevision,
  }));
  const contractsMoved = staleContractPinsOf(input.contracts, input.contractPins).length > 0;
  if (stalePinsOf(positions).length === 0 && !contractsMoved) {
    return [
      {
        code: 'REQUIREMENT_PINS_CURRENT',
        path: '/revision',
        detail: `the latest baseline of revision ${input.named} already pins every linked design at its approved revision and every linked contract at its current version; there is nothing to re-pin.`,
      },
    ];
  }
  return [];
}

// the agree waits for every blocking question its head names that is still open
// (REQUIREMENT_OPEN_QUESTIONS, JU-6): a question no entry marks blocking, or one already answered,
// holds nothing back
export function openQuestionsRefusalOf(
  spec: RequirementSpec | null | undefined,
  open: ReadonlySet<string>,
  revision: number,
): RequirementRefusal | null {
  const standing = (spec?.openQuestions ?? []).filter(
    (q) => q.blocking && q.questionId !== undefined && open.has(q.questionId),
  );
  if (standing.length === 0) return null;
  return {
    code: 'REQUIREMENT_OPEN_QUESTIONS',
    path: '/spec/openQuestions',
    detail: `revision ${revision} leaves ${standing.length} blocking question${standing.length === 1 ? '' : 's'} open: ${standing
      .map((q) => `"${q.question}" (answered by ${q.whoAnswers})`)
      .join(
        '; ',
      )}. Answer each, or write a revision that no longer marks it blocking, before the agree.`,
  };
}
