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
  PageSectionTitle,
  Divider,
  ErrorState,
  Field,
  Icon,
  Input,
  Skeleton,
  SlideOver,
  statusReading,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage, useTimeFormat } from "@/lib/i18n/interface-language";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import {
  useCanManageConnection,
  useConnectionBindings,
  useRemoveConnection,
  useTestConnection,
  useUpdateConnection,
} from "../hooks";
import { ConnectionReleaseRunnerField } from "./release-runner-field";
import { PROVIDER_MODULES, providerIcon, providerLabel, providerModule, secretPlaceholderOf } from "../providers/registry";
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
  const t = useCopy();
  const language = useInterfaceLanguage();
  const label = connection.displayName ?? providerLabel(connection.provider, language);

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
            aria-label={t("integrations.edit.name")}
            className="w-52"
          />
          <Button variant="secondary" size="sm" loading={update.isPending} onClick={save}>
            {t("integrations.edit.save")}
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
              {t("integrations.edit.rename")}
            </Button>
          )}
        </>
      )}
      <DirectoryStatusPill status={connection.directoryStatus} />
      {connection.ownerType === "org" && (
        <span className="fg-body-sm shrink-0 rounded-pill bg-sunken px-2 py-0.5 text-subtle">
          {t("integrations.detail.orgShared")}
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

  const t = useCopy();
  const language = useInterfaceLanguage();
  const time = useTimeFormat();
  const checked = time.relative(connection.lastHealthAt);
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
      <PageSectionTitle>{t("integrations.edit.credential")}</PageSectionTitle>
      {canManage && secretField === null && (
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          {module?.connectionNote
            ? t(module.connectionNote)
            : t("integrations.edit.notByHand", { provider: providerLabel(connection.provider, language) })}
        </p>
      )}
      {canManage && secretField !== null && (
        <Field
          label={t("integrations.edit.replaceKey")}
          hint={connection.hasSecrets ? t("integrations.edit.keyStored") : t("integrations.edit.noKey")}
        >
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              placeholder={secretPlaceholderOf(connection.provider, language) ?? t("integrations.edit.apiKey")}
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
              {t("integrations.edit.saveKey")}
            </Button>
          </div>
        </Field>
      )}
      <div className="flex items-center gap-3">
        {canManage && (
          <Button variant="secondary" size="sm" loading={test.isPending} onClick={runTest}>
            {t("integrations.edit.test")}
          </Button>
        )}
        <span className="fg-body-sm text-muted">
          {connection.lastHealthStatus
            ? `${t("integrations.row.lastHealth", { status: statusReading("connection", connection.lastHealthStatus, language).label })}${checked ? ` · ${checked}` : ""}`
            : t("integrations.row.neverChecked")}
          {!connection.hasSecrets && ` · ${t("integrations.row.noCredential")}`}
        </span>
      </div>
      {testResult && (
        <Banner tone={testResult.status === "ok" ? "success" : "danger"}>
          {testResult.status === "ok"
            ? t("integrations.edit.healthy")
            : t("integrations.edit.testFailed", { status: statusReading("connection", testResult.status, language).label })}
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
  const t = useCopy();
  const language = useInterfaceLanguage();

  if (!Section) {
    return (
      <section className="flex flex-col gap-2">
        <PageSectionTitle>{t("integrations.detail.config")}</PageSectionTitle>
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          {module?.connectionNote
            ? t(module.connectionNote)
            : t("integrations.edit.noConfig", { provider: providerLabel(connection.provider, language) })}
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
  const t = useCopy();
  const byId = useMemo(() => {
    const map = new Map<string, ProjectListItem>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  return (
    <section className="flex flex-col gap-2">
      <PageSectionTitle>{t("integrations.edit.projectsUsing")}</PageSectionTitle>
      {bindingsLoading ? (
        <Skeleton className="h-8 w-full" />
      ) : bindingsError ? (
        <ErrorState message={bindingsError} onRetry={onRetry} />
      ) : bindings.length === 0 ? (
        <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
          {t("integrations.edit.noProjects")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          {bindings.map((b) => {
            const project = byId.get(b.projectId);
            const archived = Boolean(project?.archivedAt);
            const row = (
              <>
                <span className="truncate text-fg">{project?.name ?? b.projectId}</span>
                <span className="fg-body-sm text-muted">
                  {scopeLabel(b.role, t)}
                </span>
                {archived && (
                  <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    {t("integrations.edit.archived")}
                  </span>
                )}
                {!b.active && (
                  <span className="fg-body-sm ml-auto rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                    {t("integrations.edit.bindingDisabled")}
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
                    href={`/projects/${project.slug}/settings?tab=connections#integrations`}
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
      {connection.ownerType === "org" && (
        <p className="fg-body-sm text-muted">
          {t("integrations.edit.orgSharedNote")}
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
  const t = useCopy();

  return (
    <section className="flex flex-col gap-3">
      <PageSectionTitle>{t("integrations.edit.danger")}</PageSectionTitle>
      <div className="flex items-center gap-2">
        {connection.active ? (
          <Button
            variant="ghost"
            size="sm"
            loading={update.isPending}
            onClick={() => update.mutate({ id: connection.id, body: { active: false } })}
          >
            {t("integrations.row.disable")}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            onClick={() => update.mutate({ id: connection.id, body: { active: true } })}
          >
            {t("integrations.row.enable")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setConfirming((v) => !v)}>
          {t("integrations.edit.removeOpen")}
        </Button>
      </div>
      {confirming && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken px-3 py-2.5">
          <p className="fg-body-sm text-fg">
            {affectedProjects.length === 0
              ? t("integrations.edit.removeNone")
              : t(affectedProjects.length === 1 ? "integrations.edit.removeOne" : "integrations.edit.removeMany", {
                  n: affectedProjects.length,
                  list: affectedProjects.join(", "),
                })}{" "}
            {t("integrations.edit.staysListed")}
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
              {t("integrations.edit.remove")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
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
        {/* ISS-1275 — the connection tier of the release runner label. It renders
            itself away unless some project binds this credential as a LIVE deploy
            target, which is the only place the label decides anything. */}
        <ConnectionReleaseRunnerField
          connection={connection}
          bindings={bindings}
          canManage={canManage}
        />
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
