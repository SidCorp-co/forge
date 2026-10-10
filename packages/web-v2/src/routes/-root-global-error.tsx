import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageTitle } from "@/design";
import { reportFailure } from "@/lib/error-tracking";
import { productCopy } from "@/lib/i18n/product-copy";

// the app failed above every screen, so no interface language is known here: English
const t = productCopy();

/** What a throw no screen caught renders: the crash line and a reload, reported once. */
export function RootError({ error }: ErrorComponentProps) {
  useEffect(() => {
    reportFailure(error, { tags: { area: "root-layout" } });
  }, [error]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "3rem", lineHeight: 1.6 }}>
      <PageTitle style={{ fontSize: "1.25rem", margin: 0 }}>{t("common.crash.title")}</PageTitle>
      <p style={{ color: "#6b7280" }}>{t("common.crash.reported")}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {t("common.crash.reload")}
      </button>
    </main>
  );
}
