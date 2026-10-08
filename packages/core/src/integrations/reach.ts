import type { ConnectionReach } from '@forge/contracts';
import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import { fencedProjectIds } from '../auth/pat-scope.js';
import { db } from '../db/client.js';
import {
  integrationBindings,
  integrationConnections,
  type OrgMemberRole,
  organizationMembers,
  projectMembers,
  projects,
} from '../db/schema.js';
import { orgRoleAtLeast } from '../lib/authz.js';
import type { IntegrationConnectionRow } from './store.js';

export type { ConnectionReach };

/**
 * Who may reach a connection, stated once, and read by every door: the directory, a connection's
 * own routes, the repository picker and the install-completion probe. Reaching is READING — what a
 * caller is shown — and never what they may change (`canManage`), so this widens no write.
 *
 *  - `owner`   — the individual who owns it.
 *  - `org`     — any member of the org that owns it.
 *  - `binding` — an admin of a project that has a binding row on it, whoever owns it and whether
 *                the binding is switched on. A connection minted before ISS-1115 is owned by
 *                whoever pressed Connect, and this keeps every other admin of its project from
 *                being told it does not exist.
 */
export interface ReachedConnection {
  connection: IntegrationConnectionRow;
  reach: ConnectionReach;
  /** The owner, or an owner/admin of the owning org. Nothing else changes a connection. */
  canManage: boolean;
  /**
   * For `binding` reach, the projects the caller administers that the connection is bound to —
   * the only bindings such a reader is shown. Empty for the other two, who see every binding.
   */
  viaProjectIds: string[];
}

async function administeredProjectIds(userId: string): Promise<string[]> {
  const conditions: SQL[] = [
    sql`(${projectMembers.role} = 'admin' OR ${organizationMembers.role} IN ('owner', 'admin'))`,
  ];
  const fence = fencedProjectIds();
  if (fence) conditions.push(fence.length > 0 ? inArray(projects.id, [...fence]) : sql`false`);
  const rows = await db
    .selectDistinct({ id: projects.id })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)),
    )
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.userId, userId)),
    )
    .where(and(...conditions));
  return rows.map((r) => r.id);
}

async function orgRolesOf(userId: string): Promise<Map<string, OrgMemberRole>> {
  const rows = await db
    .select({ orgId: organizationMembers.orgId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  return new Map(rows.map((r) => [r.orgId, r.role]));
}

/** connection id → the administered projects it has a binding row on, any active state. */
async function boundThrough(
  administered: string[],
  connectionId?: string,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (administered.length === 0) return out;
  const rows = await db
    .selectDistinct({
      connectionId: integrationBindings.connectionId,
      projectId: integrationBindings.projectId,
    })
    .from(integrationBindings)
    .where(
      and(
        inArray(integrationBindings.projectId, administered),
        connectionId ? eq(integrationBindings.connectionId, connectionId) : undefined,
      ),
    );
  for (const row of rows) {
    const list = out.get(row.connectionId);
    if (list) list.push(row.projectId);
    else out.set(row.connectionId, [row.projectId]);
  }
  return out;
}

function classify(
  connection: IntegrationConnectionRow,
  userId: string,
  orgRoles: Map<string, OrgMemberRole>,
  through: string[] | undefined,
): ReachedConnection | null {
  if (connection.ownerType === 'user' && connection.ownerId === userId) {
    return { connection, reach: 'owner', canManage: true, viaProjectIds: [] };
  }
  if (connection.ownerType === 'org') {
    const role = orgRoles.get(connection.ownerId) ?? null;
    if (role) {
      return {
        connection,
        reach: 'org',
        canManage: orgRoleAtLeast(role, 'admin'),
        viaProjectIds: [],
      };
    }
  }
  if (through && through.length > 0) {
    return { connection, reach: 'binding', canManage: false, viaProjectIds: through };
  }
  return null;
}

/**
 * Every connection the caller reaches, newest first. ALL active states: the directory shows a
 * disabled connection as Disabled and lets it be re-enabled rather than dropping it (ISS-429);
 * share-eligibility (`active && hasSecrets`) is the screen's to apply.
 */
export async function listReachableConnections(userId: string): Promise<ReachedConnection[]> {
  const [orgRoles, administered] = await Promise.all([
    orgRolesOf(userId),
    administeredProjectIds(userId),
  ]);
  const through = await boundThrough(administered);
  const orgIds = [...orgRoles.keys()];
  const boundIds = [...through.keys()];
  const clauses: SQL[] = [
    and(
      eq(integrationConnections.ownerType, 'user'),
      eq(integrationConnections.ownerId, userId),
    ) as SQL,
  ];
  if (orgIds.length > 0) {
    clauses.push(
      and(
        eq(integrationConnections.ownerType, 'org'),
        inArray(integrationConnections.ownerId, orgIds),
      ) as SQL,
    );
  }
  if (boundIds.length > 0) clauses.push(inArray(integrationConnections.id, boundIds));
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(or(...clauses))
    .orderBy(desc(integrationConnections.createdAt));
  const out: ReachedConnection[] = [];
  for (const row of rows) {
    const reached = classify(row, userId, orgRoles, through.get(row.id));
    if (reached) out.push(reached);
  }
  return out;
}

/** One connection by id, or null where the caller does not reach it or it does not exist. */
export async function findReachableConnection(
  userId: string,
  connectionId: string,
): Promise<ReachedConnection | null> {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!row) return null;
  const orgRoles = await orgRolesOf(userId);
  const direct = classify(row, userId, orgRoles, undefined);
  if (direct) return direct;
  const through = await boundThrough(await administeredProjectIds(userId), connectionId);
  return classify(row, userId, orgRoles, through.get(connectionId));
}

/** The bindings of a reached connection the caller is entitled to see. */
export function bindingsVisibleTo<T>(
  reached: ReachedConnection,
  bindings: T[],
  projectOf: (binding: T) => string,
): T[] {
  if (reached.reach !== 'binding') return bindings;
  const allowed = new Set(reached.viaProjectIds);
  return bindings.filter((b) => allowed.has(projectOf(b)));
}
