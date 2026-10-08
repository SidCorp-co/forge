// The ReportQuery port's module: the registry of queries lives here, each query one file declaring
// what it reads. The shapes (descriptor, frame, run) are the contract's, one declaration for core,
// web and every door.
export type {
  ReportFrame,
  ReportQueryDescriptor,
  ReportRun,
} from '@forge/contracts/report-queries';
export type { ReportQueryAdapter, ReportQueryContext } from './adapter.js';
export { registerReportQueries } from './register.js';
export {
  clearReportQueriesForTest,
  getReportQuery,
  listReportQueries,
  registerReportQuery,
} from './registry.js';
export { type ReportAsker, runReportQuery } from './run.js';
