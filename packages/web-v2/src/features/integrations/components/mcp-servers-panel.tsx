"use client";

// Agent MCP servers panel (ISS-429, ISS-1191). `GET .../integrations/mcp-preview`
// composes its answer from the one resolver the dispatch itself uses, so neither
// the set nor the URL here can drift from what an agent receives, and each row
// says which of the two sources supplied that server. Authorization is redacted
// server-side BY CONSTRUCTION.

import { useState } from "react";
import {
  Button,
  ErrorState,
  Icon,
  SectionTitle,
  Skeleton,
  SettingsSection,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { STATE_WORDS } from "../derive";
import { useIntegrationsList, useMcpPreview, useTestIntegration } from "../hooks";
import { providerLabel } from "../providers/registry";
import type { IntegrationSummary, IntegrationTestResult, McpServerPreviewEntry } from "../types";
import { AgentAccessControl, GRANT_LABEL } from "./agent-access-control";
import { Pill, scopeLabel } from "./status-pill";
import { healthLine } from "@forge/contracts/health-words";

const REASON_META: Record<
  McpServerPreviewEntry["reason"],
  { label: string; fg: string; bg: string; icon: "check" | "dot" | "alert"; hint?: string }
> = {
  ok: { label: "Given to agents", fg: "var(--green-600)", bg: "var(--green-50)", icon: "check" },
  not_configured: {
    label: "Not configured",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
    icon: "dot",
  },
  disabled: {
    label: STATE_WORDS.off,
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
    icon: "dot",
    hint: "It is set up and turned off, so agents do not get its MCP server until it is turned back on.",
  },
  no_credential: {
    label: "No credential",
    fg: "var(--amberw-600)",
    bg: "var(--amberw-50)",
    icon: "alert",
  },
  shadowed: {
    label: "Shadowed",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
    icon: "dot",
    hint: "Another connection of this provider already gives agents this tool, so this one is not used. Nothing is wrong with it. To use this one, move the access to it, or give it a label of its own.",
  },
  not_granted: {
    label: "Not granted",
    fg: "var(--amberw-600)",
    bg: "var(--amberw-50)",
    icon: "alert",
    // Its connection's state is the row's pill and the Integrations row's; this says only the grant.
    hint: `No agent on this project may use it yet. Switch on "${GRANT_LABEL}" below to allow it.`,
  },
  not_resolved: {
    label: "Not delivered",
    fg: "var(--red-600)",
    bg: "var(--red-50)",
    icon: "alert",
    hint: "It is set up and allowed, but agents still do not get it. Press Verify to check its credential. If that passes, check its settings above.",
  },
};

const SOURCE_LABEL: Record<McpServerPreviewEntry["source"], string> = {
  integration: "From an integration",
  project: "From this project's settings",
};

/** A row's title: the provider's name as the Integrations list shows it, the server's own name only
 *  where no provider supplies it (one this project's settings declare itself). */
export function rowTitle(entry: Pick<McpServerPreviewEntry, "provider" | "serverName">): string {
  return entry.provider ? providerLabel(entry.provider) : entry.serverName;
}

export const MCP_PANEL_INTRO =
  "The tools each agent working on this project is given. They come from this project's settings and from the integrations shared with it. An integration reaches agents only once it is allowed on its row. Credentials are added when an agent starts, and never shown here.";

/** Each reason's hint, for a reader that holds them to the panel's own sentence rule. */
export const REASON_HINTS = Object.values(REASON_META).flatMap((m) => (m.hint ? [m.hint] : []));

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
    <li className="flex flex-col gap-1.5 border-t border-line py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="command" size={15} className="text-muted" />
        <span className="text-13 font-semibold text-fg">{rowTitle(entry)}</span>
        {entry.role !== null && (
          <span className="fg-body-sm whitespace-nowrap rounded-pill bg-sunken px-2 py-0.5 text-subtle">
            {scopeLabel(entry.role, entry.stages)}
          </span>
        )}
        <span className="fg-body-sm whitespace-nowrap rounded-pill bg-sunken px-2 py-0.5 text-subtle">
          {SOURCE_LABEL[entry.source]}
        </span>
        <span className="ml-auto whitespace-nowrap">
          <ReasonPill reason={entry.reason} />
        </span>
      </div>

      {entry.url ? (
        <p className="truncate font-mono text-12-5 text-muted" title={entry.url}>
          {entry.url}
        </p>
      ) : entry.provider && !entry.configured ? (
        // Only a row with nothing set up is told to set it up; any other reads its own state (r9).
        <p className="fg-body-sm text-subtle">
          Set up {providerLabel(entry.provider)} in the list above to give agents its MCP server.
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
            {/* Turned off wins: the last check's finding is not a second state beside it. */}
            {entry.reason === "disabled"
              ? checked
                ? `Checked ${checked}.`
                : healthLine(null)
              : healthLine(entry.lastHealthStatus, checked)}
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
    <SettingsSection>
      <SectionTitle className="fg-h3 mb-1">Agent MCP servers</SectionTitle>
      <p className="fg-body-sm mb-3 text-muted">
        {MCP_PANEL_INTRO}
      </p>
      {preview.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : preview.isError ? (
        <ErrorState message={formatApiError(preview.error)} onRetry={() => preview.refetch()} />
      ) : (
        <ul className="flex flex-col">
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
          Named in this project&rsquo;s settings but not supplied, so agents do not get them:{" "}
          {dropped.join(", ")}. A pipeline step that names one with its own settings may still give
          it on that step.
        </p>
      )}
      {stateOnly.length > 0 && (
        <p className="fg-body-sm mt-2 text-subtle">
          Named only for some pipeline steps, so agents get them only on those steps:{" "}
          {stateOnly.join(", ")}.
        </p>
      )}
    </SettingsSection>
  );
}
