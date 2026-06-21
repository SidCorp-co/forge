"use client";

import {
  Badge,
  type BadgeProps,
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
import {
  isFeatureOff,
  usePipelineConfig,
  useUpdatePipelineConfig,
} from "@/features/project-settings/hooks";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import { ConnectionOwnerField } from "./connection-owner-field";
import { ENV_OPTIONS } from "./status-pill";
import {
  useConfirmProdDeploy,
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useOrgConnectionLocked,
  useRotateIntegrationSecret,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../hooks";
import type {
  CoolifyTargetInput,
  IntegrationEnvironment,
  IntegrationSummary,
  IntegrationTestResult,
  ProviderConfig,
} from "../types";

interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

function badgeFor(existing: IntegrationSummary | undefined): BadgeView {
  if (!existing) return { label: "Not configured", tone: "amber" };
  if (!existing.active) return { label: "Breaker open", tone: "red" };
  if (existing.lastHealthStatus === "ok")
    return { label: "Connected", tone: "green" };
  if (existing.lastHealthStatus === "error")
    return { label: "Last deploy failed", tone: "red" };
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
  const existing = useMemo(
    () => rows.find((i) => i.environment === env),
    [rows, env],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Coolify deploy</CardTitle>
          <Badge tone={badgeFor(existing).tone}>
            {badgeFor(existing).label}
          </Badge>
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

function EnvironmentPanel({
  projectId,
  environment,
  existing,
  onRefetch,
}: EnvPanelProps) {
  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const confirmProd = useConfirmProdDeploy(projectId);
  const rotate = useRotateIntegrationSecret(projectId);

  const cfg = (existing?.config ?? {}) as ProviderConfig;
  const seedTargets = (): CoolifyTargetInput[] =>
    cfg.targets && cfg.targets.length > 0
      ? cfg.targets.map((t) => ({ id: t.id, label: t.label, resourceUuid: t.resourceUuid }))
      : [{ label: "", resourceUuid: "" }];
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? "");
  const [targets, setTargets] = useState<CoolifyTargetInput[]>(seedTargets);
  const [apiToken, setApiToken] = useState("");
  // The panel mounts before the list query resolves (key={env} only remounts on
  // env switches), so re-seed the form when the existing row arrives — without
  // this the fields stay blank over a configured integration and a Save would
  // wipe its config with empty values.
  const [seededFor, setSeededFor] = useState(existing?.id ?? null);
  if ((existing?.id ?? null) !== seededFor) {
    setSeededFor(existing?.id ?? null);
    setBaseUrl(cfg.baseUrl ?? "");
    setTargets(seedTargets());
  }
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Returned exactly once by create + rotate-secret; the server never re-emits it.
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const isProd = environment === "prod";
  const saving = create.isPending || update.isPending;
  // Org-shared credential: only an org owner/admin may change the CONNECTION
  // tier (base URL + token). The deploy target (resourceUuid/branch) is
  // binding-tier and stays editable by a project admin, as do Test + Delete.
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  // True when this project has no binding-level targets of its own and the
  // values shown are inherited off the shared connection's config.
  const bindingCfg = (existing?.bindingConfig ?? {}) as ProviderConfig;
  const targetsInherited = Boolean(
    existing && !(bindingCfg.targets && bindingCfg.targets.length > 0) && cfg.targets?.length,
  );

  function updateTarget(idx: number, patch: Partial<CoolifyTargetInput>) {
    setTargets((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }
  function addTarget() {
    setTargets((prev) => [...prev, { label: "", resourceUuid: "" }]);
  }
  function removeTarget(idx: number) {
    setTargets((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  async function handleSave() {
    setError(null);
    setRevealedSecret(null);
    setTestResult(null);
    const cleanTargets = targets
      .map((t) => ({
        ...(t.id ? { id: t.id } : {}),
        label: t.label.trim(),
        resourceUuid: t.resourceUuid.trim(),
      }))
      .filter((t) => t.label && t.resourceUuid);
    if (cleanTargets.length === 0) {
      setError("Add at least one deploy target (label + resource UUID).");
      return;
    }
    try {
      if (existing) {
        // `targets` is binding-tier (per project) — always sendable by a project
        // admin. baseUrl + token are connection-tier (shared) and org-gated, so
        // an org-locked save must not include them (403).
        const config: Record<string, unknown> = { targets: cleanTargets };
        if (!orgLocked && baseUrl.trim()) config.baseUrl = baseUrl.trim();
        await update.mutateAsync({
          id: existing.id,
          body: {
            config,
            ...(apiToken.trim() && !orgLocked
              ? { secrets: { apiToken: apiToken.trim() } }
              : {}),
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
          config: { baseUrl, targets: cleanTargets },
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
    if (!window.confirm(`Delete the ${environment} Coolify integration?`))
      return;
    remove.mutate(existing.id);
  }

  return (
    <div
      className={`flex flex-col gap-4 rounded-lg border p-4 ${isProd ? "border-red" : "border-subtle"}`}
    >
      <p className="fg-body-sm text-muted">
        {isProd
          ? "⚠ Production — manual confirmation gate before every deploy."
          : "Staging — auto-dispatch on release."}
      </p>

      {/* ── Section 1: SHARED CREDENTIAL (connection-tier) ─────────────── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-subtle bg-sunken/40 p-3">
        <legend className="fg-label px-1 text-subtle">
          Coolify server · shared credential
        </legend>
        <p className="fg-body-sm text-muted">
          One Coolify server + API token, reused by every project bound to this
          connection. Forge calls it to trigger deploys (Forge → Coolify).
        </p>
        {!existing && (
          <ConnectionOwnerField
            projectId={projectId}
            value={ownerOrgId}
            onChange={setOwnerOrgId}
          />
        )}
        <Field label="Base URL" required>
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://coolify.example.com"
            disabled={orgLocked}
          />
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
            disabled={orgLocked}
          />
        </Field>
        {orgLocked && (
          <p className="fg-body-sm text-muted">
            Org-shared credential — only an org owner/admin can change the base
            URL or API token. The deploy targets below are yours to configure per
            project.
          </p>
        )}
      </fieldset>

      {/* ── Section 2: DEPLOY TARGETS (binding-tier, per project+env) ───── */}
      <fieldset className="flex flex-col gap-3 rounded-md border border-subtle p-3">
        <legend className="fg-label px-1 text-subtle">
          Deploy targets · this project · {environment}
        </legend>
        <p className="fg-body-sm text-muted">
          The Coolify application(s) this project deploys for {environment}. Add
          one row per app — e.g. a separate backend and frontend; they deploy
          together and the pipeline only completes once all succeed.
          {targetsInherited
            ? " Currently inherited from the shared connection — saving stores project-level targets."
            : ""}
        </p>
        {targets.map((t, idx) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional + reorder-free
            key={t.id ?? idx}
            className="flex items-end gap-2"
          >
            <div className="w-40 shrink-0">
              {idx === 0 && <span className="fg-label mb-1 block text-subtle">Label</span>}
              <Input
                value={t.label}
                onChange={(e) => updateTarget(idx, { label: e.target.value })}
                placeholder="Backend"
              />
            </div>
            <div className="flex-1">
              {idx === 0 && (
                <span className="fg-label mb-1 block text-subtle">Resource UUID</span>
              )}
              <Input
                value={t.resourceUuid}
                onChange={(e) => updateTarget(idx, { resourceUuid: e.target.value })}
                placeholder="application uuid from Coolify"
              />
            </div>
            <Button
              variant="ghost"
              icon="trash"
              aria-label="Remove target"
              disabled={targets.length <= 1}
              onClick={() => removeTarget(idx)}
            />
          </div>
        ))}
        <div>
          <Button variant="secondary" size="sm" icon="plus" onClick={addTarget}>
            Add target
          </Button>
        </div>
      </fieldset>

      {error && <Banner tone="danger">{error}</Banner>}
      {testResult &&
        (testResult.status === "ok" ? (
          <Banner tone="success">
            {testResult.message ?? "Connection OK"}
          </Banner>
        ) : (
          <Banner tone="danger">
            {testResult.message ?? "Connection failed"}
          </Banner>
        ))}

      <div className="flex flex-wrap items-center gap-3">
        {/* Save stays enabled under orgLocked — it then writes only the
            binding-tier deploy target, which a project admin may change. */}
        <Button variant="primary" onClick={handleSave} loading={saving}>
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
        {existing && (
          <Button
            variant="secondary"
            onClick={handleRotate}
            loading={rotate.isPending}
            disabled={orgLocked}
          >
            Rotate webhook secret
          </Button>
        )}
        {existing && (
          <Button
            variant="danger"
            icon="trash"
            loading={remove.isPending}
            onClick={handleDelete}
          >
            Delete
          </Button>
        )}
      </div>

      {revealedSecret && (
        <SecretRevealBanner
          secret={revealedSecret}
          onDismiss={() => setRevealedSecret(null)}
        />
      )}

      {existing && (
        <WebhookHint integrationSecretSet={existing.integrationSecretSet} />
      )}

      {isProd && existing && (
        <ProdGateSection
          projectId={projectId}
          integrationId={existing.id}
          confirmPending={confirmProd.isPending}
          onConfirm={() => confirmProd.mutate(existing.id)}
        />
      )}
    </div>
  );
}

/**
 * ISS-529 — per-project control over the production approval gate. Surfaces the
 * existing `pipelineConfig.autoProdDeploy` flag as a toggle (read/written via
 * the pipeline-config PATCH). `checked` is derived straight from the query so a
 * failed save auto-reverts (the mutation hook only writes the cache on success
 * and raises its own success/error toasts).
 *
 * - autoProd ON  → prod deploys dispatch automatically on release; the manual
 *   "Confirm production deploy" button is hidden (it would be a no-op) and an
 *   info banner reflects the auto-approve state.
 * - autoProd OFF (default) → the existing manual confirm gate is unchanged.
 *
 * When pipeline control is disabled (FEATURE_OFF) the toggle is replaced by a
 * muted note and the manual gate stays in place — never a broken/dead control.
 */
function ProdGateSection({
  projectId,
  integrationId,
  confirmPending,
  onConfirm,
}: {
  projectId: string;
  integrationId: string;
  confirmPending: boolean;
  onConfirm: () => void;
}) {
  const cfgQ = usePipelineConfig(projectId);
  const update = useUpdatePipelineConfig(projectId);

  const featureOff = cfgQ.isError && isFeatureOff(cfgQ.error);
  // Default OFF: only an explicit `=== true` enables auto-approve — a missing
  // flag (or any read error) must never auto-deploy a project to prod.
  const autoProd = cfgQ.data?.pipelineConfig?.autoProdDeploy === true;

  function handleToggle(next: boolean) {
    if (!cfgQ.data) return;
    // Spread the full current config — the PATCH persists the whole object, so
    // sending a partial would clobber every other pipeline key.
    update.mutate({ ...cfgQ.data.pipelineConfig, autoProdDeploy: next });
  }

  return (
    <div className="flex flex-col gap-3">
      {featureOff ? (
        <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
          <span className="fg-label text-subtle">Production approval gate</span>
          <span className="fg-body-sm text-muted">
            Pipeline control is disabled for this project, so auto-approve
            can&apos;t be configured here. Production deploys stay behind the
            manual gate below.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="fg-label text-subtle">
              Auto-approve production deploys
            </span>
            <Toggle
              checked={autoProd}
              onChange={handleToggle}
              disabled={update.isPending || cfgQ.isLoading || !cfgQ.data}
              aria-label="Auto-approve production deploys"
            />
          </div>
          <span className="fg-body-sm text-muted">
            When on, production deploys dispatch automatically on release —
            skipping the manual approval gate. Off (default) keeps the manual
            gate. Applies to this project.
          </span>
        </div>
      )}

      {autoProd ? (
        <Banner tone="success">
          <div className="flex flex-col gap-1">
            <span className="fg-label">Production approval gate · off</span>
            <span className="fg-body-sm">
              Auto-approve is enabled — production deploys dispatch automatically
              on release, like staging. No manual confirmation required.
            </span>
            <span className="font-mono text-[10px] text-subtle">
              integration: {integrationId}
            </span>
          </div>
        </Banner>
      ) : (
        <ProdConfirmBanner
          integrationId={integrationId}
          pending={confirmPending}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}

function SecretRevealBanner({
  secret,
  onDismiss,
}: { secret: string; onDismiss: () => void }) {
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
          Copy this value into Coolify&apos;s webhook settings as the HMAC
          secret. Forge will not show it again — rotate to issue a new one.
        </span>
        <code className="block break-all rounded bg-sunken p-2 font-mono text-[11px]">
          {secret}
        </code>
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

function WebhookHint({
  integrationSecretSet,
}: { integrationSecretSet: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Inbound webhook</span>
      <span className="fg-body-sm">
        Point Coolify at:{" "}
        <code className="font-mono">/api/webhooks/in/&lt;project-slug&gt;</code>
      </span>
      <span className="fg-body-sm">
        Signature header:{" "}
        <code className="font-mono">X-Coolify-Signature-256</code> (sha256=…)
      </span>
      {!integrationSecretSet && (
        <span className="fg-body-sm text-red">
          Signing secret missing — save this integration to mint one, then paste
          it into Coolify.
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
          Production deploys never auto-dispatch. Click confirm when ready to
          release the gate for an in-flight pipeline run.
        </span>
        <div>
          <Button size="sm" loading={pending} onClick={onConfirm}>
            Confirm production deploy
          </Button>
        </div>
        <span className="font-mono text-[10px] text-subtle">
          integration: {integrationId}
        </span>
      </div>
    </Banner>
  );
}
