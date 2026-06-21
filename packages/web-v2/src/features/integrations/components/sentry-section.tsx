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
} from "../types";
import { ConnectionOwnerField } from "./connection-owner-field";

interface FormState {
  authToken: string;
  host: string;
  organizationSlug: string;
  projectSlug: string;
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as Partial<SentryConfig>;
  return {
    authToken: "",
    host: cfg.host ?? "",
    organizationSlug: cfg.organizationSlug ?? "",
    projectSlug: cfg.projectSlug ?? "",
  };
}

/** Build the config payload — omits empty optional slugs so we don't store "". */
function toConfig(f: FormState): SentryConfig {
  const cfg: SentryConfig = { host: f.host.trim() };
  if (f.organizationSlug.trim()) cfg.organizationSlug = f.organizationSlug.trim();
  if (f.projectSlug.trim()) cfg.projectSlug = f.projectSlug.trim();
  return cfg;
}

/**
 * ISS-524 — Sentry integration config form. Reads/writes the per-project
 * `sentry` integration via the REST CRUD endpoints. The auth token is masked,
 * write-only (never returned by the API), and only sent when the operator types
 * a new one. When active, the official `@sentry/mcp-server` MCP tools are
 * auto-injected into every agent/skill running for this project. Test connection
 * validates the token against Sentry `GET /api/0/organizations/`.
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

  const keyRequired = !existing; // a brand-new integration must carry a token
  const hostRequired = !existing || !form.host.trim();
  // Org-shared credential: only an org owner/admin may change config/secrets/
  // active. Test connection stays enabled (binding-level, project admin OK).
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  const canSave =
    form.host.trim().length > 0 &&
    (!keyRequired || form.authToken.trim().length >= 8) &&
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
            Store a Sentry host + auth token. When active, the official Sentry
            MCP tools are auto-injected into every agent/skill running for this
            project so they can read this project's Sentry logs.
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Organization slug"
              hint="Optional — scopes the Sentry org."
            >
              <Input
                value={form.organizationSlug}
                onChange={(e) => set("organizationSlug", e.target.value)}
                placeholder="(optional)"
                disabled={orgLocked}
              />
            </Field>
            <Field label="Project slug" hint="Optional — scopes the Sentry project.">
              <Input
                value={form.projectSlug}
                onChange={(e) => set("projectSlug", e.target.value)}
                placeholder="(optional)"
                disabled={orgLocked}
              />
            </Field>
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
