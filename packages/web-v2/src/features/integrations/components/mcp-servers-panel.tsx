"use client";

// Agent MCP servers panel (ISS-429, ISS-1191). `GET .../integrations/mcp-preview`
// composes its answer from the one resolver the dispatch itself uses, so neither
// the set nor the URL here can drift from what an agent receives. Authorization
// is redacted server-side BY CONSTRUCTION.

import { useState } from "react";
import {
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  ErrorState,
  Icon,
  Skeleton,
  statusReading,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useIntegrationsList, useMcpPreview, useTestIntegration } from "../hooks";
import { providerLabel } from "../providers/registry";
import type { IntegrationSummary, IntegrationTestResult, McpServerPreviewEntry } from "../types";
import { AgentAccessControl } from "./agent-access-control";
import { Pill, scopeLabel } from "./status-pill";

const REASON_META: Record<
  McpServerPreviewEntry["reason"],
  { label: ProductCopyKey; fg: string; bg: string; icon: "check" | "dot" | "alert"; hint?: ProductCopyKey }
> = {
  ok: { label: "integrations.mcp.ok", fg: "var(--green-600)", bg: "var(--green-50)", icon: "check" },
  not_configured: { label: "integrations.mcp.notConfigured", fg: "var(--fg-subtle)", bg: "var(--bg-sunken)", icon: "dot" },
  disabled: { label: "integrations.status.disabled", fg: "var(--fg-subtle)", bg: "var(--bg-sunken)", icon: "dot" },
  no_credential: { label: "integrations.mcp.noCredential", fg: "var(--amberw-600)", bg: "var(--amberw-50)", icon: "alert" },
  shadowed: {
    label: "integrations.mcp.shadowed",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
    icon: "dot",
    hint: "integrations.mcp.shadowedHint",
  },
  not_granted: {
    label: "integrations.mcp.notGranted",
    fg: "var(--amberw-600)",
    bg: "var(--amberw-50)",
    icon: "alert",
    hint: "integrations.mcp.notGrantedHint",
  },
  not_resolved: {
    label: "integrations.mcp.notResolved",
    fg: "var(--red-600)",
    bg: "var(--red-50)",
    icon: "alert",
    hint: "integrations.mcp.notResolvedHint",
  },
};

function ReasonPill({ reason }: { reason: McpServerPreviewEntry["reason"] }) {
  const t = useCopy();
  const meta = REASON_META[reason];
  return <Pill label={t(meta.label)} fg={meta.fg} bg={meta.bg} icon={meta.icon} />;
}

function VerifyResult({ result }: { result: IntegrationTestResult | { errorMessage: string } }) {
  const t = useCopy();
  if ("errorMessage" in result) {
    return <p className="fg-body-sm text-[var(--red-600)]">{result.errorMessage}</p>;
  }
  const ok = result.status === "ok";
  return (
    <p className={`fg-body-sm ${ok ? "text-[var(--green-600)]" : "text-[var(--red-600)]"}`}>
      {ok ? t("integrations.mcp.verified") : t("integrations.mcp.verifyFailed", { reason: result.message ?? result.status })}
    </p>
  );
}

function McpServerRow({
  entry,
  projectId,
  binding,
  canEdit,
  onConnect,
}: {
  entry: McpServerPreviewEntry;
  projectId: string;
  /** The binding this row previews, absent for the synthetic not-configured row. */
  binding: IntegrationSummary | undefined;
  canEdit: boolean;
  /** Opens the provider's connect drawer — the act a not-configured row points at. */
  onConnect?: (provider: string) => void;
}) {
  const test = useTestIntegration(projectId);
  const [result, setResult] = useState<IntegrationTestResult | { errorMessage: string } | null>(
    null,
  );

  function verify() {
    if (!entry.bindingId) return;
    setResult(null);
    test.mutate(entry.bindingId, {
      onSuccess: setResult,
      onError: (err) => setResult({ errorMessage: formatApiError(err) }),
    });
  }

  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const checked = time.relative(entry.lastHealthAt);
  const hint = REASON_META[entry.reason].hint;

  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center gap-2">
        <Icon name="command" size={15} className="text-muted" />
        <span className="font-mono text-13 font-semibold text-fg">{entry.serverName}</span>
        {entry.role !== null && (
          <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
            {scopeLabel(entry.role, t)}
          </span>
        )}
        <span className="ml-auto">
          <ReasonPill reason={entry.reason} />
        </span>
      </div>

      {entry.url ? (
        <p className="truncate font-mono text-12-5 text-muted" title={entry.url}>
          {entry.url}
        </p>
      ) : (
        <p className="fg-body-sm flex flex-wrap items-center gap-x-2 text-subtle">
          <span>{t("integrations.mcp.notConnected", { provider: providerLabel(entry.provider, language) })}</span>
          {onConnect && canEdit && (
            <Button variant="ghost" size="sm" onClick={() => onConnect(entry.provider)}>
              {t("integrations.mcp.connect", { provider: providerLabel(entry.provider, language) })}
            </Button>
          )}
        </p>
      )}

      {hint && (
        <p className="fg-body-sm text-[var(--amberw-600)]">
          {t(hint, { grant: t("integrations.access.grant") })}
        </p>
      )}

      {binding && (
        <AgentAccessControl projectId={projectId} binding={binding} canEdit={canEdit} />
      )}

      {entry.configured && (
        <div className="flex items-center justify-between gap-2">
          <span className="fg-body-sm text-subtle">
            {entry.lastHealthStatus
              ? `${t("integrations.mcp.health", { status: statusReading("connection", entry.lastHealthStatus, language).label })}${checked ? ` · ${checked}` : ""}`
              : t("integrations.row.neverChecked")}
          </span>
          {entry.bindingId && (
            <Button variant="ghost" size="sm" onClick={verify} loading={test.isPending}>
              {t("integrations.mcp.verify")}
            </Button>
          )}
        </div>
      )}

      {result && <VerifyResult result={result} />}
    </li>
  );
}

/**
 * "Agent MCP servers" — the truthful per-project MCP view: which servers will
 * be injected into the next dispatched agent, the exact URL, and a Verify
 * action that runs the provider's real credential healthcheck.
 */
export function McpServersPanel({
  projectId,
  canEdit = true,
  onConnect,
}: {
  projectId: string;
  canEdit?: boolean;
  onConnect?: (provider: string) => void;
}) {
  const preview = useMcpPreview(projectId);
  const bindings = useIntegrationsList(projectId);
  const byBindingId = new Map((bindings.data?.items ?? []).map((b) => [b.id, b]));
  const t = useCopy();

  return (
    <PageSection>
      <PageSectionBody style={{ paddingTop: 0 }}>
        <PageSectionTitle className="mb-1">{t("integrations.mcp.title")}</PageSectionTitle>
        <p className="fg-body-sm mb-3 max-w-[72ch] text-muted">{t("integrations.mcp.intro")}</p>
        {preview.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preview.isError ? (
          <ErrorState message={formatApiError(preview.error)} onRetry={() => preview.refetch()} />
        ) : (
          <ul className="flex flex-col divide-y divide-line-subtle">
            {(preview.data?.servers ?? []).map((entry) => (
              <McpServerRow
                key={`${entry.provider}:${entry.bindingId ?? entry.serverName}`}
                entry={entry}
                projectId={projectId}
                binding={entry.bindingId ? byBindingId.get(entry.bindingId) : undefined}
                canEdit={canEdit}
                onConnect={onConnect}
              />
            ))}
          </ul>
        )}
      </PageSectionBody>
    </PageSection>
  );
}
