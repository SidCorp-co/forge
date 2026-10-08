// The reports domain: runs queries as the asker, keeps each run's provenance and frame for 30 days,
// and posts the blocks drawn from a run. It reaches queries and rooms only through ports its process
// entry provides, so the assistant never imports it.
export type { Executor } from '@forge/contracts/report-executions';
export type { ReportDocument, ReportTemplate } from '@forge/contracts/report-templates';
export { type AttachedBlock, attachVisualBlock } from './blocks.js';
export { provideReportsPorts, type ReportAsker } from './ports.js';
export { keptRunFrames, readReportRun, runReport } from './runs.js';
export { messageShareSource } from './share-source.js';
export { sweepExpiredReportRuns } from './sweep.js';
export { templateOutputSubject, templateShareSource } from './template-share-source.js';
export { checkTemplateNarrative, listReportTemplates, runTemplate } from './templates.js';
