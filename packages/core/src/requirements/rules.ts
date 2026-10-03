/**
 * The guards of workflow `requirement-lifecycle` rev 3, as pure functions over what the service
 * read: who may sign a requirement off, which revision may move where, what an agree pins, and how
 * a revision's criteria list becomes rows with stable BC codes. Every refusal is named; the service
 * answers it with nothing written.
 */

import type { ProjectMemberRole } from '../db/schema.js';
import type { CriterionForm, RequirementStatus, RevisionState } from '../db/schema-requirements.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { projectRoleAtLeast } from '../lib/authz.js';

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
  | 'REQUIREMENT_ISSUE_LINKED_ELSEWHERE'
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
  if (facts.agency !== 'human') {
    return {
      code: 'REQUIREMENT_SIGNOFF_FORBIDDEN',
      path: '',
      detail: `${facts.userId} acts as an agent; ${act} is signed by a person, this project's BA or owner. An agent drafts and proposes a revision and leaves the sign-off to them.`,
    };
  }
  if (!projectRoleAtLeast(facts.role, 'member')) {
    return {
      code: 'REQUIREMENT_SIGNOFF_FORBIDDEN',
      path: '',
      detail: `${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; ${act} is signed by a person of this project (member or above).`,
    };
  }
  return null;
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
// and every linked design approved, each one named (REQUIREMENT_DESIGN_UNAPPROVED, Q10)
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
  const unapproved = input.designs.filter(
    (d) => d.designStatus !== 'approved' || d.approvedRevision === null,
  );
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

/** Linking an issue reads an agreed requirement: a draft or dropped one has nothing to deliver. */
export function linkIssueRefusal(status: RequirementStatus): RequirementRefusal | null {
  if (status === 'agreed' || status === 'accepted') return null;
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
 * and a live code the list leaves out is retired.
 */
export function planCriteria(
  input: readonly CriterionInput[],
  live: readonly LiveCriterion[],
  highestCodeEver: number,
): { ok: true; plan: CriteriaPlan } | { ok: false; refusals: RequirementRefusal[] } {
  const refusals: RequirementRefusal[] = [];
  const byCode = new Map(live.map((c) => [c.code, c]));
  const seen = new Set<string>();
  const plan: CriteriaPlan = { keep: [], retire: [], insert: [] };
  let next = highestCodeEver;
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
    if (!prior) {
      refusals.push({
        code: 'CRITERION_CODE_UNKNOWN',
        path: `/criteria/${i}/code`,
        detail: `${c.code} is not a live criterion of the revision this one is based on (${[...byCode.keys()].join(', ') || 'none'}); a new criterion names no code and is given the next one.`,
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

// cm:why the flag is read, never stored: an issue's plan names the revision it was written against,
// and the requirement has changed since when its head is another (REQUIREMENT_CHANGED_SINCE_PLAN)
export function changedSincePlan(input: {
  plan: string | null;
  plannedRevision: number | null;
  currentRevision: number | null;
}): boolean {
  if (!input.plan?.trim()) return false;
  return input.plannedRevision !== input.currentRevision;
}
