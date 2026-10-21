// The one agent account a project's steward acts as (REQ-48 BC-1), minted lazily on its first run
// like the project's conversation handle, and a member of the project with exactly the steward's
// grants (REQ-48 r2 decision 2, amended 2026-10-21): `project.write`, `suggestions.write`,
// `feedback.approve` and `suggestions.approve`. Its role is `viewer`, so it holds nothing a role would
// add beyond them: no `issues.admit`, `releases.approve`, `plans.approve` or `project.admin`. Which
// approval one act may use is the act's token's (`STEWARD_ACT_APPROVALS`), and an accept is held to
// its own triage by the accept door.

import type { ProjectPermission } from '@forge/contracts/permissions';
import { STEWARD_ACCOUNT_NAME } from '@forge/contracts/steward-runtime';
import { eq } from 'drizzle-orm';
import { insertAgentAccount, setUserDisplayName } from '../auth/index.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { stewardAccounts } from '../db/schema-steward-runs.js';
import { lockXact } from '../lib/advisory-lock.js';
import { addProjectMembers } from '../permissions/index.js';

export const STEWARD_GRANTS: readonly ProjectPermission[] = [
  'project.write',
  'suggestions.write',
  'feedback.approve',
  'suggestions.approve',
];

/** The project's steward account where one was minted, else null; never mints one. */
export async function heldStewardOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: stewardAccounts.userId })
    .from(stewardAccounts)
    .where(eq(stewardAccounts.projectId, projectId))
    .limit(1);
  return row?.userId ?? null;
}

/** The project's steward account, minted with its membership the first time it is asked for. */
export async function stewardAccountOf(projectId: string): Promise<string> {
  const held = await heldStewardOf(projectId);
  if (held) return held;
  const minted = await db.transaction(async (tx) => {
    await lockXact(tx, 'stewardAccount', projectId);
    const [again] = await tx
      .select({ userId: stewardAccounts.userId })
      .from(stewardAccounts)
      .where(eq(stewardAccounts.projectId, projectId))
      .limit(1);
    if (again) return { userId: again.userId, created: false };
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new Error(`steward: project ${projectId} does not exist`);
    const account = await insertAgentAccount(tx, 'steward');
    await tx.insert(stewardAccounts).values({ projectId, userId: account.id });
    await addProjectMembers(tx, [
      { projectId, userId: account.id, role: 'viewer', grants: [...STEWARD_GRANTS] },
    ]);
    return { userId: account.id, created: true };
  });
  if (minted.created) await setUserDisplayName(minted.userId, STEWARD_ACCOUNT_NAME);
  return minted.userId;
}
