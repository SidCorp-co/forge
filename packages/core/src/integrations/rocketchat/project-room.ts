// The room a project's own messages go to, when nothing more specific names one.
//
// Lifted out of `question-delivery.ts` by ISS-1091 so the destination resolver
// and the comment mirror can both reach it without either importing the
// delivery lane it now only partly answers for.

import { activeRocketChatBinding } from './binding.js';
import type { RocketChatBindingConfig } from './types.js';

export interface RoomBinding {
  connectionId: string;
  rid: string;
}

/** The room this project's messages go to, or null when nobody has bound one. */
// cm:guard the FIRST rid of the first active binding, matching `connection-manager.ts:buildRoutes`, which takes the first binding per room from a `desc(createdAt)` ordering — two answers to "which room is this project's" is how a message is delivered to a room nobody is watching.
// cm:guard since ISS-1091 this is no longer the answer to "which room does this ROUND go to": a question asked while answering a conversation window is delivered to that window's own room, and this is reached only by a question that belongs to no conversation at all. The claim above is unchanged and still names this project's room; what changed is who asks it.
export async function roomForProject(projectId: string): Promise<RoomBinding | null> {
  const bindings = await activeRocketChatBinding(projectId).then((p) => (p ? [p] : []));
  for (const { binding } of bindings) {
    const rid = ((binding.config as RocketChatBindingConfig | null)?.rids ?? [])[0];
    if (rid) return { connectionId: binding.connectionId, rid };
  }
  return null;
}
