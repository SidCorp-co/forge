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
import { useMemo, useState } from "react";
import {
  Banner,
  Button,
  Divider,
  ErrorState,
  Field,
  Icon,
  Input,
  SegmentedControl,
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
import type {
  BindingSummary,
  ConnectionSummary,
  IntegrationTestResult,
  PostmanMode,
  PostmanRegion,
  ProviderConfig,
} from "../types";
import { DirectoryStatusPill, ENV_LABEL, PROVIDER_ICON, PROVIDER_LABEL } from "./status-pill";

/** Provider → name of the secrets field carrying the primary credential
 *  (mirrors core `rotation.ts` PRIMARY_FIELD). */
const SECRET_FIELD: Record<string, string> = {
  coolify: "apiToken",
  postman: "apiKey",
  epodsystem: "apiKey",
};

const SECRET_PLACEHOLDER: Record<string, string> = {
  coolify: "Coolify API token",
  postman: "PMAK-…",
  epodsystem: "crmk_…",
};

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
  const label =
    connection.displayName ?? PROVIDER_LABEL[connection.provider] ?? connection.provider;

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== connection.displayName) {
      update.mutate({ id: connection.id, body: { displayName: next } });
    }
  };

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon
        name={PROVIDER_ICON[connection.provider] ?? "link"}
        size={18}
        className="shrink-0 text-muted"
      />
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
  const secretField = SECRET_FIELD[connection.provider] ?? "apiKey";

  const saveKey = () => {
    const next = key.trim();
    if (next.length < 8) return;
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
      <h3 className="fg-h4">Credential</h3>
      {canManage && (
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
              placeholder={SECRET_PLACEHOLDER[connection.provider] ?? "API key"}
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

/** Per-provider config form. Coolify/Postman are editable; Epodsystem identity
 *  is read-only (the healthcheck fills it from the key). */
function ConfigSection({
  connection,
  canManage,
}: {
  connection: ConnectionSummary;
  canManage: boolean;
}) {
  const update = useUpdateConnection();
  const cfg = (connection.config ?? {}) as ProviderConfig;

  // Re-seed the form when the drawer switches to another connection.
  const [form, setForm] = useState<ProviderConfig>(cfg);
  const [seededFor, setSeededFor] = useState(connection.id);
  if (connection.id !== seededFor) {
    setForm(cfg);
    setSeededFor(connection.id);
  }

  const set = <K extends keyof ProviderConfig>(k: K, v: ProviderConfig[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  if (connection.provider === "epodsystem") {
    return (
      <section className="flex flex-col gap-2">
        <h3 className="fg-h4">Store</h3>
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          {cfg.storeSlug || cfg.storeName
            ? `${cfg.storeName ?? cfg.storeSlug}${cfg.storeSlug ? ` (${cfg.storeSlug})` : ""}`
            : "Store identity is filled in automatically by a successful Test."}
        </p>
      </section>
    );
  }

  const saveConfig = () => {
    const config: Record<string, unknown> =
      connection.provider === "coolify"
        ? {
            baseUrl: (form.baseUrl ?? "").trim(),
            resourceUuid: (form.resourceUuid ?? "").trim(),
            branch: (form.branch ?? "").trim(),
          }
        : {
            workspaceName: (form.workspaceName ?? "").trim(),
            region: form.region ?? "us",
            mode: form.mode ?? "minimal",
          };
    update.mutate({ id: connection.id, body: { config } });
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="fg-h4">Configuration</h3>
      {connection.provider === "coolify" ? (
        <>
          <Field label="Base URL">
            <Input
              value={form.baseUrl ?? ""}
              onChange={(e) => set("baseUrl", e.target.value)}
              disabled={!canManage}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Resource UUID">
              <Input
                value={form.resourceUuid ?? ""}
                onChange={(e) => set("resourceUuid", e.target.value)}
                disabled={!canManage}
              />
            </Field>
            <Field label="Branch">
              <Input
                value={form.branch ?? ""}
                onChange={(e) => set("branch", e.target.value)}
                disabled={!canManage}
              />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Workspace name" hint="The Postman workspace this connection writes into.">
            <Input
              value={form.workspaceName ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, workspaceName: e.target.value }))}
              disabled={!canManage}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="fg-label">Region</span>
              {canManage ? (
                <SegmentedControl<PostmanRegion>
                  value={form.region ?? "us"}
                  onChange={(v) => setForm((p) => ({ ...p, region: v }))}
                  options={[
                    { value: "us", label: "US" },
                    { value: "eu", label: "EU" },
                  ]}
                />
              ) : (
                <span className="fg-body-sm text-muted">{(form.region ?? "us").toUpperCase()}</span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="fg-label">Mode</span>
              {canManage ? (
                <SegmentedControl<PostmanMode>
                  value={form.mode ?? "minimal"}
                  onChange={(v) => setForm((p) => ({ ...p, mode: v }))}
                  options={[
                    { value: "minimal", label: "Minimal" },
                    { value: "full", label: "Full" },
                  ]}
                />
              ) : (
                <span className="fg-body-sm text-muted">{form.mode ?? "minimal"}</span>
              )}
            </div>
          </div>
        </>
      )}
      {canManage ? (
        <div>
          <Button variant="secondary" size="sm" loading={update.isPending} onClick={saveConfig}>
            Save configuration
          </Button>
        </div>
      ) : (
        <p className="fg-body-sm text-muted">
          Org-shared credential — only an org owner/admin can change it.
        </p>
      )}
    </section>
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
      <h3 className="fg-h4">Projects using it</h3>
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
                  {ENV_LABEL[b.environment] ?? b.environment}
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
      <h3 className="fg-h4">Danger zone</h3>
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
