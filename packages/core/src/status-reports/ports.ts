// What `status-reports` needs from the project status read model, handed in by the process entry at
// boot: a domain does not import a read model (ADR 0008), and a stored report is that read as it
// answered, never computed a second way. Read only inside a call.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ProjectStatus } from '@forge/contracts/project-status';
import type { ReportDocument, TemplateNarrativeSlot } from '@forge/contracts/report-templates';
import type { StatusReportNarrative } from '@forge/contracts/status-reports';
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
  /**
   * One report template run for `asker` (`reports/templates.ts:runTemplate`), the run every door
   * shares: every query kept as a run read as them, the blocks drawn over the runs, and the narrative
   * and findings one model call wrote from them, with how that narrative came to be. `what` names the
   * run in the model's scope and the log.
   */
  runTemplate(args: {
    projectId: string;
    templateId: string;
    params?: Record<string, unknown> | undefined;
    asker: { userId: string; agency: ActorAgency; access: ProjectAccess };
    what: string;
    now?: Date;
  }): Promise<{
    document: ReportDocument;
    narrative: StatusReportNarrative;
    notDrawn: { kind: string; as: string; why: string }[];
  }>;
  /**
   * A narrative and the findings beside it judged against the template's own runs, read back as
   * `userId`; the document with them set, or a refusal by name.
   */
  checkTemplateNarrative(args: {
    projectId: string;
    templateId: string;
    runIds: readonly string[];
    narrative: Partial<Record<TemplateNarrativeSlot, string | undefined>>;
    findings?: readonly string[] | undefined;
    userId: string;
    agency: ActorAgency;
  }): Promise<ReportDocument>;
}

const slot = portSlot<StatusReportsPorts>('status-reports', 'provideStatusReportsPorts');
export const provideStatusReportsPorts = slot.provide;
export const statusReportsPorts = slot.get;
