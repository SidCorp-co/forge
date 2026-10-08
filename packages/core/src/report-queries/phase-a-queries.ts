// The Phase A queries lane A3 adds. The registry (lane A2) imports this list and registers each
// entry; nothing here wires a query into assistant logic.
import { criteriaCoverage } from './criteria-coverage.js';
import { releaseReadiness } from './release-readiness.js';
import { workflowStatus } from './workflow-status.js';

export const A3_REPORT_QUERIES = [releaseReadiness, criteriaCoverage, workflowStatus] as const;
