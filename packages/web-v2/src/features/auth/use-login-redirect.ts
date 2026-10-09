"use client";

import { useEffect, useState } from "react";
import { clearBounce, leaveForLogin } from "./login-bounce";

/**
 * Sends a page that has no session to /login, once per navigation (login-bounce.ts). `stopped` is
 * true when the previous navigation already bounced: the caller renders SignInStopped.
 * `signedOut` is true only after the session was asked for and is absent.
 */
export function useLoginRedirect(signedOut: boolean, signedIn: boolean): { stopped: boolean } {
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (signedIn) {
      clearBounce();
      setStopped(false);
    } else if (signedOut) {
      setStopped(leaveForLogin() === "stopped");
    }
  }, [signedOut, signedIn]);
  return { stopped };
}
