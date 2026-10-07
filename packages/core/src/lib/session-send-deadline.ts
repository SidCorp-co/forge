/**
 * How long a message may sit `unknown` (the runner said nothing, the session is alive) before
 * silence stops being waited on: a declared deadline, past which `resolveSessionSend` answers
 * `undelivered`. Long enough for a master mid-turn for twenty minutes, short enough that an
 * answer someone typed does not wait for ever.
 */
export const SEND_UNDELIVERED_DEADLINE_MS = 30 * 60_000;
