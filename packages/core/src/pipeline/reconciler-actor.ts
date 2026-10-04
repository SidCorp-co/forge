import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/client.js';
import { db } from '../db/client.js';
import { existingProjectHandle, resolveProjectHandle } from './ports.js';

export type ReconcilerActor = { type: 'user'; id: string; agency: 'agent' };

/** The project's agent account, never its creator's (ISS-1317); read, minting nothing, so a reset
 *  called off leaves no account behind. Where there is none, it names the id the mint will take. */
export async function reconcilerActorFor(projectId: string): Promise<ReconcilerActor> {
  const existing = await existingProjectHandle(db, projectId);
  return { type: 'user', id: existing?.userId ?? randomUUID(), agency: 'agent' };
}

/**
 * Inside the move's transaction, after the re-checks: mints the account where the actor's is absent.
 * False where the project gained another agent account since the actor was read.
 */
export async function mintReconcilerActor(
  tx: Tx,
  projectId: string,
  actor: ReconcilerActor,
): Promise<boolean> {
  const existing = await existingProjectHandle(tx, projectId);
  if (existing?.userId === actor.id) return true;
  if (existing) return false;
  const handle = await resolveProjectHandle(tx, projectId, actor.id);
  return handle.userId === actor.id;
}
