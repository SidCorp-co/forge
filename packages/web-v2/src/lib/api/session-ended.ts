/**
 * Core's answer that the browser's session cookie no longer opens a session (SESSION_EXPIRED, 401).
 * It is the person's cue to sign in again, never an error to show: core has already cleared the
 * cookies, and the app treats the answer as being signed out.
 */
export const SESSION_ENDED_CODE = 'SESSION_EXPIRED';

export const SESSION_ENDED_LINE = 'Your session ended. Please sign in again.';

export function isSessionEndedAnswer(status: number, code: string | undefined): boolean {
  return status === 401 && code === SESSION_ENDED_CODE;
}

type Listener = () => void;

const listeners = new Set<Listener>();

/** Called on every session-ended answer, from whichever request met it. Returns the unsubscribe. */
export function onSessionEnded(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceSessionEnded(): void {
  for (const listener of listeners) listener();
}
