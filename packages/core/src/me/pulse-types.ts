/** The pulse response types live in `@forge/contracts/pulse`; the thresholds and windows are core's. */

import type { PulseThresholds } from '@forge/contracts/pulse';

export type * from '@forge/contracts/pulse';

export const PULSE_THRESHOLDS: PulseThresholds = {
  abandonedIssueSeconds: 3600,
  releaseWaitingSeconds: 86_400,
  projectSilenceSeconds: 604_800,
  silenceWarnSeconds: 86_400,
  silenceAlarmSeconds: 259_200,
  identityCap: 50,
};

export const PULSE_OPEN_STATUSES = ['open', 'approved'] as const;
export const PULSE_IN_PROGRESS_STATUSES = ['in_progress', 'reopen'] as const;
export const PULSE_AWAITING_RELEASE_STATUSES = ['awaiting_release'] as const;

export const PULSE_HEARTBEAT_DAYS = 30;
export const PULSE_FLOW_WEEKS = 12;
export const PULSE_QUALITY_WINDOW_DAYS = 90;
