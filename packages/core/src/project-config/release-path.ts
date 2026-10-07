import { releaseApprovalRequired } from '@forge/contracts/releases';
import { crossingsTo, type Promotion } from './promotion-path.js';
import type { DeploymentTrigger, EnvironmentDeclaration, ProjectDocument } from './schema.js';
import { readProjectDocument } from './service.js';
import { defaultBranchOf } from './source.js';

export type { Promotion } from './promotion-path.js';

export interface NamedEnvironment {
  name: string;
  declaration: EnvironmentDeclaration;
}

/** Where a change goes once it lands, read from the project document and nothing else. */
export interface ReleasePath {
  revision: number;
  document: ProjectDocument;
  /** `source.git.defaultBranch`, where work lands; null on a project with no git source. */
  defaultBranch: string | null;
  production: NamedEnvironment | null;
  /** The promotions a landed change crosses, in order, to reach the branch production deploys from. */
  crossings: Promotion[];
}

type ReleasePathRead = { ok: true; path: ReleasePath } | { ok: false; reason: string };

export function environmentsOf(document: ProjectDocument): NamedEnvironment[] {
  return Object.entries(document.environments).map(([name, declaration]) => ({
    name,
    declaration,
  }));
}

export function productionOf(document: ProjectDocument): NamedEnvironment | null {
  return environmentsOf(document).find((e) => e.declaration.tier === 'production') ?? null;
}

export function bindingOf(env: NamedEnvironment): string | null {
  return 'binding' in env.declaration.deployment ? env.declaration.deployment.binding : null;
}

export function releasePathOf(revision: number, document: ProjectDocument): ReleasePathRead {
  const defaultBranch = defaultBranchOf(document);
  const production = productionOf(document);
  const target = production?.declaration.deploysFrom;
  if (!production || defaultBranch === null || target === undefined) {
    return { ok: true, path: { revision, document, defaultBranch, production, crossings: [] } };
  }
  const crossings = crossingsTo(document.promotions, defaultBranch, target);
  if (!crossings) {
    return {
      ok: false,
      reason: `project document revision ${revision}: production environment \`${production.name}\` deploys from \`${target}\`, and no promotion reaches \`${target}\` from \`${defaultBranch}\`, where work lands — declare the promotion, or deploy production from \`${defaultBranch}\``,
    };
  }
  return { ok: true, path: { revision, document, defaultBranch, production, crossings } };
}

export async function readReleasePath(projectId: string): Promise<ReleasePathRead> {
  const held = await readProjectDocument(projectId);
  if (!held) {
    return {
      ok: false,
      reason: `project ${projectId} has declared no project document, so nothing says where a landed change goes — PUT /api/projects/${projectId}/config first`,
    };
  }
  return releasePathOf(held.revision, held.document);
}

/** The branch production deploys from where a promotion crosses into it; null where none does. */
export function promotedBranch(path: ReleasePath): string | null {
  return path.crossings.at(-1)?.to ?? null;
}

export async function readLandingBranches(
  projectId: string,
): Promise<{ defaultBranch: string | null; promoted: string | null }> {
  const held = await readProjectDocument(projectId);
  if (!held) return { defaultBranch: null, promoted: null };
  const path = releasePathOf(held.revision, held.document);
  return {
    defaultBranch: defaultBranchOf(held.document),
    promoted: path.ok ? promotedBranch(path.path) : null,
  };
}

/** One cherry-picked crossing is enough: every commit below it gets a new sha further down. */
export function crossesByCherryPick(path: ReleasePath): boolean {
  return path.crossings.some((p) => p.via === 'cherry-pick');
}

export function describeCrossings(path: ReleasePath): string {
  if (path.crossings.length === 0) return path.defaultBranch ?? 'no git source';
  return [path.defaultBranch, ...path.crossings.map((p) => `${p.via} → ${p.to}`)].join(' ');
}

/** The production environment's binding, and the environment each deploy binding serves. */
export interface DeployMap {
  productionBinding: string | null;
  /** Unset for a binding no environment of the project document names. */
  environments: ReadonlyMap<string, { name: string; trigger: DeploymentTrigger }>;
}

export async function readDeployMap(projectId: string): Promise<DeployMap> {
  const held = await readProjectDocument(projectId);
  const environments = new Map<string, { name: string; trigger: DeploymentTrigger }>();
  if (!held) return { productionBinding: null, environments };
  for (const env of environmentsOf(held.document)) {
    const d = env.declaration.deployment;
    if ('binding' in d) environments.set(d.binding, { name: env.name, trigger: d.trigger });
  }
  const production = productionOf(held.document);
  return { productionBinding: production ? bindingOf(production) : null, environments };
}

/** `release.approval.required` of the project document; a project with no document requires none. */
export async function approvalRequired(projectId: string): Promise<boolean> {
  return releaseApprovalRequired((await readProjectDocument(projectId))?.document);
}
