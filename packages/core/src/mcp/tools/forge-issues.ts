import { and, asc, desc, eq, exists, gte, ilike, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type IssueStatus,
  comments,
  issueComplexities,
  issueLabels,
  issuePriorities,
  issueStatuses,
  issues,
  labels,
  taskStatuses,
  tasks,
} from '../../db/schema.js';
import { applyStatusTransition } from '../../issues/apply-transition.js';
import {
  AttachmentError,
  type DecodedAttachment,
  decodeAndValidateAttachments,
  listIssueAttachments,
  persistDecodedIssueAttachments,
} from '../../issues/attachment-service.js';
import { pmSetDependencyHandler } from './forge-pm-set-dependency.js';
import { type ReleaseNotes, ReleaseNotesSchema } from '../../issues/release-notes.js';
import { dispatchTickForProject } from '../../jobs/dispatch-tick.js';
import { hooks } from '../../pipeline/hooks.js';
import { markUntrusted, sanitizeUntrusted } from '../../prompt/sanitize.js';
import {
  type ContextScopedMcpToolFactory,
  type McpContext,
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

// Hard total-response cap for list surfaces. ~38K leaves headroom under the
// observed spill threshold (matches the forge-jobs.ts precedent, ISS-478).
const MAX_RESPONSE_CHARS = 38_000;

// Kinds allowed in the create-time `relations` field. `decomposes` is excluded
// because it triggers integration-branch side effects that belong in the
// dedicated decompose flow (forge_project_pm set_dependency kind=decomposes).
// `duplicates` and `parent` are also excluded — they don't need to be atomic
// with create. Route those through forge_project_pm.set_dependency directly.
const createRelationKinds = ['blocks', 'relates'] as const;

/**
 * Action-based parity port of the legacy Strapi MCP `forge_issues` tool. The
 * single-tool-per-resource shape (one tool, dispatched on an `action` field)
 * preserves the input schema the existing `/forge-*` skills already speak —
 * see ISS-293. Skills round-trip `documentId`, which in the new core maps
 * directly to the issue UUID.
 */

const filtersSchema = z
  .object({
    search: z.string().trim().min(1).optional(),
    status: z.enum(issueStatuses).optional(),
    statusNot: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    updatedAfter: z.string().optional(),
    // listTasks: filter tasks by parent issue UUID + optional task status.
    // `taskStatus` is named separately from the issue-level `status` so a
    // listTasks call cannot accidentally match against issue.status.
    issue: z.uuid().optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    // Label filter: accepts a label name OR uuid (or an array of either).
    // Names are resolved to ids server-side; unknown names short-circuit to empty.
    label: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(50)])
      .optional(),
  })
  .strict()
  .optional();

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

const dataSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    suggestedSolution: z.string().max(100_000).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    // sessionContext is opaque JSON the skill pipeline uses to persist
    // accumulated context across sessions. Validated as a record here with a
    // serialised-size ceiling matched to `plan` so a single issue cannot blow
    // up TOAST or query plans (Postgres jsonb has no per-column limit, so we
    // enforce one in app code). Deeper schema lives in the skill spec.
    sessionContext: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .refine((v) => v == null || JSON.stringify(v).length <= 200_000, {
        message: 'sessionContext serialised size exceeds 200000 bytes',
      }),
    // ISS-59 — AI enrichment fields. Skill pipeline (forge-clarify /
    // forge-plan) writes these via this tool; REST PATCH does not accept
    // them (read-only from clients).
    aiSummary: z.string().max(100_000).nullable().optional(),
    aiSuggestedSolution: z.string().max(100_000).nullable().optional(),
    aiAcceptanceCriteria: z.array(z.string().max(2_000)).max(50).nullable().optional(),
    aiConfidence: z.number().min(0).max(1).nullable().optional(),
    // ISS-199 — user-facing release notes. forge-clarify writes this; the
    // shape is validated by `ReleaseNotesSchema` so an invalid section enum
    // is rejected at the MCP boundary.
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    // ISS-286 — mark_merged / unmark fields. `issueId` (below) identifies the
    // target issue. `target` is an audit label only — trunk-based v2 has a
    // single `merged_at` column (no `merged_to_prod_at` until v3), so all
    // three values stamp the same column. `mergedAt` overrides the default
    // `now()` stamp; `note` is appended to the audit comment.
    target: z.enum(['feature', 'base', 'prod']).optional(),
    mergedAt: z.string().optional(),
    note: z.string().max(10_000).optional(),
    // Task fields — only consumed by the createTask/updateTask actions. Kept
    // on the same `data` block to avoid splitting the input schema for what
    // is conceptually one tool.
    issueId: z.uuid().optional(),
    taskTitle: z.string().trim().min(1).max(500).optional(),
    taskDescription: z.string().max(50_000).nullable().optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    taskPriority: z.enum(issuePriorities).optional(),
    isAgentTask: z.boolean().optional(),
    taskAcceptanceCriteria: z.array(z.string()).nullable().optional(),
    // ISS-571 — atomic dependency edges at create time. Each entry must set
    // exactly one of dependsOnId (new issue will be blocked-by it) or blocksId
    // (new issue blocks it). Edges are inserted BEFORE issueCreated fires so
    // the L2 dispatch gate sees the blocking edge on the very first tick,
    // closing the race between create + a subsequent set_dependency call.
    // Restricted to blocks/relates; route decomposes through forge_project_pm.
    relations: z
      .array(
        z
          .object({
            kind: z.enum(createRelationKinds).default('blocks'),
            dependsOnId: z.uuid().optional(),
            blocksId: z.uuid().optional(),
            reason: z.string().max(2000).optional(),
            validUntil: z.iso.datetime().optional(),
          })
          .strict()
          .refine((r) => (r.dependsOnId == null) !== (r.blocksId == null), {
            message: 'each relation must set exactly one of dependsOnId or blocksId',
          }),
      )
      .max(20)
      .optional(),
    // ISS-596 — explicit operator-unblock intent. When true on an update that
    // also changes status away from `on_hold`, threads `reason:'operator_unblock'`
    // through the outbox so the orchestrator's ISS-411 hard-stop allows the
    // transition. A stray aborted-agent advance will never carry this flag.
    unblock: z.boolean().optional(),
  })
  .strict()
  .optional();

/**
 * Heavy free-text fields — large TOAST bodies that dominate token count on
 * complex issues. When their total char count exceeds
 * STEP_START_BODY_MANIFEST_THRESHOLD in forge_step_start, they are replaced
 * by a manifest (field → {chars} | null) so agents can pull only the fields
 * they need via `forge_issues.get { fields: [...] }`.
 */
export const STEP_START_HEAVY_FIELDS = [
  'description',
  'plan',
  'acceptanceCriteria',
  'suggestedSolution',
  'sessionContext',
  'aiSummary',
  'aiSuggestedSolution',
  'aiAcceptanceCriteria',
] as const;

export type StepStartHeavyField = (typeof STEP_START_HEAVY_FIELDS)[number];

// Fields allowed in the get action's selective-projection param.
// Mirrors STEP_START_HEAVY_FIELDS (the body fields omitted in lean step_start)
// plus releaseNotes (small structured value sometimes worth fetching alone).
const GET_SELECTABLE_FIELDS = [
  ...STEP_START_HEAVY_FIELDS,
  'releaseNotes',
] as const;

const inputSchema = z
  .object({
    action: z.enum([
      'list',
      'get',
      'create',
      'update',
      'transition',
      'createTask',
      'listTasks',
      'updateTask',
      'deleteTask',
      'mark_merged',
      'unmark',
    ]),
    projectId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: dataSchema,
    limit: z.number().int().min(1).max(500).optional(),
    /**
     * For action=get only: fetch only the listed fields (+ documentId/issueId)
     * instead of the full body. Useful when forge_step_start returned a lean
     * manifest (bodyTruncated:true) — the agent pulls only the fields it needs
     * rather than re-fetching the entire issue. Omitting this param is
     * backwards-compatible (returns full body with attachments[]).
     */
    fields: z.array(z.enum(GET_SELECTABLE_FIELDS)).min(1).max(20).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type IssueRow = {
  id: string;
  projectId: string;
  issSeq: number;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: string;
  category: string | null;
  reportedBy: string | null;
  complexity: string | null;
  assigneeId: string | null;
  createdById: string;
  parentIssueId: string | null;
  reopenCount: number;
  source: string;
  externalId: string | null;
  plan: string | null;
  acceptanceCriteria: string | null;
  suggestedSolution: string | null;
  sessionContext: unknown;
  aiSummary: string | null;
  aiSuggestedSolution: string | null;
  aiAcceptanceCriteria: string[] | null;
  aiConfidence: number | null;
  releaseNotes: ReleaseNotes | null;
  mergedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * ISS-532 — recursively char-strip control/invisible chars from every string
 * in an agent-authored JSON value (e.g. `sessionContext`). Defense-in-depth: a
 * runner agent wrote these, so DATA framing would be noise, but invisible-char
 * smuggling is still neutralized.
 */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeUntrusted(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeDeep(v)]),
    );
  }
  return value;
}

// Exported for reuse by forge-step-start (same issue payload shape in its
// bundle as `forge_issues.get` returns — agents see one serialization).
//
// ISS-532: this is the agent-facing MCP surface (and the step-start bundle), so
// untrusted human/external free-text (title/description/acceptanceCriteria) is
// framed in a labeled DATA delimiter via `markUntrusted`, and agent-authored
// fields (plan/suggestedSolution/sessionContext/ai*) get char-strip only via
// `sanitizeUntrusted`. REST/web-v2 use their own serializers, so the human UI
// is unaffected.
export function serialize(row: IssueRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    title: markUntrusted(row.title, { source: 'issue.title' }),
    description:
      row.description == null
        ? null
        : markUntrusted(row.description, { source: 'issue.description' }),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    parentIssueId: row.parentIssueId,
    reopenCount: row.reopenCount,
    plan: row.plan == null ? null : sanitizeUntrusted(row.plan),
    acceptanceCriteria:
      row.acceptanceCriteria == null
        ? null
        : markUntrusted(row.acceptanceCriteria, { source: 'issue.acceptanceCriteria' }),
    suggestedSolution:
      row.suggestedSolution == null ? null : sanitizeUntrusted(row.suggestedSolution),
    sessionContext: sanitizeDeep(row.sessionContext),
    aiSummary: row.aiSummary == null ? null : sanitizeUntrusted(row.aiSummary),
    aiSuggestedSolution:
      row.aiSuggestedSolution == null ? null : sanitizeUntrusted(row.aiSuggestedSolution),
    aiAcceptanceCriteria:
      row.aiAcceptanceCriteria == null ? null : row.aiAcceptanceCriteria.map(sanitizeUntrusted),
    aiConfidence: row.aiConfidence,
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Light projection type for the `list` surface — only the scalar fields that
 * `serializeListRow` actually reads. Using this instead of `IssueRow` lets the
 * SQL-level projection (db.select({...})) return a properly-typed result without
 * needing to load heavy TOAST columns from disk.
 */
type IssueListProjection = Pick<
  IssueRow,
  | 'id'
  | 'issSeq'
  | 'title'
  | 'status'
  | 'priority'
  | 'category'
  | 'complexity'
  | 'assigneeId'
  | 'parentIssueId'
  | 'reopenCount'
  | 'mergedAt'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * ISS-428 — body-free projection for the `list` (browse) surface. Returns only
 * light scalar fields and OMITS the heavy bodies (`description`, `plan`,
 * `acceptanceCriteria`, `suggestedSolution`, `sessionContext`, `ai*`,
 * `releaseNotes`) so a list over many populated issues never overflows the MCP
 * token cap. Heavy fields stay reachable per-issue via `action=get`. Do NOT
 * widen this back to `serialize()`.
 */
function serializeListRow(row: IssueListProjection): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    // ISS-532: char-strip only (NOT framed) — the browse-list projection exists
    // to stay under the MCP token cap (ISS-428); a full DATA banner per title
    // across many rows would defeat that. Invisible/bidi smuggling is still
    // neutralized.
    title: sanitizeUntrusted(row.title),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    parentIssueId: row.parentIssueId,
    reopenCount: row.reopenCount,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadIssue(documentId: string): Promise<IssueRow> {
  const [row] = await db.select().from(issues).where(eq(issues.id, documentId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row as IssueRow;
}

/**
 * `serialize` + the issue's attachment metadata (`attachments[]`). Used by the
 * focused single-issue surfaces an agent acts on — `get`, the write-returns,
 * and `forge_step_start` (under-threshold path) — so the agent always sees
 * which files are attached (then reads bytes via `forge_uploads` action=fetch).
 * NOT used by `list` (summary/browse) to avoid an attachment query per row.
 */
export async function serializeWithAttachments(row: IssueRow): Promise<Record<string, unknown>> {
  const attachments = await listIssueAttachments(row.id);
  return { ...serialize(row), attachments };
}

// ── Lean manifest serializer for forge_step_start over-threshold path ──────

/** Sum of char lengths across all non-null heavy fields for threshold gating. */
export function heavyFieldChars(row: IssueRow): number {
  let total = 0;
  if (row.description != null) total += row.description.length;
  if (row.plan != null) total += row.plan.length;
  if (row.acceptanceCriteria != null) total += row.acceptanceCriteria.length;
  if (row.suggestedSolution != null) total += row.suggestedSolution.length;
  if (row.sessionContext != null) total += JSON.stringify(row.sessionContext).length;
  if (row.aiSummary != null) total += row.aiSummary.length;
  if (row.aiSuggestedSolution != null) total += row.aiSuggestedSolution.length;
  if (row.aiAcceptanceCriteria != null) total += JSON.stringify(row.aiAcceptanceCriteria).length;
  return total;
}

/**
 * Lean manifest — light scalars + `bodyManifest` (field → {chars} | null)
 * + `bodyTruncated: true`. Used by forge_step_start when heavy fields exceed
 * the threshold. Agents fetch fields they need via
 * `forge_issues.get { documentId, fields: ['plan', ...] }`.
 *
 * Heavy fields are NOT emitted — only their sizes. Title framing is preserved
 * (still needed for orientation). aiConfidence and releaseNotes are small
 * scalars and remain inline.
 */
export function serializeManifest(row: IssueRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    title: markUntrusted(row.title, { source: 'issue.title' }),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    parentIssueId: row.parentIssueId,
    reopenCount: row.reopenCount,
    aiConfidence: row.aiConfidence,
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bodyTruncated: true as const,
    bodyManifest: {
      description: row.description != null ? { chars: row.description.length } : null,
      plan: row.plan != null ? { chars: row.plan.length } : null,
      acceptanceCriteria: row.acceptanceCriteria != null ? { chars: row.acceptanceCriteria.length } : null,
      suggestedSolution: row.suggestedSolution != null ? { chars: row.suggestedSolution.length } : null,
      sessionContext: row.sessionContext != null ? { chars: JSON.stringify(row.sessionContext).length } : null,
      aiSummary: row.aiSummary != null ? { chars: row.aiSummary.length } : null,
      aiSuggestedSolution: row.aiSuggestedSolution != null ? { chars: row.aiSuggestedSolution.length } : null,
      aiAcceptanceCriteria: row.aiAcceptanceCriteria != null ? { chars: JSON.stringify(row.aiAcceptanceCriteria).length } : null,
    },
  };
}

/** `serializeManifest` + attachment metadata. Used by forge_step_start over-threshold path. */
export async function serializeManifestWithAttachments(
  row: IssueRow,
): Promise<Record<string, unknown>> {
  const attachments = await listIssueAttachments(row.id);
  return { ...serializeManifest(row), attachments };
}

type TaskRow = {
  id: string;
  issueId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  isAgentTask: boolean;
  agentStatus: string | null;
  acceptanceCriteria: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function serializeTask(row: TaskRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    isAgentTask: row.isAgentTask,
    agentStatus: row.agentStatus,
    acceptanceCriteria: row.acceptanceCriteria,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Body-free projection for the `listTasks` surface — omits `description`
 * (up to 50KB each) so a list over many tasks never overflows the MCP token
 * cap. Full task body stays reachable via `action=updateTask` / `getTask`.
 * Do NOT widen this back to `serializeTask()` for the list path.
 */
function serializeTaskListRow(row: Omit<TaskRow, 'description'>): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    isAgentTask: row.isAgentTask,
    agentStatus: row.agentStatus,
    acceptanceCriteria: row.acceptanceCriteria,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

async function loadTaskForAccess(taskId: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: task not found');
  return row as TaskRow;
}

async function resolveProjectId(input: Input, ctx: McpContext): Promise<string> {
  return resolveEffectiveProjectId(ctx, input.projectId);
}

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`BAD_REQUEST: invalid ISO date for ${field}: ${value}`);
  }
  return d;
}

export const forgeIssuesTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_issues',
  description:
    'CRUD for project issues. Actions: list, get, create, update, transition, ' +
    'createTask, listTasks, updateTask, deleteTask, mark_merged, unmark. ' +
    'list returns a lightweight summary projection per issue (no description/' +
    'plan/acceptanceCriteria/suggestedSolution/sessionContext/ai*/releaseNotes) ' +
    'to stay under the response token cap; fetch the full body with action=get. ' +
    'list supports filters.label (a label name or uuid, or an array of either — ' +
    'OR semantics; unknown names return an empty set). ' +
    'Token discipline: use list (projection) to browse/triage many issues, and ' +
    'get for the single full issue you are about to work on. When forge_step_start ' +
    'returned a lean manifest (bodyTruncated:true), pull only the fields you need ' +
    'via get with fields:[...] (e.g. { action:"get", documentId, fields:["plan"] }). ' +
    'Do NOT re-get an issue whose full body you already loaded this session. ' +
    'mark_merged (data.issueId + data.target<feature|base|prod> + optional ' +
    'data.mergedAt ISO + data.note) idempotently stamps issues.merged_at via ' +
    'COALESCE (a repeat call keeps the first timestamp), writes an audit ' +
    'comment, broadcasts the issue update, and wakes the dispatcher so a ' +
    'now-unblocked parent (blocks-gate) dispatches promptly. target is an ' +
    'audit label only — all values stamp the same merged_at column. unmark ' +
    '(data.issueId + optional data.note) clears merged_at back to NULL to ' +
    're-block children when an epic merge is rolled back. ' +
    'Project scope is derived from the X-Forge-Project-Slug header (or an ' +
    'explicit projectId). Status changes route through the issue state machine. ' +
    'Use status:on_hold for a deliberate pause, or status:waiting to park an ' +
    'issue for human review. ' +
    'Attachments: for anything bigger than a tiny snippet use the forge_uploads tool ' +
    '(presigned-URL pattern) instead of base64 — base64 in data.attachments[] is slow ' +
    'and burns context tokens. Workflow: (1) create the issue to get its id; (2) call ' +
    'forge_uploads {action:"request", data:{target:"issue", targetId:<id>, name:"<file>"}} ' +
    '→ get an uploadUrl; (3) `curl -X PUT -T <localPath> "<uploadUrl>"` (no auth header). ' +
    'The PUT returns {id,name,mime,size,url}; reference the url in the body. ' +
    'data.attachments[] (base64-inline; up to 10, total ≤ UPLOADS_MAX_BYTES) still works ' +
    'for tiny inline files and on partial-failure returns `attachments` (succeeded) + ' +
    '`attachmentErrors` (code/message). ' +
    'Task sub-actions: createTask requires data.issueId + data.taskTitle; listTasks ' +
    'requires filters.issue and accepts filters.taskStatus; updateTask/deleteTask ' +
    'use documentId as the task UUID. Tasks inherit project membership from the ' +
    'parent issue. ' +
    'Atomic relations (ISS-571): pass data.relations (optional array, max 20) at ' +
    'create time to insert dependency edges BEFORE issueCreated fires — this closes ' +
    'the race where the dispatcher picks up the new issue before a subsequent ' +
    'forge_project_pm set_dependency call can land. Each entry requires kind ' +
    '(blocks|relates, default blocks) and exactly one of dependsOnId (new issue is ' +
    'blocked-by it) or blocksId (new issue blocks it). For decomposes edges, use ' +
    'forge_project_pm set_dependency kind=decomposes directly. Draft-first fallback: ' +
    'create with status:draft, set deps, then transition to open — draft issues are ' +
    'never dispatched, so the edge is always present before the issue enters the ' +
    'pipeline.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { device, principal } = ctx;

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsMember(principal, projectId);

        const conds = [eq(issues.projectId, projectId)];
        const f = input.filters;
        if (f?.status) conds.push(eq(issues.status, f.status));
        if (f?.statusNot) conds.push(ne(issues.status, f.statusNot));
        if (f?.priority) conds.push(eq(issues.priority, f.priority));
        if (f?.category) conds.push(eq(issues.category, f.category));
        if (f?.createdAfter) {
          conds.push(gte(issues.createdAt, parseDate(f.createdAfter, 'createdAfter')));
        }
        if (f?.createdBefore) {
          conds.push(lt(issues.createdAt, parseDate(f.createdBefore, 'createdBefore')));
        }
        if (f?.updatedAfter) {
          conds.push(gte(issues.updatedAt, parseDate(f.updatedAfter, 'updatedAfter')));
        }
        if (f?.search) {
          const q = `%${f.search}%`;
          const titleMatch = ilike(issues.title, q);
          const descMatch = ilike(issues.description, q);
          const orExpr = or(titleMatch, descMatch);
          if (orExpr) conds.push(orExpr);
        }

        if (f?.label !== undefined && f.label !== null) {
          const rawValues = Array.isArray(f.label) ? f.label : [f.label];
          const uuidPattern =
            /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
          const uuidValues = rawValues.filter((v) => uuidPattern.test(v));
          const nameValues = rawValues.filter((v) => !uuidPattern.test(v));

          let resolvedIds = [...uuidValues];
          if (nameValues.length > 0) {
            const nameRows = await db
              .select({ id: labels.id })
              .from(labels)
              .where(and(eq(labels.projectId, projectId), inArray(labels.name, nameValues)))
              .limit(nameValues.length + 1);
            resolvedIds = [...new Set([...resolvedIds, ...nameRows.map((r) => r.id)])];
          }

          if (resolvedIds.length === 0) {
            // Caller supplied a label filter but no ids resolved (unknown name or empty input).
            return { issues: [] };
          }

          conds.push(
            exists(
              db
                .select({ one: sql`1` })
                .from(issueLabels)
                .where(
                  and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, resolvedIds)),
                ),
            ),
          );
        }

        // ISS-562 — SQL-level light-column projection: never load heavy TOAST
        // columns (description/plan/acceptanceCriteria/sessionContext/ai*/
        // releaseNotes) from disk. serializeListRow already omits them at the
        // JS layer (ISS-428), but a bare db.select() still reads them from
        // Postgres. This aligns the DB query with the serializer projection.
        const rows = await db
          .select({
            id: issues.id,
            issSeq: issues.issSeq,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            category: issues.category,
            complexity: issues.complexity,
            assigneeId: issues.assigneeId,
            parentIssueId: issues.parentIssueId,
            reopenCount: issues.reopenCount,
            mergedAt: issues.mergedAt,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(and(...conds))
          .orderBy(desc(issues.updatedAt))
          .limit(input.limit ?? 25);

        // Hard total-response cap: trim from the tail (oldest) until the
        // serialized payload fits MAX_RESPONSE_CHARS. Newest-first ordering
        // means trimming the tail keeps the most-recent issues. Always keep
        // at least one issue.
        const serialized = rows.map((r) => serializeListRow(r));
        let keptIssues = serialized;
        while (
          keptIssues.length > 1 &&
          JSON.stringify({ issues: keptIssues }).length > MAX_RESPONSE_CHARS
        ) {
          keptIssues = keptIssues.slice(0, -1);
        }

        if (keptIssues.length < serialized.length) {
          return {
            issues: keptIssues,
            truncated: true,
            returned: keptIssues.length,
            requested: input.limit ?? 25,
            notice: `Response truncated to the ${keptIssues.length} most recent of ${serialized.length} issues to stay under the MCP output cap. Add status/priority/category filters or use a smaller limit.`,
          };
        }
        return { issues: keptIssues };
      }

      case 'get': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for get');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsMember(principal, issue.projectId);
        if (input.fields && input.fields.length > 0) {
          // Field-selective projection: pick from the already-framed serialize()
          // output so markUntrusted DATA banners are preserved on untrusted fields
          // (description/acceptanceCriteria). Never project from the raw row.
          const full = serialize(issue);
          const projected: Record<string, unknown> = {
            documentId: full.documentId,
            issueId: full.issueId,
          };
          for (const field of input.fields) {
            projected[field] = full[field] ?? null;
          }
          return projected;
        }
        return serializeWithAttachments(issue);
      }

      case 'create': {
        if (!input.data?.title) throw new Error('BAD_REQUEST: data.title is required for create');
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsWriter(principal, projectId);

        // ISS-130 — narrow allow-list for entry status. `open` is the normal
        // triage entry, `on_hold` is the decomposition parking state, and
        // ISS-236 adds `draft` for AI-generated proposals that wait for human
        // promote/discard before entering the pipeline. Anything else must go
        // through the transition action so the state machine + activity log run.
        const createStatus: IssueStatus = input.data.status ?? 'open';
        if (createStatus !== 'open' && createStatus !== 'on_hold' && createStatus !== 'draft') {
          throw new Error(
            `BAD_REQUEST: status at create must be 'open', 'on_hold', or 'draft' (got '${createStatus}'); use the transition action for other statuses`,
          );
        }

        // Decode + size-cap attachments BEFORE insert so a bad payload doesn't
        // leave a half-created issue with no files.
        let decodedAttachments: DecodedAttachment[] = [];
        if (input.data.attachments && input.data.attachments.length > 0) {
          try {
            decodedAttachments = decodeAndValidateAttachments(input.data.attachments);
          } catch (err) {
            if (err instanceof AttachmentError) {
              throw new Error(`${err.code}: ${err.message}`);
            }
            throw err;
          }
        }

        const [inserted] = await db
          .insert(issues)
          .values({
            projectId,
            title: input.data.title,
            description: input.data.description ?? null,
            status: createStatus,
            priority: input.data.priority ?? 'medium',
            category: input.data.category ?? null,
            complexity: input.data.complexity ?? null,
            createdById: device.ownerId,
            plan: input.data.plan ?? null,
            acceptanceCriteria: input.data.acceptanceCriteria ?? null,
            suggestedSolution: input.data.suggestedSolution ?? null,
            sessionContext: input.data.sessionContext ?? null,
            aiSummary: input.data.aiSummary ?? null,
            aiSuggestedSolution: input.data.aiSuggestedSolution ?? null,
            aiAcceptanceCriteria: input.data.aiAcceptanceCriteria ?? null,
            aiConfidence: input.data.aiConfidence ?? null,
            releaseNotes: input.data.releaseNotes ?? null,
          })
          .returning();
        if (!inserted) throw new Error('issues: insert returned no row');

        const created = inserted as IssueRow;

        // ISS-571 — insert dependency edges BEFORE issueCreated fires.
        // issueCreated is the synchronous trigger for considerEnqueue→dispatch,
        // so edges committed here are visible to the L2 dispatch gate on the
        // very first tick with no race window.
        if (input.data?.relations && input.data.relations.length > 0) {
          for (const rel of input.data.relations) {
            const fromIssueId = rel.dependsOnId ?? created.id;
            const toIssueId = rel.dependsOnId != null ? created.id : rel.blocksId!;
            await pmSetDependencyHandler(device, {
              projectId,
              fromIssueId,
              toIssueId,
              kind: rel.kind,
              reason: rel.reason,
              validUntil: rel.validUntil,
            });
          }
        }

        await hooks.emit('issueCreated', {
          issueId: created.id,
          projectId: created.projectId,
          actor: { type: 'device' as const, id: device.id },
          status: created.status,
          snapshot: {
            title: created.title,
            description: created.description,
            priority: created.priority,
            category: created.category,
            reportedBy: created.reportedBy,
            assigneeId: created.assigneeId,
            labels: [],
          },
        });

        const result: Record<string, unknown> = serialize(created);
        if (decodedAttachments.length > 0) {
          const { persisted, errors } = await persistDecodedIssueAttachments(
            created.id,
            decodedAttachments,
            device.ownerId,
          );
          result.attachments = persisted;
          if (errors.length > 0) result.attachmentErrors = errors;
        }
        return result;
      }

      case 'update': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for update');
        if (!input.data) throw new Error('BAD_REQUEST: data is required for update');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // Status changes always route through the state machine so the
        // transitions stay aligned with REST `/transition` (reopen-cap +
        // illegal-transition guards). The hook + WS broadcast match too.
        // ISS-596: when `data.unblock:true` is set on an `on_hold → *` update,
        // thread `reason:'operator_unblock'` so the orchestrator's ISS-411
        // hard-stop lets the transition re-engage the pipeline.
        if (input.data.status && input.data.status !== issue.status) {
          const useOperatorUnblock =
            input.data.unblock === true &&
            issue.status === 'on_hold' &&
            input.data.status !== 'on_hold';
          await applyStatusTransition(
            issue,
            input.data.status,
            device,
            useOperatorUnblock ? { reason: 'operator_unblock' } : {},
          );
        }

        const updates: Record<string, unknown> = {};
        if (input.data.title !== undefined) updates.title = input.data.title;
        if (input.data.description !== undefined) updates.description = input.data.description;
        if (input.data.priority !== undefined) updates.priority = input.data.priority;
        if (input.data.category !== undefined) updates.category = input.data.category;
        if (input.data.complexity !== undefined) updates.complexity = input.data.complexity;
        if (input.data.plan !== undefined) updates.plan = input.data.plan;
        if (input.data.acceptanceCriteria !== undefined) {
          updates.acceptanceCriteria = input.data.acceptanceCriteria;
        }
        if (input.data.suggestedSolution !== undefined) {
          updates.suggestedSolution = input.data.suggestedSolution;
        }
        if (input.data.sessionContext !== undefined) {
          updates.sessionContext = input.data.sessionContext;
        }
        if (input.data.aiSummary !== undefined) updates.aiSummary = input.data.aiSummary;
        if (input.data.aiSuggestedSolution !== undefined) {
          updates.aiSuggestedSolution = input.data.aiSuggestedSolution;
        }
        if (input.data.aiAcceptanceCriteria !== undefined) {
          updates.aiAcceptanceCriteria = input.data.aiAcceptanceCriteria;
        }
        if (input.data.aiConfidence !== undefined) {
          updates.aiConfidence = input.data.aiConfidence;
        }
        if (input.data.releaseNotes !== undefined) {
          updates.releaseNotes = input.data.releaseNotes;
        }

        if (Object.keys(updates).length > 0) {
          // Use sql`now()` (matching applyStatusTransition above) so a
          // combined status+fields update has a single canonical timestamp
          // source rather than mixing JS Date and DB now().
          updates.updatedAt = sql`now()`;
          await db.transaction(async (tx) => {
            await tx.update(issues).set(updates).where(eq(issues.id, issue.id));
          });
        }

        const fresh = await loadIssue(issue.id);
        return { ...(await serializeWithAttachments(fresh)), status: 'updated' };
      }

      case 'transition': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId is required for transition');
        }
        const target = input.data?.status;
        if (!target) throw new Error('BAD_REQUEST: data.status is required for transition');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsWriter(principal, issue.projectId);
        await applyStatusTransition(issue, target, device);
        const fresh = await loadIssue(issue.id);
        return serializeWithAttachments(fresh);
      }

      // ISS-286 — explicit, idempotent, auditable merge-marker. Decouples
      // `merged_at` from the implicit `markMergedIfLeavingBase` side-effect so
      // a skill can stamp the merge directly after verifying a push (epic /
      // feature-branch barrier: a `blocks` parent is gated on every child's
      // `merged_at IS NOT NULL` — see jobs/dispatch-gates.ts blockedBy).
      case 'mark_merged': {
        const issueId = input.data?.issueId;
        if (!issueId) {
          throw new Error('BAD_REQUEST: data.issueId is required for mark_merged');
        }
        const target = input.data?.target;
        if (!target) {
          throw new Error('BAD_REQUEST: data.target is required for mark_merged');
        }
        const issue = await loadIssue(issueId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // COALESCE keeps the first stamp: a second mark_merged call is a no-op
        // on the timestamp (AC2 idempotency). `mergedAt` overrides the default
        // server `now()`. `target` is an audit label only — trunk-based v2 has
        // a single merge column (no `merged_to_prod_at` until v3).
        const stamp = input.data?.mergedAt ? parseDate(input.data.mergedAt, 'mergedAt') : null;
        // Bind the explicit stamp as an ISO string with a `::timestamptz`
        // cast. A bare `sql`${date}`` binds an untyped parameter, and Postgres
        // cannot infer its type inside COALESCE("merged_at", $1) — it errors
        // "could not determine data type of parameter" (live 500 on forge-beta
        // for the mergedAt-supplied path). The cast pins the type.
        const stampExpr = stamp ? sql`${stamp.toISOString()}::timestamptz` : sql`now()`;
        await db
          .update(issues)
          .set({ mergedAt: sql`COALESCE(${issues.mergedAt}, ${stampExpr})`, updatedAt: sql`now()` })
          .where(eq(issues.id, issueId));

        const note = input.data?.note;
        const body = `mark_merged target=${target}${note ? ` — ${note}` : ''}`;
        const [auditComment] = await db
          .insert(comments)
          .values({ issueId, authorId: device.ownerId, body, parentId: null })
          .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
        if (auditComment) {
          await hooks.emit('commentCreated', {
            issueId,
            projectId: issue.projectId,
            actor: { type: 'device', id: device.id },
            commentId: auditComment.id,
            body: auditComment.body,
            parentId: auditComment.parentId,
          });
        }

        const fresh = await loadIssue(issueId);
        await hooks.emit('issueUpdated', {
          issueId,
          projectId: issue.projectId,
          actor: { type: 'device', id: device.id },
          fields: ['mergedAt'],
          before: { mergedAt: issue.mergedAt },
          after: { mergedAt: fresh.mergedAt },
        });
        // Wake the dispatcher so a now-unblocked parent dispatches within ~1s
        // instead of waiting for the 60s pg-boss backstop (AC3).
        void dispatchTickForProject(issue.projectId);

        return { ...(await serializeWithAttachments(fresh)), status: 'merged' };
      }

      case 'unmark': {
        const issueId = input.data?.issueId;
        if (!issueId) {
          throw new Error('BAD_REQUEST: data.issueId is required for unmark');
        }
        const issue = await loadIssue(issueId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // Clearing `merged_at` re-blocks downstream children (AC4 — supports
        // rolling back an epic whose merge was reverted).
        await db
          .update(issues)
          .set({ mergedAt: null, updatedAt: sql`now()` })
          .where(eq(issues.id, issueId));

        const note = input.data?.note;
        const body = `unmark${note ? ` — ${note}` : ''}`;
        const [auditComment] = await db
          .insert(comments)
          .values({ issueId, authorId: device.ownerId, body, parentId: null })
          .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
        if (auditComment) {
          await hooks.emit('commentCreated', {
            issueId,
            projectId: issue.projectId,
            actor: { type: 'device', id: device.id },
            commentId: auditComment.id,
            body: auditComment.body,
            parentId: auditComment.parentId,
          });
        }

        const fresh = await loadIssue(issueId);
        await hooks.emit('issueUpdated', {
          issueId,
          projectId: issue.projectId,
          actor: { type: 'device', id: device.id },
          fields: ['mergedAt'],
          before: { mergedAt: issue.mergedAt },
          after: { mergedAt: null },
        });
        // No dispatcher tick: clearing only adds a block, never unblocks.

        return { ...(await serializeWithAttachments(fresh)), status: 'unmarked' };
      }

      case 'listTasks': {
        const issueId = input.filters?.issue;
        if (!issueId) throw new Error('BAD_REQUEST: filters.issue required for listTasks');
        const projectId = await loadIssueProjectId(issueId);
        await assertPrincipalIsMember(principal, projectId);

        const where = input.filters?.taskStatus
          ? and(eq(tasks.issueId, issueId), eq(tasks.status, input.filters.taskStatus))
          : eq(tasks.issueId, issueId);

        // ISS-562 — SQL-level projection: omit description (up to 50KB each)
        // so the list query never loads heavy TOAST content from disk. Default
        // limit lowered 100→25 (100 tasks × 50KB = 5MB theoretical max).
        const rows = await db
          .select({
            id: tasks.id,
            issueId: tasks.issueId,
            projectId: tasks.projectId,
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            assigneeId: tasks.assigneeId,
            isAgentTask: tasks.isAgentTask,
            agentStatus: tasks.agentStatus,
            acceptanceCriteria: tasks.acceptanceCriteria,
            createdAt: tasks.createdAt,
            updatedAt: tasks.updatedAt,
          })
          .from(tasks)
          .where(where)
          .orderBy(asc(tasks.createdAt))
          .limit(input.limit ?? 25);

        // Hard total-response cap: trim from the front (oldest) until the
        // serialized payload fits MAX_RESPONSE_CHARS. Oldest-first ordering
        // means trimming the front keeps the newest tasks. Always keep at
        // least one task.
        const tasksSerialized = rows.map((r) => serializeTaskListRow(r));
        let keptTasks = tasksSerialized;
        while (
          keptTasks.length > 1 &&
          JSON.stringify({ tasks: keptTasks }).length > MAX_RESPONSE_CHARS
        ) {
          keptTasks = keptTasks.slice(1);
        }

        if (keptTasks.length < tasksSerialized.length) {
          return {
            tasks: keptTasks,
            truncated: true,
            returned: keptTasks.length,
            requested: input.limit ?? 25,
            notice: `Response truncated to the ${keptTasks.length} most recent of ${tasksSerialized.length} tasks to stay under the MCP output cap. Use a smaller limit or fetch tasks individually.`,
          };
        }
        return { tasks: keptTasks };
      }

      case 'createTask': {
        const data = input.data;
        if (!data?.issueId) throw new Error('BAD_REQUEST: data.issueId required for createTask');
        if (!data.taskTitle) throw new Error('BAD_REQUEST: data.taskTitle required for createTask');
        const projectId = await loadIssueProjectId(data.issueId);
        await assertPrincipalIsWriter(principal, projectId);

        const [created] = await db
          .insert(tasks)
          .values({
            issueId: data.issueId,
            projectId,
            title: data.taskTitle,
            description: data.taskDescription ?? null,
            status: data.taskStatus ?? 'backlog',
            priority: data.taskPriority ?? 'none',
            isAgentTask: data.isAgentTask ?? false,
            acceptanceCriteria: data.taskAcceptanceCriteria ?? null,
          })
          .returning();

        return { task: serializeTask(created as TaskRow) };
      }

      case 'updateTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for updateTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);

        const data = input.data ?? {};
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (data.taskTitle !== undefined) updates.title = data.taskTitle;
        if (data.taskDescription !== undefined) updates.description = data.taskDescription;
        if (data.taskStatus !== undefined) updates.status = data.taskStatus;
        if (data.taskPriority !== undefined) updates.priority = data.taskPriority;
        if (data.isAgentTask !== undefined) updates.isAgentTask = data.isAgentTask;
        if (data.taskAcceptanceCriteria !== undefined) {
          updates.acceptanceCriteria = data.taskAcceptanceCriteria;
        }

        const [updated] = await db
          .update(tasks)
          .set(updates)
          .where(eq(tasks.id, input.documentId))
          .returning();

        return { task: serializeTask(updated as TaskRow) };
      }

      case 'deleteTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for deleteTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);
        await db.delete(tasks).where(eq(tasks.id, input.documentId));
        return { deleted: true, documentId: input.documentId };
      }
    }
  },
});
