"use client";

// Agent MCP servers panel (ISS-429, ISS-1038).
//
// Two questions live here and they are not the same question:
//
//   per PROVIDER  — is this integration DECLARED, so that agents get it at all,
//                   and where is that declared. This is the group header, and
//                   the switch on it is the only control in the product that
//                   changes it.
//   per BINDING   — which of this provider's bindings wins the slot, whether it
//                   is healthy, and what URL it resolves to. These are the rows.
//
// Before ISS-1038 only the rows existed. The declaration lived in
// `pipelineConfig.mcpServers` on the Pipeline tab, which offered a catalog of
// two secret-free servers and an add-form that refused the sentinel's only
// legal value — so a connected, healthy, green integration could reach no
// agent at all and no screen said so or offered a way out.
//
// Both halves are computed server-side from one declaration projection, so a
// row cannot report `Not enabled` under a header that says enabled. Nothing
// secret reaches this component: the preview redacts by construction and the
// switch writes a bare `true`.

import { useState } from "react";
import { Button, Card, CardContent, ErrorState, Icon, Skeleton, Toggle } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import type { McpInjectionProviderState } from "@forge/contracts";
import { useMcpInjection, useMcpPreview, useSetMcpInjection, useTestIntegration } from "../hooks";
import type { IntegrationTestResult, McpServerPreviewEntry } from "../types";
import { ENV_LABEL, PROVIDER_LABEL, Pill } from "./status-pill";

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
  // ISS-623 W3 — distinct from `no_credential`/health: this integration is
  // connected and healthy, but nothing declares its sentinel, so it is not
  // injected. Connection status does not gate injection.
  // ISS-1038 — the hint used to tell the operator to hand-edit a map no screen
  // exposed. It now names the switch directly above the row.
  not_declared: {
    label: "Not enabled",
    fg: "var(--amberw-600)",
    bg: "var(--amberw-50)",
    icon: "alert",
    hint: "Connected, but it reaches no agent: nothing declares it. Turn on “Inject into this project’s agents” above to change that — connection health does not gate injection.",
  },
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

      {REASON_META[entry.reason].hint && (
        <p className="fg-body-sm text-[var(--amberw-600)]">{REASON_META[entry.reason].hint}</p>
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

function stageList(statuses: string[]): string {
  return statuses.join(", ");
}

/**
 * One provider: the switch that decides whether it reaches agents at all, the
 * scopes that disagree with that switch, and its bindings underneath.
 */
function ProviderGroup({
  state,
  entries,
  projectId,
  canEdit,
  busy,
  onToggle,
}: {
  state: McpInjectionProviderState;
  entries: McpServerPreviewEntry[];
  projectId: string;
  canEdit: boolean;
  /** A write for THIS provider is in flight. */
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const label = PROVIDER_LABEL[state.provider] ?? state.provider;

  return (
    <li className="rounded-md border border-line">
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        <div className="flex items-center gap-3">
          <span className="fg-label text-fg">{label}</span>
          <span className="ml-auto flex items-center gap-2">
            {busy && (
              <span className="fg-body-sm text-subtle" role="status">
                Saving — wait for this to finish before changing it again.
              </span>
            )}
            <Toggle
              checked={state.declaredDefault}
              onChange={onToggle}
              disabled={!canEdit || busy}
              aria-label={`Inject ${label} into this project's agents`}
            />
          </span>
        </div>

        <p className="fg-caption text-muted">
          Inject into this project’s agents. This is the project default: it reaches every
          dispatched job, every chat turn, and a resident master’s pane — a pane stands at no issue
          status, so a per-stage override never changes what it gets.
        </p>

        {!canEdit && (
          <p className="fg-caption text-subtle">
            Changing this needs org owner or admin on this project.
          </p>
        )}

        {state.declaredStates.length > 0 && (
          <p className="fg-caption text-muted">
            Also declared by these stages on their own: {stageList(state.declaredStates)}. They
            inject it whatever this switch says — edit them under Settings → Pipeline → Stage
            permissions.
          </p>
        )}

        {state.excludedStates.length > 0 && (
          <p className="fg-caption text-[var(--amberw-600)]">
            Turned back off for these stages: {stageList(state.excludedStates)}. A job at one of
            them does not get it — edit them under Settings → Pipeline → Stage permissions.
          </p>
        )}
      </div>

      <ul className="flex flex-col gap-2 p-2">
        {entries.map((entry) => (
          <McpServerRow
            key={`${entry.provider}:${entry.bindingId ?? "none"}`}
            entry={entry}
            projectId={projectId}
          />
        ))}
      </ul>
    </li>
  );
}

/**
 * "Agent MCP servers" — which integrations reach this project's agents, the
 * switch that decides it, and the exact URL each binding resolves to.
 */
export function McpServersPanel({ projectId }: { projectId: string }) {
  const preview = useMcpPreview(projectId);
  const injection = useMcpInjection(projectId);
  const setInjection = useSetMcpInjection(projectId);

  // Which provider has a write in flight, and the last failure, both keyed by
  // provider: a failure on `postman` must not blank the control on `sentry`.
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ provider: string; message: string; enabled: boolean } | null>(
    null,
  );

  function toggle(provider: string, enabled: boolean) {
    // One write at a time. The control is disabled while one is in flight, so
    // this is the belt: a second write would race the first and the panel would
    // settle on whichever response came back last.
    if (busy) return;
    setBusy(provider);
    setFailed(null);
    setInjection.mutate(
      { provider, enabled },
      {
        // The confirmed state comes back with the response and is written into
        // the cache by the hook. On failure nothing is written, so the control
        // stays where the server last said it was.
        onError: (err) =>
          setFailed({ provider, message: formatApiError(err), enabled }),
        onSettled: () => setBusy(null),
      },
    );
  }

  const isLoading = preview.isLoading || injection.isLoading;
  const error = preview.isError ? preview.error : injection.isError ? injection.error : null;
  const providers = injection.data?.providers ?? [];
  const canEdit = injection.data?.canEdit ?? false;
  const servers = preview.data?.servers ?? [];

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Agent MCP servers</h2>
        <p className="fg-body-sm mb-3 text-muted">
          Which connected integrations reach the Claude agents this project dispatches. A
          connection being healthy is not enough — the switch on each one is what injects it.
          Credentials are attached at dispatch time and never shown here.
        </p>
        {isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : error ? (
          <ErrorState
            message={formatApiError(error)}
            onRetry={() => {
              preview.refetch();
              injection.refetch();
            }}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {providers.map((state) => (
              <div key={state.provider} className="contents">
                <ProviderGroup
                  state={state}
                  entries={servers.filter((s) => s.provider === state.provider)}
                  projectId={projectId}
                  canEdit={canEdit}
                  busy={busy === state.provider}
                  onToggle={(enabled) => toggle(state.provider, enabled)}
                />
                {failed?.provider === state.provider && (
                  <li className="flex items-center gap-3 rounded-md border border-[var(--red-600)] px-3 py-2">
                    <p className="fg-body-sm text-[var(--red-600)]">
                      Could not change it: {failed.message}
                    </p>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-auto"
                      onClick={() => toggle(failed.provider, failed.enabled)}
                    >
                      Try again
                    </Button>
                  </li>
                )}
              </div>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
