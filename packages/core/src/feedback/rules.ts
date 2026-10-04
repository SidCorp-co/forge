/**
 * The guards of feedback as pure functions over what the service read: workflows
 * `feedback-lifecycle`, `feedback-triage` r3 and requirement-to-delivery r2 (`triage`, `fb-case`,
 * `route`). The phase a reader sees is the read model's (`standing.ts:phaseOf`).
 */

import {
  FEEDBACK_KIND_ROUTES,
  FEEDBACK_ROUTE_SLA_WORKING_DAYS,
  type FeedbackCaseOwner,
  type FeedbackKind,
  type FeedbackPhase,
  type FeedbackRefusal,
  type FeedbackRefusalCode,
  type FeedbackRoute,
  type FeedbackRouteWrite,
  type FeedbackSeverity,
  type FeedbackStatus,
  type FeedbackTriage,
  type FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import type { SuggestionKind, SuggestionStatus } from '@forge/contracts/suggestions';
import type { NodeRef } from '@forge/contracts/workflow-health';
import { addWorkingDays } from '../lib/working-days.js';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

export type { FeedbackRefusal, FeedbackRefusalCode } from '@forge/contracts/feedback';

const refusal = (code: FeedbackRefusalCode, path: string, detail: string): FeedbackRefusal => ({
  code,
  path,
  detail,
});

// a text search over content the viewer may not read is refused by name: matching titles
// would answer what the policy withholds, and dropping `q` would list every item as a match
export function searchWithheldRefusal(
  q: string | undefined,
  withheld: boolean,
): FeedbackRefusal | null {
  if (!q || !withheld) return null;
  return refusal(
    'FEEDBACK_SEARCH_WITHHELD',
    '/q',
    "this project's no_egress policy withholds feedback content from this reader, so a text search over it cannot be answered; list without `q`, filtering by phase.",
  );
}

export interface TargetFields {
  requirement?: string | undefined;
  issue?: string | undefined;
  release?: string | undefined;
  workflow?: string | undefined;
  screen?: string | undefined;
  node?: NodeRef | undefined;
}

// an item is about exactly one target (FEEDBACK_TARGET_NOT_ONE): a requirement, an issue,
// a release, a workflow, or a screen named in words
export function targetCountRefusal(
  fields: TargetFields,
  whereSeen: string | undefined,
): FeedbackRefusal | null {
  const named = (['requirement', 'issue', 'release', 'workflow', 'screen'] as const).filter(
    (k) => fields[k] !== undefined,
  );
  if (named.length !== 1) {
    return refusal(
      'FEEDBACK_TARGET_NOT_ONE',
      named.length ? `/${named[1]}` : '',
      named.length
        ? `an item is about one target, and this names ${named.join(' and ')}; name exactly one of requirement, issue, release, workflow or screen.`
        : 'an item is about one target; name exactly one of requirement, issue, release, workflow or screen.',
    );
  }
  if (named[0] === 'screen' && whereSeen?.trim()) {
    return refusal(
      'FEEDBACK_TARGET_NOT_ONE',
      '/whereSeen',
      'an item about a screen names it in `screen`, which is where it was seen; send one of them, not both.',
    );
  }
  return null;
}

// a decline carries the reason the reporter reads, from new, triaged or reopened
export function declineRefusal(
  status: FeedbackStatus,
  reason: string | undefined,
): FeedbackRefusal | null {
  if (!reason?.trim()) {
    return refusal(
      'FEEDBACK_DECLINE_REASON_REQUIRED',
      '/reason',
      'a declined item says why; the reporter reads the reason.',
    );
  }
  if (status === 'verified' || status === 'declined') {
    return refusal(
      'FEEDBACK_STATUS_INVALID',
      '/status',
      `the item is ${status}; only a new, triaged or reopened item is declined.`,
    );
  }
  return null;
}

// verify follows resolved and nothing else: feedback is never verified automatically, and
// never before its fix shipped (FEEDBACK_NOT_RESOLVED)
export function verifyRefusal(phase: FeedbackPhase): FeedbackRefusal | null {
  if (phase === 'resolved') return null;
  return refusal(
    'FEEDBACK_NOT_RESOLVED',
    '/status',
    `the item reads ${phase}; it is verified only once its linked work shipped (resolved), and only by a person.`,
  );
}

// a reopen follows resolved and carries the reporter's reason (FEEDBACK_REOPEN_REASON_REQUIRED)
export function reopenRefusal(
  phase: FeedbackPhase,
  reason: string | undefined,
): FeedbackRefusal | null {
  if (!reason?.trim()) {
    return refusal(
      'FEEDBACK_REOPEN_REASON_REQUIRED',
      '/reason',
      'a reopen says what the fix does not answer.',
    );
  }
  if (phase !== 'resolved') {
    return refusal(
      'FEEDBACK_NOT_RESOLVED',
      '/status',
      `the item reads ${phase}; only a resolved item is reopened.`,
    );
  }
  return null;
}

// the BA assistant asks one clarification per item, before it is routed (Q5)
export function clarificationRefusal(
  phase: FeedbackPhase,
  openQuestionId: string | null,
): FeedbackRefusal | null {
  if (phase !== 'new' && phase !== 'reopened') {
    return refusal(
      'FEEDBACK_CLARIFICATION_CLOSED',
      '/status',
      `the item reads ${phase}; a clarification is asked before it is routed.`,
    );
  }
  if (openQuestionId) {
    return refusal(
      'FEEDBACK_CLARIFICATION_ALREADY_OPEN',
      '',
      `question ${openQuestionId} is still open on this item; at most one is open per item. Wait for its answer.`,
    );
  }
  return null;
}

export function redactedRefusal(redactedAt: Date | null): FeedbackRefusal | null {
  if (!redactedAt) return null;
  return refusal(
    'FEEDBACK_ALREADY_REDACTED',
    '',
    `its reporter data was deleted at ${redactedAt.toISOString()}; nothing is left to delete.`,
  );
}

/** Picking a route, declining, marking a duplicate, verifying, reopening: approvals (ADR 0007). */
export const decideActRefusal = (facts: PermissionFacts, act: string) =>
  permissionRefusal(facts, 'feedback.approve', act);

export const verifyActRefusal = decideActRefusal;

/** Deleting reporter data (UC15). */
export const redactActRefusal = (facts: PermissionFacts) =>
  permissionRefusal(facts, 'feedback.redact', "deleting a reporter's data");

export interface PromoteFacts {
  reportId: string;
  reportProject: string;
  project: string;
  feedbackKey: string | null;
  linkedIssueKey: string | null;
}

// ISS-93: an agent report becomes feedback once, in its own project, and only while
// nothing else carries it: a second promotion is FEEDBACK_SOURCE_ALREADY_PROMOTED naming the item it
// became, another project FEEDBACK_SOURCE_NOT_IN_PROJECT (each project's data policy holds its own
// text), a report already curated into an issue FEEDBACK_SOURCE_ROUTED_ELSEWHERE
export function promoteRefusal(f: PromoteFacts): FeedbackRefusal | null {
  const report = `agent report ${f.reportId}`;
  if (f.reportProject !== f.project) {
    return refusal(
      'FEEDBACK_SOURCE_NOT_IN_PROJECT',
      '/agentReport',
      `${report} was filed on project ${f.reportProject}, not ${f.project}; promote it there. A report's text stays under the data policy of the project it was filed on, so it is never copied into another project's feedback.`,
    );
  }
  if (f.feedbackKey) {
    return refusal(
      'FEEDBACK_SOURCE_ALREADY_PROMOTED',
      '/agentReport',
      `${report} already became ${f.feedbackKey}; open ${f.feedbackKey} instead of filing it twice.`,
    );
  }
  if (f.linkedIssueKey) {
    return refusal(
      'FEEDBACK_SOURCE_ROUTED_ELSEWHERE',
      '/agentReport',
      `${report} was already curated into ${f.linkedIssueKey}; one report has one route. Track it on ${f.linkedIssueKey}, or file feedback of your own that links it.`,
    );
  }
  return null;
}

const OPEN_FOR_TRIAGE: readonly FeedbackPhase[] = ['new', 'triaged', 'reopened'];

// a route is picked while the item is new, reopened, or triaged with a dead carrier; a
// planned, resolved, verified or declined item is FEEDBACK_STATUS_INVALID
export function triagePhaseRefusal(phase: FeedbackPhase): FeedbackRefusal | null {
  if (OPEN_FOR_TRIAGE.includes(phase)) return null;
  return refusal(
    'FEEDBACK_STATUS_INVALID',
    '/status',
    `the item reads ${phase}; a route is picked only while it is new, reopened, or triaged with nothing carrying it.`,
  );
}

const CARRIERS: Record<FeedbackTriageRoute, readonly (keyof FeedbackRouteWrite)[]> = {
  issue: ['issue', 'createIssue'],
  revision: ['suggestion'],
  new_requirement: ['requirement', 'title'],
  answer: ['answer'],
  duplicate: ['duplicateOf'],
  decline: [],
};
const CARRIER_FIELDS = [
  'issue',
  'createIssue',
  'suggestion',
  'requirement',
  'title',
  'answer',
  'duplicateOf',
] as const;

/** Which carrier fields a triage or a route write named. */
export const carriersNamed = (w: FeedbackRouteWrite) =>
  CARRIER_FIELDS.filter((k) => w[k] !== undefined && !(k === 'answer' && !w.answer?.trim()));

// a carrier belongs to one route: one sent for another route is refused, never ignored, and a route
// with two alternatives takes one of them
function carrierFitRefusal(
  route: FeedbackTriageRoute,
  named: readonly string[],
): FeedbackRefusal | null {
  const own = CARRIERS[route] as readonly string[];
  const stray = named.find((k) => !own.includes(k));
  if (stray) {
    return refusal(
      'FEEDBACK_ROUTE_TARGET_MISMATCH',
      `/${stray}`,
      `\`${stray}\` carries another route than ${route}; route ${route} is carried by ${own.length ? own.map((k) => `\`${k}\``).join(' or ') : 'its reason (`note`) alone'}.`,
    );
  }
  if (named.length > 1) {
    return refusal(
      'FEEDBACK_ROUTE_INCOMPLETE',
      `/${named[1]}`,
      `route ${route} takes either ${own.map((k) => `\`${k}\``).join(' or ')}, not both.`,
    );
  }
  return null;
}

// step triage: the decision names its route; what carries it may come with it or be written later
// through the case, except a duplicate, whose root is the decision, and a decline, whose reason is
export function routeShapeRefusal(t: FeedbackTriage): FeedbackRefusal | null {
  const fit = carrierFitRefusal(t.route, carriersNamed(t));
  if (fit) return fit;
  if (t.route === 'duplicate' && !t.duplicateOf) {
    return refusal(
      'FEEDBACK_ROUTE_INCOMPLETE',
      '/duplicateOf',
      'route duplicate names its root, `duplicateOf`.',
    );
  }
  if (t.route === 'decline' && !t.note?.trim()) {
    return refusal(
      'FEEDBACK_DECLINE_REASON_REQUIRED',
      '/note',
      'a declined item says why in `note`; the reporter reads the reason.',
    );
  }
  return null;
}

// step fb-case → route: the case's owner writes exactly what carries the route triage decided
export function routeWriteShapeRefusal(
  route: FeedbackTriageRoute,
  w: FeedbackRouteWrite,
): FeedbackRefusal | null {
  const named = carriersNamed(w);
  const fit = carrierFitRefusal(route, named);
  if (fit) return fit;
  if (named.length === 1) return null;
  if (route === 'answer') {
    return refusal(
      'FEEDBACK_ANSWER_MISSING',
      '/answer',
      'route answer carries the answer the reporter reads.',
    );
  }
  return refusal(
    'FEEDBACK_ROUTE_INCOMPLETE',
    '',
    `the case routes ${route}; write it with ${(CARRIERS[route] as readonly string[]).map((k) => `\`${k}\``).join(' or ')}.`,
  );
}

export interface RouteFacts {
  kind: FeedbackKind;
  /** The requirement the item is about: its target, or the target issue's requirement. */
  targetRequirement: { id: string; key: string; status: string } | null;
  suggestion: { kind: SuggestionKind; requirementId: string | null } | null;
  routedRequirement: { key: string; status: string } | null;
}

// workflow requirement-to-delivery step `triage`, the rule table: bug → issue; contract change →
// the consumer's upgrade issue; question → answer (feedback-triage r3); change request or idea → a
// revision of the agreed requirement it is about, else a new draft requirement; any kind →
// duplicate or decline (FEEDBACK_ROUTE_KIND_MISMATCH, FEEDBACK_ROUTE_TARGET_MISMATCH)
export function routeRuleRefusal(
  route: FeedbackTriageRoute,
  f: RouteFacts,
): FeedbackRefusal | null {
  const allowed = FEEDBACK_KIND_ROUTES[f.kind];
  if (!allowed.includes(route)) {
    return refusal(
      'FEEDBACK_ROUTE_KIND_MISMATCH',
      '/route',
      `${f.kind} feedback routes to ${allowed.join(', ')}, not ${route}; change its kind first if it is something else.`,
    );
  }
  const mismatch = (path: string, detail: string) =>
    refusal('FEEDBACK_ROUTE_TARGET_MISMATCH', path, detail);
  const agreed = f.targetRequirement && ['agreed', 'accepted'].includes(f.targetRequirement.status);
  if (route === 'revision' && !agreed) {
    return mismatch(
      '/route',
      f.targetRequirement
        ? `${f.targetRequirement.key} is ${f.targetRequirement.status}; a revision route changes an agreed requirement. Route it as a new requirement, or revise the draft itself.`
        : 'the item is about no requirement, so it is out of scope of every requirement: route it as a new requirement.',
    );
  }
  if (route === 'revision' && f.suggestion) {
    if (f.suggestion.kind !== 'revision_diff') {
      return mismatch(
        '/suggestion',
        `route revision is carried by a revision_diff suggestion, and this one is ${f.suggestion.kind}.`,
      );
    }
    if (f.suggestion.requirementId !== f.targetRequirement?.id) {
      return mismatch(
        '/suggestion',
        `the suggestion revises another requirement than ${f.targetRequirement?.key}, the one this item is about.`,
      );
    }
  }
  if (
    route === 'new_requirement' &&
    f.routedRequirement &&
    f.routedRequirement.status !== 'draft'
  ) {
    return mismatch(
      '/requirement',
      `${f.routedRequirement.key} is ${f.routedRequirement.status}; a new-requirement route is carried by a draft. Route an agreed requirement's change as a revision.`,
    );
  }
  return null;
}

// step fb-case: a route is written only while the item's case waits on it (FEEDBACK_CASE_NOT_OPEN)
export function caseOpenRefusal(
  c: { route: FeedbackTriageRoute; routedAt: Date | null } | null,
  phase: FeedbackPhase,
): FeedbackRefusal | null {
  if (c && c.routedAt === null && phase === 'triaged') return null;
  return refusal(
    'FEEDBACK_CASE_NOT_OPEN',
    '',
    c
      ? `the item reads ${phase} and its case's route ${c.route} was ${c.routedAt ? `written at ${c.routedAt.toISOString()}` : 'not left open'}; triage it again to open the case.`
      : `the item reads ${phase} and holds no case; triage opens one.`,
  );
}

// duplicate_of names a root that is not itself a duplicate, and an item other items point
// at never becomes a duplicate (FEEDBACK_DUPLICATE_CHAIN); an item is never its own (FEEDBACK_DUPLICATE_SELF)
export function duplicateRefusal(
  selfId: string,
  root: { id: string; key: string; duplicateOfKey: string | null },
  pointedAtBy: readonly string[],
): FeedbackRefusal | null {
  if (root.id === selfId) {
    return refusal(
      'FEEDBACK_DUPLICATE_SELF',
      '/duplicateOf',
      'an item is not a duplicate of itself.',
    );
  }
  if (root.duplicateOfKey) {
    return refusal(
      'FEEDBACK_DUPLICATE_CHAIN',
      '/duplicateOf',
      `${root.key} is itself a duplicate of ${root.duplicateOfKey}; point at the root, ${root.duplicateOfKey}.`,
    );
  }
  if (pointedAtBy.length > 0) {
    return refusal(
      'FEEDBACK_DUPLICATE_CHAIN',
      '/duplicateOf',
      `${pointedAtBy.join(', ')} ${pointedAtBy.length === 1 ? 'is a duplicate' : 'are duplicates'} of this item, so it stays a root; mark ${root.key} a duplicate of this one instead.`,
    );
  }
  return null;
}

/** An issue route is the project master's to file or link; every other route is the BA's. */
export const caseOwnerOf = (route: FeedbackTriageRoute): FeedbackCaseOwner =>
  route === 'issue' ? 'master' : 'ba';

/** The route task is due by severity; a contract change at the end of its commitment window. */
export function caseDueAt(
  item: { kind: FeedbackKind; severity: FeedbackSeverity; dueAt: Date | null },
  now: Date,
): Date {
  if (item.kind === 'contract_change' && item.dueAt) return item.dueAt;
  return addWorkingDays(now, FEEDBACK_ROUTE_SLA_WORKING_DAYS[item.severity]);
}
