// Words a room's tracker read hands the agent about an issue's work (ISS-1483). The agent repeats what it
// is handed, so a park's free text and the records agents wrote about the work never reach it as a
// sentence to say: a wait is worded from its KIND, and a record is marked internal and stripped of the
// handles a person cannot follow.

import { releaseNoteReferences } from '@forge/contracts/content-language';
import { INTERNAL_WORDS, NAMES_THE_HAND, NEUTRAL_PARK } from './room-voice.js';

/** The mark every internal record of the work carries in a room read, and the card line teaches the same. */
export const INTERNAL_RECORD =
  'internal record: say what happened in your own words; never name who did it, and never quote a key, sha or code';

/** What a person's wait reads as: the ask is theirs, but its words were written by an agent, so only the fact of it is said. */
export const NEUTRAL_ASK = 'it is waiting on an answer';

/** What an open question's words read as in a room: none are handed on, and the person reads them in Forge. */
export const QUESTION_WORDS_WITHHELD =
  'its words are not sent here: say it is waiting on an answer, which the person reads on its page';

/** The waits a person owes: what they owe is said, never the words an agent wrote asking it. */
const PERSON_KINDS: ReadonlySet<string> = new Set(['you', 'person', 'admins', 'writers', 'answer']);

/**
 * What a parked issue waits on, as a room hears it, from its KIND alone: that an answer is owed, the
 * other issue by its title where it waits behind one, else one fixed sentence. Neither the park's own
 * text nor the question minted from it is handed on, since an agent wrote both (a question's rows
 * record no asker's agency, so no prompt can be told a person's own).
 */
export function parkReasonOf(kind: string, behind: { title: string | null } | null): string {
  if (PERSON_KINDS.has(kind)) return NEUTRAL_ASK;
  if (kind === 'issue') {
    const title = behind?.title ? plainWords(behind.title, '') : '';
    return title
      ? `it is waiting for "${title}" to move on`
      : 'it is waiting behind another issue to move on';
  }
  return NEUTRAL_PARK;
}

/**
 * Words a person or an agent wrote, as a room hears them: stripped of handles, and replaced by
 * `fallback` where they name an internal hand, so a label or a title cannot carry the master to a person.
 */
export function plainWords(text: string, fallback: string): string {
  const clean = withoutReferences(text);
  return NAMES_THE_HAND.test(clean) || INTERNAL_WORDS.test(clean) ? fallback : clean;
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
