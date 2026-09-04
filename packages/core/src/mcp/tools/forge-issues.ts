import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BodyInvalidError } from '../../body/errors.js';
import { BODY_FORMATS } from '../../body/formats.js';
import { bodySlots, bodyText } from '../../body/prepare.js';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  taskStatuses,
  waitingKinds,
} from '../../db/schema.js';
import { actorAgency } from '../../issues/actor-agency.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import { AttachmentError, listIssueAttachments } from '../../issues/attachment-service.js';
import { createIssue, IssueCreateError } from '../../issues/create-service.js';
import { loadIssueRelations } from '../../issues/dependency-read.js';
import { isValidDetectorKey } from '../../issues/detector-key.js';
import {
  LabelResolutionError,
  listIssueLabels,
  resolveLabelIdsForWrite,
} from '../../issues/label-service.js';
import { type IssueListRow, listIssueRows } from '../../issues/list-service.js';
import { applyMergeMarker, MergeMarkerError } from '../../issues/merge-marker.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from '../../issues/patch-fields.js';
import { findIssueById, findIssueProjectId, type IssueRow } from '../../issues/read-service.js';
import { applyIssueRelations, issueRelationInputSchema } from '../../issues/relations-service.js';
import { ReleaseNotesSchema } from '../../issues/release-notes.js';
import { sessionContextSchema } from '../../issues/session-context.js';
import { updateIssueFields } from '../../issues/update-service.js';
import { markUntrusted, sanitizeUntrusted } from '../../prompt/sanitize.js';
import {
  createTask as createTaskRow,
  deleteTask as deleteTaskRow,
  findTaskById,
  listTasksForIssue,
  type TaskListRow,
  type TaskRow,
  updateTask as updateTaskRow,
} from '../../tasks/task-service.js';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalActor,
  principalHookActor,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

// cm:edge lockstep -> packages/core/src/issues/create-service.ts — every error the create service can raise needs a case here; the agent-facing contract is the `CODE: message` prefix, and the UPDATE path routes its label resolution through this same mapper
function toMcpIssueError(err: unknown): unknown {
  // cm:guard the refusal reaches the agent with the ELEMENT, ATTRIBUTE and legal set intact — that named message is what it corrects from on the next call, and a generic BAD_REQUEST leaves it guessing
  if (err instanceof BodyInvalidError) return new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
  if (err instanceof LabelResolutionError) {
    return new Error(
      `BAD_REQUEST: one or more labels do not exist in this project (no auto-create): ${err.missing.join(', ')}`,
    );
  }
  if (err instanceof AttachmentError) return new Error(`${err.code}: ${err.message}`);
  if (err instanceof IssueCreateError) {
    if (err.code === 'INVALID_DETECTOR_KEY') {
      return new Error(
        `BAD_REQUEST: data.detectorKey must be lowercase slash-separated slugs, max 120 chars (got '${err.value}')`,
      );
    }
    return new Error(
      `BAD_REQUEST: status at create must be 'open', 'on_hold', or 'draft' (got '${err.value}'); use the transition action for other statuses`,
    );
  }
  return err;
}

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

const dataObject = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    // cm:edge contract -> packages/core/src/body/formats.ts — ISS-898. Optional; absent means `markdown`, which is what keeps every shipped template's `forge_issues → create` example valid unchanged.
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    // cm:why setting this on create makes the kernel guarantee at most one live issue per (project, detectorKey) — see issues/detector-key.ts
    detectorKey: z.string().trim().min(1).max(120).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    // sessionContext is opaque JSON the skill pipeline uses to persist
    // accumulated context across sessions. Validated as a record here with a
    // serialised-size ceiling matched to `plan` so a single issue cannot blow
    // up TOAST or query plans (Postgres jsonb has no per-column limit, so we
    // enforce one in app code). Deeper schema lives in the skill spec.
    sessionContext: sessionContextSchema,
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
    relations: z.array(issueRelationInputSchema).max(20).optional(),
    // cm:guard REQUIRED on any status write that enters `reopen` (RFC 0002 INV-8) — it is posted as a comment before the flip and is what the fix step scopes its patch against; `note` is accepted as a fallback so a caller that already explains itself there is not rejected
    reason: z.string().trim().min(1).max(10_000).optional(),
    // cm:guard say WHICH kind whenever you write `waiting` (RFC 0002 INV-5) — core never derives it, so an omitted kind leaves the board rendering "a human is needed" with no hint of what is being asked; it is cleared automatically on any exit
    waitingKind: z.enum(waitingKinds).optional(),
    // ISS-633 — plain label attach/detach. Accepts label NAMES or UUIDs,
    // resolved server-side (strict: unknown -> BAD_REQUEST, no auto-create).
    // REPLACE-SET semantics mirroring REST: this is the full desired label
    // set for the issue — [] clears all, undefined means "no change". Read
    // an issue's current `labels[]` (get/step_start) before sending a delta
    // to avoid clobbering the existing set.
    labels: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .strict();

// cm:edge contract -> packages/core/skills — the bundled skill markdown hand-writes `forge_issues → update → { data: { ... } }` payloads, and this object is `.strict()`, so a key named in a skill but absent here fails the whole call (the `status` write included) with a 400; `builtin-seed-field-names.test.ts` asserts the two sides agree.
export const ISSUE_UPDATE_DATA_KEYS = Object.keys(dataObject.shape);

const dataSchema = dataObject.optional();

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
  'sessionContext',
] as const;

// cm:why derived from STEP_START_HEAVY_FIELDS rather than listed again, so the fields lean `step_start` omits are exactly the ones `get` can ask back for; `releaseNotes` is the one addition — small enough to be worth fetching alone
const GET_SELECTABLE_FIELDS = [...STEP_START_HEAVY_FIELDS, 'releaseNotes'] as const;

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

export type { IssueRow };

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

// cm:guard ISS-532 — human/external free-text reaching an agent must be framed by `markUntrusted`, never merely char-stripped: `sanitizeUntrusted` neutralizes invisible/bidi smuggling but does NOT tell the model the span is data, so a field promoted from agent-authored to human-authored and left on char-strip becomes an injection surface. REST/web-v2 serialize separately, so the human UI never shows the framing.
export function serialize(row: IssueRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    title: markUntrusted(row.title, { source: 'issue.title' }),
    // cm:guard ISS-898 — the description reaches the agent PROJECTED, not as raw markup. Under thin-init `prompt/user.ts` inlines only the title, so THIS is the path a description actually travels; handing over raw HTML would spend the caller's context on tag names and shrink what the 8,000-char cap can hold, which is the gap the projection exists to close.
    description:
      row.description == null
        ? null
        : markUntrusted(bodyText(row.description, row.descriptionFormat), {
            source: 'issue.description',
          }),
    descriptionFormat: row.descriptionFormat,
    descriptionTemplate: row.descriptionTemplate,
    descriptionSlots: row.descriptionTemplate
      ? bodySlots(row.description ?? '', row.descriptionFormat)
      : null,
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    plan: row.plan == null ? null : sanitizeUntrusted(row.plan),
    acceptanceCriteria:
      row.acceptanceCriteria == null
        ? null
        : markUntrusted(row.acceptanceCriteria, { source: 'issue.acceptanceCriteria' }),
    sessionContext: sanitizeDeep(row.sessionContext),
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * ISS-428 — body-free projection for the `list` (browse) surface. Returns only
 * light scalar fields and OMITS the heavy bodies (`description`, `plan`,
 * `acceptanceCriteria`, `sessionContext`, `releaseNotes`) so a list over many
 * populated issues never overflows the MCP
 * token cap. Heavy fields stay reachable per-issue via `action=get`. Do NOT
 * widen this back to `serialize()`.
 */

function serializeListRow(row: IssueListRow): Record<string, unknown> {
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
    reopenCount: row.reopenCount,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadIssue(documentId: string): Promise<IssueRow> {
  const row = await findIssueById(documentId);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row;
}

/**
 * `serialize` + the issue's attachment metadata (`attachments[]`). Used by the
 * focused single-issue surfaces an agent acts on — `get`, the write-returns,
 * and `forge_step_start` (under-threshold path) — so the agent always sees
 * which files are attached (then reads bytes via `forge_uploads` action=fetch).
 * NOT used by `list` (summary/browse) to avoid an attachment query per row.
 */
export async function serializeWithAttachments(row: IssueRow): Promise<Record<string, unknown>> {
  const [attachments, issueLabelsList] = await Promise.all([
    listIssueAttachments(row.id),
    listIssueLabels(row.id),
  ]);
  return { ...serialize(row), attachments, labels: issueLabelsList };
}

/** Sum of char lengths across all non-null heavy fields for threshold gating. */
export function heavyFieldChars(row: IssueRow): number {
  let total = 0;
  if (row.description != null) total += row.description.length;
  if (row.plan != null) total += row.plan.length;
  if (row.acceptanceCriteria != null) total += row.acceptanceCriteria.length;
  if (row.sessionContext != null) total += JSON.stringify(row.sessionContext).length;
  return total;
}

/**
 * Lean manifest — light scalars + `bodyManifest` (field → {chars} | null)
 * + `bodyTruncated: true`. Used by forge_step_start when heavy fields exceed
 * the threshold. Agents fetch fields they need via
 * `forge_issues.get { documentId, fields: ['plan', ...] }`.
 *
 * Heavy fields are NOT emitted — only their sizes. Title framing is preserved
 * (still needed for orientation). releaseNotes is a small scalar and remains
 * inline.
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
    reopenCount: row.reopenCount,
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bodyTruncated: true as const,
    bodyManifest: {
      description: row.description != null ? { chars: row.description.length } : null,
      plan: row.plan != null ? { chars: row.plan.length } : null,
      acceptanceCriteria:
        row.acceptanceCriteria != null ? { chars: row.acceptanceCriteria.length } : null,
      sessionContext:
        row.sessionContext != null ? { chars: JSON.stringify(row.sessionContext).length } : null,
    },
  };
}

/** `serializeManifest` + attachment metadata. Used by forge_step_start over-threshold path. */
export async function serializeManifestWithAttachments(
  row: IssueRow,
): Promise<Record<string, unknown>> {
  const [attachments, issueLabelsList] = await Promise.all([
    listIssueAttachments(row.id),
    listIssueLabels(row.id),
  ]);
  return { ...serializeManifest(row), attachments, labels: issueLabelsList };
}

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
function serializeTaskListRow(row: TaskListRow): Record<string, unknown> {
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
  const projectId = await findIssueProjectId(issueId);
  if (!projectId) throw new Error('NOT_FOUND: issue not found');
  return projectId;
}

async function loadTaskForAccess(taskId: string): Promise<TaskRow> {
  const row = await findTaskById(taskId);
  if (!row) throw new Error('NOT_FOUND: task not found');
  return row;
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
    'plan/acceptanceCriteria/sessionContext/releaseNotes) ' +
    'to stay under the response token cap; fetch the full body with action=get. ' +
    'list supports filters.label (a label name or uuid, or an array of either — ' +
    'OR semantics; unknown names return an empty set). ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'Token discipline: use list (projection) to browse/triage many issues, and ' +
    'get for the single full issue you are about to work on. When forge_step_start ' +
    'returned a lean manifest (bodyTruncated:true), pull only the fields you need ' +
    'via get with fields:[...] (e.g. { action:"get", documentId, fields:["plan"] }). ' +
    'Do NOT re-get an issue whose full body you already loaded this session. ' +
    'On create, fill title/description/priority/category — `plan` and ' +
    '`acceptanceCriteria` are written by the clarify/plan steps; pre-filling them ' +
    "deletes the plan step's reason to exist (red flag: plan-by-hand). Keep the " +
    'description a requirements contract (outcome, business rules, invariants, ' +
    'out-of-scope) — not an implementation script naming files, endpoints or ' +
    '"follow the pattern at <path>"; those claims go stale and outrank live ' +
    'exploration in practice. See guides pipeline-and-issue-lifecycle and writing-an-issue (body shape; mermaid fences render; ATTACH .html, never paste it into description). ' +
    'mark_merged (data.issueId + data.target<feature|base|prod> + optional ' +
    'data.mergedAt ISO + data.note) idempotently stamps issues.merged_at via ' +
    'COALESCE (a repeat call keeps the first timestamp), writes an audit ' +
    'comment, broadcasts the issue update, and wakes the dispatcher so a ' +
    'now-unblocked parent (blocks-gate) dispatches promptly. target is an ' +
    'audit label only — all values stamp the same merged_at column. unmark ' +
    '(data.issueId + optional data.note) clears merged_at back to NULL to ' +
    're-block children when an epic merge is rolled back. ' +
    'Transitioning an issue to closed auto-stamps merged_at when still NULL ' +
    '(closed = done for the blocks-gate); if a close meant "abandoned, code ' +
    'never landed", follow up with unmark to re-block dependents. ' +
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
    'Relations (ISS-571, ISS-868): data.relations (optional array, max 20) is applied by ' +
    'BOTH create and update, and works with a personal access token — unlike ' +
    'forge_project_pm set_dependency, which needs a paired device. Edges commit before ' +
    // cm:edge naming -> packages/core/src/issues/relations-service.ts — this prose spells the kind vocabulary out for the agent, so it is a second copy of RELATION_KINDS that no type checks; the guard there forbids widening, and if that ever changes this sentence is the other half
    'the dispatch trigger (issueCreated on create, the status transition on update), so ' +
    'the dispatcher cannot pick the issue up ahead of its blocker. Each entry takes kind ' +
    '(blocks|relates, default blocks) and exactly one of dependsOnId (THIS issue is ' +
    'blocked-by it) or blocksId (THIS issue blocks it). The response carries a relations[] ' +
    'array — one entry per edge with edgeId + created/updated — so you can tell the write ' +
    'landed; re-send an existing edge with validUntil in the past to RETRACT it ' +
    '(reported as updated:true). For the other kinds, use forge_project_pm ' +
    'set_dependency directly. Read edges back with action=get, which ' +
    'returns relations.blocks (this issue blocks them) and relations.blockedBy (they ' +
    'block this issue), each entry flagged `expired` when its validUntil has passed and ' +
    'the edge no longer gates dispatch. ' +
    'Labels (ISS-633): data.labels (create/update) accepts an array of label NAMES or ' +
    'UUIDs, resolved server-side against the current project — an unknown name/uuid ' +
    '(or one from another project) throws BAD_REQUEST; labels are never auto-created. ' +
    'On update this is a REPLACE-SET, NOT additive: it is the full desired label set for ' +
    'the issue — [] clears every label, and omitting data.labels leaves labels unchanged. ' +
    "Read the issue's current labels[] (present on get/create/update responses and the " +
    'forge_step_start bundle) before sending a delta, or you will clobber the existing set.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { device, principal } = ctx;

    // cm:guard `data` is ONE shared schema across all 11 actions, so a field only `create`/`update` apply is accepted and dropped by the other nine — refuse it by name here rather than returning 200 on a write that did nothing (ISS-868). `transition` is the dangerous one: it wakes considerEnqueue→dispatch, so a discarded `blocks` edge ships the dependent ahead of its blocker.
    if (
      input.data?.relations !== undefined &&
      input.action !== 'create' &&
      input.action !== 'update'
    ) {
      throw new Error(
        `BAD_REQUEST: data.relations is applied only by action 'create' and 'update' (got '${input.action}') — send the edges on the create/update call that carries them`,
      );
    }

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsMember(principal, projectId);

        const issuesLimit = input.limit ?? 25;
        const f = input.filters;
        const rows = await listIssueRows(
          projectId,
          {
            status: f?.status,
            statusNot: f?.statusNot,
            priority: f?.priority,
            category: f?.category,
            createdAfter: f?.createdAfter ? parseDate(f.createdAfter, 'createdAfter') : undefined,
            createdBefore: f?.createdBefore
              ? parseDate(f.createdBefore, 'createdBefore')
              : undefined,
            updatedAfter: f?.updatedAfter ? parseDate(f.updatedAfter, 'updatedAfter') : undefined,
            search: f?.search,
            label:
              f?.label === undefined || f.label === null
                ? undefined
                : Array.isArray(f.label)
                  ? f.label
                  : [f.label],
          },
          overfetch(issuesLimit),
        );

        return buildListEnvelope({
          key: 'issues',
          limit: issuesLimit,
          hint: 'add status/priority/category/label filters',
          items: rows.map((r) => serializeListRow(r)),
        });
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
        // cm:edge contract -> packages/core/src/issues/dependency-read.ts — the ONLY read path an agent has onto its own edges; REST GET /api/issues/:id/dependencies is JWT-only, so without this a token that can write an edge still cannot verify one landed
        const [full, relations] = await Promise.all([
          serializeWithAttachments(issue),
          loadIssueRelations(issue.id, issue.projectId),
        ]);
        return { ...full, relations };
      }

      case 'create': {
        if (!input.data?.title) throw new Error('BAD_REQUEST: data.title is required for create');
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsWriter(principal, projectId);

        let result: Awaited<ReturnType<typeof createIssue>>;
        try {
          result = await createIssue(
            { ...input.data, projectId, title: input.data.title },
            {
              createdById: device.ownerId,
              createdVia: 'mcp',
              actor: principalHookActor(principal, device),
            },
          );
        } catch (err) {
          throw toMcpIssueError(err);
        }

        if (result.deduped) {
          return {
            created: false,
            deduped: true,
            detectorKey: result.detectorKey,
            existingIssueId: result.existingIssueId,
            existingIssueDisplayId: result.existingIssueDisplayId,
            existingIssueStatus: result.existingIssueStatus,
            message:
              'A live issue already tracks this detectorKey. Nothing was created — add your finding as a comment on existingIssueId (forge_comments action=create), or extend it via forge_issues action=update.',
          } as Record<string, unknown>;
        }

        const out: Record<string, unknown> = serialize(result.issue as IssueRow);
        out.labels = result.labelIds.length > 0 ? await listIssueLabels(result.issue.id) : [];
        if (result.relations.length > 0) out.relations = result.relations;
        if (result.attachments.length > 0 || result.attachmentErrors.length > 0) {
          out.attachments = result.attachments;
          if (result.attachmentErrors.length > 0) out.attachmentErrors = result.attachmentErrors;
        }
        if (result.bodyWarnings.length > 0) out.warnings = result.bodyWarnings;
        return out;
      }
      case 'update': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for update');
        if (!input.data) throw new Error('BAD_REQUEST: data is required for update');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        // ISS-633 — resolve + strictly validate label names/uuids BEFORE the
        // tx (mirrors REST PATCH's assertLabelsInProject running before its
        // own tx). `undefined` means "no change"; `[]` clears every label.
        let labelIds: string[] | undefined;
        if (input.data.labels !== undefined) {
          try {
            labelIds = await resolveLabelIdsForWrite(issue.projectId, input.data.labels);
          } catch (err) {
            throw toMcpIssueError(err);
          }
        }

        if (input.data.detectorKey !== undefined && !isValidDetectorKey(input.data.detectorKey)) {
          throw new Error(
            `BAD_REQUEST: data.detectorKey must be lowercase slash-separated slugs, max 120 chars (got '${input.data.detectorKey}')`,
          );
        }

        let collected: ReturnType<typeof collectIssueFieldUpdates>;
        try {
          collected = collectIssueFieldUpdates(input.data as Record<string, unknown>, [
            ...SHARED_ISSUE_PATCH_FIELDS,
          ]);
        } catch (err) {
          throw toMcpIssueError(err);
        }
        const { updates, warnings: bodyWarnings } = collected;

        // cm:edge ordering -> packages/core/src/issues/transition-evidence.ts — field writes MUST commit before the status transition below, which re-reads issues.plan for PLAN_REQUIRED; reversed order throws PLAN_REQUIRED on a legal { plan, status:'approved' } call and discards the submitted plan
        // cm:edge ordering -> packages/core/src/issues/release-record-required.ts — the second reader of this order, and the reason a close needs one call rather than two: that rule re-reads issues.release_notes, so a reversed order throws RELEASE_RECORD_REQUIRED on a legal { releaseNotes, status:'closed' } and discards the note the caller just wrote to satisfy it
        if (Object.keys(updates).length > 0 || labelIds !== undefined) {
          // cm:why sql`now()`, matching transitionIssueStatus below — a combined status+fields update needs one canonical timestamp source, not a mix of JS Date and DB now()
          updates.updatedAt = sql`now()`;
          await updateIssueFields({
            issueId: issue.id,
            updates,
            labelIds,
            actor: { type: 'device', id: device.id, agency: 'agent' },
          });
        }

        // cm:edge ordering -> packages/core/src/jobs/dispatch-gates.ts — relations commit BEFORE the transition below, for the same reason create commits them before issueCreated: the transition is what wakes considerEnqueue→dispatch, so a blocks edge written after it misses the first tick and the dependent ships ahead of its blocker. This order is also the SAFE side of a partial failure, which is why the two writes are deliberately not one transaction: edges landed + transition failed leaves an extra `blocks` edge holding a job, which a human can retract, where the reverse ships a dependent ahead of its blocker and cannot be undone.
        const r = await applyIssueRelations(
          { actor: principalHookActor(principal, device), createdById: device.ownerId },
          issue.projectId,
          issue.id,
          input.data.relations,
        );

        if (input.data.status && input.data.status !== issue.status) {
          await transitionIssueStatus(issue, input.data.status, principalActor(principal, device), {
            transitionReason: input.data.reason ?? input.data.note,
            waitingKind: input.data.waitingKind,
          });
        }

        const fresh = await loadIssue(issue.id);
        // cm:guard report what the call DID under `action`, matching mark_merged/unmark below — this used to return the literal `status:'updated'` over the issue's own status enum, so a caller could not read back the status it had just written, and `relations` was parsed and silently discarded (ISS-868)
        const updateResult: Record<string, unknown> = {
          ...(await serializeWithAttachments(fresh)),
          action: 'updated',
        };
        if (bodyWarnings.length > 0) updateResult.warnings = bodyWarnings;
        if (r.length > 0) updateResult.relations = r;
        return updateResult;
      }

      case 'transition': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId is required for transition');
        }
        const target = input.data?.status;
        if (!target) throw new Error('BAD_REQUEST: data.status is required for transition');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsWriter(principal, issue.projectId);
        await transitionIssueStatus(issue, target, principalActor(principal, device), {
          transitionReason: input.data?.reason ?? input.data?.note,
          waitingKind: input.data?.waitingKind,
        });
        const fresh = await loadIssue(issue.id);
        const transitionOutput: Record<string, unknown> = await serializeWithAttachments(fresh);
        return transitionOutput;
      }

      // ISS-286 — explicit, idempotent, auditable merge-marker. Decouples
      // `merged_at` from the implicit `markMergedIfLeavingBase` side-effect so
      // a skill can stamp the merge directly after verifying a push (epic /
      // feature-branch barrier: a `blocks` parent is gated on every child's
      // `merged_at IS NOT NULL` — see jobs/dispatch-gates.ts blockedBy).
      case 'mark_merged':
      case 'unmark': {
        const issueId = input.data?.issueId;
        if (!issueId) {
          throw new Error(`BAD_REQUEST: data.issueId is required for ${input.action}`);
        }
        const marking = input.action === 'mark_merged';
        if (marking && !input.data?.target) {
          throw new Error('BAD_REQUEST: data.target is required for mark_merged');
        }
        const issue = await loadIssue(issueId);
        await assertPrincipalIsWriter(principal, issue.projectId);

        try {
          const { issue: fresh, action } = await applyMergeMarker({
            issue,
            op: marking ? 'mark' : 'unmark',
            ...(input.data?.target ? { target: input.data.target } : {}),
            ...(input.data?.note ? { note: input.data.note } : {}),
            ...(input.data?.mergedAt
              ? { mergedAt: parseDate(input.data.mergedAt, 'mergedAt') }
              : {}),
            actor: {
              agency: actorAgency(principalActor(principal, device)),
              commentAuthorId: device.ownerId,
              hookActor: principalHookActor(principal, device),
            },
          });
          // cm:guard report the ACTION under `action`, never by overwriting `status` — `merged`/`unmarked` are not `issueStatuses` members, so a caller read a lifecycle value that cannot exist (§10)
          return { ...(await serializeWithAttachments(fresh)), action };
        } catch (err) {
          if (err instanceof MergeMarkerError) throw new Error(`${err.code}: ${err.message}`);
          throw err;
        }
      }

      case 'listTasks': {
        const issueId = input.filters?.issue;
        if (!issueId) throw new Error('BAD_REQUEST: filters.issue required for listTasks');
        const projectId = await loadIssueProjectId(issueId);
        await assertPrincipalIsMember(principal, projectId);

        const tasksLimit = input.limit ?? 25;
        const rows = await listTasksForIssue(issueId, {
          status: input.filters?.taskStatus,
          limit: overfetch(tasksLimit),
        });

        return buildListEnvelope({
          key: 'tasks',
          items: rows.map((r) => serializeTaskListRow(r)),
          limit: tasksLimit,
          hint: 'filter by taskStatus, or fetch tasks individually',
          order: 'asc',
        });
      }

      case 'createTask': {
        const data = input.data;
        if (!data?.issueId) throw new Error('BAD_REQUEST: data.issueId required for createTask');
        if (!data.taskTitle) throw new Error('BAD_REQUEST: data.taskTitle required for createTask');
        const projectId = await loadIssueProjectId(data.issueId);
        await assertPrincipalIsWriter(principal, projectId);

        const created = await createTaskRow({
          issueId: data.issueId,
          projectId,
          title: data.taskTitle,
          description: data.taskDescription ?? null,
          status: data.taskStatus,
          priority: data.taskPriority,
          isAgentTask: data.isAgentTask,
          acceptanceCriteria: data.taskAcceptanceCriteria ?? null,
          actor: { type: 'device', id: device.id, agency: 'agent' },
        });

        return { task: serializeTask(created) };
      }

      case 'updateTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for updateTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);

        const data = input.data ?? {};
        const updates: Record<string, unknown> = {};
        if (data.taskTitle !== undefined) updates.title = data.taskTitle;
        if (data.taskDescription !== undefined) updates.description = data.taskDescription;
        if (data.taskStatus !== undefined) updates.status = data.taskStatus;
        if (data.taskPriority !== undefined) updates.priority = data.taskPriority;
        if (data.isAgentTask !== undefined) updates.isAgentTask = data.isAgentTask;
        if (data.taskAcceptanceCriteria !== undefined) {
          updates.acceptanceCriteria = data.taskAcceptanceCriteria;
        }

        const updated = await updateTaskRow(
          row,
          updates,
          { type: 'device', id: device.id, agency: 'agent' },
          ['acceptanceCriteria'],
        );
        if (!updated) throw new Error('NOT_FOUND: task not found');

        return { task: serializeTask(updated) };
      }

      case 'deleteTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for deleteTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);
        await deleteTaskRow(row, { type: 'device', id: device.id, agency: 'agent' });
        return { deleted: true, documentId: input.documentId };
      }
    }
  },
});
