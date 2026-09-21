"use client";

import type { ConnectionSection } from "../registry";
import { text } from "../config-read";
import { CardTitle } from "@/design";

/** Read-only: a successful Test fills the store identity out of the key. */
export const EpodsystemConnectionConfig: ConnectionSection = ({ connection }) => {
  const config = connection.config ?? {};
  const slug = text(config, "storeSlug");
  const name = text(config, "storeName");

  return (
    <section className="flex flex-col gap-2">
      <CardTitle>Store</CardTitle>
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        {slug || name
          ? `${name ?? slug}${slug ? ` (${slug})` : ""}`
          : "Store identity is filled in automatically by a successful Test."}
      </p>
    </section>
  );
};
