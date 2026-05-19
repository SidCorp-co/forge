/**
 * Shared types for the project setup wizard (ISS-174).
 *
 * The wizard walks six steps in order. State is held in React local state via
 * `useWizardState` — refresh starts over; every commit writes directly to the
 * backend so no progress is lost.
 */

export const WIZARD_STEP_IDS = [
  'repository',
  'members',
  'pipeline',
  'skills',
  'device',
  'verify',
] as const;

export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export type StepStatus = 'pending' | 'saved' | 'skipped' | 'error';

export interface WizardStepState {
  status: StepStatus;
  error?: string | null;
}

export type WizardStepStates = Record<WizardStepId, WizardStepState>;

export interface ProjectSetupBooleans {
  repo: boolean | null;
  branches: boolean | null;
  members: boolean | null;
  pipeline: boolean | null;
  skills: boolean | null;
  devices: boolean | null;
  firstIssue: boolean | null;
  firstRun: boolean | null;
}
