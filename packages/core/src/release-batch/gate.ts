import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, projects } from '../db/schema.js';
import {
  type BindingWithConnection,
  findBindingWithConnectionById,
} from '../integrations/store.js';
import {
  bindingOf,
  type NamedEnvironment,
  promotedBranch,
  type ReleasePath,
  readReleasePath,
} from '../project-config/release-path.js';

/** The one status an issue waits at for release. */
export const RELEASE_GATE_STATUS: IssueStatus = 'awaiting_release';

/** Thrown where nothing says where a release lands, so an issue cannot be parked for one. */
export class ReleaseTargetUndeclaredError extends Error {
  readonly code = 'RELEASE_TARGET_UNDECLARED';
  constructor(
    readonly projectId: string,
    readonly reason: string,
  ) {
    super(`RELEASE_TARGET_UNDECLARED: ${reason}`);
    this.name = 'ReleaseTargetUndeclaredError';
  }
}

export type ReleaseDeclaration =
  | { kind: 'no-release'; defaultBranch: string | null }
  | { kind: 'undeclared-target'; reason: string }
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
      reason: `production environment \`${production.name}\` is deployed outside Forge (deployment mode external), so there is nowhere Forge can land a release — give it a deploy binding, or declare no production environment if Forge ships nothing`,
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
  if (!path.production) return { kind: 'no-release', defaultBranch: path.defaultBranch };
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
 * The status issues must be at to join a batch release, or `null` when the project
 * declares no production environment and the driver's `closed` means what it says.
 *
 * THROWS on `undeclared-target`. The caller 409s with `RELEASE_TARGET_UNDECLARED`; answering
 * `null` there reads to every caller as a project that declared it ships nothing.
 */
export async function resolveReleaseGate(projectId: string): Promise<IssueStatus | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (!decl) return null;
  if (decl.kind === 'undeclared-target') {
    throw new ReleaseTargetUndeclaredError(projectId, decl.reason);
  }
  return decl.kind === 'gated' ? RELEASE_GATE_STATUS : null;
}
