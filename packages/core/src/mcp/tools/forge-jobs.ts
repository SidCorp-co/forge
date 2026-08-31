import { z } from 'zod';
import { jobStatuses, jobTypes } from '../../db/schema.js';
import { cancelJob, JobCancelError } from '../../jobs/cancel-job.js';
import { assertDispatchable, gateReasonsForQueuedJobs } from '../../jobs/dispatch-gates.js';
import { listJobEvents, listJobs, readJob } from '../../jobs/job-queries.js';
import { JobResumeError, resumeHeldJob } from '../../jobs/resume-job.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type DeviceScopedMcpToolFactory,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';
import { assertDeviceOwnerIsMember } from './project-authz.js';

/**
 * MCP Phase 1 (ISS-7) — read-only diagnostic surfaces over the jobs/events
 * tables. Mirrors the drizzle queries used by the REST job routes
 * (`packages/core/src/jobs/routes.ts`, `events-routes.ts`) but skips Hono so
 * MCP callers do not need an authenticated user session — project membership
 * is enforced via the device principal.
 */

const listInputSchema = z
  .object({
    projectId: z.uuid(),
    status: z.enum(jobStatuses).optional(),
    type: z.enum(jobTypes).optional(),
    issueId: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// ISS-478 fix-forward — the body-free projection bounds per-ROW size but not
// the TOTAL response. At the old default limit of 50, a real-history project
// still produced ~52K chars and overflowed the MCP output cap, spilling to a
// file (the very failure this issue fixes, just 16× smaller). So ALSO bound the
// total response: a smaller default limit for the common no-arg call, plus a
// hard char budget that trims rows from the tail (oldest first — the list is
// ordered queuedAt desc) until the serialized payload fits. ~38K leaves
// headroom under the observed spill threshold (40 rows/~41K fit, 50/~52K did
// not).
const DEFAULT_LIST_LIMIT = 25;

const getInputSchema = z.object({ jobId: z.uuid() }).strict();

const eventsInputSchema = z
  .object({
    jobId: z.uuid(),
    sinceSeq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

const cancelInputSchema = z
  .object({
    jobId: z.uuid(),
    reason: z.string().max(500).optional(),
  })
  .strict();

export const forgeJobsListTool: DeviceScopedMcpToolFactory = (device) => ({
  name: 'forge_jobs.list',
  description:
    'List jobs scoped to a project (default 25, max 200; ordered newest-first). Supports status/type/issueId filters. Returns a lightweight projection per job: the heavy fields (payload, promptBlocks, failureMeta jsonb and the unbounded userPromptSnapshot/error text) are OMITTED to stay under the response token cap — fetch them per-job via forge_jobs.get. Every `queued` row also carries `gateReason` — the exact dispatch gate holding it (`blocked_by`, `runner_stale`, `pipeline_run_not_running`, …) or null when it is dispatchable and merely awaiting its turn. READ IT before assuming a queued job is progressing: `queued` is the status both of a job about to run and of one blocked indefinitely. EVERY response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit looks exactly like a complete one. `truncated:true` + `truncatedBy` + a notice say which cap bit (your limit, or the hard response-size cap). Requires device owner to be a project member.',
  inputSchema: zodToMcpSchema(listInputSchema),
  handler: async (args) => {
    const { projectId, status, type, issueId, limit } = listInputSchema.parse(args);
    await assertDeviceOwnerIsMember(device, projectId);

    const jobsLimit = limit ?? DEFAULT_LIST_LIMIT;
    const rows = await listJobs({ projectId, status, type, issueId, limit: overfetch(jobsLimit) });

    // cm:why one extra project-scoped query, not one per row — the gate is stateless, so `queued` alone cannot say whether a job is about to run or blocked forever, and without this the only way to find out is a hand-written script against the database (which is how 11 jobs came to sit queued for 6-22 days unnoticed)
    const gates = rows.some((r) => r.status === 'queued')
      ? await gateReasonsForQueuedJobs(projectId)
      : new Map<string, string>();
    const withGates = rows.map((r) => ({
      ...r,
      ...(r.status === 'queued' ? { gateReason: gates.get(r.id) ?? null } : {}),
    }));

    return buildListEnvelope({
      key: 'jobs',
      items: withGates,
      limit: jobsLimit,
      hint: 'narrow with status/type/issueId filters, and fetch full job bodies via forge_jobs.get',
    });
  },
});

export const forgeJobsGetTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.get',
  description:
    'Fetch a single job by id including its linked agentSessionId. A `queued` job also carries `gate`: `{ ok: true }` when it is dispatchable and merely awaiting its turn, or `{ ok: false, reason }` naming the gate holding it — the answer to "why has this been queued for days?", which `status` alone cannot give. Requires the principal to be a member of the job’s project; PAT principals must additionally have the job’s project in their allowlist.',
  inputSchema: zodToMcpSchema(getInputSchema),
  handler: async (args) => {
    const { jobId } = getInputSchema.parse(args);
    const row = await readJob(jobId);
    if (!row) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsMember(principal, row.projectId);
    if (row.status !== 'queued') return { job: row };
    return { job: row, gate: await assertDispatchable(row.id) };
  },
});

/**
 * Replace an oversized `job_events.data` with its own measurement.
 *
 * ISS-787 review round 2. `data` is the only unbounded column on this surface —
 * the runner maps each Claude stream-json line to one event and stores the
 * whole JSON — and dropping such a row for size wedged the replay: the page
 * came back empty, `lastSeq` fell back to the caller's own `sinceSeq`, and the
 * notice told them to re-call with it. Bounding the payload instead keeps the
 * row, so the cursor always clears the event that could not be sent.
 */
// cm:guard keep this cap well under MAX_RESPONSE_CHARS — it is what guarantees no SINGLE event can exhaust the response budget, which is what stops the size trim ever returning zero rows and freezing the cursor
const MAX_EVENT_DATA_CHARS = 8_000;

function boundEventData<T extends { data: unknown }>(event: T): T {
  const bytes = JSON.stringify(event.data ?? null).length;
  if (bytes <= MAX_EVENT_DATA_CHARS) return event;
  return { ...event, data: { omitted: true, bytes } };
}

export const forgeJobsEventsTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.events',
  description:
    'Stream-replay job_events for a job (paginated by sinceSeq). Read-only; returns { items, lastSeq, returned, limit, hasMore }. ' +
    'READ `hasMore`: a page bound by your own limit looks exactly like the end of the stream. `lastSeq` ALWAYS advances past every event this page accounted for, so re-calling with sinceSeq:lastSeq never replays and never stalls. ' +
    'An event whose `data` exceeds the per-event cap is returned with `data:{omitted:true,bytes:N}` rather than dropped — the stream stays contiguous and the cursor keeps moving.',
  inputSchema: zodToMcpSchema(eventsInputSchema),
  handler: async (args) => {
    const { jobId, sinceSeq, limit } = eventsInputSchema.parse(args);
    const job = await readJob(jobId);
    if (!job) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsMember(principal, job.projectId);

    const eventsLimit = limit ?? 200;
    const fetched = await listJobEvents(jobId, overfetch(eventsLimit), sinceSeq);

    const bounded = fetched.map(boundEventData);
    // cm:guard events are CURSOR-paginated, so the size trim must shed the NEWEST rows — shedding the oldest would move lastSeq past events the caller never received, and nothing replays them
    const envelope = buildListEnvelope({
      key: 'items',
      items: bounded,
      limit: eventsLimit,
      hint: 're-call with the returned sinceSeq',
      order: 'asc',
      sizeTrimSheds: 'newest',
    });
    const items = envelope.items as typeof bounded;
    // cm:guard `lastSeq` must come from the RETURNED tail, never the overfetched probe row — it is the cursor the caller passes back as `sinceSeq`, so reading it off the dropped row skips one event on every page and the replay silently loses it
    const lastSeq = items.length > 0 ? Number(items[items.length - 1]?.seq ?? 0) : (sinceSeq ?? 0);
    const { items: _, notice: __, ...metadata } = envelope;
    return {
      ...metadata,
      items,
      lastSeq,
      ...(envelope.truncated
        ? {
            notice: `More events match than were returned. Re-call with sinceSeq: ${lastSeq} for the next page.`,
          }
        : {}),
    };
  },
});

/**
 * ISS-442 C0 — the audited manual single-job cancel escape hatch. Delegates to
 * the shared {@link cancelJob} helper (same logic as REST `POST /jobs/:id/cancel`),
 * so it works even when the parent pipeline_run is already terminal — the case
 * that previously forced raw-SQL surgery. Writer-gated (this is a destructive
 * mutation), unlike the read-only forge_jobs.* tools which use the member gate.
 * Every cancel writes one `job_events` row (`kind='intervention'`) for the C6
 * interventions metric.
 */
export const forgeJobsCancelTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.cancel',
  description:
    'Cancel a single job (audited manual intervention). queued/held → cancelled; dispatched/running → cancellation requested + device push. Cancelling a `held` step leaves its issue and run untouched — reach for this instead of cancelling the whole run, which additionally parks the issue at on_hold. Works even when the parent pipeline_run is already terminal (orphan escape hatch). Requires writer access (member/admin; PAT write scope).',
  inputSchema: zodToMcpSchema(cancelInputSchema),
  handler: async (args) => {
    const { jobId, reason } = cancelInputSchema.parse(args);
    const job = await readJob(jobId);
    if (!job) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsWriter(principal, job.projectId);

    try {
      return await cancelJob(jobId, {
        actorUserId: principalUserId(principal),
        reason: reason ?? 'manual cancel (MCP)',
        source: 'mcp',
      });
    } catch (e) {
      if (e instanceof JobCancelError) throw new Error(`${e.code}: ${e.message}`);
      throw e;
    }
  },
});

/**
 * The counterpart to `forge_jobs.cancel` for a hold whose cause has been fixed.
 * Writer-gated for the same reason: it moves a job.
 */
export const forgeJobsResumeTool: ContextScopedMcpToolFactory = ({ principal }) => ({
  name: 'forge_jobs.resume',
  description:
    "Put a `held` job back in the queue (audited manual intervention). Use this when the hold's cause is FIXED — `retry_rounds_exhausted` and `non_retryable_terminal` never clear on their own, so without a resume the only way out of one is to cancel the step and lose it. The resume does not re-check the condition: you are asserting it cleared, and the audit row records that. Fails with NOT_HELD on any other status. Requires writer access (member/admin; PAT write scope).",
  inputSchema: zodToMcpSchema(cancelInputSchema),
  handler: async (args) => {
    const { jobId, reason } = cancelInputSchema.parse(args);
    const job = await readJob(jobId);
    if (!job) throw new Error('NOT_FOUND: job not found');
    await assertPrincipalIsWriter(principal, job.projectId);

    try {
      return await resumeHeldJob(jobId, {
        actorUserId: principalUserId(principal),
        reason: reason ?? 'manual resume (MCP)',
        source: 'mcp',
      });
    } catch (e) {
      if (e instanceof JobResumeError) throw new Error(`${e.code}: ${e.message}`);
      throw e;
    }
  },
});
