// What onboarding reads from the execution context: the run read model's wait for its job's run.
// The composition root provides it at boot.

import type { RunWaitingOn } from '@forge/contracts/run-standing';
import { portSlot } from '../lib/port-slot.js';

interface OnboardingPorts {
  /** The run read model's wait for `runId`; null when the project holds no such run. */
  runWaitingOf: (projectId: string, runId: string) => Promise<RunWaitingOn | null>;
}

const slot = portSlot<OnboardingPorts>('onboarding', 'provideOnboardingPorts');
export const provideOnboardingPorts = slot.provide;

export const runWaitingOf = slot.port('runWaitingOf');
