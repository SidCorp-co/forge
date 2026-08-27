/**
 * ISS-138 (PR-D) — atomic decomposition helper.
 *
 * Single entry point used by both the REST route (`POST /api/issues/:id/decompose`)
 * and the MCP `forge_pm.set_dependency` tool. Does five things in one transaction:
 *
 *   1. Loads + locks the parent row, validates status the FIRST time a parent
 *      is decomposed (`confirmed` | `waiting`). Subsequent calls on a parent
 *      that already owns an integration branch are allowed in any status, so
 *      agents can incrementally add children after the parent has progressed.
 *   2. (Unless opted out, and only on the first call) creates + pushes a
 *      shared integration branch on the project's git remote, branched off
 *      the project's `baseBranch`. Subsequent calls reuse the existing
 *      branch recorded on the parent's metadata.
 *   3. Creates new child issues at `draft` (postgres trigger allocates issSeq).
 *      `draft` is the inert proposal state — it has no STATUS_TO_JOB_TYPE entry
 *      so the orchestrator never auto-dispatches a child. Children stay `draft`
 *      until a human approves the parent (the cascade promotes them).
 *   4. Inserts `kind='decomposes'` edges (idempotent on the unique edge index).
 *   5. Writes `branchConfig` metadata onto parent (first call) + every child
 *      so PR-A's resolver returns the integration branch for child base/target.
 *
 * Post-commit: emits `issueCreated` for new children and `dependencyChanged`
 * for new edges, plus activity-log entries. Git side effects happen INSIDE
 * the transaction so a git failure rolls back the DB writes; a git success
 * followed by a commit failure leaks the remote branch (acceptable for v1,
 * PR-E adds cleanup).
 */
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import {
  type IssueDependencyKind,
  type IssuePriority,
  type IssueStatus,
  issueDependencies,
  issues,
} from '../db/schema.js';
import { logger } from '../logger.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import {
  DecomposeError,
  loadParentLite,
  type ParentDecompositionState,
  pickBranch,
  prepareParentDecomposition,
} from './decompose-branch.js';
import {
  finalizeDecomposedParentReviewGate,
  type ParentReviewGate,
  parkDecomposedParent,
} from './decompose-review-gate.js';

export { IntegrationBranchError } from '../git/branches.js';
export { DecomposeError, slugifyIssueTitle } from './decompose-branch.js';

export interface DecomposeChildSpec {
  title?: string | undefined;
  description?: string | null | undefined;
  priority?: IssuePriority | undefined;
  category?: string | null | undefined;
  existingIssueId?: string | undefined;
}

export interface DecomposeOptions {
  useIntegrationBranch?: boolean | undefined;
}

export interface DecomposeActor {
  userId: string;
  deviceId?: string | null | undefined;
}

export interface DecomposeResult {
  parentId: string;
  childIds: string[];
  integrationBranch: string | null;
  createdEdges: number;
}

interface PendingEdgeHook {
  edgeId: string;
  projectId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: IssueDependencyKind;
}

interface PendingChildHook {
  issueId: string;
  projectId: string;
  status: IssueStatus;
  title: string;
  description: string | null;
  priority: IssuePriority;
  category: string | null;
  reportedBy: string | null;
  assigneeId: string | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DecompositionWriteResult extends DecomposeResult {
  parentAlreadyDecomposed: boolean;
  parentStatus: IssueStatus;
  projectId: string;
  hasActiveDecomposition: boolean;
  reviewGate: ParentReviewGate | null;
}

export interface PendingDecomposition {
  result: DecompositionWriteResult;
  actor: Actor;
  children: PendingChildHook[];
  edges: PendingEdgeHook[];
}

export async function prepareDecomposition(
  tx: Tx,
  parentIssueId: string,
  children: DecomposeChildSpec[],
  actor: DecomposeActor,
  options?: DecomposeOptions,
): Promise<PendingDecomposition> {
  if (children.length === 0) {
    throw new DecomposeError('BAD_REQUEST', 'at least one child spec is required');
  }

  const actorRef: Actor = { type: 'user', id: actor.userId };
  const pendingEdgeHooks: PendingEdgeHook[] = [];
  const pendingChildHooks: PendingChildHook[] = [];
  const state = await prepareParentDecomposition(tx, parentIssueId, options);
  const writeResult = await writeDecomposition(
    tx,
    state,
    children,
    actor,
    actorRef,
    pendingEdgeHooks,
    pendingChildHooks,
  );
  return {
    result: {
      ...writeResult,
      reviewGate: await parkDecomposedParent(tx, writeResult, actorRef),
    },
    actor: actorRef,
    children: pendingChildHooks,
    edges: pendingEdgeHooks,
  };
}

export async function finalizeDecomposition(
  pending: PendingDecomposition,
): Promise<DecomposeResult> {
  await finalizeDecomposedParentReviewGate(pending.result, pending.result.reviewGate);
  await emitDecompositionHooks(pending.children, pending.edges, pending.actor);
  return {
    parentId: pending.result.parentId,
    childIds: pending.result.childIds,
    integrationBranch: pending.result.integrationBranch,
    createdEdges: pending.result.createdEdges,
  };
}

export async function decomposeParent(
  parentIssueId: string,
  children: DecomposeChildSpec[],
  actor: DecomposeActor,
  options?: DecomposeOptions,
): Promise<DecomposeResult> {
  const pending = await db.transaction((tx) =>
    prepareDecomposition(tx, parentIssueId, children, actor, options),
  );
  return finalizeDecomposition(pending);
}

async function writeDecomposition(
  tx: Tx,
  state: ParentDecompositionState,
  children: DecomposeChildSpec[],
  actor: DecomposeActor,
  actorRef: Actor,
  pendingEdgeHooks: PendingEdgeHook[],
  pendingChildHooks: PendingChildHook[],
): Promise<DecompositionWriteResult> {
  const { parent: parentRow, integrationBranch, parentAlreadyDecomposed } = state;

  await validateExistingChildren(tx, parentRow.projectId, children);
  const childIds = await createDecompositionChildren(
    tx,
    parentRow,
    children,
    actor,
    actorRef,
    integrationBranch,
    pendingChildHooks,
  );

  const createdEdges = await createDecompositionEdges(
    tx,
    parentRow,
    childIds,
    actor,
    actorRef,
    pendingEdgeHooks,
  );

  await writeDecompositionBranchConfig(tx, state, childIds);
  const hasActiveDecomposition = await parentHasActiveDecomposition(tx, parentRow.id);

  if (createdEdges > 0 || pendingChildHooks.length > 0) {
    await recordActivityTx(tx, {
      issueId: parentRow.id,
      actor: actorRef,
      action: 'issue.decomposed',
      payload: { childIds, integrationBranch },
    });
  }

  return {
    parentId: parentRow.id,
    childIds,
    integrationBranch,
    createdEdges,
    parentAlreadyDecomposed,
    parentStatus: parentRow.status,
    projectId: parentRow.projectId,
    hasActiveDecomposition,
    reviewGate: null,
  };
}

async function parentHasActiveDecomposition(tx: Tx, parentIssueId: string): Promise<boolean> {
  const [edge] = await tx
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(
      and(
        eq(issueDependencies.fromIssueId, parentIssueId),
        eq(issueDependencies.kind, 'decomposes'),
        or(isNull(issueDependencies.validUntil), gt(issueDependencies.validUntil, sql`now()`)),
      ),
    )
    .limit(1);
  return edge != null;
}

async function validateExistingChildren(
  tx: Tx,
  parentProjectId: string,
  children: DecomposeChildSpec[],
): Promise<void> {
  const existingIds = children
    .map((child) => child.existingIssueId)
    .filter((value): value is string => typeof value === 'string');
  if (existingIds.length === 0) return;
  const existing = await tx
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, existingIds));
  const byId = new Map(existing.map((row) => [row.id, row]));
  for (const id of existingIds) {
    const row = byId.get(id);
    if (!row) throw new DecomposeError('NOT_FOUND', `child issue ${id} not found`);
    if (row.projectId !== parentProjectId) {
      throw new DecomposeError(
        'BAD_REQUEST',
        `child issue ${id} is not in the same project as the parent`,
      );
    }
  }
}

async function createDecompositionChildren(
  tx: Tx,
  parent: ParentDecompositionState['parent'],
  children: DecomposeChildSpec[],
  actor: DecomposeActor,
  actorRef: Actor,
  integrationBranch: string | null,
  pendingHooks: PendingChildHook[],
): Promise<string[]> {
  const childIds: string[] = [];
  for (const spec of children) {
    if (spec.existingIssueId) {
      childIds.push(spec.existingIssueId);
      continue;
    }
    if (!spec.title || spec.title.trim().length === 0) {
      throw new DecomposeError('BAD_REQUEST', 'each new child must have a non-empty title');
    }
    const [inserted] = await tx
      .insert(issues)
      .values({
        projectId: parent.projectId,
        title: spec.title.trim(),
        description: spec.description ?? null,
        status: 'draft',
        priority: spec.priority ?? parent.priority,
        category: spec.category ?? parent.category,
        createdById: actor.userId,
        createdVia: 'pipeline',
      })
      .returning({
        id: issues.id,
        projectId: issues.projectId,
        status: issues.status,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        category: issues.category,
        reportedBy: issues.reportedBy,
        assigneeId: issues.assigneeId,
      });
    if (!inserted) throw new DecomposeError('INTERNAL', 'child insert returned no row');
    childIds.push(inserted.id);
    pendingHooks.push({
      issueId: inserted.id,
      projectId: inserted.projectId,
      status: inserted.status as IssueStatus,
      title: inserted.title,
      description: inserted.description,
      priority: inserted.priority as IssuePriority,
      category: inserted.category,
      reportedBy: inserted.reportedBy,
      assigneeId: inserted.assigneeId,
    });
    await recordActivityTx(tx, {
      issueId: inserted.id,
      actor: actorRef,
      action: 'issue.created_from_decomposition',
      payload: { parentId: parent.id, integrationBranch },
    });
  }
  return childIds;
}

async function createDecompositionEdges(
  tx: Tx,
  parent: ParentDecompositionState['parent'],
  childIds: string[],
  actor: DecomposeActor,
  actorRef: Actor,
  pendingHooks: PendingEdgeHook[],
): Promise<number> {
  let createdEdges = 0;
  for (const childId of childIds) {
    const inserted = await tx
      .insert(issueDependencies)
      .values({
        projectId: parent.projectId,
        fromIssueId: parent.id,
        toIssueId: childId,
        kind: 'decomposes',
        reason: null,
        createdById: actor.userId,
        validUntil: null,
      })
      .onConflictDoNothing({
        target: [
          issueDependencies.projectId,
          issueDependencies.fromIssueId,
          issueDependencies.toIssueId,
          issueDependencies.kind,
        ],
      })
      .returning({ id: issueDependencies.id });
    const edgeId = inserted[0]?.id;
    if (!edgeId) continue;
    createdEdges++;
    pendingHooks.push({
      edgeId,
      projectId: parent.projectId,
      fromIssueId: parent.id,
      toIssueId: childId,
      kind: 'decomposes',
    });
    const payload = {
      edgeId,
      fromIssueId: parent.id,
      toIssueId: childId,
      kind: 'decomposes' as const,
    };
    await recordActivityTx(tx, {
      issueId: parent.id,
      actor: actorRef,
      action: 'issue.dependency.added',
      payload,
    });
    await recordActivityTx(tx, {
      issueId: childId,
      actor: actorRef,
      action: 'issue.dependency.added',
      payload,
    });
  }
  return createdEdges;
}

async function writeDecompositionBranchConfig(
  tx: Tx,
  state: ParentDecompositionState,
  childIds: string[],
): Promise<void> {
  const { parent, project, integrationBranch, parentAlreadyDecomposed, useIntegrationBranch } =
    state;
  if (useIntegrationBranch && integrationBranch && !parentAlreadyDecomposed) {
    const projectBase = pickBranch(project.baseBranch) ?? 'main';
    const projectProd = pickBranch(project.productionBranch) ?? projectBase;
    const parentPatch = {
      useIntegrationBranch: true,
      integrationBranch,
      branchConfig: {
        baseBranch: integrationBranch,
        targetBranch: projectBase,
        prodBranch: projectProd,
      },
    };
    await tx
      .update(issues)
      .set({
        metadata: sql`coalesce(${issues.metadata}, '{}'::jsonb) || ${JSON.stringify(parentPatch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, parent.id));
  } else if (!useIntegrationBranch && parent.metadata?.useIntegrationBranch !== false) {
    await tx
      .update(issues)
      .set({
        metadata: sql`coalesce(${issues.metadata}, '{}'::jsonb) || ${JSON.stringify({ useIntegrationBranch: false })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, parent.id));
  }

  if (!useIntegrationBranch || !integrationBranch) return;
  const patchJson = JSON.stringify({
    branchConfig: { baseBranch: integrationBranch, targetBranch: integrationBranch },
  });
  for (const childId of childIds) {
    await tx
      .update(issues)
      .set({
        metadata: sql`coalesce(${issues.metadata}, '{}'::jsonb) || ${patchJson}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(issues.id, childId));
  }
}

async function emitDecompositionHooks(
  children: PendingChildHook[],
  edges: PendingEdgeHook[],
  actor: Actor,
): Promise<void> {
  for (const child of children) {
    try {
      await hooks.emit('issueCreated', {
        issueId: child.issueId,
        projectId: child.projectId,
        actor,
        status: child.status,
        snapshot: {
          title: child.title,
          description: child.description,
          priority: child.priority,
          category: child.category,
          reportedBy: child.reportedBy,
          assigneeId: child.assigneeId,
          labels: [],
        },
      });
    } catch (err) {
      logger.error({ err, issueId: child.issueId }, 'decompose: issueCreated emit failed');
    }
  }
  for (const edge of edges) {
    try {
      await hooks.emit('dependencyChanged', edge);
    } catch (err) {
      logger.error({ err, edgeId: edge.edgeId }, 'decompose: dependencyChanged emit failed');
    }
  }
}

// Exposed so call sites can decide whether to invoke the helper at all.
export async function parentHasIntegrationBranch(
  parentIssueId: string,
): Promise<{ branch: string | null; useIntegrationBranch: boolean | null }> {
  const row = await loadParentLite(parentIssueId);
  if (!row) return { branch: null, useIntegrationBranch: null };
  const meta = row.metadata ?? {};
  const cfg = meta.branchConfig ?? null;
  return {
    branch: pickBranch(meta.integrationBranch ?? null) ?? pickBranch(cfg?.baseBranch ?? null),
    useIntegrationBranch:
      typeof meta.useIntegrationBranch === 'boolean' ? meta.useIntegrationBranch : null,
  };
}
