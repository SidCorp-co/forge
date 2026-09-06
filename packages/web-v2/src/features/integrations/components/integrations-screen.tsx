"use client";

// Workspace `/integrations` — the OWNER CONNECTION DIRECTORY (ISS-429).
//
// A connection is the credential (owned by a user or an org); bindings link it
// into projects. Every card must answer three questions the provider name
// cannot: what is this, what does it point at, and who uses it. BINDING-scoped
// management (environment, webhook rotate, delivery log, disconnect) lives in
// project settings → Integrations; this page deliberately does not duplicate
// it, and opening a card hands the rest to the edit drawer (ISS-435).

import { useCallback, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HelpButton,
  Icon,
  Input,
  NativeSelect,
  PageContainer,
  Skeleton,
} from "@/design";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useActiveOrg } from "@/features/orgs/active-org";
import { useOrgs } from "@/features/orgs/hooks";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useCanManageConnection, useConnections, useRemoveConnection, useUpdateConnection } from "../hooks";
import { connectionTarget, connectionTitle, matchesQuery } from "../connection-identity";
import { deriveConnectionStatus } from "../derive";
import { ConnectionEditDrawer } from "./connection-edit-drawer";
import { DirectoryStatusPill, ENV_LABEL, PROVIDER_ICON, PROVIDER_LABEL } from "./status-pill";

/** Projects a connection is bound to, named — the line that tells two credentials apart. */
function UsageLine({
  connection,
  projectName,
}: {
  connection: ConnectionDirectoryItem;
  projectName: (id: string) => string;
}) {
  const bindings = connection.usage.bindings;
  if (bindings.length === 0) {
    return (
      <p className="fg-body-sm text-subtle">
        Not used by any project — share it from a project&apos;s settings → Integrations.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {bindings.map((b) => (
        <span
          key={b.id}
          className="fg-body-sm inline-flex items-center gap-1 rounded-pill border border-line bg-surface px-2 py-0.5"
          title={b.active ? undefined : "this project has the integration switched off"}
        >
          <span className="max-w-[14ch] truncate">{projectName(b.projectId)}</span>
          <span className="text-subtle">{ENV_LABEL[b.environment] ?? b.environment}</span>
          {!b.active && <span className="text-subtle">· off</span>}
        </span>
      ))}
    </div>
  );
}

function RemoveButton({ connection }: { connection: ConnectionDirectoryItem }) {
  const remove = useRemoveConnection();
  const [armed, setArmed] = useState(false);
  const count = connection.usage.bindings.length;

  if (!armed) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(true);
        }}
      >
        Remove
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="fg-body-sm text-muted">
        {count > 0 ? `Disconnects ${count} project${count > 1 ? "s" : ""}.` : "Delete it?"}
      </span>
      <Button
        variant="danger"
        size="sm"
        loading={remove.isPending}
        onClick={(e) => {
          e.stopPropagation();
          remove.mutate(connection.id);
        }}
      >
        Delete
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setArmed(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}

// cm:guard show the provider pill only when the TITLE is not already the provider label — `displayName` falls back to that label, so printing both rendered "Coolify deploy Coolify deploy" on every one of the 17 unnamed rows on forge-beta 2026-09-06
function ConnectionCard({
  connection,
  ownerLabel,
  projectName,
  onOpen,
}: {
  connection: ConnectionDirectoryItem;
  /** ISS-477 — which principal owns this credential ("Personal" or an org name). */
  ownerLabel: string;
  projectName: (id: string) => string;
  onOpen: () => void;
}) {
  const update = useUpdateConnection();
  const canManage = useCanManageConnection(connection);
  const checked = formatRelativeTime(connection.lastHealthAt);
  const title = connectionTitle(connection);
  const target = connectionTarget(connection);
  const providerLabel = PROVIDER_LABEL[connection.provider] ?? connection.provider;

  return (
    <Card>
      <CardContent>
        {/* The card body opens the edit drawer (ISS-435); inner buttons keep
            their own actions via stopPropagation. div+role, not <button> —
            the shortcuts inside are real buttons and can't nest. */}
        <div
          role="button"
          tabIndex={0}
          aria-label={`Manage connection ${title}`}
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
          <div className="flex items-start justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-2">
              <Icon
                name={PROVIDER_ICON[connection.provider] ?? "link"}
                size={18}
                className="shrink-0 text-muted"
              />
              <span className="fg-h3 truncate">{title}</span>
              {title !== providerLabel && (
                <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                  {providerLabel}
                </span>
              )}
            </span>
            <DirectoryStatusPill status={deriveConnectionStatus(connection)} />
          </div>

          {target && (
            <p className="fg-body-sm truncate font-mono text-muted" title={target}>
              {target}
            </p>
          )}

          <UsageLine connection={connection} projectName={projectName} />

          <p className="fg-body-sm text-subtle">
            <Badge tone={connection.ownerType === "org" ? "accent" : "neutral"}>{ownerLabel}</Badge>{" "}
            {connection.lastHealthStatus
              ? `last health: ${connection.lastHealthStatus}${checked ? ` · ${checked}` : ""}`
              : "never health-checked"}
            {!connection.hasSecrets && " · no credential stored"}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {canManage ? (
              <>
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
                <span className="ml-auto" />
                <RemoveButton connection={connection} />
              </>
            ) : (
              // cm:guard say WHY the actions are absent rather than rendering buttons that 403 — a plain org member can see this credential and cannot change it, and a disabled button with no reason reads as a bug
              <span className="fg-body-sm text-subtle">
                Read-only — only an admin of {ownerLabel} can change this credential.
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const HELP_ACTIONS = [
  "Click a card — rename, replace the key, edit config, Test, drill into bound projects, or remove the connection",
  "Disable / Enable — switch a credential off (every binding stops resolving) and back on",
  "Binding-scoped settings (environment, webhooks, delivery log) stay in the project's settings → Integrations tab",
];

export function IntegrationsScreen() {
  const connections = useConnections();
  const { activeOrg } = useActiveOrg();
  const orgsQ = useOrgs();
  const projectsQ = useProjectsIncludingArchived();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");

  const orgNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of orgsQ.data ?? []) m.set(o.id, o.name);
    return m;
  }, [orgsQ.data]);

  const projectName = useCallback(
    (id: string) => (projectsQ.data ?? []).find((p) => p.id === id)?.name ?? id,
    [projectsQ.data],
  );

  const all = useMemo(() => connections.data?.items ?? [], [connections.data]);

  // ISS-477 — scope the directory to the active org: a personal org shows the
  // user's own (`ownerType:'user'`) credentials; a team org shows credentials
  // it owns. Connections from other orgs (or another principal) never appear.
  const inScope = useMemo(() => {
    if (!activeOrg) return all;
    return all.filter((c) =>
      activeOrg.isPersonal
        ? c.ownerType === "user"
        : c.ownerType === "org" && c.ownerId === activeOrg.id,
    );
  }, [all, activeOrg]);

  const providersPresent = useMemo(
    () => [...new Set(inScope.map((c) => c.provider))].sort(),
    [inScope],
  );

  const items = useMemo(
    () =>
      inScope.filter(
        (c) => (provider === "" || c.provider === provider) && matchesQuery(c, query, projectName),
      ),
    [inScope, provider, query, projectName],
  );

  const ownerLabel = useCallback(
    (c: ConnectionDirectoryItem) =>
      c.ownerType === "org" ? orgNameById.get(c.ownerId) ?? "Organization" : "Personal",
    [orgNameById],
  );

  // Track the SELECTED ID and re-derive the row from the live query data, so
  // the open drawer reflects every mutation (rename/health/active) without
  // holding a stale snapshot. Stable onClose — SlideOver's focus effect keys
  // on it, and a fresh identity per render would yank focus on every refetch.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((c) => c.id === selectedId) ?? null;
  const closeDrawer = useCallback(() => setSelectedId(null), []);

  const scopeName = activeOrg
    ? activeOrg.isPersonal
      ? "your personal space"
      : activeOrg.name
    : "this workspace";

  // cm:guard three empty states, never one — "no connections yet" was rendered for a scope that merely HID them, which reads as data loss to anyone who created the credential under a different org
  function renderEmpty() {
    if (inScope.length > 0) {
      return (
        <EmptyState
          title="No connection matches"
          message={`None of the ${inScope.length} connections in ${scopeName} match this filter.`}
          mascot={false}
          action={{
            label: "Clear filters",
            onClick: () => {
              setQuery("");
              setProvider("");
            },
          }}
        />
      );
    }
    if (all.length > 0) {
      return (
        <EmptyState
          title={`No connections in ${scopeName}`}
          message={`You can see ${all.length} connection${all.length > 1 ? "s" : ""} in your other spaces — switch space in the sidebar to reach ${all.length > 1 ? "them" : "it"}.`}
          mascot={false}
        />
      );
    }
    return (
      <EmptyState
        title="No connections yet"
        message="Create one by configuring an integration in any project's settings → Integrations."
        mascot={false}
      />
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Connections</h1>
          <p className="fg-body-sm text-muted">
            Credentials in {scopeName}, shared across projects. Configure a project&apos;s
            integrations in its settings → Integrations.
          </p>
        </div>
        <HelpButton
          summary="A connection is a credential owned by you or one of your organizations (Coolify token, Postman key, GitHub App). Projects use a connection through bindings — share one connection with several projects without re-entering the secret. Health here is the connection's real last-known state; disabled connections stay listed so you can re-enable them."
          actions={HELP_ACTIONS}
        />
      </div>

      {inScope.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, endpoint or project…"
            aria-label="Search connections"
            className="max-w-[320px]"
          />
          <NativeSelect
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="Filter by provider"
            options={[
              { value: "", label: "All providers" },
              ...providersPresent.map((p) => ({
                value: p,
                label: PROVIDER_LABEL[p] ?? p,
              })),
            ]}
          />
          <span className="fg-body-sm text-subtle">
            {items.length} of {inScope.length}
          </span>
        </div>
      )}

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
          <CardContent>{renderEmpty()}</CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => (
            <ConnectionCard
              key={c.id}
              connection={c}
              ownerLabel={ownerLabel(c)}
              projectName={projectName}
              onOpen={() => setSelectedId(c.id)}
            />
          ))}
        </div>
      )}

      {
        // cm:guard mount the drawer only while a card is selected — it opens its own binding and org queries on mount, so rendering it always (hidden behind an `open` prop) fires them on every visit to the directory
        selected && <ConnectionEditDrawer connection={selected} onClose={closeDrawer} />
      }
    </PageContainer>
  );
}
