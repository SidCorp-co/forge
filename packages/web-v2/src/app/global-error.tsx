"use client";

import { useEffect } from "react";
import { PageTitle } from "@/design";
import { reportFailure } from "@/lib/error-tracking";
import { productCopy } from "@/lib/i18n/product-copy";

// the root layout failed, so no interface language is known here: English
const t = productCopy();

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    reportFailure(error, {
      tags: { area: "root-layout" },
      contexts: error.digest ? { forge_next: { digest: error.digest } } : undefined,
    });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", lineHeight: 1.6 }}>
          <PageTitle style={{ fontSize: "1.25rem", margin: 0 }}>{t("common.crash.title")}</PageTitle>
          <p style={{ color: "#6b7280" }}>{t("common.crash.reported")}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {t("common.crash.reload")}
          </button>
        </main>
      </body>
    </html>
  );
}
