"use client";

// Agent MCP servers panel (ISS-429, ISS-1191). `GET .../integrations/mcp-preview`
// composes its answer from the one resolver the dispatch itself uses, so neither
// the set nor the URL here can drift from what an agent receives, and each row
// says which of the two sources supplied that server. Authorization is redacted
// server-side BY CONSTRUCTION.

import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  ErrorState,
  Icon,
  SectionTitle,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useIntegrationsList, useMcpPreview, useTestIntegration } from "../hooks";
import { providerLabel } from "../providers/registry";
import type { IntegrationSummary, IntegrationTestResult, McpServerPreviewEntry } from "../types";
import { AgentAccessControl, GRANT_LABEL } from "./agent-access-control";
import { Pill, scopeLabel } from "./status-pill";

const REASON_META: Record<
  McpServerPreviewEntry["reason"],
  { label: string; fg: string; bg: string; icon: "check" | "dot" | "alert"; hint?: string }
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
  not_granted: {
    label: "Not granted",
    fg: "var(--amberw-600)",
    bg: "var(--amberw-50)",
    icon: "alert",
    hint: `Connected and credentialed, but no agent on this project may use it — nobody has granted it. Switch on "${GRANT_LABEL}" below to grant it; health does not gate the grant.`,
  },
  not_resolved: {
    label: "Not delivered",
    fg: "var(--red-600)",
    bg: "var(--red-50)",
    icon: "alert",
    hint: "Active, credentialed, granted and unshadowed — and the resolver still built no server for it, which is what a credential that will not decrypt looks like from here. Re-enter the credential and Verify.",
  },
};

const SOURCE_LABEL: Record<McpServerPreviewEntry["source"], string> = {
  integration: "from an integration",
  project: "from this project's pipeline config",
};

function ReasonPill({ reason }: { reason: McpServerPreviewEntry["reason"] }) {
  const meta = REASON_META[reason];
  return <Pill label={meta.label} fg={meta.fg} bg={meta.bg} icon={meta.icon} />;
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
  binding,
  canEdit,
}: {
  entry: McpServerPreviewEntry;
  projectId: string;
  /** The binding this row previews, absent for the synthetic not-configured row. */
  binding: IntegrationSummary | undefined;
  canEdit: boolean;
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
        <span className="font-mono text-13 font-semibold text-fg">{entry.serverName}</span>
        {entry.role !== null && (
          <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
            {scopeLabel(entry.role, entry.stages)}
          </span>
        )}
        <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
          {SOURCE_LABEL[entry.source]}
        </span>
        <span className="ml-auto">
          <ReasonPill reason={entry.reason} />
        </span>
      </div>

      {entry.url ? (
        <p className="truncate font-mono text-12-5 text-muted" title={entry.url}>
          {entry.url}
        </p>
      ) : entry.provider ? (
        <p className="fg-body-sm text-subtle">
          Configure the {providerLabel(entry.provider)} integration below to inject its MCP server.
        </p>
      ) : null}

      {REASON_META[entry.reason].hint && (
        <p className="fg-body-sm text-[var(--amberw-600)]">{REASON_META[entry.reason].hint}</p>
      )}

      {binding && (
        <AgentAccessControl projectId={projectId} binding={binding} canEdit={canEdit} />
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
export function McpServersPanel({
  projectId,
  canEdit = true,
}: {
  projectId: string;
  canEdit?: boolean;
}) {
  const preview = useMcpPreview(projectId);
  const bindings = useIntegrationsList(projectId);
  const byBindingId = new Map((bindings.data?.bindings ?? []).map((b) => [b.id, b]));
  const stateOnly = preview.data?.stateOnlyNames ?? [];
  const dropped = preview.data?.droppedNames ?? [];

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-1">Agent MCP servers</SectionTitle>
        <p className="fg-body-sm mb-3 text-muted">
          Every MCP server injected into a Claude agent dispatched for this project without a
          per-state override, from both sources that feed them: this project&rsquo;s own pipeline
          configuration and its granted integrations. The list comes from the same resolver that
          performs the injection; credentials are attached at dispatch time and never shown here. A
          connected integration reaches an agent only once it is granted, on the row below.
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
                key={`${entry.source}:${entry.provider ?? entry.serverName}:${entry.bindingId ?? entry.serverName}`}
                entry={entry}
                projectId={projectId}
                binding={entry.bindingId ? byBindingId.get(entry.bindingId) : undefined}
                canEdit={canEdit}
              />
            ))}
          </ul>
        )}
        {dropped.length > 0 && (
          <p className="fg-body-sm mt-3 text-[var(--amberw-600)]">
            Declared for this project and not supplied, so the list above does not carry them:{" "}
            {dropped.join(", ")}. A pipeline state that declares one with a spec of its own may
            still supply it on that state&rsquo;s dispatches.
          </p>
        )}
        {stateOnly.length > 0 && (
          <p className="fg-body-sm mt-2 text-subtle">
            Declared only for particular pipeline states, so they are not in the list above and
            whether each one resolves is decided on that state&rsquo;s dispatch: {stateOnly.join(", ")}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
