// Whom a project's master acts as, read off the boxes serving it: the steward's ports
// (steward-ports.ts) and Needs you (work-ports.ts) both read it.

import { deviceHolderUserId, workspaceHolderUserId } from './devices/index.js';
import { projectDeviceIds } from './runners/index.js';
import type { MasterAccounts } from './steward/index.js';

/**
 * The accounts a project's master acts as: for each box serving the project (one holding a live device
 * credential), the holder of its checkout's credential, which its pane writes under. The device
 * credential's holder is not it: a box paired by a person carries the project's agent in its checkout
 * (ISS-590). A box whose checkout carries no live credential is named unread, never guessed.
 */
export async function masterAccountsOf(projectId: string): Promise<MasterAccounts> {
  const accounts = new Set<string>();
  const unread: string[] = [];
  for (const deviceId of await projectDeviceIds(projectId)) {
    if ((await deviceHolderUserId(deviceId)) === null) continue;
    const holder = await workspaceHolderUserId(deviceId, projectId);
    if (holder === null) unread.push(deviceId);
    else accounts.add(holder);
  }
  return { accounts: [...accounts], unread };
}
