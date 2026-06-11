"use client";

// Workspace `/integrations` — the OWNER CONNECTION DIRECTORY (ISS-429).
//
// A connection is the credential (owned by the signed-in user); bindings link
// it into projects. This page lists every connection the user owns — including
// disabled ones — with truthful health, the projects using each connection,
// and enable/disable controls. All PROJECT-scoped management (provider config,
// Test/Rotate/Disconnect, delivery log, MCP preview) lives in project settings
// → Integrations (`ProjectIntegrationsPanel`); this page deliberately does not
// duplicate it.

import { useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HelpButton,
  Icon,
  type IconName,
  PageContainer,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useConnectionBindings, useConnections, useUpdateConnection } from "../hooks";
import { deriveConnectionStatus } from "../derive";
import type { ConnectionSummary } from "../types";
import { DirectoryStatusPill, ENV_LABEL, PROVIDER_LABEL } from "./status-pill";

const PROVIDER_ICON: Record<string, IconName> = {
  coolify: "server",
  postman: "command",
  epodsystem: "command",
};

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

function ConnectionCard({ connection }: { connection: ConnectionSummary }) {
  const [expanded, setExpanded] = useState(false);
  const update = useUpdateConnection();
  const checked = formatRelativeTime(connection.lastHealthAt);
  const label =
    connection.displayName ?? PROVIDER_LABEL[connection.provider] ?? connection.provider;

  return (
    <Card>
      <CardContent>
        <div className="flex flex-col gap-2.5">
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
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Hide projects" : "Projects using it"}
            </Button>
            <span className="ml-auto" />
            {connection.active ? (
              <Button
                variant="ghost"
                size="sm"
                loading={update.isPending}
                onClick={() => update.mutate({ id: connection.id, body: { active: false } })}
              >
                Disable
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={update.isPending}
                onClick={() => update.mutate({ id: connection.id, body: { active: true } })}
              >
                Enable
              </Button>
            )}
          </div>

          {expanded && <ConnectionBindings connectionId={connection.id} />}
        </div>
      </CardContent>
    </Card>
  );
}

export function IntegrationsScreen() {
  const connections = useConnections();
  const items = connections.data?.items ?? [];

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
            "Projects using it — see every project + environment bound to a connection",
            "Disable / Enable — switch a credential off (every binding stops resolving) and back on",
            "Configure project integrations in the project's settings → Integrations tab",
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
            <ConnectionCard key={c.id} connection={c} />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
