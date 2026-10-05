// What the automation read model needs from the contexts below work: the agent reports, the
// admin thresholds and the schedule fires. The composition root provides them at boot.

import type { AgentReportView } from '@forge/contracts/agent-reports';
import type {
  ScheduleRunSkipReason,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from '@forge/contracts/schedules';
import { portSlot } from '../lib/port-slot.js';

export interface LastFire {
  id: string;
  status: ScheduleRunStatus;
  trigger: ScheduleRunTrigger;
  startedAt: Date;
  finishedAt: Date | null;
  reason: ScheduleRunSkipReason | null;
  refusal: string | null;
  sessionId: string | null;
}

export interface ScheduleStreak {
  scheduleId: string;
  streak: number;
  lastCountedAt: Date;
  streakStartedAt: Date | null;
}

interface AutomationPorts {
  reportRows: (scope: {
    projectId: string;
    scheduleId?: string;
    triaged: number;
  }) => Promise<AgentReportView[]>;
  reportRow: (projectId: string, reportId: string) => Promise<AgentReportView[]>;
  lastFires: (projectId: string, scheduleIds?: readonly string[]) => Promise<Map<string, LastFire>>;
  readScheduleStreaks: (scope?: {
    projectId?: string;
    scheduleId?: string;
    minStreak?: number;
  }) => Promise<ScheduleStreak[]>;
  streakFails: (
    streak: Pick<ScheduleStreak, 'streak' | 'lastCountedAt'> | null,
    schedule: { enabled: boolean },
    failStreak: number,
    now: Date,
  ) => boolean;
}

const slot = portSlot<AutomationPorts>('automation', 'provideAutomationPorts');
export const provideAutomationPorts = slot.provide;
const { port } = slot;

export const reportRows = port('reportRows');
export const reportRow = port('reportRow');
export const lastFires = port('lastFires');
export const readScheduleStreaks = port('readScheduleStreaks');
export const streakFails = port('streakFails');
