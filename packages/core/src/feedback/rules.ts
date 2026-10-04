/**
 * The guards of workflows `feedback-lifecycle` rev 2 and `feedback-triage` rev 2, as pure functions
 * over what the service read, and the phase a reader sees: `planned` and `resolved` are read from
 * the linked work, never stored (Q1), and nothing here ever reads an item as verified on its own.
 * Who may act is `actMiss` against a declared rule (`lib/person-act.ts`).
 */

import {
  FEEDBACK_CASE_OWNER_LABELS,
  type FeedbackAttention,
  type FeedbackCaseView,
  type FeedbackPhase,
  type FeedbackRefusal,
  type FeedbackRefusalCode,
  type FeedbackRoute,
  type FeedbackStatus,
  type FeedbackTriageRoute,
  type FeedbackWaiting,
} from '@forge/contracts/feedback';
import type { SuggestionStatus } from '@forge/contracts/suggestions';
import type { NodeRef } from '@forge/contracts/workflow-health';
import {
  type ActorFacts,
  type ActRule,
  actMiss,
  PERSON_ACT,
  PERSON_ADMIN_ACT,
  PROJECT_MEMBER_WRITE,
} from '../lib/person-act.js';

export type { FeedbackRefusal, FeedbackRefusalCode } from '@forge/contracts/feedback';

const refusal = (code: FeedbackRefusalCode, path: string, detail: string): FeedbackRefusal => ({
  code,
  path,
  detail,
});

/** What the linked work reads, for the phase of a triaged item. */
export interface PhaseFacts {
  status: FeedbackStatus;
  route: FeedbackRoute | null;
  routedIssueStatus: string | null;
  suggestion: { status: SuggestionStatus; revisionLive: boolean; delivered: boolean } | null;
  routedRequirementStatus: string | null;
  /** The routed requirement reads delivered (requirement_delivery) or was accepted. */
  routedRequirementDelivered: boolean;
  rootPhase: FeedbackPhase | null;
}

// cm:guard planned and resolved are computed on read from the linked work (Q1); a route whose
// carrier died (issue dropped, suggestion rejected, requirement dropped) reads triaged, so a person
// routes it again. verified is only ever the stored decision of a person
export function phaseOf(f: PhaseFacts): FeedbackPhase {
  if (f.status !== 'triaged') return f.status;
  switch (f.route) {
    case 'issue':
      if (f.routedIssueStatus === 'closed') return 'resolved';
      return f.routedIssueStatus === 'dropped' ? 'triaged' : 'planned';
    case 'revision':
      if (!f.suggestion) return 'triaged';
      if (f.suggestion.status === 'accepted') {
        return f.suggestion.revisionLive && f.suggestion.delivered ? 'resolved' : 'planned';
      }
      return f.suggestion.status === 'proposed' ? 'planned' : 'triaged';
    // cm:guard workflow feedback-lifecycle edge planned → resolved: the linked requirement reads
    // delivered; agreeing it only plans the work, so an agreed requirement keeps the item planned
    case 'new_requirement':
      if (f.routedRequirementDelivered) return 'resolved';
      return f.routedRequirementStatus === 'dropped' ? 'triaged' : 'planned';
    case 'answer':
      return 'resolved';
    case 'duplicate':
      if (f.rootPhase === 'resolved' || f.rootPhase === 'verified') return 'resolved';
      return f.rootPhase === 'declined' ? 'declined' : 'planned';
    default:
      return 'triaged';
  }
}

// cm:guard a text search over content the viewer may not read is refused by name: matching titles
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

/** Who a row waits on for this viewer: a member triages, the reporter verifies. */
export function attentionOf(phase: FeedbackPhase, viewerIsReporter: boolean): FeedbackAttention {
  if (phase === 'new' || phase === 'triaged' || phase === 'reopened') return 'you';
  if (phase === 'planned') return 'moving';
  if (phase === 'resolved') return viewerIsReporter ? 'you' : 'others';
  return 'done';
}

const ROUTE_ACTS: Record<FeedbackTriageRoute, string> = {
  issue: 'create or link the issue',
  revision: 'name the revision proposal',
  new_requirement: 'start the draft requirement',
  answer: 'write the answer',
  duplicate: 'name the root',
  decline: 'decline it',
};

// step fb-case: a triaged item whose route is not written waits on its case's owner by name, by its
// due; a written route whose carrier died reads triaged with no open case, so a person routes it again
function caseWaiting(c: FeedbackCaseView | null): FeedbackWaiting {
  if (!c || c.routedAt !== null) {
    return { kind: 'person', who: 'A person', act: 'route it again: its route carries nothing' };
  }
  const due = `${c.overdue ? 'overdue since' : 'due'} ${c.dueAt.slice(0, 10)}`;
  return {
    kind: c.owner === 'master' ? 'agent' : 'person',
    who: FEEDBACK_CASE_OWNER_LABELS[c.owner],
    act: `${ROUTE_ACTS[c.route]}, ${due}`,
  };
}

/** Who or what an item waits on, whoever reads it: the "Waiting on" cell's name and act. */
export function waitingOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carrier: string | null,
  reporter: string,
  kase: FeedbackCaseView | null = null,
): FeedbackWaiting {
  switch (phase) {
    case 'new':
    case 'reopened':
      return { kind: 'person', who: 'A person', act: 'triage it' };
    case 'triaged':
      return caseWaiting(kase);
    case 'planned':
      if (route === 'issue')
        return { kind: 'issue', who: carrier ?? 'The linked issue', act: 'ship' };
      if (route === 'revision')
        return { kind: 'person', who: 'The revision proposal', act: 'be accepted and delivered' };
      if (route === 'new_requirement')
        return {
          kind: 'issue',
          who: carrier ?? 'The new requirement',
          act: 'be agreed and delivered',
        };
      if (route === 'duplicate')
        return { kind: 'issue', who: `Its root ${carrier ?? ''}`.trim(), act: 'be resolved' };
      return { kind: 'issue', who: 'The linked work', act: '' };
    case 'resolved':
      return { kind: 'person', who: reporter, act: 'verify the fix' };
    default:
      return { kind: 'none', who: 'Nothing', act: '' };
  }
}

/** The same fact as one sentence, for a reader without the cell: "ISS-12 to ship". */
export function waitingOnOf(
  phase: FeedbackPhase,
  route: FeedbackRoute | null,
  carrier: string | null,
  reporter: string,
  kase: FeedbackCaseView | null = null,
): string {
  const w = waitingOf(phase, route, carrier, reporter, kase);
  return w.act ? `${w.who} to ${w.act}` : w.who;
}

/** The cell for one viewer: when it is their turn it names them. */
export function waitingFor(w: FeedbackWaiting, attention: FeedbackAttention): FeedbackWaiting {
  return attention === 'you' ? { kind: 'you', who: 'You', act: w.act } : w;
}

export interface TargetFields {
  requirement?: string | undefined;
  issue?: string | undefined;
  release?: string | undefined;
  workflow?: string | undefined;
  screen?: string | undefined;
  node?: NodeRef | undefined;
}

// cm:guard an item is about exactly one target (FEEDBACK_TARGET_NOT_ONE): a requirement, an issue,
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

// cm:guard a decline carries the reason the reporter reads, from new, triaged or reopened
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

// cm:guard verify follows resolved and nothing else: feedback is never verified automatically, and
// never before its fix shipped (FEEDBACK_NOT_RESOLVED)
export function verifyRefusal(phase: FeedbackPhase): FeedbackRefusal | null {
  if (phase === 'resolved') return null;
  return refusal(
    'FEEDBACK_NOT_RESOLVED',
    '/status',
    `the item reads ${phase}; it is verified only once its linked work shipped (resolved), and only by a person.`,
  );
}

// cm:guard a reopen follows resolved and carries the reporter's reason (FEEDBACK_REOPEN_REASON_REQUIRED)
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

// cm:guard the BA assistant asks one clarification per item, before it is routed (Q5)
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

function actRefusal(
  facts: ActorFacts,
  rule: ActRule,
  code: FeedbackRefusalCode,
  act: string,
  standing: string,
): FeedbackRefusal | null {
  const miss = actMiss(facts, rule);
  if (!miss) return null;
  return refusal(
    code,
    '',
    miss.kind === 'agent-not-allowed'
      ? `${facts.userId} acts as an agent; ${act} is a person's act. An agent or the BA assistant proposes it as a feedback_triage suggestion, and a person accepts.`
      : `${facts.userId} holds ${facts.role ?? 'no role'} on this project; ${act} needs ${standing}.`,
  );
}

/** Picking a route, declining, marking a duplicate: a person of the project (member or above). */
export const decideActRefusal = (facts: ActorFacts, act: string) =>
  actRefusal(
    facts,
    PERSON_ACT,
    'FEEDBACK_DECIDE_FORBIDDEN',
    act,
    'a person of the project (member or above)',
  );

/** Writing the route of a case: any member of the project, person or agent; the owner is whom it waits on. */
export const routeWriteActRefusal = (facts: ActorFacts) =>
  actRefusal(
    facts,
    PROJECT_MEMBER_WRITE,
    'FEEDBACK_ROUTE_WRITE_FORBIDDEN',
    "writing a feedback case's route",
    'a member of the project',
  );

/** Verifying or reopening: the reporter or a BA naming them, so a person of the project. */
export const verifyActRefusal = (facts: ActorFacts, act: string) =>
  actRefusal(
    facts,
    PERSON_ACT,
    'FEEDBACK_VERIFY_FORBIDDEN',
    act,
    'the reporter or a BA, a person of the project',
  );

/** Deleting reporter data (UC15): a project admin person. */
export const redactActRefusal = (facts: ActorFacts) =>
  actRefusal(
    facts,
    PERSON_ADMIN_ACT,
    'FEEDBACK_REDACT_FORBIDDEN',
    "deleting a reporter's data",
    'a project admin person',
  );

export interface PromoteFacts {
  reportId: string;
  reportProject: string;
  project: string;
  feedbackKey: string | null;
  linkedIssueKey: string | null;
}

// cm:guard ISS-93: an agent report becomes feedback once, in its own project, and only while
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
