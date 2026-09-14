/**
 * The Rocket.Chat side of the message contract: a reply headed for a room is a
 * report read by somebody holding no role on the project, and that is the pair
 * it is screened under.
 *
 * ISS-672/675 extracted this from `connection-manager.ts` so the async bridges
 * could not bypass the guards the synchronous path had. ISS-997 moved the rules
 * themselves out of this tree entirely, leaving this file as what it always
 * was — the place the transport names its audience and its intent.
 */

import { NO_ROLE } from '../../messaging/audiences.js';
import type { Intent, MessageVerdict } from '../../messaging/contract.js';
import type { ProgressFacts } from '../../messaging/facts.js';
import { gatherFacts } from '../../messaging/gather.js';
import { screenMessage } from '../../messaging/screen.js';

/**
 * Screen a reply to somebody with no role on the project.
 */
// cm:guard `progress` is required on purpose (ISS-818) — never widen it back to optional; a caller that omits it must fail to compile rather than silently screen against a snapshot the model never saw. Pass the SAME snapshot the reply's turn was shown: screening against a fresh re-query bounces a reply that was accurate for what the model actually saw. `'legacy-session'` is the one case that self-computes, for a session created before the snapshot was stored.
// cm:guard `intent` defaults to `report` and every caller today takes the default, because nothing in this transport lets an agent say it is ASKING the reader for something. That is the `public:ask` cell ISS-997 ships reserved, and the day a caller can declare one this is where it says so — not a place to infer it from the text.
export async function screenRoomReply(
  projectId: string,
  reply: string,
  toolCalls: Array<{ name: string; arguments: string }>,
  progress: ProgressFacts | null | 'legacy-session',
  intent: Intent = 'report',
): Promise<MessageVerdict> {
  const segments = [reply];
  const facts = await gatherFacts({
    projectId,
    audience: NO_ROLE,
    intent,
    segments,
    toolCalls,
    progress: progress === 'legacy-session' ? 'compute' : progress,
  });
  return screenMessage({ audience: NO_ROLE, intent, segments, facts });
}
