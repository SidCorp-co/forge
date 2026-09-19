"use client";

// ISS-435 — workspace connection EDIT drawer, opened from a directory card at
// `/integrations`. Connection-scoped management lives HERE (rename, replace
// key, provider config, Test, enable/disable, remove); binding-scoped controls
// (environment, webhook rotate, delivery log, disconnect) stay in project
// settings → Integrations and are deliberately not duplicated.
//
// Permissions mirror the server: user-owned → only the owner ever sees the row
// (the list is owner-scoped); org-owned → org owner/admin edits, every other
// org member gets a read-only drawer that can still drill into projects.

import Link from "next/link";
import { Suspense, lazy, useMemo, useState } from "react";
import {
  Banner,
  Button,
  CardTitle,
  Divider,
  ErrorState,
  Field,
  Icon,
  Input,
  Skeleton,
  SlideOver,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import {
  useCanManageConnection,
  useConnectionBindings,
  useRemoveConnection,
  useTestConnection,
  useUpdateConnection,
} from "../hooks";
import { deriveConnectionStatus } from "../derive";
import { PROVIDER_MODULES, providerIcon, providerLabel, providerModule } from "../providers/registry";
import type { BindingSummary, ConnectionSummary, IntegrationTestResult } from "../types";
import { DirectoryStatusPill, scopeLabel } from "./status-pill";

const CONNECTION_SECTIONS = new Map(
  PROVIDER_MODULES.flatMap((m) =>
    m.connectionSection ? [[m.provider, lazy(m.connectionSection)] as const] : [],
  ),
);

/** Inline rename in the drawer header (AC1). */
function HeaderTitle({
  connection,
  canManage,
}: {
  connection: ConnectionSummary;
  canManage: boolean;
}) {
  const update = useUpdateConnection();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = connection.displayName ?? providerLabel(connection.provider);

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== connection.displayName) {
      update.mutate({ id: connection.id, body: { displayName: next } });
    }
  };

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon name={providerIcon(connection.provider)} size={18} className="shrink-0 text-muted" />
      {editing ? (
        <span className="flex items-center gap-1.5">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                // Cancel just the edit — stop the keydown before SlideOver's
                // document-level Escape listener closes the whole drawer.
                e.stopPropagation();
                setEditing(false);
              }
            }}
            aria-label="Connection name"
            className="w-52"
          />
          <Button variant="secondary" size="sm" loading={update.isPending} onClick={save}>
            Save
          </Button>
        </span>
      ) : (
        <>
          <span className="truncate">{label}</span>
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(connection.displayName ?? "");
                setEditing(true);
              }}
            >
              Rename
            </Button>
          )}
        </>
      )}
      <DirectoryStatusPill status={deriveConnectionStatus(connection)} />
      {connection.ownerType === "org" && (
        <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
          org-shared
        </span>
      )}
    </span>
  );
}

/** Replace-key (write-only) + Test + truthful last-health line (AC2, AC6). */
function CredentialSection({
  connection,
  canManage,
}: {
  connection: ConnectionSummary;
  canManage: boolean;
}) {
  const update = useUpdateConnection();
  const test = useTestConnection();
  const [key, setKey] = useState("");
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const checked = formatRelativeTime(connection.lastHealthAt);
  const module = providerModule(connection.provider);
  const secretField = module?.secretField ?? null;

  const saveKey = () => {
    const next = key.trim();
    if (next.length < 8 || secretField === null) return;
    // mutate (not mutateAsync) — the hook's onError toast handles failure; the
    // input clears only on success so a rejected key isn't silently dropped.
    update.mutate(
      { id: connection.id, body: { secrets: { [secretField]: next } } },
      { onSuccess: () => setKey("") },
    );
  };

  const runTest = async () => {
    setTestResult(null);
    setTestError(null);
    try {
      setTestResult(await test.mutateAsync(connection.id));
    } catch (err) {
      setTestError(formatApiError(err));
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <CardTitle>Credential</CardTitle>
      {canManage && secretField === null && (
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          {module?.connectionNote ??
            `${providerLabel(connection.provider)}'s credential is not entered by hand and cannot be replaced here.`}
        </p>
      )}
      {canManage && secretField !== null && (
        <Field
          label="Replace key"
          hint={
            connection.hasSecrets
              ? "A key is stored (never shown). Enter a new one to rotate — the previous key stays valid for 24h."
              : "No credential stored yet. Enter one to activate this connection."
          }
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={module?.secretPlaceholder ?? "API key"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={key.trim().length < 8}
              loading={update.isPending}
              onClick={saveKey}
            >
              Save key
            </Button>
          </div>
        </Field>
      )}
      <div className="flex items-center gap-3">
        {canManage && (
          <Button variant="secondary" size="sm" loading={test.isPending} onClick={runTest}>
            Test connection
          </Button>
        )}
        <span className="fg-body-sm text-muted">
          {connection.lastHealthStatus
            ? `last health: ${connection.lastHealthStatus}${checked ? ` · ${checked}` : ""}`
            : "never health-checked"}
          {!connection.hasSecrets && " · no credential stored"}
        </span>
      </div>
      {testResult && (
        <Banner tone={testResult.status === "ok" ? "success" : "danger"}>
          {testResult.status === "ok" ? "Connection healthy" : `Test failed: ${testResult.status}`}
          {testResult.message ? ` — ${testResult.message}` : ""}
        </Banner>
      )}
      {testError && <Banner tone="danger">{testError}</Banner>}
    </section>
  );
}

/** The provider's own connection-tier form, or a line saying where its config is edited instead. */
function ConfigSection({
  connection,
  canManage,
}: {
  connection: ConnectionSummary;
  canManage: boolean;
}) {
  const module = providerModule(connection.provider);
  const Section = CONNECTION_SECTIONS.get(connection.provider);

  if (!Section) {
    return (
      <section className="flex flex-col gap-2">
        <CardTitle>Configuration</CardTitle>
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          {module?.connectionNote ??
            `${providerLabel(connection.provider)} has no configuration at the credential tier.`}
        </p>
      </section>
    );
  }

  return (
    <Suspense fallback={<Skeleton className="h-28 w-full" />}>
      <Section
        key={connection.id}
        connection={{ id: connection.id, config: connection.config ?? {} }}
        canManage={canManage}
      />
    </Suspense>
  );
}

/** "Projects using it" — each row drills into that project's settings →
 *  Integrations tab (AC3); archived projects render non-clickable + badge. */
function ProjectsSection({
  connection,
  projects,
  bindings,
  bindingsError,
  bindingsLoading,
  onRetry,
  onNavigate,
}: {
  connection: ConnectionSummary;
  projects: ProjectListItem[];
  bindings: BindingSummary[];
  bindingsError: string | null;
  bindingsLoading: boolean;
  onRetry: () => void;
  onNavigate: () => void;
}) {
  const byId = useMemo(() => {
    const map = new Map<string, ProjectListItem>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  return (
    <section className="flex flex-col gap-2">
      <CardTitle>Projects using it</CardTitle>
      {bindingsLoading ? (
        <Skeleton className="h-8 w-full" />
      ) : bindingsError ? (
        <ErrorState message={bindingsError} onRetry={onRetry} />
      ) : bindings.length === 0 ? (
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          No projects use this connection yet. Share it from a project&apos;s settings →
          Integrations.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {bindings.map((b) => {
            const project = byId.get(b.projectId);
            const archived = Boolean(project?.archivedAt);
            const row = (
              <>
                <span className="truncate text-fg">{project?.name ?? b.projectId}</span>
                <span className="fg-body-sm text-muted">
                  {scopeLabel(b.role, b.stages)}
                </span>
                {archived && (
                  <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    archived
                  </span>
                )}
                {!b.active && (
                  <span className="fg-body-sm ml-auto rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    binding disabled
                  </span>
                )}
                {!archived && project && (
                  <Icon name="arrowRight" size={14} className="ml-auto shrink-0 text-subtle" />
                )}
              </>
            );
            return (
              <li key={b.id}>
                {project && !archived ? (
                  <Link
                    href={`/projects/${project.slug}/settings?tab=integrations`}
                    onClick={onNavigate}
                    className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 transition-colors hover:bg-hover"
                  >
                    {row}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2 opacity-80">
                    {row}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {connection.ownerType === "org" && (
        <p className="fg-body-sm text-muted">
          Org-shared — any project in the org can be bound to this connection.
        </p>
      )}
    </section>
  );
}

/** Disable/Enable + Remove with an inline confirm listing affected projects (AC5). */
function DangerZone({
  connection,
  affectedProjects,
  onRemoved,
}: {
  connection: ConnectionSummary;
  affectedProjects: string[];
  onRemoved: () => void;
}) {
  const update = useUpdateConnection();
  const remove = useRemoveConnection();
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <CardTitle>Danger zone</CardTitle>
      <div className="flex items-center gap-2">
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
        <Button variant="ghost" size="sm" onClick={() => setConfirming((v) => !v)}>
          Remove…
        </Button>
      </div>
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken px-3 py-2.5">
          <p className="fg-body-sm text-fg">
            {affectedProjects.length > 0
              ? `Removing this connection stops credential resolution for ${affectedProjects.length} project${affectedProjects.length === 1 ? "" : "s"}: ${affectedProjects.join(", ")}. Their integrations stop working on the next dispatch.`
              : "No projects are actively using this connection. Removing it disables the stored credential."}{" "}
            The connection stays listed as Disabled so it can be re-enabled later.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(connection.id, {
                  onSuccess: onRemoved,
                })
              }
            >
              Remove connection
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function ConnectionEditDrawer({
  connection,
  onClose,
}: {
  connection: ConnectionSummary | null;
  onClose: () => void;
}) {
  const canManage = useCanManageConnection(connection);
  const bindingsQ = useConnectionBindings(connection?.id);
  const projectsQ = useProjectsIncludingArchived();

  const bindings = bindingsQ.data?.items ?? [];
  const projects = projectsQ.data ?? [];
  // Distinct PROJECT IDS with a still-resolving binding — dedupe by id (two
  // projects may share a display name) and skip already-disabled bindings,
  // which stopped resolving before any removal.
  const affectedProjects = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name] as const));
    const ids = [...new Set(bindings.filter((b) => b.active).map((b) => b.projectId))];
    return ids.map((id) => byId.get(id) ?? id);
  }, [bindings, projects]);

  if (!connection) return null;

  return (
    <SlideOver
      open={Boolean(connection)}
      onClose={onClose}
      title={<HeaderTitle connection={connection} canManage={canManage} />}
      width={560}
    >
      <div className="flex flex-col gap-5">
        <CredentialSection connection={connection} canManage={canManage} />
        <Divider />
        <ConfigSection connection={connection} canManage={canManage} />
        <Divider />
        <ProjectsSection
          connection={connection}
          projects={projects}
          bindings={bindings}
          bindingsLoading={bindingsQ.isLoading}
          bindingsError={bindingsQ.isError ? formatApiError(bindingsQ.error) : null}
          onRetry={() => bindingsQ.refetch()}
          onNavigate={onClose}
        />
        {canManage && (
          <>
            <Divider />
            <DangerZone
              connection={connection}
              affectedProjects={affectedProjects}
              onRemoved={onClose}
            />
          </>
        )}
      </div>
    </SlideOver>
  );
}
