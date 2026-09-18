/**
 * The one check a comment meets on its way into a room, which is db-free on
 * purpose: it runs for a PERSON's comment as well as an agent's, and the write
 * door's own screen binds agents only.
 */

import type { MessageRefusal, MessageVerdict } from '../../messaging/contract.js';
import { NO_FACTS } from '../../messaging/facts.js';
import { NO_ROOM_BROADCAST_CARRIED } from '../../messaging/text-rules.js';

/**
 * A comment being carried into a room, screened for the one thing carrying it
 * can do that writing it could not.
 */
// cm:guard a comment is CARRIED text and not generated text, so the claim rules the write door applies do not apply again here — what does apply is the broadcast: `@all` in a comment nobody paged is harmless on an issue page and pages the whole room the moment this mirror posts it (ISS-981).
// cm:guard this stays even though `comment-write` now screens the same rule, because that door screens AGENT authors only: a person writing `@all` on an issue page is not the audience of any of those rules, and this is the only thing standing between that comment and the room.
// cm:guard this file IS a screen, which is why it may mint an `ok` verdict: it reads the body against a
// real rule and refuses on what it finds. The cast below is that mint, and `verdict-mint.test.ts` holds
// the list of files allowed to make one — a reply path that wants to declare its own text passed has to
// become a screen here rather than write `{ ok: true }` at its call site (ISS-978 F5).
export function screenCarriedComment(body: string): MessageVerdict {
  const refusals: MessageRefusal[] = [];
  if (!body.trim()) {
    refusals.push({
      rule: 'carried-comment-has-text',
      why: 'a comment with no text carries nothing to say',
      quote: null,
      shape: 'a comment carried into a room has a body',
      example: 'Deployed to beta and the health check is green.',
    });
  }
  for (const b of NO_ROOM_BROADCAST_CARRIED.check(body, NO_FACTS)) {
    refusals.push({
      rule: NO_ROOM_BROADCAST_CARRIED.id,
      why: b.why,
      quote: b.quote,
      shape: NO_ROOM_BROADCAST_CARRIED.shape,
      example: NO_ROOM_BROADCAST_CARRIED.example,
    });
  }
  return refusals.length === 0 ? ({ ok: true } as MessageVerdict) : { ok: false, refusals };
}
