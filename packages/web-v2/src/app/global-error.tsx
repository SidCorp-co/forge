"use client";

import { useEffect } from "react";
import { PageTitle } from "@/design";
import * as Sentry from "@sentry/react";

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
          <PageTitle style={{ fontSize: "1.25rem", margin: 0 }}>Something broke while loading Forge.</PageTitle>
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
