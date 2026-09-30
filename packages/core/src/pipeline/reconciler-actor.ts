import { randomUUID } from 'node:crypto';
import type { Executor } from '../conversations/db-executor.js';
import { existingProjectHandle, resolveProjectHandle } from '../conversations/handles.js';
import { db } from '../db/client.js';

export type ReconcilerActor = { type: 'user'; id: string; agency: 'agent' };

export class AgentMintedSinceSelected extends Error {}

/** The project's agent account, never its creator's (ISS-1317); read, minting nothing, so a reset
 *  called off leaves no account behind. Where there is none, it names the id the mint will take. */
export async function reconcilerActorFor(projectId: string): Promise<ReconcilerActor> {
  const existing = await existingProjectHandle(db, projectId);
  return { type: 'user', id: existing?.userId ?? randomUUID(), agency: 'agent' };
}

/** Inside the move's transaction, after the re-checks: mints the account where the actor's is absent. */
export async function mintReconcilerActor(
  tx: Executor,
  projectId: string,
  actor: ReconcilerActor,
): Promise<void> {
  const existing = await existingProjectHandle(tx, projectId);
  if (existing?.userId === actor.id) return;
  if (existing) throw new AgentMintedSinceSelected();
  const handle = await resolveProjectHandle(tx, projectId, actor.id);
  if (handle.userId !== actor.id) throw new AgentMintedSinceSelected();
}
