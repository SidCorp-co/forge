import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { BODY_FORMATS } from '../../body/formats.js';
import { bodyText } from '../../body/prepare.js';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  taskStatuses,
  waitingKinds,
} from '../../db/schema.js';
import { actorAgency } from '../../issues/actor-agency.js';
import { transitionIssueStatus } from '../../issues/apply-transition.js';
import { issueArchiveFilterSchema } from '../../issues/archive.js';
import { listIssueAttachments } from '../../issues/attachment-service.js';
import { loadIssueAttributes } from '../../issues/attributes/read.js';
import { setIssueAttributes } from '../../issues/attributes/service.js';
import { AttributeRefusal } from '../../issues/attributes/write.js';
import { createIssue } from '../../issues/create-service.js';
import { loadIssueRelations } from '../../issues/dependency-read.js';
import { isValidDetectorKey } from '../../issues/detector-key.js';
import { activeIssuePrefix } from '../../issues/issue-prefix-read.js';
import {
  listIssueLabels,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from '../../issues/label-service.js';
import { type IssueListRow, listIssueRows } from '../../issues/list-service.js';
import {
  applyMergeMarker,
  MergeMarkerError,
  mergedCommitShaSchema,
} from '../../issues/merge-marker.js';
import { mergeMarkFields } from '../../issues/merge-record.js';
import { parkQuestionNotMinted } from '../../issues/park-question.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from '../../issues/patch-fields.js';
import { findIssueById, findIssueProjectId, type IssueRow } from '../../issues/read-service.js';
import { applyIssueRelations, issueRelationInputSchema } from '../../issues/relations-service.js';
import { ReleaseNotesSchema } from '../../issues/release-notes.js';
import { sessionContextExpectSchema, sessionContextSchema } from '../../issues/session-context.js';
import { updateIssueFields } from '../../issues/update-service.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
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
import { refuseStrayArchiveFields, runArchiveAction } from './forge-issues-archive.js';
import { forgeIssuesDescription } from './forge-issues-description.js';
import { toMcpIssueError } from './forge-issues-errors.js';
import { ISSUE_REF_CLAUSE, issueRefSchema, refsFor } from './issue-ref-input.js';
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
    issue: issueRefSchema.optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    label: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(50)])
      .optional(),
    module: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1)).max(50)])
      .optional(),
    /** ISS-1237 — archived issues are out of the browse unless this is true. */
    includeArchived: z.boolean().optional(),
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
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    detectorKey: z.string().trim().min(1).max(120).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    sessionContext: sessionContextSchema,
    expect: sessionContextExpectSchema.optional(),
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    target: z.enum(['feature', 'base', 'prod']).optional(),
    commit: mergedCommitShaSchema.optional(),
    mergedAt: z.string().optional(),
    note: z.string().max(10_000).optional(),
    issueId: issueRefSchema.optional(),
    taskTitle: z.string().trim().min(1).max(500).optional(),
    taskDescription: z.string().max(50_000).nullable().optional(),
    taskStatus: z.enum(taskStatuses).optional(),
    taskPriority: z.enum(issuePriorities).optional(),
    isAgentTask: z.boolean().optional(),
    taskAcceptanceCriteria: z.array(z.string()).nullable().optional(),
    relations: z.array(issueRelationInputSchema).max(20).optional(),
    reason: z.string().trim().min(1).max(10_000).optional(),
    waitingKind: z.enum(waitingKinds).optional(),
    needs: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .optional()
      .describe(
        'What a person must supply for a `needs_info` park to start again — NOT `reason`, which is why the work stopped. Sending it mints the free-text question that person answers; omitting it mints one saying the run did not say what would settle this. Minted only for an agent-held credential.',
      ),
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
      'setAttributes',
      'archive',
      'unarchive',
    ]),
    projectId: z.uuid().optional(),
    documentId: issueRefSchema.optional(),
    filters: filtersSchema,
    data: dataSchema,
    attributes: z
      .array(
        z
          .object({
            key: z.string().min(1),
            value: z.union([z.string(), z.number(), z.boolean()]),
            sourceCommentId: z.uuid().nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(50)
      .optional(),
    limit: z.number().int().min(1).max(500).optional(),
    /**
     * For action=get only: fetch only the listed fields (+ documentId/issueId)
     * instead of the full body. Useful when forge_step_start returned a lean
     * manifest (bodyTruncated:true) — the agent pulls only the fields it needs
     * rather than re-fetching the entire issue. Omitting this param is
     * backwards-compatible (returns full body with attachments[]).
     */
    fields: z.array(z.enum(GET_SELECTABLE_FIELDS)).min(1).max(20).optional(),
    /** For action=archive/unarchive only: which issues, read back first with `dryRun: true`. */
    archiveFilter: issueArchiveFilterSchema.optional(),
    dryRun: z.boolean().optional(),
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

export function serialize(row: IssueRow, prefix: string | null): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: formatIssueRef(prefix, row.issSeq),
    title: markUntrusted(row.title, { source: 'issue.title' }),
    description:
      row.description == null
        ? null
        : markUntrusted(bodyText(row.description, row.descriptionFormat), {
            source: 'issue.description',
          }),
    descriptionFormat: row.descriptionFormat,
    status: row.status,
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
    ...mergeMarkFields(row),
    archivedAt: row.archivedAt,
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

export function serializeListRow(
  row: IssueListRow,
  prefix: string | null,
): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: formatIssueRef(prefix, row.issSeq),
    title: sanitizeUntrusted(row.title),
    status: row.status,
    waitingKind: row.waitingKind,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    mergedAt: row.mergedAt,
    ...mergeMarkFields(row),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
  const [attachments, issueLabelsList, prefix] = await Promise.all([
    listIssueAttachments(row.id),
    listIssueLabels(row.id),
    activeIssuePrefix(row.projectId),
  ]);
  return { ...serialize(row, prefix), attachments, labels: issueLabelsList };
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
export function serializeManifest(row: IssueRow, prefix: string | null): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: formatIssueRef(prefix, row.issSeq),
    title: markUntrusted(row.title, { source: 'issue.title' }),
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    assigneeId: row.assigneeId,
    reopenCount: row.reopenCount,
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    ...mergeMarkFields(row),
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
  const [attachments, issueLabelsList, prefix] = await Promise.all([
    listIssueAttachments(row.id),
    listIssueLabels(row.id),
    activeIssuePrefix(row.projectId),
  ]);
  return { ...serializeManifest(row, prefix), attachments, labels: issueLabelsList };
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
  description: forgeIssuesDescription(ISSUE_REF_CLAUSE),
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;
    const refs = refsFor(input, ctx, principal);
    refuseStrayArchiveFields(input);

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
      case 'archive':
      case 'unarchive': {
        const projectId = await resolveProjectId(input, ctx);
        const { archiveFilter: filter, dryRun } = input;
        return runArchiveAction({ direction: input.action, projectId, filter, dryRun, principal });
      }
      case 'list': {
        const projectId = await resolveProjectId(input, ctx);
        await assertPrincipalIsMember(principal, projectId);

        const issuesLimit = input.limit ?? 25;
        const f = input.filters;
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
            complexity: f?.complexity,
            createdAfter: f?.createdAfter ? parseDate(f.createdAfter, 'createdAfter') : undefined,
            createdBefore: f?.createdBefore
              ? parseDate(f.createdBefore, 'createdBefore')
              : undefined,
            updatedAfter: f?.updatedAfter ? parseDate(f.updatedAfter, 'updatedAfter') : undefined,
            search: f?.search,
            includeArchived: f?.includeArchived,
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

        const listPrefix = await activeIssuePrefix(projectId);
        return buildListEnvelope({
          key: 'issues',
          limit: issuesLimit,
          hint: 'add status/priority/category/label filters',
          items: rows.map((r) => serializeListRow(r, listPrefix)),
        });
      }

      case 'get': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for get');
        const issue = await loadIssue(await refs.issue('documentId', input.documentId));
        await assertPrincipalIsMember(principal, issue.projectId);
        if (input.fields && input.fields.length > 0) {
          const full = serialize(issue, await activeIssuePrefix(issue.projectId));
          // ISS-1126 — `fields` narrows the heavy BODIES; the mark rides with the identity, so a
          // narrowed answer never reads as an issue with no mark.
          const projected: Record<string, unknown> = {
            documentId: full.documentId,
            issueId: full.issueId,
            ...mergeMarkFields(issue),
          };
          for (const field of input.fields) {
            projected[field] = full[field] ?? null;
          }
          return projected;
        }
        const [full, relations, attributes] = await Promise.all([
          serializeWithAttachments(issue),
          loadIssueRelations(issue.id, issue.projectId),
          loadIssueAttributes(issue.id),
        ]);
        return { ...full, relations, attributes };
      }

      case 'setAttributes': {
        if (!input.documentId)
          throw new Error('BAD_REQUEST: documentId is required for setAttributes');
        if (!input.attributes || input.attributes.length === 0)
          throw new Error(
            'BAD_REQUEST: attributes is required for setAttributes — each entry is { key, value }, and the registered keys come back on action=get under `attributes`',
          );
        const issue = await loadIssue(await refs.issue('documentId', input.documentId));
        await assertPrincipalIsWriter(principal, issue.projectId);
        try {
          return await setIssueAttributes(
            input.attributes.map((a) => ({
              issueId: issue.id,
              key: a.key,
              value: a.value,
              sourceCommentId: a.sourceCommentId ?? null,
              assertedByUserId: principal.userId,
            })),
          );
        } catch (err) {
          if (err instanceof AttributeRefusal) throw new Error(`${err.code}: ${err.message}`);
          throw err;
        }
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

        const out: Record<string, unknown> = serialize(
          result.issue as IssueRow,
          await activeIssuePrefix(result.issue.projectId),
        );
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
        const issue = await loadIssue(await refs.issue('documentId', input.documentId));
        await assertPrincipalIsWriter(principal, issue.projectId);

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

        const willWriteFields = Object.keys(updates).length > 0 || labelIds !== undefined;
        if (input.data.expect && !willWriteFields) {
          throw new Error(
            'BAD_REQUEST: data.expect is a precondition on a FIELD write — it holds nothing against a status or relations change. Send the field(s) to write alongside it.',
          );
        }

        if (willWriteFields) {
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

        const r = await applyIssueRelations(
          { actor: principalHookActor(principal), createdById: principal.userId },
          issue.projectId,
          issue.id,
          input.data.relations,
        );

        let unasked: string | null = null;
        if (input.data.status && input.data.status !== issue.status) {
          await transitionIssueStatus(issue, input.data.status, principalActor(principal), {
            transitionReason: input.data.reason ?? input.data.note,
            waitingKind: input.data.waitingKind,
            needs: input.data.needs,
          });
          unasked = parkQuestionNotMinted({
            issue,
            toStatus: input.data.status,
            actor: principalActor(principal),
            options: { needs: input.data.needs },
          });
        }

        const fresh = await loadIssue(issue.id);
        const updateResult: Record<string, unknown> = {
          ...(await serializeWithAttachments(fresh)),
          action: 'updated',
        };
        const allWarnings = unasked ? [...bodyWarnings, unasked] : bodyWarnings;
        if (allWarnings.length > 0) updateResult.warnings = allWarnings;
        if (r.length > 0) updateResult.relations = r;
        return updateResult;
      }

      case 'transition': {
        if (!input.documentId)
          throw new Error('BAD_REQUEST: documentId is required for transition');
        const target = input.data?.status;
        if (!target) throw new Error('BAD_REQUEST: data.status is required for transition');
        const issue = await loadIssue(await refs.issue('documentId', input.documentId));
        await assertPrincipalIsWriter(principal, issue.projectId);
        await transitionIssueStatus(issue, target, principalActor(principal), {
          transitionReason: input.data?.reason ?? input.data?.note,
          waitingKind: input.data?.waitingKind,
          needs: input.data?.needs,
        });
        const fresh = await loadIssue(issue.id);
        const transitionOutput: Record<string, unknown> = await serializeWithAttachments(fresh);
        const unheard = parkQuestionNotMinted({
          issue,
          toStatus: target,
          actor: principalActor(principal),
          options: { needs: input.data?.needs },
        });
        if (unheard) transitionOutput.warnings = [unheard];
        return transitionOutput;
      }

      case 'mark_merged':
      case 'unmark': {
        const ref = input.data?.issueId;
        if (!ref) throw new Error(`BAD_REQUEST: data.issueId is required for ${input.action}`);
        const marking = input.action === 'mark_merged';
        if (marking && !input.data?.target) {
          throw new Error('BAD_REQUEST: data.target is required for mark_merged');
        }
        const issue = await loadIssue(await refs.issue('data.issueId', ref));
        await assertPrincipalIsWriter(principal, issue.projectId);

        try {
          const {
            issue: fresh,
            action,
            mark,
            markDetail: detail,
          } = await applyMergeMarker({
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
          return { ...(await serializeWithAttachments(fresh)), action, mark, detail };
        } catch (err) {
          if (err instanceof MergeMarkerError) throw new Error(`${err.code}: ${err.message}`);
          throw err;
        }
      }

      case 'listTasks': {
        const ref = input.filters?.issue;
        if (!ref) throw new Error('BAD_REQUEST: filters.issue required for listTasks');
        const issueId = await refs.issue('filters.issue', ref);
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
        const issueId = await refs.issue('data.issueId', data.issueId);
        const projectId = await loadIssueProjectId(issueId);
        await assertPrincipalIsWriter(principal, projectId);

        const created = await createTaskRow({
          issueId,
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
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId required for updateTask');
        const row = await loadTaskForAccess(refs.task('documentId', input.documentId));
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
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId required for deleteTask');
        const row = await loadTaskForAccess(refs.task('documentId', input.documentId));
        await assertPrincipalIsWriter(principal, row.projectId);
        await deleteTaskRow(row, principalHookActor(principal));
        return { deleted: true, documentId: row.id };
      }
    }
  },
});
