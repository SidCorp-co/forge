"use client";

import type { ConnectionSection } from "../registry";
import { text } from "../config-read";
import { PageSectionTitle } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

/** Read-only: a successful Test fills the store identity out of the key. */
export const EpodsystemConnectionConfig: ConnectionSection = ({ connection }) => {
  const config = connection.config ?? {};
  const slug = text(config, "storeSlug");
  const name = text(config, "storeName");
  const t = useCopy();

  return (
    <section className="flex flex-col gap-2">
      <PageSectionTitle>{t("integrations.epod.store")}</PageSectionTitle>
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        {slug || name
          ? `${name ?? slug}${slug ? ` (${slug})` : ""}`
          : t("integrations.epod.identityAfterTest")}
      </p>
    </section>
  );
};
