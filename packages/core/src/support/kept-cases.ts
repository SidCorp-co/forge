// What the room agent kept is handed back to it by relevance (ISS-1485, REQ-107 BC-5), as a note in
// the turn like the dated reads (`dated-reads.ts`), never in the always-on brief, whose size is held.
// The summaries are the project's knowledge entries a room agent wrote with support.keep (slug
// `case-<topic>`); the find door ranks them against what the turn's messages say, and the few that
// rank are handed in, cut to a stated size. Core only hands them over: the agent reads them against
// the person's words and answers or asks, and nothing here answers for it, blocks a reply or writes.

import {
  SUPPORT_KEPT_NOTE_MAX_CHARS,
  SUPPORT_KEPT_NOTE_MAX_ENTRIES,
  SUPPORT_KEPT_PREFIX,
} from '@forge/contracts/support-keep';
import { scrubLogText } from '@forge/observability';
import { findRecords } from '../knowledge/index.js';
import { logger } from '../lib/logger.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import type { RoomRow } from './store.js';

/** How far into a turn's messages the relevance read goes, and how many records it ranks. */
const QUERY_CHARS = 1000;
const RANKED = 16;
/** One summary's share of the note, so a long one never crowds out the next. */
const ENTRY_CHARS = 600;

type Finder = typeof findRecords;

const LEAD =
  'What you kept from earlier cases of this project that may bear on this turn (support.keep; each is your own earlier fact with its scope, never the owner’s decision). Answer from one that covers this case under its scope, and say so only in your own words; where a case lies outside its scope or the world changed, read again or ask, then keep the corrected summary under the same topic. A precedent the owner agreed is read from the rule entries `precedent-*`, not from here.';

/** The note for a turn whose messages say `text`, or null where nothing kept bears on it. */
export async function keptCasesNote(
  room: Pick<RoomRow, 'projectId' | 'principalUserId'>,
  text: string,
  find: Finder = findRecords,
): Promise<string | null> {
  const query = text.trim().slice(0, QUERY_CHARS);
  if (!query) return null;
  let records: Awaited<ReturnType<Finder>>;
  try {
    records = await find({
      projectId: room.projectId,
      reader: { userId: room.principalUserId, fence: [room.projectId] },
      query,
      types: ['knowledge'],
      limit: RANKED,
      askedBy: 'agent',
    });
  } catch (err) {
    // the turn goes on without the note: a read that failed hands nothing, and is logged, never silent
    logger.warn({ err, projectId: room.projectId }, 'support: the kept-case read failed');
    return null;
  }
  const kept = records
    .filter((r) => r.key?.startsWith(SUPPORT_KEPT_PREFIX))
    .slice(0, SUPPORT_KEPT_NOTE_MAX_ENTRIES);
  if (kept.length === 0) return null;
  const lines: string[] = [];
  let size = LEAD.length;
  for (const r of kept) {
    const line = `- ${r.title} (${r.key}): ${markUntrusted(scrubLogText(r.text, []).slice(0, ENTRY_CHARS), { source: 'kept case summary' })}`;
    if (size + line.length > SUPPORT_KEPT_NOTE_MAX_CHARS) break;
    lines.push(line);
    size += line.length;
  }
  return lines.length > 0 ? `${LEAD}\n${lines.join('\n')}` : null;
}
