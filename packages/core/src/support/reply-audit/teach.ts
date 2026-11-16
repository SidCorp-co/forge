// How a room agent is taught to audit its own reply (ISS-1250; owner 2026-11-16): the tool's line and
// the brief's line, both read off the one rubric, so neither keeps a copy of it.

import { REPLY_RUBRIC, REPLY_RUBRIC_LINES } from '@forge/contracts/support-reply-audit';

/** The rubric as the agent reads it: each line's key and what it asks. */
const RUBRIC = REPLY_RUBRIC_LINES.map((k) => `${k} (${REPLY_RUBRIC[k]})`).join('; ');

/** support.audit's entry in the room tool's description (`tool.ts`). */
export const AUDIT_TOOL_TEXT = `audit {thread, message, failed}: right after each reply you post, score it against the rubric and keep the verdict; message is the messageId reply answered you, failed each line it fails with why ([] where none). Rubric: ${RUBRIC}. Forge checks the lines code can tell beside your reading and answers the verdict; a failed line becomes a correction your lessons draw from. Nothing is posted or changed in the thread: do better on the next reply.`;

/** The brief's one line teaching the step (`prompt.ts`). */
export const AUDIT_BRIEF_LINE =
  'After each reply you post, audit it with support.audit against the rubric, honestly, and let what fails shape your next reply.';
