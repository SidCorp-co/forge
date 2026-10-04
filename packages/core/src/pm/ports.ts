// What the PM agent needs from the contexts below work: notifications to escalate with, and the
// job ledger to start fallback jobs on and read runner load from. The composition root provides
// them at boot.

import type { Tx } from '../db/client.js';
import type { JobType, jobs, NotificationType } from '../db/schema.js';

export interface PmPorts {
  insertTypedNotificationRecord: (
    tx: Tx,
    input: {
      projectId: string;
      type: NotificationType;
      title: string;
      body: string;
      issueId: string | null;
      agentSessionId: string | null;
    },
  ) => Promise<string | null>;
  deliverExisting: (recordId: string, recipients: string[]) => Promise<unknown>;
  emitNotification: (input: {
    userId: string;
    projectId: string;
    type: NotificationType;
    title: string;
    body: string;
    decisionId: string;
  }) => Promise<{ id: string; delivered: number } | null>;
  closeEscalationTasks: (projectId: string, decisionId: string) => Promise<number>;
  insertJobRow: (tx: Tx, values: typeof jobs.$inferInsert) => Promise<{ id: string }>;
  buildJobPromptString: (args: { skillName: string; jobType: JobType; issueId: string }) => string;
  countInFlightByRunner: (runnerIds: string[]) => Promise<Map<string, number>>;
}

let provided: PmPorts | null = null;

export function providePmPorts(given: PmPorts): void {
  provided = given;
}

function pmPorts(): PmPorts {
  if (!provided) {
    throw new Error(
      'pm: no ports were provided; the process entry calls providePmPorts before it serves',
    );
  }
  return provided;
}

export const insertTypedNotificationRecord: PmPorts['insertTypedNotificationRecord'] = (
  tx,
  input,
) => pmPorts().insertTypedNotificationRecord(tx, input);
export const deliverExisting: PmPorts['deliverExisting'] = (recordId, recipients) =>
  pmPorts().deliverExisting(recordId, recipients);
export const emitNotification: PmPorts['emitNotification'] = (input) =>
  pmPorts().emitNotification(input);
export const closeEscalationTasks: PmPorts['closeEscalationTasks'] = (projectId, decisionId) =>
  pmPorts().closeEscalationTasks(projectId, decisionId);
export const insertJobRow: PmPorts['insertJobRow'] = (tx, values) =>
  pmPorts().insertJobRow(tx, values);
export const buildJobPromptString: PmPorts['buildJobPromptString'] = (args) =>
  pmPorts().buildJobPromptString(args);
export const countInFlightByRunner: PmPorts['countInFlightByRunner'] = (runnerIds) =>
  pmPorts().countInFlightByRunner(runnerIds);
