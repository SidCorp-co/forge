"use client";

// Agent MCP servers panel (ISS-429). Renders EXACTLY what the dispatch-time
// resolvers will inject into a runner's `mcpServers` for this project — the
// preview comes from `GET .../integrations/mcp-preview`, which runs the same
// builders + filters as the resolvers, so the URL shown here cannot drift from
// what an agent actually receives. The Authorization header is redacted
// server-side BY CONSTRUCTION; nothing secret ever reaches this component.

import { useState } from "react";
import { Button, Card, CardContent, ErrorState, Icon, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useMcpPreview, useTestIntegration } from "../hooks";
import type { IntegrationTestResult, McpServerPreviewEntry } from "../types";

const REASON_META: Record<
  McpServerPreviewEntry["reason"],
  { label: string; fg: string; bg: string; icon: "check" | "dot" | "alert" }
> = {
  ok: { label: "Will inject", fg: "var(--green-600)", bg: "var(--green-50)", icon: "check" },
  not_configured: {
    label: "Not configured",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
    icon: "dot",
  },
  disabled: { label: "Disabled", fg: "var(--fg-subtle)", bg: "var(--bg-sunken)", icon: "dot" },
  no_credential: {
    label: "No credential",
    fg: "var(--amberw-600)",
    bg: "var(--amberw-50)",
    icon: "alert",
  },
  shadowed: { label: "Shadowed", fg: "var(--fg-subtle)", bg: "var(--bg-sunken)", icon: "dot" },
};

const ENV_LABEL: Record<string, string> = { staging: "Staging", prod: "Production" };

function ReasonPill({ reason }: { reason: McpServerPreviewEntry["reason"] }) {
  const m = REASON_META[reason];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[12px] font-semibold"
      style={{ color: m.fg, background: m.bg }}
    >
      <Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

function VerifyResult({ result }: { result: IntegrationTestResult | { errorMessage: string } }) {
  if ("errorMessage" in result) {
    return <p className="fg-body-sm text-[var(--red-600)]">{result.errorMessage}</p>;
  }
  const ok = result.status === "ok";
  return (
    <p className={`fg-body-sm ${ok ? "text-[var(--green-600)]" : "text-[var(--red-600)]"}`}>
      {ok ? "Credential verified" : `Verify failed: ${result.message ?? result.status}`}
    </p>
  );
}

function McpServerRow({
  entry,
  projectId,
}: {
  entry: McpServerPreviewEntry;
  projectId: string;
}) {
  const test = useTestIntegration(projectId);
  const [result, setResult] = useState<IntegrationTestResult | { errorMessage: string } | null>(
    null,
  );

  function verify() {
    if (!entry.bindingId) return;
    setResult(null);
    test.mutate(entry.bindingId, {
      onSuccess: (r) => setResult(r),
      onError: (err) => setResult({ errorMessage: formatApiError(err) }),
    });
  }

  const checked = formatRelativeTime(entry.lastHealthAt);

  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Icon name="command" size={15} className="text-muted" />
        <span className="font-mono text-[13px] font-semibold text-fg">{entry.serverName}</span>
        {entry.environment && (
          <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
            {ENV_LABEL[entry.environment] ?? entry.environment}
          </span>
        )}
        <span className="ml-auto">
          <ReasonPill reason={entry.reason} />
        </span>
      </div>

      {entry.url ? (
        <p className="truncate font-mono text-[12.5px] text-muted" title={entry.url}>
          {entry.url}
        </p>
      ) : (
        <p className="fg-body-sm text-subtle">
          Configure the {entry.provider} integration below to inject its MCP server.
        </p>
      )}

      {entry.configured && (
        <div className="flex items-center justify-between gap-2">
          <span className="fg-body-sm text-subtle">
            {entry.lastHealthStatus
              ? `health: ${entry.lastHealthStatus}${checked ? ` · ${checked}` : ""}`
              : "never health-checked"}
          </span>
          {entry.bindingId && (
            <Button variant="ghost" size="sm" onClick={verify} loading={test.isPending}>
              Verify
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
export function McpServersPanel({ projectId }: { projectId: string }) {
  const preview = useMcpPreview(projectId);

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Agent MCP servers</h2>
        <p className="fg-body-sm mb-3 text-muted">
          MCP servers injected into every Claude agent dispatched for this project. URLs come from
          the same resolver that performs the injection; credentials are attached at dispatch time
          and never shown here.
        </p>
        {preview.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : preview.isError ? (
          <ErrorState message={formatApiError(preview.error)} onRetry={() => preview.refetch()} />
        ) : (
          <ul className="flex flex-col gap-2">
            {(preview.data?.servers ?? []).map((entry) => (
              <McpServerRow
                key={`${entry.provider}:${entry.bindingId ?? "none"}`}
                entry={entry}
                projectId={projectId}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
