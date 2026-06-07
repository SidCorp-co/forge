"use client";

import { useMemo, useState } from "react";
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
  SegmentedControl,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../hooks";
import type {
  IntegrationSummary,
  IntegrationTestResult,
  PostmanConfig,
  PostmanMode,
  PostmanRegion,
} from "../types";

const DEFAULT_WORKSPACE = "Forge Integration";

interface FormState {
  apiKey: string;
  workspaceName: string;
  workspaceId: string;
  collectionId: string;
  region: PostmanRegion;
  mode: PostmanMode;
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as Partial<PostmanConfig>;
  return {
    apiKey: "",
    workspaceName: cfg.workspaceName ?? DEFAULT_WORKSPACE,
    workspaceId: cfg.workspaceId ?? "",
    collectionId: cfg.collectionId ?? "",
    region: cfg.region ?? "us",
    mode: cfg.mode ?? "minimal",
  };
}

/** Build the config payload — omits empty optional ids so we don't store "". */
function toConfig(f: FormState): PostmanConfig {
  const cfg: PostmanConfig = {
    workspaceName: f.workspaceName.trim() || DEFAULT_WORKSPACE,
    region: f.region,
    mode: f.mode,
  };
  if (f.workspaceId.trim()) cfg.workspaceId = f.workspaceId.trim();
  if (f.collectionId.trim()) cfg.collectionId = f.collectionId.trim();
  return cfg;
}

/**
 * ISS-336 — Postman integration config form. Reads/writes the per-project
 * `postman` integration via the REST CRUD endpoints. The API key is masked,
 * write-only (never returned by the API), and only sent when the operator
 * types a new one. Test connection validates the key against Postman `GET /me`.
 */
export function PostmanSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === "postman"),
    [list.data],
  );

  const create = useCreateProviderIntegration(projectId);
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

  const keyRequired = !existing; // a brand-new integration must carry a key
  const canSave = (!keyRequired || form.apiKey.trim().length >= 8) && !create.isPending && !update.isPending;

  async function handleSave() {
    setTestResult(null);
    setTestError(null);
    if (existing) {
      await update.mutateAsync({
        id: existing.id,
        body: {
          config: toConfig(form),
          ...(form.apiKey.trim() ? { secrets: { apiKey: form.apiKey.trim() } } : {}),
        },
      });
      setForm((f) => ({ ...f, apiKey: "" }));
    } else {
      await create.mutateAsync({
        provider: "postman",
        environment: "prod",
        config: toConfig(form),
        secrets: { apiKey: form.apiKey.trim() },
      });
      setForm((f) => ({ ...f, apiKey: "" }));
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

  const testUser = testResult?.diagnostics?.user;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Postman</CardTitle>
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
            Store a Postman API key + write-target. When active, the official Postman MCP tools
            are auto-injected into every agent/skill running for this project.
          </p>

          <Field
            label="API key"
            hint={
              existing
                ? "A key is stored. Leave blank to keep it; enter a new one to rotate."
                : "Postman API key (PMAK-…). Stored encrypted; never shown again."
            }
            required={keyRequired}
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder={existing ? "•••••••• (unchanged)" : "PMAK-…"}
              value={form.apiKey}
              onChange={(e) => set("apiKey", e.target.value)}
            />
          </Field>

          <Field label="Workspace name" hint="The Postman workspace this project writes into.">
            <Input
              value={form.workspaceName}
              onChange={(e) => set("workspaceName", e.target.value)}
              placeholder={DEFAULT_WORKSPACE}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Workspace ID" hint="Optional — the workspace UUID.">
              <Input
                value={form.workspaceId}
                onChange={(e) => set("workspaceId", e.target.value)}
                placeholder="(optional)"
              />
            </Field>
            <Field label="Collection ID" hint="Optional — the collection to write.">
              <Input
                value={form.collectionId}
                onChange={(e) => set("collectionId", e.target.value)}
                placeholder="(optional)"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="fg-label">Region</span>
              <SegmentedControl<PostmanRegion>
                value={form.region}
                onChange={(v) => set("region", v)}
                options={[
                  { value: "us", label: "US" },
                  { value: "eu", label: "EU" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="fg-label">Mode</span>
              <SegmentedControl<PostmanMode>
                value={form.mode}
                onChange={(v) => set("mode", v)}
                options={[
                  { value: "minimal", label: "Minimal" },
                  { value: "full", label: "Full" },
                ]}
              />
            </div>
          </div>

          {testError && <Banner tone="danger">{testError}</Banner>}
          {testResult &&
            (testResult.status === "ok" ? (
              <Banner tone="success">
                Connected{testUser?.username ? ` as ${testUser.username}` : ""}
                {testUser?.email ? ` (${testUser.email})` : ""}.
              </Banner>
            ) : (
              <Banner tone="danger">{testResult.message ?? "Connection failed"}</Banner>
            ))}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-3">
              <Button variant="primary" onClick={handleSave} loading={create.isPending || update.isPending} disabled={!canSave}>
                {existing ? "Save" : "Create integration"}
              </Button>
              {existing && (
                <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
                  Test connection
                </Button>
              )}
            </div>
            {existing && (
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">
                  <span className="fg-body-sm text-muted">Enabled</span>
                  <Toggle checked={existing.active} onChange={handleToggleActive} />
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
