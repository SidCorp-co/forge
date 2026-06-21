"use client";

import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useOrgConnectionLocked,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../hooks";
import type {
  IntegrationSummary,
  IntegrationTestResult,
  SentryConfig,
  SentryTarget,
} from "../types";
import { ConnectionOwnerField } from "./connection-owner-field";

/** Editable Sentry target row — strings only so inputs stay controlled. */
interface TargetRow {
  label: string;
  organizationSlug: string;
  projectSlug: string;
  environment: string;
  notes: string;
}

interface FormState {
  authToken: string;
  host: string;
  targets: TargetRow[];
}

const emptyRow = (): TargetRow => ({
  label: "",
  organizationSlug: "",
  projectSlug: "",
  environment: "",
  notes: "",
});

/** Seed the editable rows from the stored config — `targets[]` if present, else
 *  the legacy single-slug pair as one row, else a single blank starter row. */
function initialTargets(cfg: Partial<SentryConfig>): TargetRow[] {
  if (Array.isArray(cfg.targets) && cfg.targets.length > 0) {
    return cfg.targets.map((t) => ({
      label: t.label ?? "",
      organizationSlug: t.organizationSlug ?? "",
      projectSlug: t.projectSlug ?? "",
      environment: t.environment ?? "",
      notes: t.notes ?? "",
    }));
  }
  if (cfg.organizationSlug || cfg.projectSlug) {
    return [
      {
        ...emptyRow(),
        label: "default",
        organizationSlug: cfg.organizationSlug ?? "",
        projectSlug: cfg.projectSlug ?? "",
      },
    ];
  }
  return [emptyRow()];
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as Partial<SentryConfig>;
  return {
    authToken: "",
    host: cfg.host ?? "",
    targets: initialTargets(cfg),
  };
}

/** A row carrying any data but no label — must be fixed before save. */
function rowInvalid(t: TargetRow): boolean {
  const hasContent =
    t.organizationSlug.trim() ||
    t.projectSlug.trim() ||
    t.environment.trim() ||
    t.notes.trim();
  return !t.label.trim() && Boolean(hasContent);
}

/** A row with nothing at all — silently dropped, never persisted. */
function rowBlank(t: TargetRow): boolean {
  return (
    !t.label.trim() &&
    !t.organizationSlug.trim() &&
    !t.projectSlug.trim() &&
    !t.environment.trim() &&
    !t.notes.trim()
  );
}

/** Build the config payload — drops blank rows and trims, omitting empties. */
function toConfig(f: FormState): SentryConfig {
  const targets: SentryTarget[] = f.targets
    .filter((t) => !rowBlank(t))
    .map((t) => {
      const out: SentryTarget = { label: t.label.trim() };
      if (t.organizationSlug.trim()) out.organizationSlug = t.organizationSlug.trim();
      if (t.projectSlug.trim()) out.projectSlug = t.projectSlug.trim();
      if (t.environment.trim()) out.environment = t.environment.trim();
      if (t.notes.trim()) out.notes = t.notes.trim();
      return out;
    });
  return { host: f.host.trim(), targets };
}

/**
 * ISS-524 / ISS-526 — Sentry integration config form. Reads/writes the
 * per-project `sentry` integration via the REST CRUD endpoints. One connection
 * (host + masked, write-only auth token) maps to a LIST of labelled targets
 * (backend / frontend / mobile …) — each with optional org/project slug,
 * environment label and notes. When active, the official `@sentry/mcp-server`
 * MCP tools are auto-injected into every agent/skill for this project and the
 * target list is surfaced in the agent's prompt so it queries the right
 * org/project. Test connection validates the token against Sentry
 * `GET /api/0/organizations/`.
 */
export function SentrySection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === "sentry"),
    [list.data],
  );

  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);

  // Re-seed the form whenever the loaded integration identity changes.
  const [form, setForm] = useState<FormState>(() => initialForm(existing));
  const [seededFor, setSeededFor] = useState<string | null>(existing?.id ?? null);
  if ((existing?.id ?? null) !== seededFor) {
    setForm(initialForm(existing));
    setSeededFor(existing?.id ?? null);
  }

  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setTarget = (index: number, key: keyof TargetRow, value: string) =>
    setForm((f) => ({
      ...f,
      targets: f.targets.map((t, i) => (i === index ? { ...t, [key]: value } : t)),
    }));
  const addTarget = () =>
    setForm((f) => ({ ...f, targets: [...f.targets, emptyRow()] }));
  const removeTarget = (index: number) =>
    setForm((f) => ({ ...f, targets: f.targets.filter((_, i) => i !== index) }));

  const keyRequired = !existing; // a brand-new integration must carry a token
  const hostRequired = !existing || !form.host.trim();
  const hasInvalidTarget = form.targets.some(rowInvalid);
  // Org-shared credential: only an org owner/admin may change config/secrets/
  // active. Test connection stays enabled (binding-level, project admin OK).
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  const canSave =
    form.host.trim().length > 0 &&
    (!keyRequired || form.authToken.trim().length >= 8) &&
    !hasInvalidTarget &&
    !create.isPending &&
    !update.isPending &&
    !orgLocked;

  async function handleSave() {
    setTestResult(null);
    setTestError(null);
    if (existing) {
      await update.mutateAsync({
        id: existing.id,
        body: {
          config: toConfig(form),
          ...(form.authToken.trim()
            ? { secrets: { authToken: form.authToken.trim() } }
            : {}),
        },
      });
      setForm((f) => ({ ...f, authToken: "" }));
    } else {
      await create.mutateAsync({
        provider: "sentry",
        environment: "prod",
        config: toConfig(form),
        secrets: { authToken: form.authToken.trim() },
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
      setForm((f) => ({ ...f, authToken: "" }));
    }
  }

  async function handleTest() {
    if (!existing) return;
    setTestResult(null);
    setTestError(null);
    try {
      const res = await test.mutateAsync(existing.id);
      setTestResult(res);
    } catch (err) {
      setTestError(formatApiError(err));
    }
  }

  async function handleToggleActive(active: boolean) {
    if (!existing) return;
    await update.mutateAsync({ id: existing.id, body: { active } });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Sentry</CardTitle>
          {existing && (
            <Badge tone={existing.active ? "green" : "neutral"}>
              {existing.active ? "Active" : "Disabled"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="fg-body-sm text-muted">
            Store one Sentry host + auth token, then register every Sentry
            project it can read (e.g. backend, frontend, mobile). When active,
            the official Sentry MCP tools are auto-injected into every agent for
            this project and the target list below is shared with them so they
            query the right org/project.
          </p>

          <Field
            label="Sentry host"
            hint="The Sentry instance host without scheme, e.g. logs.canawan.com or sentry.io."
            required={hostRequired}
          >
            <Input
              value={form.host}
              onChange={(e) => set("host", e.target.value)}
              placeholder="logs.canawan.com"
              disabled={orgLocked}
            />
          </Field>

          <Field
            label="Auth token"
            hint={
              existing
                ? "A token is stored. Leave blank to keep it; enter a new one to rotate."
                : "Sentry user auth token (sntryu-…). Stored encrypted; never shown again."
            }
            required={keyRequired}
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder={existing ? "•••••••• (unchanged)" : "sntryu_…"}
              value={form.authToken}
              onChange={(e) => set("authToken", e.target.value)}
              disabled={orgLocked}
            />
          </Field>

          {orgLocked && (
            <p className="fg-body-sm text-muted">
              Org-shared credential — only an org owner/admin can change it.
            </p>
          )}

          {!existing && (
            <ConnectionOwnerField
              projectId={projectId}
              value={ownerOrgId}
              onChange={setOwnerOrgId}
            />
          )}

          {/* ISS-526 — repeatable target rows. One shared token reads them all. */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <span className="fg-label text-muted">Sentry projects</span>
              <Button
                variant="secondary"
                icon="plus"
                onClick={addTarget}
                disabled={orgLocked}
              >
                Add project
              </Button>
            </div>

            {form.targets.length === 0 ? (
              <p className="fg-body-sm text-muted rounded-md border border-dashed border-subtle p-4 text-center">
                No Sentry projects registered yet. Add one (e.g. “Backend” →
                org/project slug) so agents know which Sentry project to query.
              </p>
            ) : (
              form.targets.map((t, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; order is the identity
                  key={i}
                  className="flex flex-col gap-3 rounded-md border border-subtle p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="fg-label text-muted">
                      Project {i + 1}
                    </span>
                    <Button
                      variant="ghost"
                      icon="trash"
                      onClick={() => removeTarget(i)}
                      disabled={orgLocked}
                      aria-label={`Remove project ${i + 1}`}
                    />
                  </div>
                  <Field
                    label="Label"
                    hint="A name the agent recognizes, e.g. Backend prod."
                    required
                    error={
                      rowInvalid(t)
                        ? "A label is required for this project."
                        : undefined
                    }
                  >
                    <Input
                      value={t.label}
                      onChange={(e) => setTarget(i, "label", e.target.value)}
                      placeholder="Backend prod"
                      disabled={orgLocked}
                    />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Organization slug" hint="Optional — scopes the Sentry org.">
                      <Input
                        value={t.organizationSlug}
                        onChange={(e) =>
                          setTarget(i, "organizationSlug", e.target.value)
                        }
                        placeholder="(optional)"
                        disabled={orgLocked}
                      />
                    </Field>
                    <Field label="Project slug" hint="Optional — scopes the Sentry project.">
                      <Input
                        value={t.projectSlug}
                        onChange={(e) =>
                          setTarget(i, "projectSlug", e.target.value)
                        }
                        placeholder="(optional)"
                        disabled={orgLocked}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Environment"
                    hint="Optional label only (e.g. prod, staging) — not a separate token."
                  >
                    <Input
                      value={t.environment}
                      onChange={(e) => setTarget(i, "environment", e.target.value)}
                      placeholder="(optional)"
                      disabled={orgLocked}
                    />
                  </Field>
                  <Field
                    label="Notes"
                    hint="Optional free text shared with agents (e.g. what lives in this project)."
                  >
                    <Textarea
                      value={t.notes}
                      onChange={(e) => setTarget(i, "notes", e.target.value)}
                      rows={2}
                      placeholder="(optional)"
                      disabled={orgLocked}
                    />
                  </Field>
                </div>
              ))
            )}
          </div>

          {testError && <Banner tone="danger">{testError}</Banner>}
          {testResult &&
            (testResult.status === "ok" ? (
              <Banner tone="success">
                {testResult.message ?? "Connected."}
              </Banner>
            ) : (
              <Banner tone="danger">
                {testResult.message ?? "Connection failed"}
              </Banner>
            ))}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={create.isPending || update.isPending}
                disabled={!canSave}
              >
                {existing ? "Save" : "Create integration"}
              </Button>
              {existing && (
                <Button
                  variant="secondary"
                  onClick={handleTest}
                  loading={test.isPending}
                >
                  Test connection
                </Button>
              )}
            </div>
            {existing && (
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <span className="fg-body-sm text-muted">Enabled</span>
                  <Toggle
                    checked={existing.active}
                    onChange={handleToggleActive}
                    disabled={orgLocked}
                  />
                </label>
                <Button
                  variant="danger"
                  icon="trash"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(existing.id)}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
