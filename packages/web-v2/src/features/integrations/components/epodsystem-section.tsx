"use client";

import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  type BadgeProps,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../hooks";
import type { IntegrationSummary, IntegrationTestResult, ProviderConfig } from "../types";

// Scopes a website build needs to publish themes + toggle commerce/cache.
const REQUIRED_SCOPES = ["products:write", "webstore:write", "settings:write"];

interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

function badgeFor(existing: IntegrationSummary | undefined): BadgeView {
  if (!existing) return { label: "Not configured", tone: "amber" };
  if (existing.lastHealthStatus === "ok") {
    const name = (existing.config as ProviderConfig).storeName;
    return { label: name ? `Connected to ${name}` : "Connected", tone: "green" };
  }
  if (existing.lastHealthStatus === "error") return { label: "Invalid key", tone: "red" };
  return { label: "Untested", tone: "neutral" };
}

/**
 * ISS-395 / ISS-387 — Epodsystem storefront integration config (ported from the
 * v1 `epodsystem-section.tsx`). One store per project; the operator pastes ONLY
 * the `crmk_` API key — the endpoint is fixed platform config
 * (EPODSYSTEM_ENDPOINT env), never user input. Test connection runs the
 * healthcheck which fills the store identity surfaced in the read-only theme
 * panel. Publish / rollback run through the website pipeline's release stage.
 */
export function EpodsystemSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === "epodsystem"),
    [list.data],
  );

  const create = useCreateProviderIntegration(projectId);
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);

  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keyRequired = !existing;
  const saving = create.isPending || update.isPending;
  const canSave = (!keyRequired || apiKey.trim().length >= 8) && !saving;
  const badge = badgeFor(existing);

  async function handleSave() {
    setError(null);
    setTestResult(null);
    try {
      if (existing) {
        // Endpoint is fixed platform config — the only thing to update is the key.
        await update.mutateAsync({
          id: existing.id,
          body: apiKey.trim() ? { secrets: { apiKey: apiKey.trim() } } : {},
        });
      } else {
        await create.mutateAsync({
          provider: "epodsystem",
          config: {},
          secrets: { apiKey: apiKey.trim() },
        });
      }
      setApiKey("");
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function handleTest() {
    if (!existing) return;
    setTestResult(null);
    setError(null);
    try {
      // The healthcheck refreshes store identity diagnostics; the list query is
      // invalidated by the mutation chain, so the theme panel updates on success.
      const res = await test.mutateAsync(existing.id);
      setTestResult(res);
      list.refetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  function handleDelete() {
    if (!existing) return;
    if (!window.confirm("Delete the Epodsystem integration for this project?")) return;
    remove.mutate(existing.id);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Epodsystem storefront</CardTitle>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="fg-body-sm text-muted">
            One Epodsystem store per project. Paste the <span className="font-mono">crmk_</span> API
            key — the endpoint is fixed platform config, not entered here. Builds run on the draft
            theme (staging); release promotes draft → main (production).
          </p>

          <Field
            label={existing ? "API key" : "API key"}
            hint={
              existing
                ? "A key is stored. Leave blank to keep it; enter a new one to rotate."
                : "Epodsystem API key (crmk_…). Stored encrypted; never shown again."
            }
            required={keyRequired}
          >
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={existing ? "•••••••• (unchanged)" : "crmk_…"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>

          {error && <Banner tone="danger">{error}</Banner>}
          {testResult &&
            (testResult.status === "ok" ? (
              <Banner tone="success">{testResult.message ?? "Connection OK"}</Banner>
            ) : (
              <Banner tone="danger">{testResult.message ?? "Connection failed"}</Banner>
            ))}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button variant="primary" onClick={handleSave} loading={saving} disabled={!canSave}>
              {existing ? "Save" : "Create integration"}
            </Button>
            {existing && (
              <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
                Test connection
              </Button>
            )}
            {existing && (
              <Button variant="danger" icon="trash" loading={remove.isPending} onClick={handleDelete}>
                Delete
              </Button>
            )}
          </div>

          {existing && <ThemePanel config={existing.config as ProviderConfig} />}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Read-only theme panel: resolved store identity + draft/main theme ids from the
 * last healthcheck. Mirrors the v1 ThemePanel.
 */
function ThemePanel({ config }: { config: ProviderConfig }) {
  const storefrontUrl = config.domain
    ? `https://${config.domain}`
    : config.storeSlug
      ? `https://${config.storeSlug}.epodsystem.com`
      : null;
  const scopes = config.scopes ?? null;
  const hasWildcard = scopes?.includes("*") ?? false;
  const missingScopes =
    scopes && !hasWildcard ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s)) : [];

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Store &amp; themes</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
        <dt className="text-subtle">Store</dt>
        <dd>
          {config.storeName ?? config.storeSlug ?? "— (run Test connection)"}
          {config.storeId && <span className="text-subtle"> · #{config.storeId}</span>}
          {config.orgId && <span className="text-subtle"> · org {config.orgId}</span>}
        </dd>
        <dt className="text-subtle">Domain</dt>
        <dd>{config.domain ?? "—"}</dd>
        <dt className="text-subtle">Theme (main / prod)</dt>
        <dd>
          {config.themeId ?? "—"}
          {config.themeName && <span className="text-subtle"> · {config.themeName}</span>}
        </dd>
        <dt className="text-subtle">Theme (draft / staging)</dt>
        <dd>{config.draftThemeId ?? "— (created at build time)"}</dd>
        <dt className="text-subtle">Commerce</dt>
        <dd>{config.commerceEnabled == null ? "—" : config.commerceEnabled ? "enabled" : "disabled"}</dd>
        <dt className="text-subtle">Scopes</dt>
        <dd>{scopes ? (hasWildcard ? "full (*)" : scopes.join(", ")) : "—"}</dd>
      </dl>
      {missingScopes.length > 0 && (
        <Banner tone="attention">
          Key is missing scope(s): <b>{missingScopes.join(", ")}</b> — builds/publish may fail.
        </Banner>
      )}
      {storefrontUrl && (
        <a
          href={storefrontUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[13px] font-semibold text-accent hover:underline"
        >
          Open storefront ↗
        </a>
      )}
      <p className="fg-body-sm text-subtle">
        Builds run on a draft theme (previewed via a token on this domain); publish (draft → live)
        and rollback run through the website pipeline&apos;s release stage.
      </p>
    </div>
  );
}
