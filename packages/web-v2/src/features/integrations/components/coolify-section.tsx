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
  type BadgeProps,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { ConnectionOwnerField } from "./connection-owner-field";
import {
  useConfirmProdDeploy,
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useRotateIntegrationSecret,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../hooks";
import type {
  IntegrationEnvironment,
  IntegrationSummary,
  IntegrationTestResult,
  ProviderConfig,
} from "../types";

const ENV_OPTIONS: { value: IntegrationEnvironment; label: string }[] = [
  { value: "staging", label: "Staging" },
  { value: "prod", label: "Production" },
];

interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

function badgeFor(existing: IntegrationSummary | undefined): BadgeView {
  if (!existing) return { label: "Not configured", tone: "amber" };
  if (!existing.active) return { label: "Breaker open", tone: "red" };
  if (existing.lastHealthStatus === "ok") return { label: "Connected", tone: "green" };
  if (existing.lastHealthStatus === "error") return { label: "Last deploy failed", tone: "red" };
  return { label: "Untested", tone: "neutral" };
}

/**
 * ISS-395 — Coolify deploy integration config (ported from the v1
 * `coolify-section.tsx`). Separate staging/prod integrations toggled via a
 * SegmentedControl. Prod requires a manual confirmation gate before every
 * deploy. The inbound HMAC webhook secret is minted server-side and revealed
 * exactly once (on create + on rotate).
 */
export function CoolifySection({ projectId }: { projectId: string }) {
  const [env, setEnv] = useState<IntegrationEnvironment>("staging");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === "coolify"),
    [list.data],
  );
  const existing = useMemo(() => rows.find((i) => i.environment === env), [rows, env]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Coolify deploy</CardTitle>
          <Badge tone={badgeFor(existing).tone}>{badgeFor(existing).label}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <SegmentedControl<IntegrationEnvironment>
            value={env}
            onChange={setEnv}
            options={ENV_OPTIONS}
          />
          {/* Remount the panel per environment so its form state re-seeds. */}
          <EnvironmentPanel
            key={env}
            projectId={projectId}
            environment={env}
            existing={existing}
            onRefetch={() => list.refetch()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface EnvPanelProps {
  projectId: string;
  environment: IntegrationEnvironment;
  existing: IntegrationSummary | undefined;
  onRefetch: () => void;
}

function EnvironmentPanel({ projectId, environment, existing, onRefetch }: EnvPanelProps) {
  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const confirmProd = useConfirmProdDeploy(projectId);
  const rotate = useRotateIntegrationSecret(projectId);

  const cfg = (existing?.config ?? {}) as ProviderConfig;
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? "");
  const [resourceUuid, setResourceUuid] = useState(cfg.resourceUuid ?? "");
  const [branch, setBranch] = useState(cfg.branch ?? "main");
  const [apiToken, setApiToken] = useState("");
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Returned exactly once by create + rotate-secret; the server never re-emits it.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const isProd = environment === "prod";
  const saving = create.isPending || update.isPending;

  async function handleSave() {
    setError(null);
    setRevealedSecret(null);
    setTestResult(null);
    try {
      if (existing) {
        await update.mutateAsync({
          id: existing.id,
          body: {
            config: { baseUrl, resourceUuid, branch },
            ...(apiToken.trim() ? { secrets: { apiToken: apiToken.trim() } } : {}),
          },
        });
      } else {
        if (!apiToken.trim()) {
          setError("API token is required for the first save");
          return;
        }
        const res = await create.mutateAsync({
          provider: "coolify",
          environment,
          config: { baseUrl, resourceUuid, branch },
          secrets: { apiToken: apiToken.trim() },
          ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
        });
        // Surface the auto-minted HMAC secret once — the operator must paste it
        // into Coolify's webhook settings or inbound callbacks fail sig checks.
        setRevealedSecret(res.integrationSecret);
      }
      setApiToken("");
      onRefetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function handleRotate() {
    if (!existing) return;
    if (
      !window.confirm(
        `Rotate the inbound webhook secret for ${environment}? You will need to update Coolify's webhook settings with the new value.`,
      )
    )
      return;
    setError(null);
    try {
      const res = await rotate.mutateAsync(existing.id);
      setRevealedSecret(res.integrationSecret);
      onRefetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function handleTest() {
    if (!existing) return;
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await test.mutateAsync(existing.id));
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  function handleDelete() {
    if (!existing) return;
    if (!window.confirm(`Delete the ${environment} Coolify integration?`)) return;
    remove.mutate(existing.id);
  }

  return (
    <div className={`flex flex-col gap-4 rounded-lg border p-4 ${isProd ? "border-red" : "border-subtle"}`}>
      <p className="fg-body-sm text-muted">
        {isProd
          ? "⚠ Production — manual confirmation gate before every deploy."
          : "Staging — auto-dispatch on release."}
      </p>

      {!existing && (
        <ConnectionOwnerField projectId={projectId} value={ownerOrgId} onChange={setOwnerOrgId} />
      )}
      <Field label="Base URL" required>
        <Input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://coolify.example.com"
        />
      </Field>
      <Field label="Resource UUID" required>
        <Input
          value={resourceUuid}
          onChange={(e) => setResourceUuid(e.target.value)}
          placeholder="application uuid from Coolify"
        />
      </Field>
      <Field label="Branch" required>
        <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
      </Field>
      <Field
        label="API token"
        hint={
          existing
            ? "A token is stored. Leave blank to keep it; enter a new one to rotate."
            : "Coolify API token. Stored encrypted; never shown again."
        }
        required={!existing}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={existing ? "•••••••• (unchanged)" : "Coolify API token"}
        />
      </Field>

      {error && <Banner tone="danger">{error}</Banner>}
      {testResult &&
        (testResult.status === "ok" ? (
          <Banner tone="success">{testResult.message ?? "Connection OK"}</Banner>
        ) : (
          <Banner tone="danger">{testResult.message ?? "Connection failed"}</Banner>
        ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={handleSave} loading={saving}>
          {existing ? "Save" : "Create integration"}
        </Button>
        {existing && (
          <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
            Test connection
          </Button>
        )}
        {existing && (
          <Button variant="secondary" onClick={handleRotate} loading={rotate.isPending}>
            Rotate webhook secret
          </Button>
        )}
        {existing && (
          <Button variant="danger" icon="trash" loading={remove.isPending} onClick={handleDelete}>
            Delete
          </Button>
        )}
      </div>

      {revealedSecret && (
        <SecretRevealBanner secret={revealedSecret} onDismiss={() => setRevealedSecret(null)} />
      )}

      {existing && <WebhookHint integrationSecretSet={existing.integrationSecretSet} />}

      {isProd && existing && (
        <ProdConfirmBanner
          integrationId={existing.id}
          pending={confirmProd.isPending}
          onConfirm={() => confirmProd.mutate(existing.id)}
        />
      )}
    </div>
  );
}

function SecretRevealBanner({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable (insecure context); leave it on screen.
    }
  }
  return (
    <Banner tone="attention">
      <div className="flex flex-col gap-2">
        <span className="fg-label">Webhook signing secret — shown once</span>
        <span className="fg-body-sm">
          Copy this value into Coolify&apos;s webhook settings as the HMAC secret. Forge will not
          show it again — rotate to issue a new one.
        </span>
        <code className="block break-all rounded bg-sunken p-2 font-mono text-[11px]">{secret}</code>
        <div className="flex gap-2">
          <Button size="sm" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="secondary" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Banner>
  );
}

function WebhookHint({ integrationSecretSet }: { integrationSecretSet: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Inbound webhook</span>
      <span className="fg-body-sm">
        Point Coolify at: <code className="font-mono">/api/webhooks/in/&lt;project-slug&gt;</code>
      </span>
      <span className="fg-body-sm">
        Signature header: <code className="font-mono">X-Coolify-Signature-256</code> (sha256=…)
      </span>
      {!integrationSecretSet && (
        <span className="fg-body-sm text-red">
          Signing secret missing — save this integration to mint one, then paste it into Coolify.
        </span>
      )}
    </div>
  );
}

function ProdConfirmBanner({
  integrationId,
  pending,
  onConfirm,
}: {
  integrationId: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Banner tone="attention">
      <div className="flex flex-col gap-2">
        <span className="fg-label">Production approval gate</span>
        <span className="fg-body-sm">
          Production deploys never auto-dispatch. Click confirm when ready to release the gate for
          an in-flight pipeline run.
        </span>
        <div>
          <Button size="sm" loading={pending} onClick={onConfirm}>
            Confirm production deploy
          </Button>
        </div>
        <span className="font-mono text-[10px] text-subtle">integration: {integrationId}</span>
      </div>
    </Banner>
  );
}
