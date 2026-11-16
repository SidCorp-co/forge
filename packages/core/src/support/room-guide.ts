// `guide`: the room agent's guide, the detail behind each line of its brief (ISS-1251, owner
// 2026-11-16: teaching changes without a code deploy). A project's own knowledge entry
// `room-agent-guide` comes first, then its organization's, read through the one door a project's
// knowledge is read by (`knowledge/service.ts:readKnowledgeEntry`); where neither keeps one, the guide
// Forge ships (`guides/room-agent-guide.ts`). Either body is served with the cards of the acts the
// shipped guide works through beneath it (`guides/served.ts`): a kept body changes the method, never
// an act's card, which is the one text teaching that act. Read on the agent's call; nothing is posted.

import { getGuide, servedGuideBody } from '../guides/index.js';
import { readKnowledgeEntry } from '../knowledge/index.js';
import type { Outcome } from './outcome.js';
import { noteRoomReached } from './room-reaches.js';
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

export async function roomGuideOf(
  room: Pick<RoomRow, 'projectId' | 'sessionId'>,
): Promise<Outcome<RoomGuide>> {
  const guide = await guideOf(room);
  // the guide the room's agent read, kept as an opened knowledge entry is (ISS-1251): the project's or
  // its organization's entry by its slug, Forge's own by the guide's name
  noteRoomReached(room, room.projectId, 'get', {
    knowledge: [{ slug: guide.value.slug, body: guide.value.body }],
  });
  return guide;
}

async function guideOf(room: Pick<RoomRow, 'projectId'>): Promise<{ ok: true; value: RoomGuide }> {
  const shipped = getGuide(SHIPPED_ROOM_GUIDE);
  if (!shipped)
    throw new Error(`support: the shipped guide ${SHIPPED_ROOM_GUIDE} is not registered`);
  const kept = await readKnowledgeEntry(room.projectId, ROOM_GUIDE_SLUG);
  if (kept && !kept.archivedAt) {
    const body = servedGuideBody({ ...shipped, body: kept.body });
    return { ok: true, value: { from: kept.origin, slug: ROOM_GUIDE_SLUG, body } };
  }
  return {
    ok: true,
    value: { from: 'forge', slug: SHIPPED_ROOM_GUIDE, body: servedGuideBody(shipped) },
  };
}
