// What the skills domain needs from the contexts after execution (notifications), handed in by the
// process entry at boot: a module imports only its own context or one before it (ADR 0008). Read
// only inside a call.

import type { NotificationType } from '../db/schema.js';

export interface SkillsPorts {
  emitNotification(input: {
    userId: string;
    projectId: string;
    type: NotificationType;
    title: string;
    body: string;
    resolutionKey: string;
  }): Promise<unknown>;
  /** Clears every notification raised under `resolutionKey`. */
  resolveNotifications(resolutionKey: string): Promise<unknown>;
  projectAdminUserIds(projectId: string): Promise<string[]>;
}

let provided: SkillsPorts | null = null;

export function provideSkillsPorts(ports: SkillsPorts): void {
  provided = ports;
}

export function skillsPorts(): SkillsPorts {
  if (!provided) {
    throw new Error(
      'skills: no ports were provided, so a reconcile run cannot notify the project admins; the process entry calls provideSkillsPorts before it serves',
    );
  }
  return provided;
}
