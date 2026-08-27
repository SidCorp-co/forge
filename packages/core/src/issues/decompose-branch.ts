import { eq } from 'drizzle-orm';
import { type Db, db } from '../db/client.js';
import { type IssuePriority, type IssueStatus, issues, projects } from '../db/schema.js';
import {
  createIntegrationBranch,
  gitRemoteHasBranch,
  IntegrationBranchError,
} from '../git/branches.js';

const MAX_BRANCH_SUFFIX = 10;
const allowedParentStatuses: ReadonlySet<IssueStatus> = new Set([
  'confirmed',
  'clarified',
  'waiting',
]);

interface ParentMetadata {
  branchConfig?: { baseBranch?: string | null; targetBranch?: string | null } | null;
  integrationBranch?: string | null;
  useIntegrationBranch?: boolean;
  [k: string]: unknown;
}

export interface DecompositionParent {
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

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ParentDecompositionState {
  parent: DecompositionParent;
  project: ProjectRow;
  integrationBranch: string | null;
  parentAlreadyDecomposed: boolean;
  useIntegrationBranch: boolean;
}

export class DecomposeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DecomposeError';
    this.code = code;
  }
}

export async function prepareParentDecomposition(
  tx: Tx,
  parentIssueId: string,
  options: { useIntegrationBranch?: boolean | undefined } | undefined,
): Promise<ParentDecompositionState> {
  const [parent] = (await tx
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
    .for('update')) as DecompositionParent[];
  if (!parent) throw new DecomposeError('NOT_FOUND', `issue ${parentIssueId} not found`);

  const project = await loadProject(tx, parent.projectId);
  if (!project) throw new DecomposeError('NOT_FOUND', 'parent project not found');

  const recordedBranch = pickBranch(parent.metadata?.integrationBranch ?? null);
  const legacyBranch = pickBranch(parent.metadata?.branchConfig?.baseBranch ?? null);
  const projectBase = pickBranch(project.baseBranch) ?? 'main';
  const legacyIntegrationBranch = legacyBranch !== projectBase ? legacyBranch : null;
  const parentAlreadyDecomposed =
    recordedBranch != null ||
    parent.metadata?.useIntegrationBranch === true ||
    parent.metadata?.useIntegrationBranch === false;
  if (!parentAlreadyDecomposed && !allowedParentStatuses.has(parent.status)) {
    throw new DecomposeError(
      'BAD_REQUEST',
      `parent status must be confirmed, clarified, or waiting (got ${parent.status})`,
    );
  }

  const useIntegrationBranch =
    options?.useIntegrationBranch ?? parent.metadata?.useIntegrationBranch ?? true;
  if (
    useIntegrationBranch &&
    parentAlreadyDecomposed &&
    !recordedBranch &&
    !legacyIntegrationBranch
  ) {
    throw new DecomposeError(
      'LEGACY_INTEGRATION_BRANCH_UNKNOWN',
      'parent integration branch is not recorded; set metadata.integrationBranch before adding children',
    );
  }
  const integrationBranch = await ensureIntegrationBranch(
    parent,
    project,
    recordedBranch ?? legacyIntegrationBranch,
    useIntegrationBranch,
  );
  return { parent, project, integrationBranch, parentAlreadyDecomposed, useIntegrationBranch };
}

export function slugifyIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function pickBranch(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function loadParentLite(parentIssueId: string): Promise<DecompositionParent | null> {
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
    .limit(1)) as DecompositionParent[];
  return rows[0] ?? null;
}

async function loadProject(tx: Tx, projectId: string): Promise<ProjectRow | null> {
  const [row] = await tx
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

async function ensureIntegrationBranch(
  parent: DecompositionParent,
  project: ProjectRow,
  existingBranch: string | null,
  useIntegrationBranch: boolean,
): Promise<string | null> {
  if (!useIntegrationBranch) return null;
  if (existingBranch) return existingBranch;
  if (!project.repoPath) {
    throw new DecomposeError(
      'BAD_REQUEST',
      'project has no repoPath configured; cannot create integration branch',
    );
  }
  const projectBase = pickBranch(project.baseBranch) ?? 'main';
  const baseSlug = slugifyIssueTitle(parent.title).slice(0, 40);
  const baseCandidate = baseSlug ? `iss-${parent.issSeq}-${baseSlug}` : `iss-${parent.issSeq}`;
  // cm:guard hold the parent row lock through branch selection and creation — concurrent decomposes writes otherwise both choose a free name, race the remote push, and can commit edges without one shared integration branch
  const integrationBranch = await resolveIntegrationBranchName(project.repoPath, baseCandidate);
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
  return integrationBranch;
}

async function resolveIntegrationBranchName(
  repoPath: string,
  baseCandidate: string,
): Promise<string> {
  if (!(await gitRemoteHasBranch(repoPath, baseCandidate))) return baseCandidate;
  for (let i = 2; i <= MAX_BRANCH_SUFFIX; i++) {
    const candidate = `${baseCandidate}-${i}`;
    if (!(await gitRemoteHasBranch(repoPath, candidate))) return candidate;
  }
  throw new DecomposeError(
    'INTEGRATION_BRANCH_CONFLICT',
    `cannot find an unused integration branch name for ${baseCandidate}`,
  );
}
