
import { useEffect, useSyncExternalStore } from "react";
import { bounceOutcome, clearBounce, leaveForLogin, subscribeBounce } from "./login-bounce";

/**
 * Sends a page that has no session to /login, once per navigation (login-bounce.ts). `stopped` is
 * true when the previous navigation already bounced: the caller renders SignInStopped.
 * `signedOut` is true only after the session was asked for and is absent.
 */
export function useLoginRedirect(signedOut: boolean, signedIn: boolean): { stopped: boolean } {
  const outcome = useSyncExternalStore(subscribeBounce, bounceOutcome, () => null);
  useEffect(() => {
    if (signedIn) clearBounce();
    else if (signedOut) leaveForLogin();
  }, [signedOut, signedIn]);
  return { stopped: !signedIn && outcome === "stopped" };
}
