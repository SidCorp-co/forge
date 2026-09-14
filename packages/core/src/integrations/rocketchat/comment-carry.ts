/**
 * The one check a comment meets on its way into a room, which is db-free on
 * purpose: it runs for a PERSON's comment as well as an agent's, and the write
 * door's own screen binds agents only.
 */

import { NO_FACTS } from '../../messaging/facts.js';
import { NO_ROOM_BROADCAST_CARRIED } from '../../messaging/text-rules.js';

/**
 * A comment being carried into a room, screened for the one thing carrying it
 * can do that writing it could not.
 */
// cm:guard a comment is CARRIED text and not generated text, so the claim rules the write door applies do not apply again here — what does apply is the broadcast: `@all` in a comment nobody paged is harmless on an issue page and pages the whole room the moment this mirror posts it (ISS-981).
// cm:guard this stays even though `comment-write` now screens the same rule, because that door screens AGENT authors only: a person writing `@all` on an issue page is not the audience of any of those rules, and this is the only thing standing between that comment and the room.
export function screenCarriedComment(body: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!body.trim()) problems.push('a comment with no text carries nothing to say');
  for (const b of NO_ROOM_BROADCAST_CARRIED.check(body, NO_FACTS)) problems.push(b.why);
  return { ok: problems.length === 0, problems };
}
