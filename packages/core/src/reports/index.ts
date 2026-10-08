// The reports domain: runs queries as the asker, keeps each run's provenance and frame for 30 days,
// runs a script over a turn's runs on a sandbox executor and keeps that for 30 days too, and posts
// the blocks drawn from either. It reaches queries, rooms, executors and the project's compute
// setting only through ports its process entry provides, so the assistant never imports it.
export type { Executor } from '@forge/contracts/report-executions';
export type { ReportDocument, ReportTemplate } from '@forge/contracts/report-templates';
export { type AttachedBlock, attachVisualBlock } from './blocks.js';
export { keptExecutionFrames, readExecution } from './executions.js';
export {
  type ComputePolicy,
  provideExecutorPorts,
  provideExecutors,
  registerExecutor,
  unregisterExecutorForTest,
} from './executors.js';
export { provideReportsPorts, type ReportAsker, type RestTurn } from './ports.js';
export { keptRunFrames, readReportRun, runReport } from './runs.js';
export { messageShareSource } from './share-source.js';
export { sweepExpiredExecutions, sweepExpiredReportRuns } from './sweep.js';
export { templateOutputSubject, templateShareSource } from './template-share-source.js';
export { checkTemplateNarrative, listReportTemplates, runTemplate } from './templates.js';
