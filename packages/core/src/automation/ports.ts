// What the automation read model needs from the contexts below work: the agent reports, the
// admin thresholds and the schedule fires. The composition root provides them at boot.

import type { AgentReportView } from '@forge/contracts/agent-reports';
import type {
  ScheduleRunSkipReason,
  ScheduleRunStatus,
  ScheduleRunTrigger,
} from '@forge/contracts/schedules';

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

export interface AutomationPorts {
  reportRows: (scope: {
    projectId: string;
    scheduleId?: string;
    triaged: number;
  }) => Promise<AgentReportView[]>;
  reportRow: (projectId: string, reportId: string) => Promise<AgentReportView[]>;
  /** The admin thresholds; the read model uses only the schedule fail streak. */
  readThresholds: () => Promise<{ scheduleFailStreak: number }>;
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

let provided: AutomationPorts | null = null;

export function provideAutomationPorts(given: AutomationPorts): void {
  provided = given;
}

function automationPorts(): AutomationPorts {
  if (!provided) {
    throw new Error(
      'automation: no ports were provided; the process entry calls provideAutomationPorts before it serves',
    );
  }
  return provided;
}

export const reportRows: AutomationPorts['reportRows'] = (scope) =>
  automationPorts().reportRows(scope);
export const reportRow: AutomationPorts['reportRow'] = (projectId, reportId) =>
  automationPorts().reportRow(projectId, reportId);
export const readThresholds: AutomationPorts['readThresholds'] = () =>
  automationPorts().readThresholds();
export const lastFires: AutomationPorts['lastFires'] = (projectId, scheduleIds) =>
  automationPorts().lastFires(projectId, scheduleIds);
export const readScheduleStreaks: AutomationPorts['readScheduleStreaks'] = (scope) =>
  automationPorts().readScheduleStreaks(scope);
export const streakFails: AutomationPorts['streakFails'] = (streak, schedule, failStreak, now) =>
  automationPorts().streakFails(streak, schedule, failStreak, now);
