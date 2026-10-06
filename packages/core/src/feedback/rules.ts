/**
 * The guards of feedback as pure functions over what the service read: workflows
 * `feedback-lifecycle`, `feedback-triage` r4 and requirement-to-delivery (`triage`, `route`). The phase a reader sees is the read model's (`standing.ts:phaseOf`).
 */

import type {
  FeedbackKind,
  FeedbackPhase,
  FeedbackRefusal,
  FeedbackRefusalCode,
  FeedbackStatus,
  FeedbackTriage,
  FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import type { SuggestionKind } from '@forge/contracts/suggestions';
import type { NodeRef } from '@forge/contracts/workflow-health';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

export type { FeedbackRefusal } from '@forge/contracts/feedback';

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

/** What a retarget is checked against: the item as it stands and the target it asks for. */
export interface RetargetFacts {
  key: string;
  /** The target it has, as a reader names it (REQ-3, ISS-12, a version, a flow, the screen text). */
  current: { type: string; key: string; node: string | null };
  next: { type: string; key: string; node: string | null };
  /** Set when core filed the item against a provider's contract version (E3). */
  contract: string | null;
  redacted: boolean;
  /** On an item routed as a revision: the requirement its suggestion revises, and the one the new target is about. */
  revision: { revises: string | null; nextRequirement: string | null } | null;
}

// ISS-264: a target is corrected at any phase, so an item filed about a screen moves to the
// requirement that later records its rule; what it can never be moved off or onto is named
export function retargetRefusal(f: RetargetFacts): FeedbackRefusal | null {
  if (f.contract) {
    return refusal(
      'FEEDBACK_TARGET_CORE_FILED',
      '',
      `${f.key} was filed by core about contract version ${f.contract}, and its deadline is that version's; it is not moved. Decline it, or file a new item about the target you mean.`,
    );
  }
  const same =
    f.current.type === f.next.type &&
    f.current.key === f.next.key &&
    f.current.node === f.next.node;
  if (same) {
    return refusal(
      'FEEDBACK_TARGET_UNCHANGED',
      `/${f.next.type}`,
      `${f.key} is already about ${f.next.type} ${f.next.key}${f.next.node ? ` (${f.next.node})` : ''}; name the target it should move to.`,
    );
  }
  if (f.next.type === 'screen' && f.redacted) {
    return refusal(
      'FEEDBACK_ALREADY_REDACTED',
      '/screen',
      `${f.key}'s reporter data was deleted, and a screen named in words is reporter data; retarget it to a requirement, issue, release or workflow instead.`,
    );
  }
  if (f.revision && f.revision.revises !== f.revision.nextRequirement) {
    return refusal(
      'FEEDBACK_ROUTE_TARGET_MISMATCH',
      `/${f.next.type}`,
      `${f.key} is routed as a revision of ${f.revision.revises ?? 'no requirement'}, and ${f.next.type} ${f.next.key} is about ${f.revision.nextRequirement ?? 'no requirement'}; retarget it to that requirement or one of its issues.`,
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

// the reporter is asked only about a resolved item (FEEDBACK_NOT_RESOLVED), and never by themselves
// (FEEDBACK_VERIFY_ASK_SELF): the reporter verifies their own item directly
export function verifyAskRefusal(
  phase: FeedbackPhase,
  askerIsReporter: boolean,
): FeedbackRefusal | null {
  if (phase !== 'resolved') {
    return refusal(
      'FEEDBACK_NOT_RESOLVED',
      '/status',
      `the item reads ${phase}; the reporter is asked to verify it only once its linked work shipped (resolved).`,
    );
  }
  if (askerIsReporter) {
    return refusal(
      'FEEDBACK_VERIFY_ASK_SELF',
      '',
      'you reported this item; verify it (POST .../verify) or reopen it (POST .../reopen) instead of asking yourself.',
    );
  }
  return null;
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

/** The reporter verifies or reopens their own item; anyone else does it with feedback.approve. */
export function personalActRefusal(
  facts: PermissionFacts,
  act: 'verified' | 'reopened',
  actorIsReporter: boolean,
): FeedbackRefusal | null {
  if (actorIsReporter) return null;
  return decideActRefusal(facts, act === 'verified' ? 'verifying feedback' : 'reopening feedback');
}

/** Deleting reporter data (UC15). */
export const redactActRefusal = (facts: PermissionFacts) =>
  permissionRefusal(facts, 'feedback.redact', "deleting a reporter's data");

interface PromoteFacts {
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

const CARRIERS: Record<FeedbackTriageRoute, readonly (keyof FeedbackTriage)[]> = {
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

/** Which carrier fields a triage named. */
export const carriersNamed = (w: FeedbackTriage) =>
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

// step triage (feedback-triage r4 `decide`): the route is written in the triage act, so the triage
// names what carries it; an issue route naming neither carrier files a draft, a decline carries its reason
export function routeShapeRefusal(t: FeedbackTriage): FeedbackRefusal | null {
  const named = carriersNamed(t);
  const fit = carrierFitRefusal(t.route, named);
  if (fit) return fit;
  if (t.route === 'decline') {
    return t.note?.trim()
      ? null
      : refusal(
          'FEEDBACK_DECLINE_REASON_REQUIRED',
          '/note',
          'a declined item says why in `note`; the reporter reads the reason.',
        );
  }
  if (named.length === 1 || t.route === 'issue') return null;
  if (t.route === 'answer') {
    return refusal(
      'FEEDBACK_ANSWER_MISSING',
      '/answer',
      'route answer carries the answer the reporter reads.',
    );
  }
  const own = CARRIERS[t.route] as readonly string[];
  return refusal(
    'FEEDBACK_ROUTE_INCOMPLETE',
    `/${own[0]}`,
    `route ${t.route} is written in the triage act; name what carries it with ${own.map((k) => `\`${k}\``).join(' or ')}.`,
  );
}

export interface RouteFacts {
  kind: FeedbackKind;
  /** The requirement the item is about: its target, or the target issue's requirement. */
  targetRequirement: { id: string; key: string; status: string } | null;
  suggestion: { kind: SuggestionKind; requirementId: string | null } | null;
  routedRequirement: { key: string; status: string } | null;
}

// step triage: a person picks the route and no rule keyed on kind picks it, except that a contract
// change takes the issue route (FEEDBACK_ROUTE_TARGET_MISMATCH); the route must also fit the target
export function routeRuleRefusal(
  route: FeedbackTriageRoute,
  f: RouteFacts,
): FeedbackRefusal | null {
  if (f.kind === 'contract_change' && route !== 'issue' && route !== 'decline') {
    return refusal(
      'FEEDBACK_ROUTE_TARGET_MISMATCH',
      '/route',
      `contract change feedback routes to the consumer's upgrade issue, not ${route}.`,
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

/**
 * A contract change routed to an issue writes its wait there (requirement-to-delivery `triage`): a
 * finished issue is dispatched no more, and one already waiting on the contract keeps its own wait
 * and deadline, so the route is refused by name rather than folded into the wait it holds.
 */
export function upgradeTargetRefusal(
  issue: { key: string; status: string },
  held: { id: string; minVersion: string; contractSlug: string } | null,
): FeedbackRefusal | null {
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status)) {
    return {
      code: 'CONTRACT_WAIT_ISSUE_FINISHED',
      path: '/issue',
      detail: `${issue.key} is ${issue.status}; a contract change is carried by an issue that will still be dispatched, so it waits on the version and its deadline. Name a live issue or file a new one.`,
    };
  }
  if (held) {
    return {
      code: 'CONTRACT_WAIT_DUPLICATE',
      path: '/issue',
      detail: `${issue.key} already waits on ${held.contractSlug} >= ${held.minVersion} (wait ${held.id}); retract that wait first so this change's version and deadline are written, or file a new issue for it.`,
    };
  }
  return null;
}
