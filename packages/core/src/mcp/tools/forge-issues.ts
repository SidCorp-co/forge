import { and, desc, eq, gte, ilike, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  type IssueStatus,
  issueComplexities,
  issuePriorities,
  issueStatuses,
  issues,
} from '../../db/schema.js';
import { applyStatusTransition } from '../../issues/apply-transition.js';
import { recordActivityTx } from '../../pipeline/activity.js';
import { hooks } from '../../pipeline/hooks.js';
import {
  type ContextScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
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
  })
  .strict()
  .optional();

const dataSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
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
      .refine(
        (v) => v == null || JSON.stringify(v).length <= 200_000,
        { message: 'sessionContext serialised size exceeds 200000 bytes' },
      ),
    // ISS-59 — AI enrichment fields. Skill pipeline (forge-clarify /
    // forge-plan) writes these via this tool; REST PATCH does not accept
    // them (read-only from clients).
    aiSummary: z.string().max(100_000).nullable().optional(),
    aiSuggestedSolution: z.string().max(100_000).nullable().optional(),
    aiAcceptanceCriteria: z.array(z.string().max(2_000)).max(50).nullable().optional(),
    aiConfidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict()
  .optional();

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'create', 'update', 'transition']),
    projectId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: dataSchema,
    limit: z.number().int().min(1).max(200).optional(),
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadIssue(documentId: string): Promise<IssueRow> {
  const [row] = await db.select().from(issues).where(eq(issues.id, documentId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row as IssueRow;
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
    'CRUD for project issues. Actions: list, get, create, update, transition. ' +
    'Project scope is derived from the X-Forge-Project-Slug header (or an ' +
    'explicit projectId). Status changes route through the issue state machine. ' +
    'Avoid setting manualHold:true at create time — combine with confirmed ' +
    'status transitions and the issue stalls. Toggle manualHold after the ' +
    'issue settles, or use status:on_hold for a deliberate pause.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { device, projectSlug } = ctx;

    switch (input.action) {
      case 'list': {
        const projectId = await resolveProjectId(input, projectSlug);
        await assertDeviceOwnerIsMember(device, projectId);

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
        await assertDeviceOwnerIsMember(device, issue.projectId);
        return serialize(issue);
      }

      case 'create': {
        if (!input.data?.title) throw new Error('BAD_REQUEST: data.title is required for create');
        const projectId = await resolveProjectId(input, projectSlug);
        await assertDeviceOwnerIsMember(device, projectId);

        const [inserted] = await db
          .insert(issues)
          .values({
            projectId,
            title: input.data.title,
            description: input.data.description ?? null,
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
          })
          .returning();
        if (!inserted) throw new Error('issues: insert returned no row');

        const created = inserted as IssueRow;
        await hooks.emit('issueCreated', {
          issueId: created.id,
          projectId: created.projectId,
          actor: { type: 'device' as const, id: device.id },
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

        return serialize(created);
      }

      case 'update': {
        if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for update');
        if (!input.data) throw new Error('BAD_REQUEST: data is required for update');
        const issue = await loadIssue(input.documentId);
        await assertDeviceOwnerIsMember(device, issue.projectId);

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
        if (
          input.data.manualHold !== undefined &&
          input.data.manualHold !== issue.manualHold
        ) {
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
        await assertDeviceOwnerIsMember(device, issue.projectId);
        await applyStatusTransition(issue, target, device);
        const fresh = await loadIssue(issue.id);
        return serialize(fresh);
      }
    }
  },
});


