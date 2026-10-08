// Fills the registry at boot. A query is one file under `queries/`; adding one is a line here and
// its `reads` declared, reviewed like any read model.

import { A3_REPORT_QUERIES } from './phase-a-queries.js';
import { progressByRequirement } from './progress-by-requirement.js';
import { registerReportQuery } from './registry.js';
import { roadmapEta } from './roadmap-eta.js';

export function registerReportQueries(): void {
  registerReportQuery(progressByRequirement);
  registerReportQuery(roadmapEta);
  for (const query of A3_REPORT_QUERIES) registerReportQuery(query);
}
