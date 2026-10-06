/**
 * The dashboard's one-line onboarding hint, derived from the onboarding's own view on every read:
 * never stored, never a blocker.
 */

import { LIVE_JOB_STATUSES } from '@forge/contracts/job-machine';
import {
  type OnboardingHint,
  type OnboardingView,
  QUESTIONNAIRE_DUE_DAYS,
} from '@forge/contracts/onboarding';

const DAY_MS = 86_400_000;

/** When an open batch is due, and whether it is past due: one rule for the hint and the chat. */
export function batchDue(postedAt: Date, now: Date) {
  const dueAt = new Date(postedAt.getTime() + QUESTIONNAIRE_DUE_DAYS * DAY_MS);
  return {
    dueAt: dueAt.toISOString(),
    overdue: now.getTime() >= dueAt.getTime(),
    waitingDays: Math.max(0, Math.floor((now.getTime() - postedAt.getTime()) / DAY_MS)),
  };
}

const LIVE = new Set<string>(LIVE_JOB_STATUSES);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const OPEN = { action: 'open', actionLabel: 'Open onboarding' } as const;
const START = { action: 'start', actionLabel: 'Start onboarding', mayReanalyze: false } as const;

/** The project's system-context design, by its template: none, drafted but not approved, or approved. */
export type SystemContextState = 'none' | 'unapproved' | 'approved';

function noOnboardingHint(systemContext: SystemContextState): OnboardingHint | null {
  if (systemContext === 'approved') return null;
  if (systemContext === 'unapproved') {
    return {
      tone: 'you',
      lead: 'System context not approved yet.',
      text: 'A system-context design is drafted; approve it in Workflows, or let the agent draft the rest.',
      ...START,
    };
  }
  return {
    tone: 'you',
    lead: 'No system context yet.',
    text: 'The agent can read the code, draft the key designs and ask what it cannot tell.',
    ...START,
  };
}

function openBatchHint(
  batch: NonNullable<OnboardingView['openBatch']>,
  drafted: number,
  mayReanalyze: boolean,
): OnboardingHint {
  const tone = batch.overdue ? 'attention' : 'you';
  const tail = `Open questions ${batch.open}${batch.overdue ? ` · waiting ${batch.waitingDays} days` : ''}`;
  return batch.round === 1
    ? {
        tone,
        lead: 'No system context yet.',
        text: `The agent read the code and drafted ${plural(drafted, 'design')} · ${tail}`,
        action: 'continue',
        actionLabel: 'Start onboarding',
        mayReanalyze,
      }
    : {
        tone,
        lead: 'Onboarding:',
        text: `follow-up round waits on you · ${tail}`,
        action: 'continue',
        actionLabel: 'Continue onboarding',
        mayReanalyze,
      };
}

/** A live job's line: what the run read model says it waits on, else that it runs. */
function liveJobText(job: NonNullable<OnboardingView['job']>): string {
  const w = job.waitingOn;
  if (w?.kind === 'gate') return `Waits on the ${w.gate} gate; the project works meanwhile.`;
  if (w?.kind === 'machine') {
    return `Waiting on ${w.who}${w.act ? `: ${w.act}` : ''}; the project works meanwhile.`;
  }
  if (w && w.kind !== 'none') {
    return `Waits on ${w.who}${w.act ? ` to ${w.act}` : ''}; the project works meanwhile.`;
  }
  return job.status === 'queued'
    ? 'The analysis job is queued for a runner; the project works meanwhile.'
    : 'One analysis job is running; the project works meanwhile.';
}

// the hint is derived, never stored: it says what the onboarding's own rows say now, and it
// leaves the dashboard once every onboarding design is approved (state `onboarded`). With no
// onboarding it reads the project's system-context design, so a project that has one approved is
// never told it has no system context (e2e D9). A re-analysis is offered whenever no job is live,
// the same rule reanalyzeRefusal holds (ONBOARDING_ALREADY_RUNNING)
export function hintOf(
  view: OnboardingView | null,
  systemContext: SystemContextState,
): OnboardingHint | null {
  if (!view) return noOnboardingHint(systemContext);
  const drafted = view.designs.length;
  const approved = view.designs.filter((d) => d.designStatus === 'approved').length;
  const live = view.job !== null && LIVE.has(view.job.status);
  const mayReanalyze = !live;
  if (view.status === 'done') {
    if (drafted > 0 && approved === drafted) return null;
    return {
      tone: 'ready',
      lead: 'Onboarding done.',
      text: `${plural(drafted - approved, 'design')} wait on your approval.`,
      ...OPEN,
      mayReanalyze,
    };
  }
  if (view.job && live) {
    return {
      tone:
        view.job.waitingOn?.kind === 'you' || view.job.waitingOn?.kind === 'person' ? 'you' : 'run',
      lead:
        view.job.phase === 'revise'
          ? 'Onboarding: updating designs.'
          : 'Onboarding: reading the code.',
      text: liveJobText(view.job),
      ...OPEN,
      mayReanalyze,
    };
  }
  if (view.openBatch) return openBatchHint(view.openBatch, drafted, mayReanalyze);
  if (view.job?.status === 'failed') {
    return {
      tone: 'err',
      lead: 'Onboarding analysis failed.',
      text: 'The last code map stays.',
      action: 'reanalyze',
      actionLabel: 'Ask for a re-analysis',
      mayReanalyze,
    };
  }
  return {
    tone: 'run',
    lead: 'Onboarding in progress.',
    text: drafted ? `${plural(drafted, 'design')} drafted.` : 'Waiting for the analysis.',
    ...OPEN,
    mayReanalyze,
  };
}
