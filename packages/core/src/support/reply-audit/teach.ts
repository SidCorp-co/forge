// How a room agent is taught to audit its own reply (ISS-1250; owner 2026-11-16): the tool's line,
// read off the one rubric so it keeps no copy of it. The brief's line is support.audit's card
// (`room-cards.ts`), rendered into the map (ISS-1251).

import { REPLY_RUBRIC, REPLY_RUBRIC_LINES } from '@forge/contracts/support-reply-audit';

/** The rubric as the agent reads it: each line's key and what it asks. */
const RUBRIC = REPLY_RUBRIC_LINES.map((k) => `${k} (${REPLY_RUBRIC[k]})`).join('; ');

/**
 * The rubric support.audit's entry in the room tool's description carries beside its card's purpose
 * (`support/tool-description.ts`): the lines an agent scores its reply against.
 */
export const AUDIT_RUBRIC_TEXT = `Rubric: ${RUBRIC}; failed names each line the reply fails with why ([] where none).`;
