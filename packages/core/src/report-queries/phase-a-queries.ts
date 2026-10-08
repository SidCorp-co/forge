// The Phase A queries lane A3 adds. The registry (lane A2) imports this list and registers each
// entry; nothing here wires a query into assistant logic.
import type { ReportQueryAdapter } from './adapter.js';
import { criteriaCoverage } from './criteria-coverage.js';
import { releaseReadiness } from './release-readiness.js';
import { workflowStatus } from './workflow-status.js';

/** Typed as adapters of any params, so one loop registers queries whose params differ. */
export const A3_REPORT_QUERIES: readonly ReportQueryAdapter[] = [
  releaseReadiness,
  criteriaCoverage,
  workflowStatus,
];
