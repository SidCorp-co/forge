"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/react";

/**
 * The last boundary. `error.tsx` files cover the segments below them; a throw
 * in the ROOT layout escapes all of them and reaches only this one, which
 * replaces the document — so it renders its own `<html>` and `<body>`.
 *
 * It exists to report, not to decorate: before it, a root-layout failure showed
 * the user a blank page and left nothing behind anywhere.
 */
// cm:guard `captureException` belongs in an effect, never in the render body — a render can run more than once for one error, and a capture in the body sends one event per render rather than one per failure.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { area: "root-layout" },
      contexts: error.digest ? { forge_next: { digest: error.digest } } : undefined,
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", lineHeight: 1.6 }}>
          <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Something broke while loading Forge.</h1>
          <p style={{ color: "#6b7280" }}>
            The error was reported. Reloading is usually enough; if it keeps happening, the report
            carries what we need.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
