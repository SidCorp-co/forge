import type { MessageRefusal, MessageVerdict } from '../../messaging/contract.js';
import { NO_FACTS } from '../../messaging/facts.js';
import { admitted } from '../../messaging/screen.js';
import { NO_ROOM_BROADCAST_CARRIED } from '../../messaging/text-rules.js';

/**
 * A comment being carried into a room, screened for the one thing carrying it
 * can do that writing it could not.
 */
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
  return refusals.length === 0 ? admitted([body]) : { ok: false, refusals };
}
