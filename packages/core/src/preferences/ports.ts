// What the seen-mark rule needs from a module that sits after it: the release this instance serves.
// What's new owns the reading (`whats-new/serving.ts`); the process entry hands it in at boot, since
// `preferences` is earlier in context order and never imports it.

import { portSlot } from '../lib/port-slot.js';

export interface ServingRead {
  environment: string | null;
  version: string | null;
}

export interface PreferencesPorts {
  serving(): Promise<ServingRead>;
}

const slot = portSlot<PreferencesPorts>('preferences', 'providePreferencesPorts');
export const providePreferencesPorts = slot.provide;
export const preferencesPorts = slot.get;
