/**
 * Filing, listing and reading agent reports (automation#report), once for every door: REST
 * serves them first, and the MCP tool calls the same functions (docs/patterns/core-module.md, BC-21).
 */

import { AGENT_REPORT_TRIAGES } from '@forge/contracts/agent-reports';
import { writtenLangSchema } from '@forge/contracts/written-lang';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  agentReportKinds,
  agentReportSeverities,
  agentReports,
  agentReportTargets,
} from '../db/schema.js';
import { type PipelineCaller, resolvePipelineContext } from '../jobs/index.js';
import { env } from '../lib/env.js';
import { overfetch } from '../lib/list-envelope.js';
import { sanitizeUntrusted, stripFrameTokens } from '../lib/untrusted-text.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  countReportsForJob,
  fireOfSession,
  insertReport,
  listReports,
  readReport,
  reportViews,
} from './service.js';

export const submitReportSchema = z
  .object({
    projectId: z.uuid(),
    kind: z.enum(agentReportKinds),
    severity: z.enum(agentReportSeverities).optional(),
    target: z.enum(agentReportTargets),
    targetRef: z.string().max(500).optional(),
    summary: z.string().min(1).max(2000),
    detail: z.string().max(5000).optional(),
    suggestion: z.string().max(2000).optional(),
    /** The language summary, detail and suggestion are written in; absent, the project's content language. */
    writtenLang: writtenLangSchema.optional(),
  })
  .strict();

export const reportFiltersSchema = z
  .object({
    kind: z.enum(agentReportKinds).optional(),
    target: z.enum(agentReportTargets).optional(),
    severity: z.enum(agentReportSeverities).optional(),
    triage: z.enum(AGENT_REPORT_TRIAGES).optional(),
  })
  .strict();

type ReportCaller = PipelineCaller & { userId: string };

function signalKeyOf(target: string, targetRef: string | null | undefined, kind: string): string {
  const safeRef = targetRef ? stripFrameTokens(sanitizeUntrusted(targetRef)) : '-';
  return `self_report:${target}:${safeRef}:${kind}`;
}

/**
 * File one report against the project it is about. Its pipeline context (issue, run, job, stage,
 * the fire a scheduled run is for) comes from the caller's active job, never from the caller; a
 * job past its report cap is answered `rate_limited`, which is not an error.
 */
export async function fileReport(caller: ReportCaller, input: z.infer<typeof submitReportSchema>) {
  await requireCan(actorFor(caller.userId), 'project.read', projectResource(input.projectId));
  const resolved = await resolvePipelineContext(caller);
  const active = resolved.ok ? resolved.context : null;
  const jobId = active?.jobId ?? null;
  const sessionId = active?.agentSessionId ?? null;
  if (jobId) {
    const limit = env.FEEDBACK_MAX_PER_JOB;
    if ((await countReportsForJob(jobId)) >= limit) {
      return { ok: false as const, reason: 'rate_limited' as const, limit };
    }
  }
  const signalKey = signalKeyOf(input.target, input.targetRef, input.kind);
  const id = await insertReport({
    ...input,
    severity: input.severity ?? 'low',
    issueId: active?.issueId ?? undefined,
    runId: active?.runId ?? undefined,
    jobId: jobId ?? undefined,
    stage: active?.stage ?? undefined,
    signalKey,
    sessionId: sessionId ?? undefined,
    scheduleRunId: (await fireOfSession(sessionId)) ?? undefined,
    // a report is a device's (an agent's) unless filed on a person's own credential
    writtenLang: await writtenLangFor(
      { userId: caller.userId, agency: caller.deviceId ? 'agent' : 'human' },
      input.projectId,
      input.writtenLang,
      undefined,
      [input.summary, input.detail, input.suggestion].join('\n'),
    ),
  });
  if (!id) throw new Error('agent report: insert returned no row');
  return { ok: true as const, id, signalKey };
}

/** The report feed over projects the caller may read, newest first, one row past `limit`. */
export async function readReportFeed(
  projectIds: readonly string[],
  filters: z.infer<typeof reportFiltersSchema>,
  limit: number,
) {
  if (projectIds.length === 0) return [];
  const rows = await listReports(
    [
      inArray(agentReports.projectId, [...projectIds]),
      filters.kind ? eq(agentReports.kind, filters.kind) : undefined,
      filters.target ? eq(agentReports.target, filters.target) : undefined,
      filters.severity ? eq(agentReports.severity, filters.severity) : undefined,
      filters.triage ? eq(agentReports.triage, filters.triage) : undefined,
    ],
    overfetch(limit),
  );
  return reportViews(rows);
}

/** One report, its project read off the row and then checked; null when it does not exist. */
export async function readOneReport(userId: string, reportId: string) {
  const row = await readReport(reportId);
  if (!row) return null;
  await requireCan(actorFor(userId), 'project.read', projectResource(row.projectId));
  const [view] = await reportViews([row]);
  return view ?? null;
}
