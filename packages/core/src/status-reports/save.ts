// Saving a template run as a kept report: the one service behind the REST route
// (`POST /api/projects/:id/status/reports` with a templateId) and the Assistant's
// `forge_template_save`, so a save means the same thing whichever door made it. The narrative is
// judged against what the template's blocks show of its own runs, read back as the saver, before it
// is kept with who saved it, and so is each block's finding against what its own block shows.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { TemplateNarrativeSlot } from '@forge/contracts/report-templates';
import type { StatusReportMeta } from '@forge/contracts/status-reports';
import type { ProjectAccess } from '../lib/authz.js';
import { requireHeld } from '../permissions/index.js';
import { statusReportsPorts } from './ports.js';
import { reportMeta, storeTemplateReport } from './store.js';

export async function saveTemplateReport(args: {
  projectId: string;
  access: ProjectAccess;
  userId: string;
  agency: ActorAgency;
  templateId: string;
  runIds: readonly string[];
  narrative: Partial<Record<TemplateNarrativeSlot, string | undefined>>;
  /** Each block's one-line finding, in order, as the run wrote it or the saver stated it. */
  findings?: readonly string[] | undefined;
}): Promise<StatusReportMeta> {
  requireHeld(args.access, 'project.write', 'saving a status report');
  const document = await statusReportsPorts().checkTemplateNarrative({
    projectId: args.projectId,
    templateId: args.templateId,
    runIds: args.runIds,
    narrative: args.narrative,
    findings: args.findings,
    userId: args.userId,
    agency: args.agency,
  });
  const row = await storeTemplateReport({
    projectId: args.projectId,
    document,
    producer: { kind: 'person', userId: args.userId },
  });
  return reportMeta(row);
}
