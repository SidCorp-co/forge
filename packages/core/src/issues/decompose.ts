/**
 * ISS-138 (PR-D) — atomic decomposition helper.
 *
 * Single entry point for the REST route (`POST /api/issues/:id/decompose`) and
 * the MCP `forge_pm.set_dependency` tool. In one transaction it locks the
 * parent, validates its status on the FIRST decomposition only (see
 * {@link allowedParentStatuses}; later calls are allowed from any status so
 * agents can add children incrementally), creates the children at `draft`,
 * inserts the `kind='decomposes'` edges, and writes the `branchConfig`
 * metadata that points parent and children at the shared integration branch.
 *
 * `draft` has no STATUS_TO_JOB_TYPE entry, so a child is inert until the
 * cascade promotes it — `pipeline/decomposition-subscribers.ts` owns that, and
 * owns which status it promotes to, which differs per mode.
 *
 * Git runs INSIDE the transaction so a git failure rolls the DB writes back; a
 * git success followed by a commit failure leaks the remote branch (v1).
 * Post-commit: `issueCreated` per child, `dependencyChanged` per edge, then the
 * review-gate park.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueDependencyKind,
  type IssuePriority,
  type IssueStatus,
  issueDependencies,
  issues,
  projects,
} from '../db/schema.js';
import {
  createIntegrationBranch,
  gitRemoteHasBranch,
  IntegrationBranchError,
} from '../git/branches.js';
import { logger } from '../logger.js';
import { type Actor, recordActivityTx } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import type { ActorAgency } from './actor-agency.js';
import { parkParentAtReviewGate } from './decompose-review-gate.js';

const MAX_BRANCH_SUFFIX = 10;
// cm:guard `in_progress` is here because the driver owns the whole issue and decides mid-run that it is two; `waiting` is here for a re-split from the review gate. The staged half of this — a separate `confirmed`/`clarified` set chosen by mode — went with the lane in ISS-897. Do not widen this to every status: a parent decomposed from a terminal one has children nothing will ever promote.
const PARENT_STATUSES: ReadonlySet<IssueStatus> = new Set(['open', 'in_progress', 'waiting']);

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
  // cm:guard required — `deviceId` does not answer this. A decompose driven by an agent on a job token has no device and would otherwise file every child it creates under the person who owns the token, acting by hand.
  agency: ActorAgency;
}

export interface DecomposeResult {
  parentId: string;
  childIds: string[];
  integrationBranch: string | null;
  createdEdges: number;
}

export class DecomposeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DecomposeError';
    this.code = code;
  }
}

export { IntegrationBranchError } from '../git/branches.js';

export function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

interface ParentMetadata {
  branchConfig?: { baseBranch?: string | null; targetBranch?: string | null } | null;
  useIntegrationBranch?: boolean;
  [k: string]: unknown;
}

interface ParentRow {
  id: string;
  issSeq: number;
  title: string;
  projectId: string;
  status: IssueStatus;
  priority: IssuePriority;
  category: string | null;
  metadata: ParentMetadata | null;
}

interface ProjectRow {
  id: string;
  baseBranch: string | null;
  productionBranch: string | null;
  repoPath: string | null;
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

export async function decomposeParent(
  parentIssueId: string,
  children: DecomposeChildSpec[],
  actor: DecomposeActor,
  options?: DecomposeOptions,
): Promise<DecomposeResult> {
  if (children.length === 0) {
    throw new DecomposeError('BAD_REQUEST', 'at least one child spec is required');
  }

  const actorRef: Actor = { type: 'user', id: actor.userId, agency: actor.agency };

  // Pre-flight: load parent + project, resolve the integration branch (or
  // reuse the existing one) BEFORE opening the transaction so we don't hold
  // a row lock across a git round-trip.
  const preParent = await loadParentLite(parentIssueId);
  if (!preParent) throw new DecomposeError('NOT_FOUND', `issue ${parentIssueId} not found`);

  const project = await loadProject(preParent.projectId);
  if (!project) throw new DecomposeError('NOT_FOUND', 'parent project not found');

  const existingBranch = pickBranch(preParent.metadata?.branchConfig?.baseBranch ?? null);
  const parentAlreadyDecomposed = existingBranch != null;

  const allowed = PARENT_STATUSES;
  if (!parentAlreadyDecomposed && !allowed.has(preParent.status)) {
    throw new DecomposeError(
      'BAD_REQUEST',
      `parent status must be ${[...allowed].join(', ')} (got ${preParent.status})`,
    );
  }

  const explicitOpt = options?.useIntegrationBranch;
  const metaOpt = preParent.metadata?.useIntegrationBranch;
  const useIntegrationBranch = explicitOpt ?? metaOpt ?? true;

  let integrationBranch: string | null = null;
  if (useIntegrationBranch) {
    if (existingBranch) {
      integrationBranch = existingBranch;
    } else {
      if (!project.repoPath) {
        throw new DecomposeError(
          'BAD_REQUEST',
          'project has no repoPath configured; cannot create integration branch',
        );
      }
      const projectBase = pickBranch(project.baseBranch) ?? 'main';
      const baseSlug = slugifyIssueTitle(preParent.title).slice(0, 40);
      const baseCandidate = baseSlug
        ? `iss-${preParent.issSeq}-${baseSlug}`
        : `iss-${preParent.issSeq}`;
      integrationBranch = await resolveIntegrationBranchName(project.repoPath, baseCandidate);
      try {
        await createIntegrationBranch({
          repoPath: project.repoPath,
          remoteRef: projectBase,
          newBranch: integrationBranch,
        });
      } catch (e) {
        if (e instanceof IntegrationBranchError) throw e;
        throw new IntegrationBranchError('GIT_PUSH_FAILED', String(e));
      }
    }
  }

  const pendingEdgeHooks: PendingEdgeHook[] = [];
  const pendingChildHooks: PendingChildHook[] = [];

  const result = await db.transaction(async (tx) => {
    const parent = (await tx
      .select({
        id: issues.id,
        issSeq: issues.issSeq,
        title: issues.title,
        projectId: issues.projectId,
        status: issues.status,
        priority: issues.priority,
        category: issues.category,
        metadata: issues.metadata,
      })
      .from(issues)
      .where(eq(issues.id, parentIssueId))
      .limit(1)
      .for('update')) as ParentRow[];

    const parentRow = parent[0];
    if (!parentRow) throw new DecomposeError('NOT_FOUND', `issue ${parentIssueId} not found`);

    // Validate existing-issue specs (membership in the same project).
    const existingIds = children
      .map((c) => c.existingIssueId)
      .filter((v): v is string => typeof v === 'string');
    if (existingIds.length > 0) {
      const existing = await tx
        .select({ id: issues.id, projectId: issues.projectId })
        .from(issues)
        .where(inArray(issues.id, existingIds));
      const byId = new Map(existing.map((r) => [r.id, r]));
      for (const id of existingIds) {
        const row = byId.get(id);
        if (!row) throw new DecomposeError('NOT_FOUND', `child issue ${id} not found`);
        if (row.projectId !== parentRow.projectId) {
          throw new DecomposeError(
            'BAD_REQUEST',
            `child issue ${id} is not in the same project as the parent`,
          );
        }
      }
    }

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
          projectId: parentRow.projectId,
          title: spec.title.trim(),
          description: spec.description ?? null,
          status: 'draft',
          priority: spec.priority ?? parentRow.priority,
          category: spec.category ?? parentRow.category,
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
      pendingChildHooks.push({
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
        payload: { parentId: parentRow.id, integrationBranch },
      });
    }

    // Insert decomposes edges (idempotent on the unique edge index).
    let createdEdges = 0;
    for (const childId of childIds) {
      const inserted = await tx
        .insert(issueDependencies)
        .values({
          projectId: parentRow.projectId,
          fromIssueId: parentRow.id,
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
      if (edgeId) {
        createdEdges++;
        pendingEdgeHooks.push({
          edgeId,
          projectId: parentRow.projectId,
          fromIssueId: parentRow.id,
          toIssueId: childId,
          kind: 'decomposes',
        });
        const payload = {
          edgeId,
          fromIssueId: parentRow.id,
          toIssueId: childId,
          kind: 'decomposes' as const,
        };
        await recordActivityTx(tx, {
          issueId: parentRow.id,
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
    }

    // Parent metadata: written on the FIRST decomposition only (i.e. when
    // the parent does not yet record a branchConfig). Opt-out parents also
    // get a metadata write so subsequent calls inherit the flag.
    if (useIntegrationBranch && integrationBranch && !parentAlreadyDecomposed) {
      const projectBase = pickBranch(project.baseBranch) ?? 'main';
      const projectProd = pickBranch(project.productionBranch) ?? projectBase;
      const parentPatch = {
        useIntegrationBranch: true,
        branchConfig: {
          baseBranch: projectBase,
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
        .where(eq(issues.id, parentRow.id));
    } else if (!useIntegrationBranch && parentRow.metadata?.useIntegrationBranch !== false) {
      const parentPatch = { useIntegrationBranch: false };
      await tx
        .update(issues)
        .set({
          metadata: sql`coalesce(${issues.metadata}, '{}'::jsonb) || ${JSON.stringify(parentPatch)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, parentRow.id));
    }

    if (useIntegrationBranch && integrationBranch) {
      const childPatch = {
        branchConfig: {
          baseBranch: integrationBranch,
          targetBranch: integrationBranch,
        },
      };
      const patchJson = JSON.stringify(childPatch);
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

    if (createdEdges > 0 || pendingChildHooks.length > 0) {
      await recordActivityTx(tx, {
        issueId: parentRow.id,
        actor: actorRef,
        action: 'issue.decomposed',
        payload: { childIds, integrationBranch },
      });
    }

    return { parentId: parentRow.id, childIds, createdEdges };
  });

  // Post-commit hooks. Failures here are logged but do not roll back the
  // transaction (consistent with the issues routes' issueCreated emit site).
  for (const child of pendingChildHooks) {
    try {
      await hooks.emit('issueCreated', {
        issueId: child.issueId,
        projectId: child.projectId,
        actor: actorRef,
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
  for (const edge of pendingEdgeHooks) {
    try {
      await hooks.emit('dependencyChanged', edge);
    } catch (err) {
      logger.error({ err, edgeId: edge.edgeId }, 'decompose: dependencyChanged emit failed');
    }
  }

  await parkParentAtReviewGate({
    parentId: result.parentId,
    projectId: preParent.projectId,
    fromStatus: preParent.status,
    createdEdges: result.createdEdges,
    skip: parentAlreadyDecomposed || preParent.status === 'waiting',
  });

  return {
    parentId: result.parentId,
    childIds: result.childIds,
    integrationBranch,
    createdEdges: result.createdEdges,
  };
}

function pickBranch(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function loadParentLite(parentIssueId: string): Promise<ParentRow | null> {
  const rows = (await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      projectId: issues.projectId,
      status: issues.status,
      priority: issues.priority,
      category: issues.category,
      metadata: issues.metadata,
    })
    .from(issues)
    .where(eq(issues.id, parentIssueId))
    .limit(1)) as ParentRow[];
  return rows[0] ?? null;
}

async function loadProject(projectId: string): Promise<ProjectRow | null> {
  const [row] = await db
    .select({
      id: projects.id,
      baseBranch: projects.baseBranch,
      productionBranch: projects.productionBranch,
      repoPath: projects.repoPath,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return (row as ProjectRow | undefined) ?? null;
}

async function resolveIntegrationBranchName(
  repoPath: string,
  baseCandidate: string,
): Promise<string> {
  if (!(await gitRemoteHasBranch(repoPath, baseCandidate))) {
    return baseCandidate;
  }
  for (let i = 2; i <= MAX_BRANCH_SUFFIX; i++) {
    const candidate = `${baseCandidate}-${i}`;
    if (!(await gitRemoteHasBranch(repoPath, candidate))) return candidate;
  }
  throw new DecomposeError(
    'INTEGRATION_BRANCH_CONFLICT',
    `cannot find an unused integration branch name for ${baseCandidate}`,
  );
}
