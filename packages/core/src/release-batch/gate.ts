import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { onePerProject } from '../db/read-memo.js';
import { type IssueStatus, projects } from '../db/schema.js';
import { type BindingWithConnection, heldBindingWithConnection } from '../integrations/index.js';
import {
  bindingOf,
  type EnvironmentSite,
  type NamedEnvironment,
  promotedBranch,
  type ReleasePath,
  readReleasePath,
  sitesOf,
} from '../project-config/index.js';
import { blockerRefusal } from './refuse.js';

/** The one status an issue waits at for release. */
export const RELEASE_GATE_STATUS: IssueStatus = 'awaiting_release';

export type ReleaseDeclaration =
  | { kind: 'no-release'; defaultBranch: string | null }
  /** No deploy: a release is its change requests merged into `defaultBranch` in order (REQ-63). */
  | { kind: 'change-requests'; path: ReleasePath; defaultBranch: string | null }
  | { kind: 'undeclared-target'; reason: string }
  /**
   * Production is deployed outside Forge and one promotion crosses into the branch it deploys from
   * (REQ-63 BC-9): a release is that promotion's change request, merged once approved, and closed by
   * the operator's record of the deploy.
   */
  | {
      kind: 'promotion';
      path: ReleasePath;
      defaultBranch: string | null;
      production: NamedEnvironment;
      promotion: { from: string; to: string };
    }
  /**
   * Production is deployed outside Forge by the door its environment names (`deployment.target`)
   * (ISS-851): issues wait at the gate, nothing is cut, and a release is the agent's record of that
   * door's deploy under the version it released; Forge reads no commit (owner, 2026-11-01).
   */
  | {
      kind: 'external';
      path: ReleasePath;
      defaultBranch: string | null;
      production: NamedEnvironment;
      target: string;
    }
  | {
      kind: 'gated';
      path: ReleasePath;
      defaultBranch: string | null;
      production: NamedEnvironment;
      /** The branch production deploys from where a promotion crosses into it; null where none does. */
      deploysFrom: string | null;
      /** The environment's own site's binding: `sites[0].binding`. */
      binding: BindingWithConnection;
      /** Every site production serves, its own first, each through its own binding (ISS-1077). */
      sites: GatedSite[];
    };

/** One production site a gated release deploys, judges and records, with its binding held. */
export interface GatedSite {
  site: EnvironmentSite;
  binding: BindingWithConnection;
}

/** The door an external production names as the one that deploys it, or null where it names none. */
function externalTarget(production: NamedEnvironment): string | null {
  const { deployment } = production.declaration;
  return 'mode' in deployment ? (deployment.target ?? null) : null;
}

async function siteBinding(
  projectId: string,
  production: NamedEnvironment,
  site: EnvironmentSite,
): Promise<{ ok: true; pair: BindingWithConnection } | { ok: false; reason: string }> {
  const id = site.binding;
  const named =
    site.name === production.name
      ? `production environment \`${production.name}\``
      : `site \`${site.name}\` of production environment \`${production.name}\``;
  if (id === null) {
    return {
      ok: false,
      reason: `${named} is deployed outside Forge (deployment mode external), names no door that deploys it, and no promotion crosses into the branch it deploys from, so there is nowhere Forge can land a release — name the door (\`deployment.target\`, a release is then your record of its deploy), declare that promotion (a release is then its change request), give it a deploy binding, or declare no production environment if Forge ships nothing`,
    };
  }
  const pair = await heldBindingWithConnection(id);
  const live =
    pair?.binding.projectId === projectId && pair.binding.active && pair.connection.active;
  if (!pair || !live) {
    return {
      ok: false,
      reason: `${named} deploys through binding ${id}, which is not an active binding of this project with an active connection — rebind it, or change the project document`,
    };
  }
  return { ok: true, pair };
}

/** Every production site's binding, held; the first site that cannot be deployed refuses the whole. */
async function productionBindings(
  projectId: string,
  production: NamedEnvironment,
): Promise<{ ok: true; sites: GatedSite[] } | { ok: false; reason: string }> {
  const sites: GatedSite[] = [];
  for (const site of sitesOf(production)) {
    const bound = await siteBinding(projectId, production, site);
    if (!bound.ok) return bound;
    sites.push({ site, binding: bound.pair });
  }
  return { ok: true, sites };
}

/** The declaration, read from the project document rather than inferred. `null`: no such project. */
export async function resolveReleaseDeclaration(
  projectId: string,
): Promise<ReleaseDeclaration | null> {
  // a read asks this of each release it weighs and each landing it reads, and of every project it
  // reads beside this one: each is asked once, all of them in one statement (ISS-1070 r6)
  const row = await onePerProject('projectExists', projectId, async (ids) => {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r]));
  });
  if (!row) return null;
  const read = await readReleasePath(projectId);
  if (!read.ok) return { kind: 'undeclared-target', reason: read.reason };
  const { path } = read;
  if (!path.production) {
    return releaseThroughChangeRequests(path.document)
      ? { kind: 'change-requests', path, defaultBranch: path.defaultBranch }
      : { kind: 'no-release', defaultBranch: path.defaultBranch };
  }
  if (bindingOf(path.production) === null && path.crossing) {
    return {
      kind: 'promotion',
      path,
      defaultBranch: path.defaultBranch,
      production: path.production,
      promotion: { from: path.crossing.from, to: path.crossing.to },
    };
  }
  const target = bindingOf(path.production) === null ? externalTarget(path.production) : null;
  if (target) {
    return {
      kind: 'external',
      path,
      defaultBranch: path.defaultBranch,
      production: path.production,
      target,
    };
  }
  const bound = await productionBindings(projectId, path.production);
  if (!bound.ok) return { kind: 'undeclared-target', reason: bound.reason };
  const [own] = bound.sites;
  if (!own) return { kind: 'undeclared-target', reason: 'production declares no site' };
  return {
    kind: 'gated',
    path,
    defaultBranch: path.defaultBranch,
    production: path.production,
    deploysFrom: promotedBranch(path),
    binding: own.binding,
    sites: bound.sites,
  };
}

/**
 * Whether the project has a running build Forge observes: a production environment, bound, that its
 * releases deploy to. A project declaring none — its landing or its change request's merge is the
 * build — has nothing running a steward act could judge (`steward/prompts.ts`).
 */
export async function runningBuildObserved(projectId: string): Promise<boolean> {
  return (await resolveReleaseDeclaration(projectId))?.kind === 'gated';
}

/**
 * The status issues must be at to join a batch release, or `null` when the project
 * declares no production environment and the driver's `closed` means what it says. A project that
 * releases through change requests has the gate too: its issues wait there for their merge.
 *
 * THROWS on `undeclared-target`, refused `RELEASE_TARGET_UNDECLARED`; answering
 * `null` there reads to every caller as a project that declared it ships nothing.
 */
export async function resolveReleaseGate(projectId: string): Promise<IssueStatus | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (!decl) return null;
  if (decl.kind === 'undeclared-target') {
    throw blockerRefusal('RELEASE_TARGET_UNDECLARED', { reason: decl.reason });
  }
  return decl.kind === 'gated' ||
    decl.kind === 'change-requests' ||
    decl.kind === 'promotion' ||
    decl.kind === 'external'
    ? RELEASE_GATE_STATUS
    : null;
}
