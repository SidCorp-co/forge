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
  PrimaryModuleError,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from '../../issues/label-service.js';
import { type IssueListRow, listIssueRows } from '../../issues/list-service.js';
import {
  applyMergeMarker,
  MergeMarkerError,
  mergedCommitShaSchema,
} from '../../issues/merge-marker.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from '../../issues/patch-fields.js';
import { findIssueById, findIssueProjectId, type IssueRow } from '../../issues/read-service.js';
import { applyIssueRelations, issueRelationInputSchema } from '../../issues/relations-service.js';
import { ReleaseNotesSchema } from '../../issues/release-notes.js';
import { sessionContextExpectSchema, sessionContextSchema } from '../../issues/session-context.js';
import { SessionContextExpectMismatch, updateIssueFields } from '../../issues/update-service.js';
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
  if (err instanceof PrimaryModuleError) {
    return new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
  }
  if (err instanceof LabelResolutionError) {
    return new Error(
      `BAD_REQUEST: one or more labels do not exist in this project (no auto-create): ${err.missing.join(', ')}`,
    );
  }
  if (err instanceof AttachmentError) return new Error(`${err.code}: ${err.message}`);
  // cm:guard the CURRENT value is serialised into the message because MCP has no `details` channel — a refusal that only says "you lost" leaves the agent's one remaining move a blind unconditional overwrite, which is the write this refusal exists to stop
  if (err instanceof SessionContextExpectMismatch) {
    return new Error(
      'SESSION_CONTEXT_MISMATCH: `sessionContext` no longer holds the value this write expected — ' +
        'another writer moved it. It now holds ' +
        `${JSON.stringify(err.current)}. Decide whether your claim still stands, then send the write again with the new \`expect\`.`,
    );
  }
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
    complexity: z.enum(issueComplexities).optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    updatedAfter: z.string().optional(),
    // cm:guard `taskStatus` must stay named apart from the issue-level `status` on this one input object: collapsing the two makes a `listTasks` filter silently match `issues.status` instead
    issue: z.uuid().optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    // cm:guard a name that resolves to nothing short-circuits to an EMPTY set, never to "no filter" — the alternative hands the caller every issue in the project as the label's issues
    label: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(50)])
      .optional(),
    // cm:why ISS-593 — same name|uuid shape as `label`, resolved against `kind='module'` only, so the name of a plain label matches nothing rather than silently behaving as `label`
    module: z
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
    // cm:guard the serialised-size ceiling on this field is app code's alone and must stay matched to `plan`'s — Postgres jsonb carries no per-column limit, so nothing below this line stops one issue's accumulated context blowing up TOAST and the query plans that read it
    sessionContext: sessionContextSchema,
    // cm:guard ISS-959 — a PRECONDITION, not a field. It is absent from `SHARED_ISSUE_PATCH_FIELDS` on purpose; adding it there would write the value the caller read back into a column.
    expect: sessionContextExpectSchema.optional(),
    // cm:edge contract -> packages/core/src/issues/release-notes.ts — `ReleaseNotesSchema` is what refuses an invalid `section` at the MCP boundary, so a section added there and not here is accepted by one side and rejected by the other (ISS-199)
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    // cm:guard an audit LABEL and never a second column — all three values stamp the one `merged_at`, so a reader that branches on `target` to decide where the work landed is reading a string somebody typed (ISS-286)
    target: z.enum(['feature', 'base', 'prod']).optional(),
    // cm:edge contract -> packages/core/src/issues/merge-routes.ts — the same field on the REST door, and the same shape refusal; the two are one claim with two surfaces
    commit: mergedCommitShaSchema.optional(),
    mergedAt: z.string().optional(),
    note: z.string().max(10_000).optional(),
    // cm:why the task fields ride this same `data` block rather than a schema of their own: createTask/updateTask are sub-actions of one tool, and a second input schema would advertise them as a second tool
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
    // cm:guard REPLACE-SET, not additive — `[]` clears every label and `undefined` means no change, so a caller that has not read the issue's current `labels[]` clobbers the set it did not send (ISS-633)
    // cm:guard the object arm mirrors REST's `labelAttachItemSchema` exactly — `labelId` takes a NAME or a uuid like the bare string, `isPrimary` is legal only on a module, and both arms resolve through `resolveLabelIdsForWrite`, so the two surfaces cannot drift apart
    labels: z
      .array(
        z.union([
          z.string().trim().min(1),
          z
            .object({ labelId: z.string().trim().min(1), isPrimary: z.boolean().optional() })
            .strict(),
        ]),
      )
      .max(50)
      .optional(),
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
    // cm:guard emit it on BOTH projections or the kind is unreadable through MCP: core never derives it (see the `waitingKind` input guard), and an absent key reads as `null` to a caller — a park asking for a DECISION and one asking for a RESOURCE then look identical, which is what a `waiting` read looked like until 2026-09-09
    // cm:edge lockstep -> packages/core/src/issues/list-service.ts — `IssueListRow`, its `projection` and `serializeListRow` carry the same field; adding it to one surface only leaves the triage list unable to say what any park wants
    waitingKind: row.waitingKind,
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
    // cm:why char-stripped and NOT framed, unlike `serialize` — a full DATA banner per title across many rows would defeat the token cap this projection exists for (ISS-428, ISS-532); invisible/bidi smuggling is still neutralized
    title: sanitizeUntrusted(row.title),
    status: row.status,
    // cm:edge lockstep -> packages/core/src/mcp/tools/forge-issues.ts — `serialize` carries the same field; see the guard there
    waitingKind: row.waitingKind,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // cm:why ISS-960 — only when the query carried `filters.search`; on an unfiltered browse the key is absent rather than `[]`, so "not searched" and "matched on nothing literal" stay distinguishable
    ...(row.matchedFields ? { matchedFields: row.matchedFields } : {}),
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
  // cm:guard order is load-bearing here, not taste: `buildToolset` truncates this string at DESCRIPTION_CAP before chat reads it, so a rule written past the cut reaches that model in no form at all. The four a caller cannot act without are ordered ahead of the cut, and held there by forge-issues-description.test.ts.
  // cm:edge contract -> packages/core/src/assistant/tools/mcp-adapter.ts — DESCRIPTION_CAP decides how much of this string the chat front-end ever reads, while the `/mcp` transport serves all of it: the two doors read different halves of one piece of prose
  description:
    'Issues and their tasks; every sub-action is in the action enum, and documentId takes a ' +
    'uuid or the short ISS-<n>.\n' +
    'READING. list returns a summary projection - it omits the five heavy fields the fields ' +
    'enum names - to stay under the response token cap; get returns the full body. ' +
    'filters.issue and filters.taskStatus belong to listTasks - list REFUSES them, use get. ' +
    'Triage with list, get only the one issue you are about to work, and never re-get a body ' +
    'already loaded this session; after a lean forge_step_start manifest (bodyTruncated:true) ' +
    'pull just the fields:[...] you need. Read hasMore before calling any count complete: a ' +
    'list cut short by your own limit looks exactly like a complete one. truncated/truncatedBy ' +
    'name the cap that bit.\n' +
    'CREATE. Fill title, description, priority, category. plan and acceptanceCriteria are the ' +
    "clarify/plan steps' output - pre-filling them deletes that step's reason to exist (red " +
    'flag: plan-by-hand). description is a requirements contract (outcome, business rules, ' +
    'invariants, out-of-scope), not an implementation script: file paths, endpoints and ' +
    '"follow the pattern at <path>" go stale and outrank live exploration. Body shape: guides ' +
    'pipeline-and-issue-lifecycle and writing-an-issue; mermaid fences render; ATTACH .html ' +
    'rather than pasting it.\n' +
    'FILTERS. search: a literal substring or identifier-split token over ' +
    'title/description/plan/acceptanceCriteria, with matchedFields naming which matched per ' +
    'row, so a clause cited only on a criterion is findable. label/module: a name or uuid or ' +
    'an array of either (OR); an unknown name returns an EMPTY set, and module matches MODULE ' +
    'labels only.\n' +
    'LABELS. data.labels takes label NAMES or UUIDs from this project; unknown ones are ' +
    'refused, never auto-created. On update it is a REPLACE-SET, not additive: [] clears all, ' +
    'omitting it changes none. Read the labels[] every response carries before a delta, or you ' +
    'clobber the set. A module is a label with kind:"module", and each labels[] entry reports ' +
    'kind and isPrimary. Set the primary module by sending { labelId, isPrimary: true } among ' +
    'the plain strings - at most one, and it must be a module, or the whole write is refused. ' +
    'A new primary replaces the old atomically; omit isPrimary everywhere for none.\n' +
    'RELATIONS. data.relations applies on create AND update and works with a personal access ' +
    'token; for a kind its own enum does not list, use forge_project_pm set_dependency. Send ' +
    'exactly one of dependsOnId (THIS issue is blocked BY it) or blocksId (THIS issue blocks ' +
    'it). Edges commit before the dispatch trigger, so nothing dispatches ahead of its ' +
    "blocker, and the reply's relations[] confirms each edge. Re-send an edge with validUntil " +
    'in the past to RETRACT it (updated:true). get returns relations.blocks (this blocks them) ' +
    'and relations.blockedBy (they block this), each flagged expired when its validUntil has ' +
    'passed and it no longer gates dispatch.\n' +
    'TRANSITION. on_hold is a deliberate pause, waiting parks the issue for human review, and ' +
    'closed auto-stamps merged_at when still NULL (closed = done, for the blocks-gate), so a ' +
    'close meaning "abandoned, code never landed" needs unmark after it.\n' +
    'MERGE MARK. mark_merged (data.issueId, data.target, optional data.commit / data.mergedAt ' +
    'ISO / data.note) idempotently stamps merged_at and merged_commit_sha together, defaulting ' +
    "commit to the recorded implementation handoff's, and unblocks dependents. target is an " +
    'audit label; every value stamps the same column. unmark (data.issueId + optional ' +
    'data.note) clears merged_at to NULL, re-blocking children when a merge is rolled back.\n' +
    'TASKS. createTask needs data.issueId + data.taskTitle; listTasks needs filters.issue and ' +
    'accepts filters.taskStatus; updateTask/deleteTask take the task UUID as documentId. Tasks ' +
    'inherit project membership from their issue.\n' +
    'ATTACHMENTS. Use forge_uploads (presigned URL) for anything past a tiny snippet; base64 ' +
    'in data.attachments[] is slow and burns context, though it still works for up to 10 tiny ' +
    'files (total <= UPLOADS_MAX_BYTES) and on partial failure returns attachments plus ' +
    'attachmentErrors (code/message).\n' +
    'The X-Forge-Project-Slug header sets the project; projectId only overrides it.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

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
        // cm:guard ISS-960 — `filters.issue` and `filters.taskStatus` belong to `listTasks` and this action cannot honour them, so they are REFUSED by name. Dropping them silently returned the project's newest issues instead, and at `limit: 1` that is indistinguishable from a single-issue lookup: a master read one issue's merge state as another's twice in one morning before this refusal existed.
        for (const key of ['issue', 'taskStatus'] as const) {
          if (f?.[key] !== undefined) {
            throw new Error(
              `BAD_REQUEST: filters.${key} is applied only by action 'listTasks' — for one issue use action 'get' with its documentId`,
            );
          }
        }
        const rows = await listIssueRows(
          projectId,
          {
            status: f?.status,
            statusNot: f?.statusNot,
            priority: f?.priority,
            category: f?.category,
            // cm:guard this mapping is hand-copied field by field, and a filter accepted by `filtersSchema` but dropped here fails SILENTLY in the worst direction: the caller gets every row back and reads it as "nothing matched the narrowing", not as a broken filter. Add a filter above and you must add it here in the same edit — measured on ISS-912, where `complexity` reached all three projections and the strict schema while nothing could filter on it.
            complexity: f?.complexity,
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
            module:
              f?.module === undefined || f.module === null
                ? undefined
                : Array.isArray(f.module)
                  ? f.module
                  : [f.module],
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
          // cm:guard project out of `serialize()`'s output and never out of the raw row — the DATA banners `markUntrusted` puts on `description` and `acceptanceCriteria` exist only on the framed copy, so a projection taken off the row hands the agent untrusted text with nothing marking it as untrusted
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
              createdById: principal.userId,
              createdVia: 'mcp',
              actor: principalHookActor(principal),
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

        // cm:guard resolved BEFORE the transaction, mirroring REST PATCH's `assertLabelsInProject` — a bad label name must fail the call rather than roll a started write back (ISS-633). `undefined` is "no change" and `[]` clears every label, so the two cannot be collapsed.
        let labelIds: ResolvedLabelAttach[] | undefined;
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

        // cm:edge ordering -> packages/core/src/issues/release-record-required.ts — the second reader of this order, and the reason a close needs one call rather than two: that rule re-reads issues.release_notes, so a reversed order throws RELEASE_RECORD_REQUIRED on a legal { releaseNotes, status:'closed' } and discards the note the caller just wrote to satisfy it
        const willWriteFields = Object.keys(updates).length > 0 || labelIds !== undefined;
        // cm:guard REFUSE rather than ignore. `expect` reaches the database only through `updateIssueFields`, and this action also writes a status and relations by other calls — so `{ expect, status }` with no field to write would transition unconditionally while the caller believes a precondition held it. REST's second refine on `issuePatchSchema` says the same thing at its own door; this is that door.
        if (input.data.expect && !willWriteFields) {
          throw new Error(
            'BAD_REQUEST: data.expect is a precondition on a FIELD write — it holds nothing against a status or relations change. Send the field(s) to write alongside it.',
          );
        }

        if (willWriteFields) {
          // cm:why sql`now()`, matching transitionIssueStatus below — a combined status+fields update needs one canonical timestamp source, not a mix of JS Date and DB now()
          updates.updatedAt = sql`now()`;
          try {
            await updateIssueFields({
              issueId: issue.id,
              updates,
              labelIds,
              ...(input.data.expect ? { expect: input.data.expect } : {}),
              actor: principalHookActor(principal),
            });
          } catch (err) {
            throw toMcpIssueError(err);
          }
        }

        // cm:edge ordering -> packages/core/src/jobs/queued-gates.ts — relations commit BEFORE the transition below, for the same reason create commits them before issueCreated: the transition is what wakes considerEnqueue→dispatch, so a blocks edge written after it misses the first tick and the dependent ships ahead of its blocker. This order is also the SAFE side of a partial failure, which is why the two writes are deliberately not one transaction: edges landed + transition failed leaves an extra `blocks` edge holding a job, which a human can retract, where the reverse ships a dependent ahead of its blocker and cannot be undone.
        const r = await applyIssueRelations(
          { actor: principalHookActor(principal), createdById: principal.userId },
          issue.projectId,
          issue.id,
          input.data.relations,
        );

        if (input.data.status && input.data.status !== issue.status) {
          await transitionIssueStatus(issue, input.data.status, principalActor(principal), {
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
        await transitionIssueStatus(issue, target, principalActor(principal), {
          transitionReason: input.data?.reason ?? input.data?.note,
          waitingKind: input.data?.waitingKind,
        });
        const fresh = await loadIssue(issue.id);
        const transitionOutput: Record<string, unknown> = await serializeWithAttachments(fresh);
        return transitionOutput;
      }

      // cm:why ISS-286 — an explicit, idempotent, auditable marker that decouples `merged_at` from the implicit `markMergedIfLeavingBase` side-effect, so a skill can stamp the merge straight after verifying a push; since the blocker gate was deleted the stamp is a FACT a master reads off the relation rather than something the kernel enforces, and what it means for a dependent is the master's call
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
            ...(input.data?.commit ? { commit: input.data.commit } : {}),
            ...(input.data?.mergedAt
              ? { mergedAt: parseDate(input.data.mergedAt, 'mergedAt') }
              : {}),
            actor: {
              agency: actorAgency(principalActor(principal)),
              commentAuthorId: principal.userId,
              hookActor: principalHookActor(principal),
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
          actor: principalHookActor(principal),
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

        const updated = await updateTaskRow(row, updates, principalHookActor(principal), [
          'acceptanceCriteria',
        ]);
        if (!updated) throw new Error('NOT_FOUND: task not found');

        return { task: serializeTask(updated) };
      }

      case 'deleteTask': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId required for deleteTask');
        }
        const row = await loadTaskForAccess(input.documentId);
        await assertPrincipalIsWriter(principal, row.projectId);
        await deleteTaskRow(row, principalHookActor(principal));
        return { deleted: true, documentId: input.documentId };
      }
    }
  },
});
