import type {
  AgentReportRefusalCode,
  AgentReportTriage,
  TriageAgentReportRequest,
} from '@forge/contracts/agent-reports';
import type { Refusal } from '../lib/refusal.js';

const refusal = (code: AgentReportRefusalCode, path: string, detail: string): Refusal => ({
  code,
  path,
  detail,
});

/** What a triage rule reads about one report, its target named by key. */
export interface TriageFacts {
  id: string;
  projectId: string;
  triage: AgentReportTriage;
  triagedByName: string | null;
  triagedAt: Date | null;
  triageReason: string | null;
  duplicateOf: string | null;
  linkedIssueKey: string | null;
  feedbackKey: string | null;
}

function howTriaged(f: TriageFacts): string {
  if (f.triage === 'filed') {
    return f.feedbackKey
      ? `filed as ${f.feedbackKey} (promoted to feedback)`
      : `filed into ${f.linkedIssueKey ?? 'an issue'}`;
  }
  if (f.triage === 'duplicate') return `marked a duplicate of agent report ${f.duplicateOf}`;
  return `dismissed ("${f.triageReason ?? ''}")`;
}

// design automation rev 1 (step file; REQ-16 BC-3): a report is triaged once; a second
// file, dismiss, duplicate or promote is refused naming who triaged it, how and when, and the way
// back is an explicit reopen
export function alreadyTriagedRefusal(f: TriageFacts): Refusal | null {
  if (f.triage === 'new') return null;
  const who = f.triagedByName ?? 'nobody recorded (reviewed before triage was recorded)';
  const when = f.triagedAt ? ` at ${f.triagedAt.toISOString()}` : '';
  return refusal(
    'AGENT_REPORT_ALREADY_TRIAGED',
    '/act',
    `agent report ${f.id} was already ${howTriaged(f)} by ${who}${when}; reopen it ({ act: reopen }) before triaging it again.`,
  );
}

// step dismiss: a dismissal says why, so "not work" is never an unexplained click
function dismissReasonRefusal(reason: string | undefined): Refusal | null {
  if (reason !== undefined && reason.trim() !== '') return null;
  return refusal(
    'AGENT_REPORT_DISMISS_REASON_REQUIRED',
    '/reason',
    'dismissing an agent report needs a reason saying why it is not work, for example "already fixed in ISS-12" or "the agent misread the step".',
  );
}

// step dismiss: a duplicate points at another report of the same project, never at one
// the caller cannot see, one in another project, or itself
export function duplicateRefusal(
  f: Pick<TriageFacts, 'id' | 'projectId'>,
  duplicateOf: string,
  original: { id: string; projectId: string } | null,
): Refusal | null {
  if (original && original.projectId === f.projectId && original.id !== f.id) return null;
  const why = !original
    ? 'no such agent report exists'
    : original.id === f.id
      ? 'a report cannot be a duplicate of itself'
      : 'it was filed on another project';
  return refusal(
    'AGENT_REPORT_DUPLICATE_UNKNOWN',
    '/duplicateOf',
    `agent report ${f.id} cannot be a duplicate of ${duplicateOf}: ${why}; name an earlier report of the same project.`,
  );
}

// step dismiss: reopening returns a triaged report to new; one that is new already has
// nothing to reopen, and a promoted one keeps the feedback item it became as its one target
export function reopenRefusal(f: TriageFacts): Refusal | null {
  if (f.triage === 'new') {
    return refusal(
      'AGENT_REPORT_NOT_TRIAGED',
      '/act',
      `agent report ${f.id} is new already; there is no triage to reopen.`,
    );
  }
  if (f.feedbackKey) {
    return refusal(
      'AGENT_REPORT_PROMOTED',
      '/act',
      `agent report ${f.id} was promoted into ${f.feedbackKey}, which is its one target; triage ${f.feedbackKey} instead. A promoted report cannot be reopened.`,
    );
  }
  return null;
}

/** Every rule one act owes one report, before anything is written. */
export function triageRefusals(
  f: TriageFacts,
  act: TriageAgentReportRequest,
  original: { id: string; projectId: string } | null,
): Refusal[] {
  const found: (Refusal | null)[] = [];
  if (act.act === 'reopen') found.push(reopenRefusal(f));
  else found.push(alreadyTriagedRefusal(f));
  if (act.act === 'dismiss') found.push(dismissReasonRefusal(act.reason));
  if (act.act === 'duplicate') found.push(duplicateRefusal(f, act.duplicateOf, original));
  return found.filter((r): r is Refusal => r !== null);
}

/** Is this report one a bulk act by signal moves, or one it leaves as it stands? */
export function bulkMoves(f: TriageFacts, act: TriageAgentReportRequest): boolean {
  if (act.act === 'reopen') return f.triage !== 'new' && f.feedbackKey === null;
  if (act.act === 'duplicate' && f.id === act.duplicateOf) return false;
  return f.triage === 'new';
}

// ISS-113: a filed report has exactly one target, so the issue it was filed into is not
// deleted out from under it; reopening the report first is the way to delete that issue
export function filedIntoIssueRefusal(issueKey: string, reportIds: readonly string[]): Refusal {
  return refusal(
    'AGENT_REPORT_FILED_INTO_ISSUE',
    '',
    `${issueKey} carries ${reportIds.length} filed agent report(s) (${reportIds.join(', ')}); deleting it would leave each with no target. Reopen them ({ act: reopen }) first.`,
  );
}

/** Where a triage by signal reaches: one named project, or every project the caller can write. */
export interface SignalReach {
  signalKey: string;
  scope: 'project' | 'all';
  projectId: string | null;
  act: TriageAgentReportRequest;
}

export function signalTriageRefusal(t: SignalReach): Refusal | null {
  if (t.scope === 'project' && !t.projectId) {
    return refusal(
      'AGENT_REPORT_BULK_PROJECT_REQUIRED',
      '/projectId',
      `a triage of signal ${t.signalKey} in one project names that project; pass projectId, or scope: all for every project you can write.`,
    );
  }
  if (t.scope === 'all' && t.act.act === 'file' && t.act.createIssue) {
    return refusal(
      'AGENT_REPORT_BULK_CREATE_ACROSS_PROJECTS',
      '/triage/createIssue',
      'createIssue files into one project, so a scope: all triage names an existing issue instead.',
    );
  }
  return null;
}

export function noWritableProjectRefusal(signalKey: string): Refusal {
  return refusal(
    'AGENT_REPORT_NO_WRITABLE_PROJECT',
    '/scope',
    `a scope: all triage of signal ${signalKey} reaches no project: you can write to none that holds agent reports.`,
  );
}
