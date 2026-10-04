/**
 * The guards of workflow project-onboarding rev 1 (rules `may-start`, `which-designs`,
 * `approve-guard`), as pure functions over what the service read. Who may act is a permission.
 */

import { OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import type { OnboardingRefusal } from '@forge/contracts/onboarding';
import type { ActorAgency } from '@forge/contracts/permissions';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';

export type { OnboardingRefusal };

export interface LiveJob {
  id: string;
  status: string;
  queuedAt: Date;
  dispatchedAt: Date | null;
}

const runningDetail = (job: LiveJob) =>
  `analysis job ${job.id} is ${job.status} (queued ${job.queuedAt.toISOString()}${job.dispatchedAt ? `, started ${job.dispatchedAt.toISOString()}` : ''}); one onboarding job runs per project at a time. Wait for it to finish.`;

// cm:guard one analysis job per onboarding (may-start): a second start while one runs is
// ONBOARDING_ALREADY_RUNNING naming the running job; a start over a finished onboarding is
// ONBOARDING_ALREADY_STARTED, because a fresh analysis is a re-analysis a person asks for
export function startRefusal(
  existing: { id: string; doneAt: Date | null } | null,
  live: LiveJob | null,
): OnboardingRefusal | null {
  if (live) return { code: 'ONBOARDING_ALREADY_RUNNING', path: '', detail: runningDetail(live) };
  if (!existing) return null;
  return {
    code: 'ONBOARDING_ALREADY_STARTED',
    path: '',
    detail: `onboarding ${existing.id} already exists${existing.doneAt ? ' and is done' : ''}; its thread holds the rounds so far. Ask for a re-analysis (POST …/onboarding/reanalyze) to read the code again.`,
  };
}

// cm:guard a re-analysis runs only on an onboarding that exists (ONBOARDING_NOT_STARTED)
export function reanalyzeRefusal(
  existing: { id: string } | null,
  live: LiveJob | null,
): OnboardingRefusal | null {
  if (!existing) return notStarted();
  if (live) return { code: 'ONBOARDING_ALREADY_RUNNING', path: '', detail: runningDetail(live) };
  return null;
}

export function notStarted(): OnboardingRefusal {
  return {
    code: 'ONBOARDING_NOT_STARTED',
    path: '',
    detail: 'this project has no onboarding yet; a person starts it (POST …/onboarding/start).',
  };
}

// cm:guard a done onboarding takes no more batches or updates (ONBOARDING_DONE) until a person
// asks for a re-analysis, which reopens it
export function doneRefusal(row: { doneAt: Date | null }): OnboardingRefusal | null {
  if (!row.doneAt) return null;
  return {
    code: 'ONBOARDING_DONE',
    path: '',
    detail: 'this onboarding is done; a re-analysis (asked by a person) reopens it.',
  };
}

/** Start and re-analysis: each spends a job, so asking takes onboarding.request. */
export const personActRefusal = (facts: PermissionFacts, act: string): OnboardingRefusal | null =>
  permissionRefusal(facts, 'onboarding.request', act);

/** The thread's agent messages. */
export const agentWriteRefusal = (facts: PermissionFacts): OnboardingRefusal | null =>
  permissionRefusal(facts, 'onboarding.write', 'writing an onboarding update');

export const closeRefusal = (facts: PermissionFacts): OnboardingRefusal | null =>
  permissionRefusal(facts, 'project.write', 'closing onboarding');

// cm:guard a design an update names is a workflow of this project (ONBOARDING_DESIGN_UNKNOWN)
export function designUnknownRefusals(missing: readonly string[]): OnboardingRefusal[] {
  return missing.map((id) => ({
    code: 'ONBOARDING_DESIGN_UNKNOWN' as const,
    path: '/designs/workflowIds',
    detail: `workflow ${id} is not a workflow of this project; write the design first (POST /api/projects/:id/workflows), then name it.`,
  }));
}

// cm:guard on a sensitive_data project the data flow is mandatory (which-designs): onboarding is not
// closed without one (ONBOARDING_DATA_FLOW_MISSING), never skipped
export function dataFlowRefusal(
  sensitive: boolean,
  templates: readonly (string | null)[],
): OnboardingRefusal | null {
  if (!sensitive || templates.includes('data-flow')) return null;
  return {
    code: 'ONBOARDING_DATA_FLOW_MISSING',
    path: '/designs',
    detail:
      'this project holds sensitive data, so its onboarding draws a data flow (template data-flow) with trust boundaries and where redaction runs; none of its designs is one. Draft it, propose it and name it in an update before closing.',
  };
}

// cm:why a phase's last act is the agent's own questionnaire or its mark_done: that write is the
// evidence the job finished, so the job is settled done there. Left to the runner, an issue-less job
// is concluded failed a quarter hour after its last turn, and until then a submit finds it live and
// queues no revise job
export function settlesPhaseJob(agency: ActorAgency, jobStatus: string | null): boolean {
  return (
    agency === 'agent' &&
    jobStatus !== null &&
    (OCCUPYING_JOB_STATUSES as readonly string[]).includes(jobStatus)
  );
}
