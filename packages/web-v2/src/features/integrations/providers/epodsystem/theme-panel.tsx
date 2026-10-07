import { Banner } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { EpodsystemReadConfig } from "./config";

// Scopes a website build needs to publish themes + toggle commerce/cache.
const REQUIRED_SCOPES = ["products:write", "webstore:write", "settings:write"];

/** The store, its themes and the key's scopes as the last Test read them. */
export function ThemePanel({ config }: { config: EpodsystemReadConfig }) {
  const storefrontUrl = config.domain
    ? `https://${config.domain}`
    : config.storeSlug
      ? `https://${config.storeSlug}.epodsystem.com`
      : null;
  const scopes = config.scopes ?? null;
  const hasWildcard = scopes?.includes("*") ?? false;
  const missingScopes =
    scopes && !hasWildcard
      ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
      : [];
  const t = useCopy();

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">{t("integrations.epod.storeThemes")}</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-12">
        <dt className="text-subtle">{t("integrations.epod.store")}</dt>
        <dd>
          {config.storeName ?? config.storeSlug ?? t("integrations.autoflow.runTest")}
          {config.storeId && (
            <span className="text-subtle"> · #{config.storeId}</span>
          )}
          {config.orgId && (
            <span className="text-subtle"> · {t("integrations.epod.org", { id: config.orgId })}</span>
          )}
        </dd>
        <dt className="text-subtle">{t("integrations.epod.domain")}</dt>
        <dd>{config.domain ?? "—"}</dd>
        <dt className="text-subtle">{t("integrations.epod.themeMain")}</dt>
        <dd>
          {config.themeId ?? "—"}
          {config.themeName && (
            <span className="text-subtle"> · {config.themeName}</span>
          )}
        </dd>
        <dt className="text-subtle">{t("integrations.epod.themeDraft")}</dt>
        <dd>{config.draftThemeId ?? t("integrations.epod.draftLater")}</dd>
        <dt className="text-subtle">{t("integrations.epod.commerce")}</dt>
        <dd>
          {config.commerceEnabled == null
            ? "—"
            : config.commerceEnabled
              ? t("integrations.epod.commerceOn")
              : t("integrations.epod.commerceOff")}
        </dd>
        <dt className="text-subtle">{t("integrations.epod.scopes")}</dt>
        <dd translate={scopes && !hasWildcard ? "no" : undefined}>
          {scopes ? (hasWildcard ? t("integrations.epod.scopesFull") : scopes.join(", ")) : "—"}
        </dd>
      </dl>
      {missingScopes.length > 0 && (
        <Banner tone="attention">
          {t("integrations.epod.missingScopes.lead")} <b translate="no">{missingScopes.join(", ")}</b> —{" "}
          {t("integrations.epod.missingScopes.tail")}
        </Banner>
      )}
      {storefrontUrl && (
        <a
          href={storefrontUrl}
          target="_blank"
          rel="noreferrer"
          className="text-13 font-semibold text-accent hover:underline"
        >
          {t("integrations.epod.openStorefront")}
        </a>
      )}
      <p className="fg-body-sm text-subtle">
        {t("integrations.epod.buildsNote")}
      </p>
    </div>
  );
}
