import { activeRocketChatBinding } from './binding.js';
import type { RocketChatBindingConfig } from './types.js';

interface RoomBinding {
  connectionId: string;
  rid: string;
}

/**
 * The room this project's messages go to, or null when nobody has bound one. A support group is
 * never it: the people there are a product's users, not the team a parked question is for; nor is an
 * operations room, which its own session answers; nor a channel agent's room, whose agent is handed
 * the question itself and asks it, if at all, in the owner's room (ISS-873).
 */
export async function roomForProject(projectId: string): Promise<RoomBinding | null> {
  const bindings = await activeRocketChatBinding(projectId).then((p) => (p ? [p] : []));
  for (const { binding } of bindings) {
    const config = binding.config as RocketChatBindingConfig | null;
    if (config?.support || config?.operations || config?.agent) continue;
    const rid = (config?.rids ?? [])[0];
    if (rid) return { connectionId: binding.connectionId, rid };
  }
  return null;
}
