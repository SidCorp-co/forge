// Fills the registry at boot. A query is one file under `queries/`; adding one is a line here and
// its `reads` declared, reviewed like any read model.

import { burndown } from './burndown.js';
import { issueFlow } from './issue-flow.js';
import { closedByRequirement, periodFlow, statusTime } from './period-progress.js';
import { A3_REPORT_QUERIES } from './phase-a-queries.js';
import { progressByRequirement } from './progress-by-requirement.js';
import { registerReportQuery } from './registry.js';
import { roadmapEta } from './roadmap-eta.js';

export function registerReportQueries(): void {
  registerReportQuery(progressByRequirement);
  registerReportQuery(roadmapEta);
  for (const query of A3_REPORT_QUERIES) registerReportQuery(query);
  // work over time: a line and a burndown chart (REQ-32 BC-3), and the progress template's period (BC-15)
  registerReportQuery(issueFlow);
  registerReportQuery(burndown);
  registerReportQuery(periodFlow);
  registerReportQuery(statusTime);
  registerReportQuery(closedByRequirement);
}
