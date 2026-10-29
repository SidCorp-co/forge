import { releaseThroughChangeRequests } from '@forge/contracts/releases';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import {
  type BindingWithConnection,
  findBindingWithConnectionById,
} from '../integrations/index.js';
import {
  bindingOf,
  type NamedEnvironment,
  promotedBranch,
  type ReleasePath,
  readReleasePath,
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
  | {
      kind: 'gated';
      path: ReleasePath;
      defaultBranch: string | null;
      production: NamedEnvironment;
      /** The branch production deploys from where a promotion crosses into it; null where none does. */
      deploysFrom: string | null;
      binding: BindingWithConnection;
    };

async function productionBinding(
  projectId: string,
  production: NamedEnvironment,
): Promise<{ ok: true; pair: BindingWithConnection } | { ok: false; reason: string }> {
  const id = bindingOf(production);
  if (id === null) {
    return {
      ok: false,
      reason: `production environment \`${production.name}\` is deployed outside Forge (deployment mode external) and no promotion crosses into the branch it deploys from, so there is nowhere Forge can land a release — declare that promotion (a release is then its change request), give it a deploy binding, or declare no production environment if Forge ships nothing`,
    };
  }
  const pair = await findBindingWithConnectionById(id);
  const live =
    pair?.binding.projectId === projectId && pair.binding.active && pair.connection.active;
  if (!pair || !live) {
    return {
      ok: false,
      reason: `production environment \`${production.name}\` deploys through binding ${id}, which is not an active binding of this project with an active connection — rebind it, or change the project document`,
    };
  }
  return { ok: true, pair };
}

/** The declaration, read from the project document rather than inferred. `null`: no such project. */
export async function resolveReleaseDeclaration(
  projectId: string,
): Promise<ReleaseDeclaration | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
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
  const bound = await productionBinding(projectId, path.production);
  if (!bound.ok) return { kind: 'undeclared-target', reason: bound.reason };
  return {
    kind: 'gated',
    path,
    defaultBranch: path.defaultBranch,
    production: path.production,
    deploysFrom: promotedBranch(path),
    binding: bound.pair,
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
  return decl.kind === 'gated' || decl.kind === 'change-requests' || decl.kind === 'promotion'
    ? RELEASE_GATE_STATUS
    : null;
}
