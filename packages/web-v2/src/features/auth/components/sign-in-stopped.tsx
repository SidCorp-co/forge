"use client";

import { Button } from "@/design";
import { bounceCause, clearBounce } from "../login-bounce";
import { AuthShell } from "./auth-shell";

/**
 * What a page shows instead of a second redirect to /login (login-bounce.ts): the cause, and one
 * way out that is the person's own act. It never navigates by itself.
 */
export function SignInStopped() {
  const framed = bounceCause() === "frame-cookies";
  const again = () => {
    clearBounce();
    window.location.assign("/login");
  };
  return (
    <AuthShell
      title={framed ? "This frame cannot keep you signed in" : "You are not signed in"}
      subtitle={
        framed
          ? "The browser blocks cookies in a frame on another site, so the session was dropped as soon as it was made. Forge stopped here instead of asking again."
          : "Forge sent you to sign in a moment ago and you came back without a session, so it stopped here instead of sending you again."
      }
    >
      <p className="fg-body-sm mb-4">
        {framed
          ? "Open the page in its own tab, or allow cookies for this site and try again."
          : "Sign in again from the sign-in page. If it brings you back here, the cause is on the server: tell whoever runs this Forge."}
      </p>
      <Button onClick={again}>Go to sign in</Button>
    </AuthShell>
  );
}
