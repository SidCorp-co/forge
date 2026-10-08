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
import { type Said, say, sayEn } from '@forge/contracts/said';

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
const designs = (n: number) =>
  say(n === 1 ? 'onboarding.hint.designOne' : 'onboarding.hint.designMany', { n });

/** A hint whose words are rendered from what it says. */
function hint(
  tone: OnboardingHint['tone'],
  lead: Said,
  text: Said,
  action: OnboardingHint['action'],
  actionLabel: Said,
  mayReanalyze: boolean,
): OnboardingHint {
  return {
    tone,
    lead: sayEn(lead),
    text: sayEn(text),
    action,
    actionLabel: sayEn(actionLabel),
    mayReanalyze,
    says: { lead, text, actionLabel },
  };
}

/** The project's system-context design, by its template: none, drafted but not approved, or approved. */
export type SystemContextState = 'none' | 'unapproved' | 'approved';

function noOnboardingHint(systemContext: SystemContextState): OnboardingHint | null {
  if (systemContext === 'approved') return null;
  const ask = say('onboarding.hint.askForDesigns');
  if (systemContext === 'unapproved') {
    return hint(
      'you',
      say('onboarding.hint.contextUnapproved'),
      say('onboarding.hint.contextDrafted'),
      'start',
      ask,
      false,
    );
  }
  return hint(
    'you',
    say('onboarding.hint.noContext'),
    say('onboarding.hint.agentCan'),
    'start',
    ask,
    false,
  );
}

function openBatchHint(
  batch: NonNullable<OnboardingView['openBatch']>,
  drafted: number,
  mayReanalyze: boolean,
): OnboardingHint {
  const tone = batch.overdue ? 'attention' : 'you';
  const tail = say('onboarding.hint.openQuestions', {
    n: batch.open,
    waiting: batch.overdue ? say('onboarding.hint.waitingDays', { n: batch.waitingDays }) : null,
  });
  return batch.round === 1
    ? hint(
        tone,
        say('onboarding.hint.noContext'),
        say('onboarding.hint.readAndDrafted', { designs: designs(drafted), tail }),
        'continue',
        say('onboarding.hint.answerQuestions'),
        mayReanalyze,
      )
    : hint(
        tone,
        say('onboarding.hint.onboardingLead'),
        say('onboarding.hint.followUp', { tail }),
        'continue',
        say('onboarding.hint.continue'),
        mayReanalyze,
      );
}

/** A live job's line: what the run read model says it waits on, else that it runs. */
function liveJobText(job: NonNullable<OnboardingView['job']>): Said {
  const w = job.waitingOn;
  if (w?.kind === 'gate') return say('onboarding.hint.waitsGate', { gate: w.gate });
  if (w?.kind === 'machine') {
    return say('onboarding.hint.waitingOnMachine', {
      who: w.says.who,
      act: w.act ? say('onboarding.hint.colonAct', { act: w.says.act }) : null,
    });
  }
  if (w && w.kind !== 'none') {
    return say('onboarding.hint.waitsOn', {
      who: w.says.who,
      act: w.act ? say('onboarding.hint.toAct', { act: w.says.act }) : null,
    });
  }
  return say(job.status === 'queued' ? 'onboarding.hint.jobQueued' : 'onboarding.hint.jobRunning');
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
  const open = say('onboarding.hint.openOnboarding');
  if (view.status === 'done') {
    if (drafted > 0 && approved === drafted) return null;
    return hint(
      'ready',
      say('onboarding.hint.done'),
      say('onboarding.hint.waitApproval', { designs: designs(drafted - approved) }),
      'open',
      open,
      mayReanalyze,
    );
  }
  if (view.job && live) {
    return hint(
      view.job.waitingOn?.kind === 'you' || view.job.waitingOn?.kind === 'person' ? 'you' : 'run',
      say(view.job.phase === 'revise' ? 'onboarding.hint.updating' : 'onboarding.hint.reading'),
      liveJobText(view.job),
      'open',
      open,
      mayReanalyze,
    );
  }
  if (view.openBatch) return openBatchHint(view.openBatch, drafted, mayReanalyze);
  if (view.job?.status === 'failed') {
    return hint(
      'err',
      say('onboarding.hint.failed'),
      say('onboarding.hint.mapStays'),
      'reanalyze',
      say('onboarding.hint.askReanalysis'),
      mayReanalyze,
    );
  }
  return hint(
    'run',
    say('onboarding.hint.inProgress'),
    drafted
      ? say('onboarding.hint.drafted', { designs: designs(drafted) })
      : say('onboarding.hint.waitingAnalysis'),
    'open',
    open,
    mayReanalyze,
  );
}
