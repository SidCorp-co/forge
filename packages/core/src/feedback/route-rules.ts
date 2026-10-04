/**
 * The rules of triage and the case's route write (workflow requirement-to-delivery steps `triage`,
 * `fb-case`, `route`; feedback-triage r3 `decide`), as pure functions over what the service read.
 */

import {
  FEEDBACK_KIND_ROUTES,
  type FeedbackKind,
  type FeedbackPhase,
  type FeedbackRefusal,
  type FeedbackRefusalCode,
  type FeedbackRouteWrite,
  type FeedbackTriage,
  type FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import type { SuggestionKind } from '@forge/contracts/suggestions';

const refusal = (code: FeedbackRefusalCode, path: string, detail: string): FeedbackRefusal => ({
  code,
  path,
  detail,
});

const OPEN_FOR_TRIAGE: readonly FeedbackPhase[] = ['new', 'triaged', 'reopened'];

// cm:guard a route is picked while the item is new, reopened, or triaged with a dead carrier; a
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

// cm:guard duplicate_of names a root that is not itself a duplicate, and an item other items point
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
