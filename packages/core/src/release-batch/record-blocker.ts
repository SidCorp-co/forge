import { releaseNotesSections } from '@forge/contracts/release-notes';
import type { releaseRecordGaps } from '../issues/index.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';

/**
 * The one blocker a roster's notes owe: the issues with no note, and the issues whose stored note
 * holds a section the cut cannot place, named with the issue, the section it holds and the accepted
 * ones, never read as no note (ISS-835). Null where every note stands.
 */
export async function releaseRecordBlocker(
  gaps: Awaited<ReturnType<typeof releaseRecordGaps>>,
  namedAs: (ids: string[]) => Promise<string[]>,
): Promise<ReleaseBlocker | null> {
  const ids = [...gaps.missing, ...gaps.unplaceable.map((u) => u.id)];
  if (ids.length === 0) return null;
  const displayIds = await namedAs(ids);
  const shown = (id: string) => displayIds[ids.indexOf(id)] ?? id;
  const unreadable = gaps.unplaceable.map((u) => ({
    issueId: u.id,
    displayId: shown(u.id),
    section: u.section,
  }));
  return blocker('RELEASE_RECORD_MISSING', {
    issueIds: ids,
    displayIds,
    ...(unreadable.length > 0 ? { unreadable, accepted: [...releaseNotesSections] } : {}),
  });
}
