/**
 * The guards of workflow project-onboarding rev 1 (rules `may-start`, `which-designs`,
 * `approve-guard`), as pure functions over what the service read. Who may act is a permission, and
 * a start or a re-analysis is a person's alone.
 */

import { OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import {
  ONBOARDING_MAX_QUESTIONS,
  type OnboardingRefusal,
  type OnboardingStatus,
  type QuestionnaireItem,
} from '@forge/contracts/onboarding';
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

// one analysis job per onboarding (may-start): a second start while one runs is
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

// a re-analysis runs only on an onboarding that exists (ONBOARDING_NOT_STARTED)
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

// a done onboarding takes no more batches or updates (ONBOARDING_DONE) until a person
// asks for a re-analysis, which reopens it
export function doneRefusal(row: { doneAt: Date | null }): OnboardingRefusal | null {
  if (!row.doneAt) return null;
  return {
    code: 'ONBOARDING_DONE',
    path: '',
    detail: 'this onboarding is done; a re-analysis (asked by a person) reopens it.',
  };
}

/**
 * Start and re-analysis are a person's ask (REQ-10 BC-1, BC-2): an agent's credential is refused
 * them by name, whatever its grant holds (ONBOARDING_PERSON_ACT_FORBIDDEN); a person's spends a job,
 * so it takes onboarding.request.
 */
export function personActRefusal(
  agency: ActorAgency,
  facts: PermissionFacts,
  act: string,
): OnboardingRefusal | null {
  if (agency === 'agent')
    return {
      code: 'ONBOARDING_PERSON_ACT_FORBIDDEN',
      path: '',
      detail: `${act} is a person's ask (REQ-10 BC-2), and this request carries an agent's credential. A person of the project holding onboarding.request asks for it, signed in or with their own token.`,
    };
  return permissionRefusal(facts, 'onboarding.request', act);
}

/** The thread's agent messages. */
export const agentWriteRefusal = (facts: PermissionFacts): OnboardingRefusal | null =>
  permissionRefusal(facts, 'onboarding.write', 'writing an onboarding update');

export const closeRefusal = (facts: PermissionFacts): OnboardingRefusal | null =>
  permissionRefusal(facts, 'project.write', 'closing onboarding');

// a design an update names is a workflow of this project (ONBOARDING_DESIGN_UNKNOWN)
export function designUnknownRefusals(missing: readonly string[]): OnboardingRefusal[] {
  return missing.map((id) => ({
    code: 'ONBOARDING_DESIGN_UNKNOWN' as const,
    path: '/designs/workflowIds',
    detail: `workflow ${id} is not a workflow of this project; write the design first (POST /api/projects/:id/workflows), then name it.`,
  }));
}

// on a sensitive_data project the data flow is mandatory (which-designs): onboarding is not
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

// an onboarding round asks the person only what the code cannot answer (REQ-10 BC-6): at most
// ONBOARDING_MAX_QUESTIONS questions and clarifications (ONBOARDING_QUESTIONS_OVER_CAP), each a
// choice carrying its recommended answer (ONBOARDING_QUESTION_UNRECOMMENDED); what the code
// suggests is an assumption, and a recommendation lands as a suggestion on its own, never as an item
// the round waits on (ONBOARDING_RECOMMENDATION_IS_A_SUGGESTION)
export function onboardingItemRefusals(items: readonly QuestionnaireItem[]): OnboardingRefusal[] {
  const out: OnboardingRefusal[] = [];
  const asked = items.filter((i) => i.group === 'question' || i.group === 'clarification');
  if (asked.length > ONBOARDING_MAX_QUESTIONS)
    out.push({
      code: 'ONBOARDING_QUESTIONS_OVER_CAP',
      path: '/items',
      detail: `an onboarding round asks at most ${ONBOARDING_MAX_QUESTIONS} questions; this one asks ${asked.length} (${asked.map((i) => i.id).join(', ')}). Post what the code suggests as an assumption (group assumption, inferredDefault the suggested option) and ask only what it cannot answer.`,
    });
  items.forEach((item, i) => {
    if (item.group === 'recommendation')
      out.push({
        code: 'ONBOARDING_RECOMMENDATION_IS_A_SUGGESTION',
        path: `/items/${i}/group`,
        detail: `"${item.id}" is a recommendation: onboarding posts it as a suggestion on its own (POST /api/projects/:id/suggestions), which a holder of suggestions.approve decides; it is never an item the round waits on.`,
      });
    else if (
      (item.group === 'question' || item.group === 'clarification') &&
      (item.control === 'text' || item.inferredDefault === undefined)
    )
      out.push({
        code: 'ONBOARDING_QUESTION_UNRECOMMENDED',
        path: `/items/${i}/inferredDefault`,
        detail: `"${item.id}" asks the person without a recommended answer: an onboarding question is a choice (or multi) whose inferredDefault names the option you recommend, so one press answers it.`,
      });
  });
  return out;
}

// onboarding is done on its assumptions once its designs are proposed (REQ-10 BC-11): the agent's
// mark is refused while a design it registered still stands at draft (ONBOARDING_DESIGNS_UNPROPOSED)
export function designsUnproposedRefusal(
  designs: readonly { workflowId: string; flow: string; designStatus: string | null }[],
): OnboardingRefusal | null {
  const drafts = designs.filter((d) => d.designStatus === null || d.designStatus === 'draft');
  if (drafts.length === 0) return null;
  return {
    code: 'ONBOARDING_DESIGNS_UNPROPOSED',
    path: '/designs',
    detail: `${drafts.map((d) => `${d.flow} (${d.workflowId})`).join(', ')} still stand${drafts.length === 1 ? 's' : ''} at draft; propose each (POST …/workflows/<workflowId>/design/propose { revision }) before marking onboarding done.`,
  };
}

// The status is read, never stored (REQ-10 BC-11). Failed first: the newest attempt of the last
// analysis job failed with no retry after it (a queued retry is live), so onboarding is not done,
// done or not before, and waits on no answer (ISS-605). Then done once marked done (until a
// re-analysis clears the mark); then waiting on a person while an answerable batch holds a question
// open — an assumption never waits on anyone, and an open question keeps only its own item open
// once onboarding is done; else with the agent
export function onboardingStatusOf(
  row: { doneAt: Date | null },
  questionOpen: boolean,
  newestAttempt: string | null,
): OnboardingStatus {
  if (newestAttempt === 'failed') return 'failed';
  if (row.doneAt) return 'done';
  return questionOpen ? 'waiting_on_you' : 'in_progress';
}

// a phase's last act is the agent's mark_done (REQ-10 BC-11: every phase ends with onboarding done
// on its assumptions, a questionnaire posted before it): that write is the evidence the job
// finished, so the job is settled done there. Left to the runner, an issue-less job
// is concluded failed a quarter hour after its last turn, and until then a submit finds it live and
// queues no revise job
export function settlesPhaseJob(agency: ActorAgency, jobStatus: string | null): boolean {
  return (
    agency === 'agent' &&
    jobStatus !== null &&
    (OCCUPYING_JOB_STATUSES as readonly string[]).includes(jobStatus)
  );
}
