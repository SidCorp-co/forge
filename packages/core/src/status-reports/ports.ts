// What `status-reports` needs from the project status read model, handed in by the process entry at
// boot: a domain does not import a read model (ADR 0008), and a stored report is that read as it
// answered, never computed a second way. Read only inside a call.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ProjectStatus } from '@forge/contracts/project-status';
import type { ProjectAccess } from '../lib/authz.js';
import { portSlot } from '../lib/port-slot.js';

interface StatusReportsPorts {
  /** The project status as `userId` reads it with `access` (`project-status/read.ts:readProjectStatus`). */
  readProjectStatus(args: {
    projectId: string;
    access: ProjectAccess;
    userId: string;
    agency: ActorAgency;
    days: number;
    now?: Date;
  }): Promise<ProjectStatus>;
}

const slot = portSlot<StatusReportsPorts>('status-reports', 'provideStatusReportsPorts');
export const provideStatusReportsPorts = slot.provide;
export const statusReportsPorts = slot.get;
