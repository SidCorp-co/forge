"use client";

// Workspace `/integrations` — the OWNER CONNECTION DIRECTORY (ISS-429).
//
// A connection is the credential (owned by the signed-in user); bindings link
// it into projects. This page lists every connection the user owns — including
// disabled ones — with truthful health and enable/disable shortcuts; clicking
// a card opens the connection edit drawer (ISS-435: rename, replace key,
// provider config, Test, per-project drill-through, remove). BINDING-scoped
// management (environment, webhook rotate, delivery log, disconnect) lives in
// project settings → Integrations (`ProjectIntegrationsPanel`); this page
// deliberately does not duplicate it.

import { useCallback, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HelpButton,
  Icon,
  PageContainer,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useConnectionBindings, useConnections, useUpdateConnection } from "../hooks";
import { deriveConnectionStatus } from "../derive";
import type { ConnectionSummary } from "../types";
import { ConnectionEditDrawer } from "./connection-edit-drawer";
import { DirectoryStatusPill, ENV_LABEL, PROVIDER_ICON, PROVIDER_LABEL } from "./status-pill";

function ConnectionStatusPill({ connection }: { connection: ConnectionSummary }) {
  return <DirectoryStatusPill status={deriveConnectionStatus(connection)} />;
}

/** "Projects using this connection" — fetched lazily once the row expands. */
function ConnectionBindings({ connectionId }: { connectionId: string }) {
  const bindingsQ = useConnectionBindings(connectionId);
  const projectsQ = useProjectsIncludingArchived();

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQ.data ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsQ.data]);

  if (bindingsQ.isLoading) {
    return (
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (bindingsQ.isError) {
    return (
      <ErrorState message={formatApiError(bindingsQ.error)} onRetry={() => bindingsQ.refetch()} />
    );
  }
  const items = bindingsQ.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        No projects use this connection yet. Share it from a project&apos;s settings →
        Integrations.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((b) => (
        <li
          key={b.id}
          className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2"
        >
          <span className="truncate text-fg">{projectNames.get(b.projectId) ?? b.projectId}</span>
          <span className="fg-body-sm text-muted">{ENV_LABEL[b.environment] ?? b.environment}</span>
          {!b.active && (
            <span className="fg-body-sm ml-auto rounded-pill bg-sunken px-2 py-0.5 text-subtle">
              binding disabled
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConnectionCard({
  connection,
  onOpen,
}: {
  connection: ConnectionSummary;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const update = useUpdateConnection();
  const checked = formatRelativeTime(connection.lastHealthAt);
  const label =
    connection.displayName ?? PROVIDER_LABEL[connection.provider] ?? connection.provider;

  return (
    <Card>
      <CardContent>
        {/* The card body opens the edit drawer (ISS-435); inner buttons keep
            their own actions via stopPropagation. div+role, not <button> —
            the shortcuts inside are real buttons and can't nest. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={`Manage connection ${label}`}
          className="flex cursor-pointer flex-col gap-2.5 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          onClick={onOpen}
          onKeyDown={(e) => {
            // Only when the card ITSELF is focused — Enter/Space on the inner
            // buttons/links must keep their native activation.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen();
            }
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-2">
              <Icon
                name={PROVIDER_ICON[connection.provider] ?? "link"}
                size={18}
                className="shrink-0 text-muted"
              />
              <span className="fg-h3 truncate">{label}</span>
              <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                {PROVIDER_LABEL[connection.provider] ?? connection.provider}
              </span>
            </span>
            <ConnectionStatusPill connection={connection} />
          </div>

          <p className="fg-body-sm text-muted">
            {connection.lastHealthStatus
              ? `last health: ${connection.lastHealthStatus}${checked ? ` · ${checked}` : ""}`
              : "never health-checked"}
            {!connection.hasSecrets && " · no credential stored"}
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              {expanded ? "Hide projects" : "Projects using it"}
            </Button>
            <span className="ml-auto" />
            {connection.active ? (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  update.mutate({ id: connection.id, body: { active: false } });
                }}
              >
                Disable
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={update.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  update.mutate({ id: connection.id, body: { active: true } });
                }}
              >
                Enable
              </Button>
            )}
          </div>

          {expanded && (
            // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: stops bubbling only — the inner list has its own semantics
            <div onClick={(e) => e.stopPropagation()}>
              <ConnectionBindings connectionId={connection.id} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function IntegrationsScreen() {
  const connections = useConnections();
  const items = connections.data?.items ?? [];
  // Track the SELECTED ID and re-derive the row from the live query data, so
  // the open drawer reflects every mutation (rename/health/active) without
  // holding a stale snapshot. Stable onClose — SlideOver's focus effect keys
  // on it, and a fresh identity per render would yank focus on every refetch.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((c) => c.id === selectedId) ?? null;
  const closeDrawer = useCallback(() => setSelectedId(null), []);

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Connections</h1>
          <p className="fg-body-sm text-muted">
            Credentials you own, shared across projects. Configure a project&apos;s integrations in
            its settings → Integrations.
          </p>
        </div>
        <HelpButton
          summary="A connection is a credential you own (Coolify token, Postman key, Epodsystem key). Projects use a connection through bindings — share one connection with several projects without re-entering the secret. Health here is the connection's real last-known state; disabled connections stay listed so you can re-enable them."
          actions={[
            "Click a card — rename, replace the key, edit config, Test, drill into bound projects, or remove the connection",
            "Disable / Enable — switch a credential off (every binding stops resolving) and back on",
            "Binding-scoped settings (environment, webhooks, delivery log) stay in the project's settings → Integrations tab",
          ]}
          docPath="docs/guides/integrations.md"
        />
      </div>

      {connections.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[148px] w-full" />
          ))}
        </div>
      ) : connections.isError ? (
        <ErrorState
          message={formatApiError(connections.error)}
          onRetry={() => connections.refetch()}
        />
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title="No connections yet"
              message="Create one by configuring an integration in any project's settings → Integrations."
              mascot={false}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <ConnectionCard key={c.id} connection={c} onOpen={() => setSelectedId(c.id)} />
          ))}
        </div>
      )}

      {/* Mounted only while open so its queries (bindings, archived projects,
          orgs) never fire as a side effect of rendering the directory. */}
      {selected && <ConnectionEditDrawer connection={selected} onClose={closeDrawer} />}
    </PageContainer>
  );
}
