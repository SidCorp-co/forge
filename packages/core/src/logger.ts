// ISS-167 until: no module imports this path — a re-export so branches in flight keep compiling while
// importers move to observability/logger.ts; every importer of the root door's file is a direction finding.
export { getLogger, logger } from './observability/logger.js';
