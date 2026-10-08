// The ReportQuery port's module: the registry of queries lives here, each query one file declaring
// the tables it reads. The shapes (descriptor, frame, run) are the contract's, one declaration for
// core, web and every door.
export type {
  ReportFrame,
  ReportQueryDescriptor,
  ReportRun,
} from '@forge/contracts/report-queries';
