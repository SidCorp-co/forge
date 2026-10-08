// The reports domain: runs queries as the asker and keeps their provenance. It reaches queries and
// executors only through ports its process entry provides, so the assistant never imports it.
export type { Executor } from '@forge/contracts/report-executions';
export type { ReportDocument, ReportTemplate } from '@forge/contracts/report-templates';
