import { existingProjectHandle, resolveProjectHandle } from '../conversations/handles.js';
import { db } from '../db/client.js';

export type ReconcilerActor = { type: 'user'; id: string; agency: 'agent' };

/** The project's own agent account, never its creator's: that reads as a person (ISS-1317). */
export async function reconcilerActorFor(projectId: string): Promise<ReconcilerActor> {
  const userId = await db.transaction(async (tx) => {
    const existing = await existingProjectHandle(tx, projectId);
    if (existing) return existing.userId;
    return (await resolveProjectHandle(tx, projectId)).userId;
  });
  return { type: 'user', id: userId, agency: 'agent' };
}
