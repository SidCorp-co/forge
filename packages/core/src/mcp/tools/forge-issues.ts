import { and, asc, desc, eq, gte, ilike, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type IssueStatus,
  comments,
  issueComplexities,
  issuePriorities,
  issueStatuses,
  issues,
  taskStatuses,
  tasks,
} from '../../db/schema.js';
import { applyStatusTransition } from '../../issues/apply-transition.js';
import {
  AttachmentError,
  type DecodedAttachment,
  decodeAndValidateAttachments,
  persistDecodedIssueAttachments,
} from '../../issues/attachment-service.js';
import { type ReleaseNotes, ReleaseNotesSchema } from '../../issues/release-notes.js';
import { dispatchTickForProject } from '../../jobs/dispatch-tick.js';
import { recordActivityTx } from '../../pipeline/activity.js';
import { hooks } from '../../pipeline/hooks.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  resolveProjectIdFromSlug,
  zodToMcpSchema,
} from './lib.js';

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
    manualHold: z.boolean().optional(),
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
  })
  .strict()
  .optional();

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
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

type IssueRow = {
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
  manualHold: boolean;
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

function serialize(row: IssueRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: `ISS-${row.issSeq}`,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    category: row.category,
    complexity: row.complexity,
    manualHold: row.manualHold,
    assigneeId: row.assigneeId,
    parentIssueId: row.parentIssueId,
    reopenCount: row.reopenCount,
    plan: row.plan,
    acceptanceCriteria: row.acceptanceCriteria,
    suggestedSolution: row.suggestedSolution,
    sessionContext: row.sessionContext,
    aiSummary: row.aiSummary,
    aiSuggestedSolution: row.aiSuggestedSolution,
    aiAcceptanceCriteria: row.aiAcceptanceCriteria,
    aiConfidence: row.aiConfidence,
    releaseNotes: row.releaseNotes,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadIssue(documentId: string): Promise<IssueRow> {
  const [row] = await db.select().from(issues).where(eq(issues.id, documentId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row as IssueRow;
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

async function resolveProjectId(input: Input, projectSlug: string | null): Promise<string> {
  if (input.projectId) return input.projectId;
  return resolveProjectIdFromSlug(projectSlug);
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
    'Avoid setting manualHold:true at create time — combine with confirmed ' +
    'status transitions and the issue stalls. Toggle manualHold after the ' +
    'issue settles, or use status:on_hold for a deliberate pause. ' +
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
    'parent issue.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { device, principal, projectSlug } = ctx;

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, projectSlug);
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

        const rows = await db
          .select()
          .from(issues)
          .where(and(...conds))
          .orderBy(desc(issues.updatedAt))
          .limit(input.limit ?? 25);

        return { issues: rows.map((r) => serialize(r as IssueRow)) };
      }

      case 'get': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for get');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsMember(principal, issue.projectId);
        return serialize(issue);
      }

      case 'create': {
        if (!input.data?.title) throw new Error('BAD_REQUEST: data.title is required for create');
        const projectId = await resolveProjectId(input, projectSlug);
        await assertPrincipalIsMember(principal, projectId);

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
            manualHold: input.data.manualHold ?? false,
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
        await assertPrincipalIsMember(principal, issue.projectId);

        // Status changes always route through the state machine so the
        // transitions stay aligned with REST `/transition` (reopen-cap +
        // illegal-transition guards). The hook + WS broadcast match too.
        if (input.data.status && input.data.status !== issue.status) {
          await applyStatusTransition(issue, input.data.status, device);
        }

        const updates: Record<string, unknown> = {};
        if (input.data.title !== undefined) updates.title = input.data.title;
        if (input.data.description !== undefined) updates.description = input.data.description;
        if (input.data.priority !== undefined) updates.priority = input.data.priority;
        if (input.data.category !== undefined) updates.category = input.data.category;
        if (input.data.complexity !== undefined) updates.complexity = input.data.complexity;
        // manualHold is journalled separately so MCP-driven holds emit the
        // same activity entry + WS broadcast as the dedicated REST handler
        // (`PATCH /api/issues/:id/manual-hold`). Without this, dispatcher
        // gating still works (DB read is canonical) but other clients miss
        // the toggle on the timeline + real-time UI.
        let manualHoldChange: { before: boolean; after: boolean } | null = null;
        if (input.data.manualHold !== undefined && input.data.manualHold !== issue.manualHold) {
          manualHoldChange = { before: issue.manualHold, after: input.data.manualHold };
          updates.manualHold = input.data.manualHold;
        }
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
            if (manualHoldChange) {
              await recordActivityTx(tx, {
                issueId: issue.id,
                actor: { type: 'device' as const, id: device.id },
                action: manualHoldChange.after
                  ? 'issue.manualHold.set'
                  : 'issue.manualHold.cleared',
                payload: { manualHold: manualHoldChange.after },
              });
            }
          });

          if (manualHoldChange) {
            await hooks.emit('issueUpdated', {
              issueId: issue.id,
              projectId: issue.projectId,
              actor: { type: 'device' as const, id: device.id },
              fields: ['manualHold'],
              before: { manualHold: manualHoldChange.before },
              after: { manualHold: manualHoldChange.after },
            });
            // ISS-133 — clearing manualHold must wake the dispatcher so jobs
            // gated on `manual_hold` get re-evaluated within a second instead
            // of waiting up to 60s for the pg-boss backstop.
            if (manualHoldChange.before === true && manualHoldChange.after === false) {
              void dispatchTickForProject(issue.projectId);
            }
          }
        }

        const fresh = await loadIssue(issue.id);
        return { ...serialize(fresh), status: 'updated' };
      }

      case 'transition': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId is required for transition');
        }
        const target = input.data?.status;
        if (!target) throw new Error('BAD_REQUEST: data.status is required for transition');
        const issue = await loadIssue(input.documentId);
        await assertPrincipalIsMember(principal, issue.projectId);
        await applyStatusTransition(issue, target, device);
        const fresh = await loadIssue(issue.id);
        return serialize(fresh);
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
        await assertPrincipalIsMember(principal, issue.projectId);

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

        return { ...serialize(fresh), status: 'merged' };
      }

      case 'unmark': {
        const issueId = input.data?.issueId;
        if (!issueId) {
          throw new Error('BAD_REQUEST: data.issueId is required for unmark');
        }
        const issue = await loadIssue(issueId);
        await assertPrincipalIsMember(principal, issue.projectId);

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

        return { ...serialize(fresh), status: 'unmarked' };
      }

      case 'listTasks': {
        const issueId = input.filters?.issue;
        if (!issueId) throw new Error('BAD_REQUEST: filters.issue required for listTasks');
        const projectId = await loadIssueProjectId(issueId);
        await assertPrincipalIsMember(principal, projectId);

        const where = input.filters?.taskStatus
          ? and(eq(tasks.issueId, issueId), eq(tasks.status, input.filters.taskStatus))
          : eq(tasks.issueId, issueId);

        const rows = await db
          .select()
          .from(tasks)
          .where(where)
          .orderBy(asc(tasks.createdAt))
          .limit(input.limit ?? 100);

        return { tasks: (rows as TaskRow[]).map(serializeTask) };
      }

      case 'createTask': {
        const data = input.data;
        if (!data?.issueId) throw new Error('BAD_REQUEST: data.issueId required for createTask');
        if (!data.taskTitle) throw new Error('BAD_REQUEST: data.taskTitle required for createTask');
        const projectId = await loadIssueProjectId(data.issueId);
        await assertPrincipalIsMember(principal, projectId);

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
        await assertPrincipalIsMember(principal, row.projectId);

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
        await assertPrincipalIsMember(principal, row.projectId);
        await db.delete(tasks).where(eq(tasks.id, input.documentId));
        return { deleted: true, documentId: input.documentId };
      }
    }
  },
});
