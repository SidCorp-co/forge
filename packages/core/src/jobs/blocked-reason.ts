export const BLOCKED_PHRASE = 'stopped on a question only a human can answer';

export function isBlockedReason(error: string): boolean {
  return error.includes(BLOCKED_PHRASE);
}
