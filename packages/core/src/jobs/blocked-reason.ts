/** The runner's `job_exit.rs` `BLOCKED_PHRASE`, held to one value by `blocked-reason.test.ts`. */
export const BLOCKED_PHRASE = 'stopped on a question only a human can answer';

export function isBlockedReason(error: string): boolean {
  return error.includes(BLOCKED_PHRASE);
}
