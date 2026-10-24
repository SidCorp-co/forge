/**
 * The guards of feedback as pure functions over what the service read: workflows
 * `feedback-lifecycle` r14, `feedback-triage` r16 and requirement-to-delivery (`triage`, `route`); the
 * triage checklist's own rules are `triage-checklist.ts`. The phase a reader sees is the read model's (`standing.ts:phaseOf`).
 */

import type {
  FeedbackKind,
  FeedbackPhase,
  FeedbackRefusal,
  FeedbackRefusalCode,
  FeedbackRoute,
  FeedbackStatus,
  FeedbackTriage,
  FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { isAgreedStatus } from '@forge/contracts/requirements';
import type { SuggestionKind } from '@forge/contracts/suggestions';
import type { NodeRef } from '@forge/contracts/workflow-health';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

export type { FeedbackRefusal } from '@forge/contracts/feedback';

export const refusal = (
  code: FeedbackRefusalCode,
  path: string,
  detail: string,
): FeedbackRefusal => ({
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
  endpoint?: string | undefined;
  mockup?: string | undefined;
  screen?: string | undefined;
  node?: NodeRef | undefined;
}

// an item is about exactly one target (FEEDBACK_TARGET_NOT_ONE): a requirement, an issue,
// a release, a workflow, a route or tool the project serves, or a screen named in words; a screen
// item stores its screen as where it was seen, so a whereSeen beside it is FEEDBACK_SCREEN_TWICE
export function targetCountRefusal(
  fields: TargetFields,
  whereSeen: string | undefined,
): FeedbackRefusal | null {
  const named = (
    ['requirement', 'issue', 'release', 'workflow', 'endpoint', 'mockup', 'screen'] as const
  ).filter((k) => fields[k] !== undefined);
  if (named.length !== 1) {
    return refusal(
      'FEEDBACK_TARGET_NOT_ONE',
      named.length ? `/${named[1]}` : '',
      named.length
        ? `an item is about one target, and this names ${named.join(' and ')}; name exactly one of requirement, issue, release, workflow, endpoint, mockup or screen.`
        : 'an item is about one target; name exactly one of requirement, issue, release, workflow, endpoint, mockup or screen.',
    );
  }
  if (named[0] === 'screen' && whereSeen?.trim()) {
    return refusal(
      'FEEDBACK_SCREEN_TWICE',
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
      `${f.key}'s reporter data was deleted, and a screen named in words is reporter data; retarget it to a requirement, issue, release, workflow, endpoint or mockup instead.`,
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

// verify follows resolved and nothing else: never before its fix shipped (FEEDBACK_NOT_RESOLVED)
export function verifyRefusal(phase: FeedbackPhase): FeedbackRefusal | null {
  if (phase === 'resolved') return null;
  return refusal(
    'FEEDBACK_NOT_RESOLVED',
    '/status',
    `the item reads ${phase}; it is verified only once its linked work shipped (resolved), by its reporter or a person on their behalf.`,
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
  openForReporter: { question: string; item: string } | null = null,
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
  // REQ-66 BC-4: one question at a time to a reporter, whichever of their items it is about
  if (openForReporter) {
    return refusal(
      'FEEDBACK_CLARIFICATION_ALREADY_OPEN',
      '',
      `question ${openForReporter.question} on ${openForReporter.item} is still open to this reporter; at most one is open per reporter. Wait for its answer.`,
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

/**
 * A redaction deletes the item's mockups (UC15), and a mockup another item is filed about would leave
 * that item's target pointing at nothing: refused, naming each mockup and each item about it.
 */
export function redactMockupTargetedRefusal(
  hits: readonly { mockup: string; feedback: string }[],
): FeedbackRefusal | null {
  if (!hits.length) return null;
  const named = hits.map((h) => `${h.mockup} is the target of ${h.feedback}`).join('; ');
  return refusal(
    'FEEDBACK_REDACT_MOCKUP_TARGETED',
    '/mockups',
    `${named}. Deleting the reporter data deletes this item's mockups; retarget those items first. Nothing was deleted.`,
  );
}

/** Picking a route, declining, marking a duplicate, verifying, reopening: approvals (ADR 0007). */
export const decideActRefusal = (facts: PermissionFacts, act: string) =>
  permissionRefusal(facts, 'feedback.approve', act);

/**
 * Anyone on the project, or the reporter, confirms a fix (owner, 2026-10-07): verifying is no longer
 * a BA act, and the decision records who and when. Saying it is not fixed stays the reporter's, or
 * a holder of feedback.approve on their behalf.
 */
export function personalActRefusal(
  facts: PermissionFacts,
  act: 'verified' | 'reopened',
  actorIsReporter: boolean,
): FeedbackRefusal | null {
  if (actorIsReporter) return null;
  if (act === 'verified') return permissionRefusal(facts, 'project.read', 'verifying feedback');
  return decideActRefusal(facts, 'reopening feedback');
}

/** Deleting reporter data (UC15). */
export const redactActRefusal = (facts: PermissionFacts) =>
  permissionRefusal(facts, 'feedback.redact', "deleting a reporter's data");

const OPEN_FOR_TRIAGE: readonly FeedbackPhase[] = ['new', 'triaged', 'reopened'];

/**
 * What a planned item's re-route moves from (REQ-66): the route it is on, and for a duplicate the
 * root it would merge into, with whether an issue carries both.
 */
export interface Replan {
  from: FeedbackRoute | null;
  root?: { key: string; sharesCarrier: boolean } | null;
}

// a route is picked while the item is new, reopened, or triaged with a dead carrier; a resolved,
// verified or declined item is FEEDBACK_STATUS_INVALID. A planned item stays with what carries it,
// with three ways out: decline (feedback-lifecycle draws `declined` from the stored `triaged`; QA of
// dev.219: FB-110 could not be dropped), a requirement route moved to the requirement that replaces
// its own (REQ-66: FB-128 on REQ-46 once REQ-73 took its place), and a merge into another open
// item one of its issues also carries (REQ-66 BC-3: FB-243 and FB-192 on ISS-609)
export function triagePhaseRefusal(
  phase: FeedbackPhase,
  route?: FeedbackTriageRoute,
  replan?: Replan,
): FeedbackRefusal | null {
  if (OPEN_FOR_TRIAGE.includes(phase)) return null;
  if (phase === 'planned') {
    if (route === 'decline') return null;
    if (route === 'new_requirement' && replan?.from === 'new_requirement') return null;
    if (route === 'duplicate' && replan?.root?.sharesCarrier) return null;
    if (route === 'duplicate' && replan?.root) {
      return refusal(
        'FEEDBACK_STATUS_INVALID',
        '/duplicateOf',
        `the item reads planned on its own issue, and no issue carrying it carries ${replan.root.key}; it merges only into an item on the same issue. Decline it with a reason instead.`,
      );
    }
  }
  return refusal(
    'FEEDBACK_STATUS_INVALID',
    '/status',
    phase === 'planned'
      ? `the item reads planned: something carries it, so a route is picked only to drop it, to move it to the requirement that replaces its own, or to merge it into an item on the same issue; use the decline route with a reason.`
      : `the item reads ${phase}; a route is picked only while it is new, reopened, or triaged with nothing carrying it.`,
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

// step triage (feedback-triage r16 `decide`): the route is written in the triage act, so the triage
// names what carries it; an issue route naming neither carrier files a draft, a decline carries its
// reason. `route` is the one the act takes: the one it sent, or the issue route of the short form
export function routeShapeRefusal(
  t: FeedbackTriage,
  route: FeedbackTriageRoute,
): FeedbackRefusal | null {
  const named = carriersNamed(t);
  const fit = carrierFitRefusal(route, named);
  if (fit) return fit;
  if (route === 'decline') {
    return t.note?.trim()
      ? null
      : refusal(
          'FEEDBACK_DECLINE_REASON_REQUIRED',
          '/note',
          'a declined item says why in `note`; the reporter reads the reason.',
        );
  }
  if (named.length === 1 || route === 'issue') return null;
  if (route === 'answer') {
    return refusal(
      'FEEDBACK_ANSWER_MISSING',
      '/answer',
      'route answer carries the answer the reporter reads.',
    );
  }
  const own = CARRIERS[route] as readonly string[];
  return refusal(
    'FEEDBACK_ROUTE_INCOMPLETE',
    `/${own[0]}`,
    `route ${route} is written in the triage act; name what carries it with ${own.map((k) => `\`${k}\``).join(' or ')}.`,
  );
}

/** What a requirement route may name: a draft it starts, or the agreed requirement that covers it (REQ-66). */
const NEW_REQUIREMENT_CARRIERS: readonly string[] = ['draft', 'agreed', 'accepted'];
const AGREED: readonly string[] = ['agreed', 'accepted'];

export interface RouteFacts {
  /** A planned item re-routed off the requirement it was on (`Replan`). */
  replan?: boolean;
  kind: FeedbackKind;
  /** The requirement the item is about: its target, or the target issue's requirement. */
  targetRequirement: { id: string; key: string; status: string } | null;
  suggestion: { kind: SuggestionKind; requirementId: string | null } | null;
  routedRequirement: { key: string; status: string } | null;
}

// Feedback triage r16 `decide`: the route must fit the answers and the target. A contract change
// takes the issue route (FEEDBACK_ROUTE_TARGET_MISMATCH), and a bug against a named criterion the
// issue route of the short form (`triage-checklist.ts:shortFormRouteRefusal`)
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
  const agreed = f.targetRequirement && isAgreedStatus(f.targetRequirement.status);
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
  if (route === 'new_requirement' && f.routedRequirement) {
    const { key, status } = f.routedRequirement;
    // a re-route moves the item to the requirement that replaces its own, which is agreed already
    const carries = f.replan ? AGREED : NEW_REQUIREMENT_CARRIERS;
    if (!carries.includes(status)) {
      return mismatch(
        '/requirement',
        f.replan
          ? `${key} is ${status}; a planned item moves only to an agreed or accepted requirement that replaces its own.`
          : `${key} is ${status}; a requirement route is carried by a draft, an agreed or an accepted requirement.`,
      );
    }
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
  path = '/issue',
): FeedbackRefusal | null {
  if ((ISSUE_TERMINAL_STATUSES as readonly string[]).includes(issue.status)) {
    return {
      code: 'CONTRACT_WAIT_ISSUE_FINISHED',
      path,
      detail: `${issue.key} is ${issue.status}; a contract change is carried by an issue that will still be dispatched, so it waits on the version and its deadline. Name a live issue or file a new one.`,
    };
  }
  if (held) {
    return {
      code: 'CONTRACT_WAIT_DUPLICATE',
      path,
      detail: `${issue.key} already waits on ${held.contractSlug} >= ${held.minVersion} (wait ${held.id}); retract that wait first so this change's version and deadline are written, or file a new issue for it.`,
    };
  }
  return null;
}
