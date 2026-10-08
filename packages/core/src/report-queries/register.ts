// Fills the registry at boot. A query is one file under `queries/`; adding one is a line here and
// its `reads` declared, reviewed like any read model.

import { progressByRequirement } from './queries/progress-by-requirement.js';
import { roadmapEta } from './queries/roadmap-eta.js';
import { registerReportQuery } from './registry.js';

export function registerReportQueries(): void {
  registerReportQuery(progressByRequirement);
  registerReportQuery(roadmapEta);
}
