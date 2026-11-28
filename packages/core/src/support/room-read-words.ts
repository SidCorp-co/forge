// Words a room's tracker read hands the agent about an issue's work (ISS-1483). The agent repeats what it
// is handed, so a park's free text and the records agents wrote about the work never reach it as a
// sentence to say: a wait is worded from its KIND, and a record is marked internal and stripped of the
// handles a person cannot follow.

import { releaseNoteReferences } from '@forge/contracts/content-language';
import { NEUTRAL_PARK } from './room-voice.js';

/** The mark every internal record of the work carries in a room read, and the card line teaches the same. */
export const INTERNAL_RECORD =
  'internal record: say what happened in your own words; never name who did it, and never quote a key, sha or code';

/** The waits whose ask is a person's own: the question prompt is addressed to them and stays. */
const PERSON_KINDS: ReadonlySet<string> = new Set(['you', 'person', 'admins', 'writers', 'answer']);

/**
 * What a parked issue waits on, as a room hears it: the question where a person is asked, the other
 * issue by its title where it waits behind one, else one fixed sentence. A park's own text, written by
 * an agent, is never handed on.
 */
export function parkReasonOf(
  kind: string,
  threadPrompt: string | null,
  behind: { key: string; title: string | null } | null,
): string {
  if (PERSON_KINDS.has(kind)) return threadPrompt ?? NEUTRAL_PARK;
  if (kind === 'issue' && behind) {
    return behind.title
      ? `it is waiting for "${behind.title}" (${behind.key}) to move on`
      : `it is waiting for ${behind.key} to move on`;
  }
  return NEUTRAL_PARK;
}

/**
 * `text` without the handles of an engineer's record: issue keys, commit shas, rule and error codes,
 * criterion codes and paths, each read by the release note's own recogniser.
 */
export function withoutReferences(text: string): string {
  let out = text;
  for (const ref of releaseNoteReferences(text)) {
    const at = ref.lastIndexOf(' ');
    const handle = at < 0 || ref.startsWith('label ') ? '' : ref.slice(at + 1);
    if (handle) out = out.split(handle).join('[reference]');
  }
  return out;
}
