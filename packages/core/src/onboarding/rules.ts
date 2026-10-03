/**
 * The guards of workflow project-onboarding rev 1 (rules `may-start`, `which-designs`,
 * `approve-guard`), as pure functions over what the service read. Who may act is
 * `lib/person-act.ts:actMiss` under the rules declared here, worded under this slice's codes.
 */

import type { OnboardingRefusal, OnboardingStatus } from '@forge/contracts/onboarding';
import {
  type ActorFacts,
  type ActRule,
  actMiss,
  PERSON_ACT,
  PROJECT_AGENT_WRITE,
} from '../lib/person-act.js';

export type { OnboardingRefusal };

/** Closing onboarding as done: the agent when it hands over, or a person of the project. */
export const ONBOARDING_CLOSE: ActRule = { person: 'member', agent: 'member' };

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
  existing: { id: string; status: OnboardingStatus } | null,
  live: LiveJob | null,
): OnboardingRefusal | null {
  if (live) return { code: 'ONBOARDING_ALREADY_RUNNING', path: '', detail: runningDetail(live) };
  if (!existing) return null;
  return {
    code: 'ONBOARDING_ALREADY_STARTED',
    path: '',
    detail: `onboarding ${existing.id} already exists (${existing.status}); its thread holds the rounds so far. Ask for a re-analysis (POST …/onboarding/reanalyze) to read the code again.`,
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
export function doneRefusal(status: OnboardingStatus): OnboardingRefusal | null {
  if (status !== 'done') return null;
  return {
    code: 'ONBOARDING_DONE',
    path: '',
    detail: 'this onboarding is done; a re-analysis (asked by a person) reopens it.',
  };
}

// cm:guard start and re-analysis are a person's acts (ONBOARDING_ACT_FORBIDDEN): the cost bound is
// one job per run, spent only when a person asks
export function personActRefusal(
  facts: ActorFacts,
  projectId: string,
  act: string,
): OnboardingRefusal | null {
  const miss = actMiss(facts, PERSON_ACT);
  if (!miss) return null;
  return {
    code: 'ONBOARDING_ACT_FORBIDDEN',
    path: '',
    detail:
      miss.kind === 'agent-not-allowed'
        ? `${facts.userId} acts as an agent; ${act} is a person's act on project ${projectId}, so a job is spent only when a person asks.`
        : `${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; ${act} takes member or above.`,
  };
}

// cm:guard the thread's agent messages are written by the project's own agent (ONBOARDING_WRITE_FORBIDDEN)
export function agentWriteRefusal(facts: ActorFacts, projectId: string): OnboardingRefusal | null {
  const miss = actMiss(facts, PROJECT_AGENT_WRITE);
  if (!miss) return null;
  return {
    code: 'ONBOARDING_WRITE_FORBIDDEN',
    path: '',
    detail:
      miss.kind === 'person-not-allowed'
        ? `${facts.userId} acts as a person; onboarding updates are written by project ${projectId}'s own agent. A person answers the questionnaire or writes in the thread's composer.`
        : `${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; only that project's own agent writes its onboarding updates.`,
  };
}

export function closeRefusal(facts: ActorFacts, projectId: string): OnboardingRefusal | null {
  const miss = actMiss(facts, ONBOARDING_CLOSE);
  if (!miss) return null;
  return {
    code: 'ONBOARDING_ACT_FORBIDDEN',
    path: '',
    detail: `${facts.userId} holds ${facts.role ?? 'no role'} on project ${projectId}; closing its onboarding takes member or above, person or the project's own agent.`,
  };
}

// cm:guard a design an update names is a workflow of this project (ONBOARDING_DESIGN_UNKNOWN)
export function designUnknownRefusals(missing: readonly string[]): OnboardingRefusal[] {
  return missing.map((id) => ({
    code: 'ONBOARDING_DESIGN_UNKNOWN' as const,
    path: '/designs/workflowIds',
    detail: `workflow ${id} is not a workflow of this project; write the design first (forge_workflows write), then name it.`,
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
