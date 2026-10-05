import { Banner } from "@/design";
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Store &amp; themes</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-12">
        <dt className="text-subtle">Store</dt>
        <dd>
          {config.storeName ?? config.storeSlug ?? "— (run Test)"}
          {config.storeId && (
            <span className="text-subtle"> · #{config.storeId}</span>
          )}
          {config.orgId && (
            <span className="text-subtle"> · org {config.orgId}</span>
          )}
        </dd>
        <dt className="text-subtle">Domain</dt>
        <dd>{config.domain ?? "—"}</dd>
        <dt className="text-subtle">Theme (main / prod)</dt>
        <dd>
          {config.themeId ?? "—"}
          {config.themeName && (
            <span className="text-subtle"> · {config.themeName}</span>
          )}
        </dd>
        <dt className="text-subtle">Theme (draft / staging)</dt>
        <dd>{config.draftThemeId ?? "— (created at build time)"}</dd>
        <dt className="text-subtle">Commerce</dt>
        <dd>
          {config.commerceEnabled == null
            ? "—"
            : config.commerceEnabled
              ? "enabled"
              : "disabled"}
        </dd>
        <dt className="text-subtle">Scopes</dt>
        <dd>{scopes ? (hasWildcard ? "full (*)" : scopes.join(", ")) : "—"}</dd>
      </dl>
      {missingScopes.length > 0 && (
        <Banner tone="attention">
          Key is missing scope(s): <b>{missingScopes.join(", ")}</b> —
          builds/publish may fail.
        </Banner>
      )}
      {storefrontUrl && (
        <a
          href={storefrontUrl}
          target="_blank"
          rel="noreferrer"
          className="text-13 font-semibold text-accent hover:underline"
        >
          Open storefront ↗
        </a>
      )}
      <p className="fg-body-sm text-subtle">
        Builds run on a draft theme (previewed via a token on this domain);
        publish (draft → live) and rollback run through the website
        pipeline&apos;s release stage.
      </p>
    </div>
  );
}
