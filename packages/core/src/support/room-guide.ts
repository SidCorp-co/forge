// `guide`: the room agent's guide, the detail behind each line of its brief (ISS-1251, owner
// 2026-11-16: teaching changes without a code deploy). A project's own knowledge entry
// `room-agent-guide` comes first, then its organization's, read through the one door a project's
// knowledge is read by (`knowledge/service.ts:readKnowledgeEntry`); where neither keeps one, the guide
// Forge ships (`guides/room-agent-guide.ts`). Read on the agent's call; nothing is posted.

import { getGuide } from '../guides/index.js';
import { readKnowledgeEntry } from '../knowledge/index.js';
import type { Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

/** The knowledge slug a project or its organization keeps its own room agent guide under. */
export const ROOM_GUIDE_SLUG = 'room-agent-guide';
/** The guide Forge ships, read where no knowledge entry stands in for it. */
export const SHIPPED_ROOM_GUIDE = 'room-agent';

export interface RoomGuide {
  /** Where the text came from: the project's knowledge, its organization's, or Forge's own guide. */
  from: 'project' | 'org' | 'forge';
  slug: string;
  body: string;
}

export async function roomGuideOf(room: Pick<RoomRow, 'projectId'>): Promise<Outcome<RoomGuide>> {
  const kept = await readKnowledgeEntry(room.projectId, ROOM_GUIDE_SLUG);
  if (kept && !kept.archivedAt) {
    return { ok: true, value: { from: kept.origin, slug: ROOM_GUIDE_SLUG, body: kept.body } };
  }
  const shipped = getGuide(SHIPPED_ROOM_GUIDE);
  if (!shipped)
    throw new Error(`support: the shipped guide ${SHIPPED_ROOM_GUIDE} is not registered`);
  return { ok: true, value: { from: 'forge', slug: SHIPPED_ROOM_GUIDE, body: shipped.body } };
}
