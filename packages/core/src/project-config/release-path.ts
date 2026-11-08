import type { ReleaseMode } from '@forge/contracts/forecast';
import { releaseApprovalRequired, releaseThroughChangeRequests } from '@forge/contracts/releases';
import {
  defaultBranchOf,
  environmentsOf,
  MAX_PERFORMED_CROSSINGS,
  type NamedEnvironment,
  type Promotion,
  productionOf,
  productionSitesOf,
  promotionSourcesOf,
  releaseLandingOf,
  sitesOf,
} from './promotion-path.js';
import type { DeploymentTrigger, ProjectDocument } from './schema.js';
import { readProjectDocument } from './service.js';

export {
  type EnvironmentSite,
  environmentsOf,
  type NamedEnvironment,
  type Promotion,
  productionOf,
  productionSitesOf,
  sitesOf,
} from './promotion-path.js';

/** Where a change goes once it lands, read from the project document and nothing else. */
export interface ReleasePath {
  revision: number;
  document: ProjectDocument;
  /** `source.git.defaultBranch`, where work lands; null on a project with no git source. */
  defaultBranch: string | null;
  production: NamedEnvironment | null;
  /** The one promotion a landed change crosses to reach the branch production deploys from; null where none is needed. */
  crossing: Promotion | null;
}

type ReleasePathRead = { ok: true; path: ReleasePath } | { ok: false; reason: string };

export function bindingOf(env: NamedEnvironment): string | null {
  return 'binding' in env.declaration.deployment ? env.declaration.deployment.binding : null;
}

export function releasePathOf(revision: number, document: ProjectDocument): ReleasePathRead {
  const { defaultBranch, production, target, crossings } = releaseLandingOf(document);
  if (!crossings) {
    return {
      ok: false,
      reason: `project document revision ${revision}: production environment \`${production?.name}\` deploys from \`${target}\`, and no promotion reaches \`${target}\` from \`${defaultBranch}\`, where work lands — declare the promotion, or deploy production from \`${defaultBranch}\``,
    };
  }
  if (crossings.length > MAX_PERFORMED_CROSSINGS) {
    return {
      ok: false,
      reason: `project document revision ${revision}: a change landing on \`${defaultBranch}\` crosses ${crossings.length} promotions to reach \`${target}\`, and a release performs at most ${MAX_PERFORMED_CROSSINGS} — declare one promotion into \`${target}\`, or deploy production from a nearer branch`,
    };
  }
  return {
    ok: true,
    path: { revision, document, defaultBranch, production, crossing: crossings[0] ?? null },
  };
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
  return path.crossing?.to ?? null;
}

/** Where work lands, the branch a promotion carries it to, and every branch a promotion leaves from. */
export interface LandingBranches {
  defaultBranch: string | null;
  promoted: string | null;
  /** A request whose head is one of these is a promotion of landed work (`promotionSourcesOf`). */
  promotes: string[];
}

export async function readLandingBranches(projectId: string): Promise<LandingBranches> {
  const held = await readProjectDocument(projectId);
  if (!held) return { defaultBranch: null, promoted: null, promotes: [] };
  const path = releasePathOf(held.revision, held.document);
  return {
    defaultBranch: defaultBranchOf(held.document),
    promoted: path.ok ? promotedBranch(path.path) : null,
    promotes: promotionSourcesOf(held.document),
  };
}

/** One cherry-picked crossing is enough: every commit below it gets a new sha further down. */
export function crossesByCherryPick(path: ReleasePath): boolean {
  return path.crossing?.via === 'cherry-pick';
}

export function describeCrossings(path: ReleasePath): string {
  if (!path.crossing) return path.defaultBranch ?? 'no git source';
  return `${path.defaultBranch} ${path.crossing.via} → ${path.crossing.to}`;
}

/** The production sites' bindings, and the environment and site each deploy binding serves. */
export interface DeployMap {
  /** Every production site's binding, the environment's own first (ISS-1077); empty where none is bound. */
  productionBindings: ReadonlySet<string>;
  /** Unset for a binding no environment of the project document names. */
  environments: ReadonlyMap<string, { name: string; site: string; trigger: DeploymentTrigger }>;
}

/** The deploy map one document declares: every site of every environment, by its binding. */
export function readDeployMapOf(document: ProjectDocument): DeployMap {
  const environments = new Map<
    string,
    { name: string; site: string; trigger: DeploymentTrigger }
  >();
  for (const env of environmentsOf(document)) {
    for (const site of sitesOf(env)) {
      if (site.binding !== null && site.trigger !== null) {
        environments.set(site.binding, { name: env.name, site: site.name, trigger: site.trigger });
      }
    }
  }
  const productionBindings = new Set(
    productionSitesOf(document).flatMap((s) => (s.binding === null ? [] : [s.binding])),
  );
  return { productionBindings, environments };
}

export async function readDeployMap(projectId: string): Promise<DeployMap> {
  const held = await readProjectDocument(projectId);
  if (!held) return { productionBindings: new Set(), environments: new Map() };
  return readDeployMapOf(held.document);
}

/** `release.approval.required` of the project document; a project with no document requires none. */
export async function approvalRequired(projectId: string): Promise<boolean> {
  return releaseApprovalRequired((await readProjectDocument(projectId))?.document);
}

/**
 * How a landed change reaches people: no production environment (`none`), a release approval
 * required (`approval`), production deploying on land (`automatic`), or a release a person cuts
 * (`manual`). A project with no document declares no production. With no production, a project
 * whose release merges its change requests (`release.changeRequests`, REQ-63 BC-1) releases by
 * approval: the approval is the go to merge.
 */
export function releaseModeOf(document: ProjectDocument | undefined): ReleaseMode {
  const production = document ? productionOf(document) : null;
  if (!production) {
    return releaseThroughChangeRequests(document) && releaseApprovalRequired(document)
      ? 'approval'
      : 'none';
  }
  if (releaseApprovalRequired(document)) return 'approval';
  return deploysOnLandOf(document) ? 'automatic' : 'manual';
}

/**
 * Whether production deploys on land (`environments.<production>.deployment.trigger: on-land`, and
 * the same on each of its `sites`, ISS-1077): a change reaches production when it lands on the
 * branch, so what holds it from production holds it from landing. A project with no document, no
 * production environment, or a production any site of which is deployed another way (`on-request`,
 * `provider`, external) does not: it promotes, and a person cuts the release.
 */
export function deploysOnLandOf(document: ProjectDocument | undefined): boolean {
  const sites = document ? productionSitesOf(document) : [];
  return sites.length > 0 && sites.every((s) => s.trigger === 'on-land');
}

export async function readReleaseMode(projectId: string): Promise<ReleaseMode> {
  return releaseModeOf((await readProjectDocument(projectId))?.document);
}
