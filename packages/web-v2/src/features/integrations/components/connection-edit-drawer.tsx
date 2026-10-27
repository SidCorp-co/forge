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

import type { ConnectionDirectoryItem } from "@forge/contracts";
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
  type ErrorStateRetry,
} from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import {
  useCanManageConnection,
  useConnectionBindings,
  useTestConnection,
  useUpdateConnection,
} from "../hooks";
import { takesTheApp } from "../app-owner";
import { connectionTitle, projectCalled } from "../connection-identity";
import { readOnlyNote, whoChangesConnection } from "../connection-space";
import { deriveConnectionStatus } from "../derive";
import { ConnectionReleaseRunnerField } from "./release-runner-field";
import { DangerZone, isRemovedConnection } from "./connection-danger-zone";
import { PROVIDER_MODULES, providerIcon, providerLabel, providerModule } from "../providers/registry";
import type { BindingSummary, ConnectionSummary, IntegrationTestResult } from "../types";
import { DirectoryStatusPill, scopeLabel } from "./status-pill";
import { healthLine, healthWords } from "@forge/contracts/health-words";

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
  const label = connectionTitle(connection);

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== connection.displayName) {
      update.mutate({ id: connection.id, body: { displayName: next } });
    }
  };

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
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
          <span className="min-w-0 max-w-full truncate" title={label} data-testid="connection-drawer-name">
            {label}
          </span>
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
      {connection.ownerType === "org" && !isRemovedConnection(connection) && (
        <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
          org-shared
        </span>
      )}
    </span>
  );
}

/**
 * What a test just run found: Forge's worded answer whole where it gave one, and otherwise the
 * status said to a person in one sentence, never the stored value itself (ISS-1421 r17).
 */
export function testOutcome(result: { status: string; message?: string | null }): string {
  if (result.message) return result.message;
  return result.status === "ok" ? "The connection works." : healthWords(result.status);
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
    // A connection holding no key is turned on by the key that arrives (ISS-1421 r20): removing one
    // wiped its keys, and the line under this field says a new key activates it.
    const turnOn = !connection.hasSecrets && !connection.active ? { active: true } : {};
    update.mutate(
      { id: connection.id, body: { secrets: { [secretField]: next }, ...turnOn } },
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
      {canManage && secretField === null && !isRemovedConnection(connection) && (
        <p className="fg-body-sm border-b border-line pb-2 text-muted">
          {module?.connectionNote ??
            `${providerLabel(connection.provider)}'s credential is not entered by hand and cannot be replaced here.`}
        </p>
      )}
      {canManage && secretField !== null && (
        <Field
          label="Replace key"
          hint={
            connection.hasSecrets
              ? `A key is stored (never shown). ${module?.previousKeyNote ?? "Enter a new one to replace it."}`
              : "No key is stored. Enter one to activate this connection."
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
        {/* A removed connection holds nothing a check could pass; core refuses it (ISS-1421 r22). */}
        {canManage && !isRemovedConnection(connection) && (
          <Button variant="secondary" size="sm" loading={test.isPending} onClick={runTest}>
            Test connection
          </Button>
        )}
        <span className="fg-body-sm text-muted">
          {healthLine(connection.lastHealthStatus, checked)}
          {!connection.hasSecrets && " No credential is stored."}
        </span>
      </div>
      {testResult && (
        <Banner tone={testResult.status === "ok" ? "success" : "danger"}>
          {testOutcome(testResult)}
        </Banner>
      )}
      {testError && <Banner tone="danger">{testError}</Banner>}
    </section>
  );
}

/** Whether the Configuration section has anything to say: a removed App connection's installation holds nothing. */
function hasConfigSection(connection: ConnectionSummary): boolean {
  if (CONNECTION_SECTIONS.has(connection.provider)) return true;
  return !(isRemovedConnection(connection) && providerModule(connection.provider)?.secretField === null);
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
        <p className="fg-body-sm border-b border-line pb-2 text-muted">
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

/** {@link projectCalled} for a sentence, one entry a project so a count read off it stays true. */
function projectNames(ids: string[], projects: ProjectListItem[], projectsRead: boolean): string[] {
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  return ids.map((id) => {
    const project = byId.get(id);
    return project ? project.name : projectCalled(undefined, projectsRead).toLowerCase();
  });
}

/** "Projects using it" — each row drills into that project's settings →
 *  Integrations tab (AC3); archived projects render non-clickable + badge. */
function ProjectsSection({
  connection,
  projects,
  projectsRead,
  bindings,
  bindingsError,
  bindingsLoading,
  retry,
  onNavigate,
}: {
  connection: ConnectionSummary;
  projects: ProjectListItem[];
  projectsRead: boolean;
  bindings: BindingSummary[];
  bindingsError: string | null;
  bindingsLoading: boolean;
  /** `final` where retrying would meet the same refusal (a 4xx), so no control promises what it cannot do. */
  retry: ErrorStateRetry;
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
        <ErrorState title="Couldn't load the projects using it" message={bindingsError} {...retry} />
      ) : bindings.length === 0 ? (
        // A removed connection cannot be shared (ISS-1421 r22): its Danger zone says what it can do.
        <p className="fg-body-sm border-b border-line pb-2 text-muted">
          {isRemovedConnection(connection)
            ? "No project uses this connection."
            : "No projects use this connection yet. Share it from a project's settings → Integrations."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {bindings.map((b) => {
            const project = byId.get(b.projectId);
            const archived = Boolean(project?.archivedAt);
            const row = (
              <>
                <span className="truncate text-fg">{projectCalled(project?.name, projectsRead)}</span>
                <span className="fg-body-sm text-muted">
                  {scopeLabel(b.role, b.stages)}
                </span>
                {archived && (
                  <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    archived
                  </span>
                )}
                {/* The project's own switch; a connection turned off says so in the header (ISS-1421 r21). */}
                {!b.bindingActive && (
                  <span className="fg-body-sm ml-auto rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    Turned off
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
                    className="flex items-center gap-3 py-2 transition-colors hover:bg-hover"
                  >
                    {row}
                  </Link>
                ) : (
                  <div className="flex items-center gap-3 py-2 opacity-80">
                    {row}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* A removed connection is refused a binding by name (ISS-1421 r23, judge-94 on 229). */}
      {connection.ownerType === "org" && !isRemovedConnection(connection) && (
        <p className="fg-body-sm text-muted">
          Org-shared — it can be shared with any project in the org.
        </p>
      )}
    </section>
  );
}

export function ConnectionEditDrawer({
  connection,
  onClose,
}: {
  connection: ConnectionDirectoryItem | null;
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
  const projectsRead = projectsQ.isSuccess;
  const affectedProjects = useMemo(() => {
    const ids = [...new Set(bindings.filter((b) => b.active).map((b) => b.projectId))];
    return projectNames(ids, projects, projectsRead);
  }, [bindings, projects, projectsRead]);
  const bindingsRead = bindingsQ.isSuccess;
  const boundProjects = useMemo(() => {
    if (!bindingsRead) return null;
    return projectNames([...new Set(bindings.map((b) => b.projectId))], projects, projectsRead);
  }, [bindings, projects, bindingsRead, projectsRead]);
  const returnsFrom = useMemo(() => {
    if (!bindingsRead || !projectsRead || !connection) return null;
    const byId = new Map(projects.map((p) => [p.id, p] as const));
    return [...new Set(bindings.map((b) => b.projectId))].flatMap((id) => {
      const project = byId.get(id);
      return project && takesTheApp(connection, project) ? [project.name] : [];
    });
  }, [bindings, projects, bindingsRead, projectsRead, connection]);

  if (!connection) return null;
  const ownerLabel = connection.access.ownerName ?? "the organization that owns it";

  return (
    <SlideOver
      open={Boolean(connection)}
      onClose={onClose}
      title={<HeaderTitle connection={connection} canManage={canManage} />}
      width={560}
    >
      <div className="flex flex-col gap-5">
        {/* Said for as long as the drawer is open, not only in a refusal's toast (ISS-1421 r28). */}
        {!canManage && (
          <p className="fg-body-sm text-muted" data-testid="connection-read-only">
            {readOnlyNote(connection, ownerLabel)}
          </p>
        )}
        <CredentialSection connection={connection} canManage={canManage} />
        {hasConfigSection(connection) && (
          <>
            <Divider />
            <ConfigSection connection={connection} canManage={canManage} />
          </>
        )}
        {/* ISS-1275 — the connection tier of the release runner label. It renders
            itself away unless some project binds this credential as a LIVE deploy
            target, which is the only place the label decides anything. */}
        <ConnectionReleaseRunnerField
          connection={connection}
          bindings={bindings}
          canManage={canManage}
          whoChanges={whoChangesConnection(connection, ownerLabel)}
        />
        <Divider />
        <ProjectsSection
          connection={connection}
          projects={projects}
          projectsRead={projectsRead}
          bindings={bindings}
          bindingsLoading={bindingsQ.isLoading}
          bindingsError={bindingsQ.isError ? formatApiError(bindingsQ.error) : null}
          retry={{ error: bindingsQ.error, onRetry: () => void bindingsQ.refetch() }}
          onNavigate={onClose}
        />
        {canManage && (
          <>
            <Divider />
            <DangerZone
              connection={connection}
              affectedProjects={affectedProjects}
              boundProjects={boundProjects}
              returnsFrom={returnsFrom}
              onRemoved={onClose}
            />
          </>
        )}
      </div>
    </SlideOver>
  );
}
