// What the permission kernel needs from modules above it: where a project sits, owned by the
// projects domain, and which accounts are agents, owned by auth. The kernel reads only its
// membership tables (ADR 0008); the composition root fills these at boot (`provideProjectOrg` is
// the pattern).

import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';

interface PermissionsPorts {
  /** A project's org as a SQL expression over a project id; null where no such project exists. */
  projectOrgIdSql(projectId: SQLWrapper): SQL;
  /** The org of each of these projects that exists, keyed by project id. */
  projectOrgIds(projectIds: readonly string[]): Promise<Map<string, string>>;
  /** Which of these accounts are agent accounts, read on the executor given. */
  agentAccountsAmong(userIds: readonly string[], executor?: Tx): Promise<Set<string>>;
}

const slot = portSlot<PermissionsPorts>('permissions', 'providePermissionsPorts');
export const providePermissionsPorts = slot.provide;
export const permissionsPort = slot.port;
