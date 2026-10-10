import { Banner, Property, PropertyList, Section } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { EpodsystemReadConfig } from "./config";

// Scopes a website build needs to publish themes + toggle commerce/cache.
const REQUIRED_SCOPES = ["products:write", "webstore:write", "settings:write"];

/** The store, its themes and the key's scopes as the last Test read them. */
export function ThemeSettings({ config }: { config: EpodsystemReadConfig }) {
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
    <Section title={t("integrations.epod.storeThemes")}>
      <PropertyList>
        <Property label={t("integrations.epod.store")}>
          {config.storeName ?? config.storeSlug ?? t("integrations.autoflow.runTest")}
          {config.storeId && (
            <span className="text-subtle"> · #{config.storeId}</span>
          )}
          {config.orgId && (
            <span className="text-subtle"> · {t("integrations.epod.org", { id: config.orgId })}</span>
          )}
        </Property>
        <Property label={t("integrations.epod.domain")}>{config.domain ?? "—"}</Property>
        <Property label={t("integrations.epod.themeMain")}>
          {config.themeId ?? "—"}
          {config.themeName && (
            <span className="text-subtle"> · {config.themeName}</span>
          )}
        </Property>
        <Property label={t("integrations.epod.themeDraft")}>{config.draftThemeId ?? t("integrations.epod.draftLater")}</Property>
        <Property label={t("integrations.epod.commerce")}>
          {config.commerceEnabled == null
            ? "—"
            : config.commerceEnabled
              ? t("integrations.epod.commerceOn")
              : t("integrations.epod.commerceOff")}
        </Property>
        <Property label={t("integrations.epod.scopes")}>
          {scopes ? (hasWildcard ? t("integrations.epod.scopesFull") : scopes.join(", ")) : "—"}
        </Property>
      </PropertyList>
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
    </Section>
  );
}
