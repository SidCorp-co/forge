import { activeRocketChatBinding } from './binding.js';
import type { RocketChatBindingConfig } from './types.js';

export interface RoomBinding {
  connectionId: string;
  rid: string;
}

/** The room this project's messages go to, or null when nobody has bound one. */
export async function roomForProject(projectId: string): Promise<RoomBinding | null> {
  const bindings = await activeRocketChatBinding(projectId).then((p) => (p ? [p] : []));
  for (const { binding } of bindings) {
    const rid = ((binding.config as RocketChatBindingConfig | null)?.rids ?? [])[0];
    if (rid) return { connectionId: binding.connectionId, rid };
  }
  return null;
}
