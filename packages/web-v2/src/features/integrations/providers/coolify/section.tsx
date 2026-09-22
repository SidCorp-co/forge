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
import { sectionWrite } from "@/features/project-settings/types";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl, agentAccessBody} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { coolify } from "./index";
import { CoolifyTargetsField } from "./targets-field";
import { STAGE_OPTIONS } from "../../components/status-pill";
import {
  useConfirmProdDeploy,
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useOrgConnectionLocked,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../../hooks";
import type {
  CoolifyTargetInput,
  DeployStage,
  IntegrationSummary,
  IntegrationTestResult,
} from "../../types";
import type { CoolifyReadConfig } from "./config";

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

export function CoolifySection({ projectId }: { projectId: string }) {
  const [stage, setStage] = useState<DeployStage>("preview");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === "coolify"),
    [list.data],
  );
  // Every coolify binding serving this stage — a stage may hold more than one
  // and core never picks among them (ISS-1046 rule 3). This panel edits the
  // first; the connection drawer lists them all.
  const existing = useMemo(() => rows.find((i) => i.stages.includes(stage)), [rows, stage]);

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
          <SegmentedControl<DeployStage>
            value={stage}
            onChange={setStage}
            options={STAGE_OPTIONS}
          />
          {/* Remount the panel per stage so its form state re-seeds. */}
          <StagePanel
            key={stage}
            projectId={projectId}
            stage={stage}
            existing={existing}
            onRefetch={() => list.refetch()}
          />
          <LandingDeploySection projectId={projectId} />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * ISS-1152 — the landing deploy is a PROJECT-level opt-in, not a property of
 * the live binding, so it sits outside the stage panel: a project whose only
 * binding is preview still needs it. Default OFF — running the pipeline is not
 * by itself consent to deploy at a moment the project did not choose.
 */
function LandingDeploySection({ projectId }: { projectId: string }) {
  const cfgQ = usePipelineConfig(projectId);
  const update = useUpdatePipelineConfig(projectId);
  if (cfgQ.isError && isFeatureOff(cfgQ.error)) return null;
  const deployOnLanding = cfgQ.data?.pipelineConfig?.deployOnLanding === true;

  function handleToggle(next: boolean) {
    if (!cfgQ.data) return;
    const read = cfgQ.data.pipelineConfig;
    update.mutate(sectionWrite({ deployOnLanding: read.deployOnLanding }, { deployOnLanding: next }));
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="fg-label text-subtle">Deploy when a change lands</span>
        <Toggle
          checked={deployOnLanding}
          onChange={handleToggle}
          disabled={update.isPending || cfgQ.isLoading || !cfgQ.data}
          aria-label="Deploy when a change lands"
        />
      </div>
      <span className="fg-body-sm text-muted">
        When on, a deploy dispatches as soon as a change lands, so work can be
        checked on the running product without waiting for a release. Off
        (default) deploys only on release. Production still waits for the
        approval gate unless auto-approve is on.
      </span>
    </div>
  );
}

interface EnvPanelProps {
  projectId: string;
  stage: DeployStage;
  existing: IntegrationSummary | undefined;
  onRefetch: () => void;
}

function StagePanel({
  projectId,
  stage,
  existing,
  onRefetch,
}: EnvPanelProps) {
  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const confirmProd = useConfirmProdDeploy(projectId);

  const cfg = (existing?.config ?? {}) as CoolifyReadConfig;
  const seedTargets = (): CoolifyTargetInput[] =>
    cfg.targets && cfg.targets.length > 0
      ? cfg.targets.map((t) => ({
          id: t.id,
          label: t.label,
          resourceUuid: t.resourceUuid,
          healthUrl: t.healthUrl ?? "",
        }))
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
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);

  const isLive = stage === "live";
  const saving = create.isPending || update.isPending;
  // Org-shared credential: only an org owner/admin may change the CONNECTION
  // tier (base URL + token). The deploy target (resourceUuid/branch) is
  // binding-tier and stays editable by a project admin, as do Test + Delete.
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  // True when this project has no binding-level targets of its own and the
  // values shown are inherited off the shared connection's config.
  const bindingCfg = (existing?.bindingConfig ?? {}) as CoolifyReadConfig;
  const targetsInherited = Boolean(
    existing && !(bindingCfg.targets && bindingCfg.targets.length > 0) && cfg.targets?.length,
  );

  async function handleSave() {
    setError(null);
    setTestResult(null);
    const cleanTargets = targets
      .map((t) => ({
        ...(t.id ? { id: t.id } : {}),
        label: t.label.trim(),
        resourceUuid: t.resourceUuid.trim(),
        ...(t.healthUrl?.trim() ? { healthUrl: t.healthUrl.trim() } : {}),
      }))
      .filter((t) => t.label && t.resourceUuid);
    if (cleanTargets.length === 0) {
      setError("Add at least one deploy target (label + resource UUID).");
      return;
    }
    try {
      if (existing) {
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
        await create.mutateAsync({
          provider: "coolify",
          role: "deploy",
          stages: [stage],
          config: { baseUrl, targets: cleanTargets },
          secrets: { apiToken: apiToken.trim() },
          ...agentAccessBody(coolify.agentPathKind, agentAccess),
          ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
        });
      }
      setApiToken("");
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
    if (!window.confirm(`Delete the ${stage} Coolify integration?`))
      return;
    remove.mutate(existing.id);
  }

  return (
    <div
      className={`flex flex-col gap-4 rounded-lg border p-4 ${isLive ? "border-red" : "border-subtle"}`}
    >
      <p className="fg-body-sm text-muted">
        {isLive
          ? "⚠ Live — manual confirmation gate before every deploy."
          : "Preview — auto-dispatch on release."}
      </p>

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

      <CoolifyTargetsField
        projectId={projectId}
        stage={stage}
        integrationId={existing?.id}
        baseUrl={baseUrl}
        apiToken={apiToken}
        targets={targets}
        onChange={setTargets}
        inherited={targetsInherited}
      />

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

      {existing ? (
        <AgentAccessControl
          projectId={projectId}
          binding={existing}
          canEdit={true}
          disabledReason="Org-shared credential — only an org owner/admin can grant it."
        />
      ) : (
        <AgentAccessChoice
          value={agentAccess}
          onChange={setAgentAccess}
          pathKind={coolify.agentPathKind}
          canEdit={true}
          disabledReason="Org-shared credential — only an org owner/admin can grant it."
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
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
            variant="danger"
            icon="trash"
            loading={remove.isPending}
            onClick={handleDelete}
          >
            Delete
          </Button>
        )}
      </div>

      {existing && <DeployConfirmationHint />}

      {isLive && existing && (
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
 * - autoProd ON  → live deploys dispatch automatically on release; the manual
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
  // flag (or any read error) must never auto-deploy a project to its live stage.
  const autoProd = cfgQ.data?.pipelineConfig?.autoProdDeploy === true;

  // This toggle lives on the Integrations tab and writes the same document the Pipeline tab
  // edits. It names its own key and the value it read there, so neither tab's save can carry
  // the other's away (ISS-1170).
  function handleToggle(next: boolean) {
    if (!cfgQ.data) return;
    const read = cfgQ.data.pipelineConfig;
    update.mutate(sectionWrite({ autoProdDeploy: read.autoProdDeploy }, { autoProdDeploy: next }));
  }


  return (
    <div className="flex flex-col gap-3">
      {featureOff ? (
        <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
          <span className="fg-label text-subtle">Live approval gate</span>
          <span className="fg-body-sm text-muted">
            Pipeline control is disabled for this project, so auto-approve
            can&apos;t be configured here. Live deploys stay behind the manual
            gate below.
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
            <span className="fg-label">Live approval gate · off</span>
            <span className="fg-body-sm">
              Auto-approve is enabled — live deploys dispatch automatically on
              release, like preview. No manual confirmation required.
            </span>
            <span className="font-mono text-10 text-subtle">
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

function DeployConfirmationHint() {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Deploy confirmation</span>
      <span className="fg-body-sm">
        Forge reads each deploy&apos;s outcome back from Coolify and holds the
        pipeline run open until every target reports. Nothing to configure in
        Coolify — it sends no callback, so Forge asks instead.
      </span>
      <span className="fg-body-sm text-subtle">
        A deploy still unconfirmed after 30 minutes fails its run.
      </span>
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
        <span className="fg-label">Live approval gate</span>
        <span className="fg-body-sm">
          Live deploys never auto-dispatch. Click confirm when ready to release
          the gate for an in-flight pipeline run.
        </span>
        <div>
          <Button size="sm" loading={pending} onClick={onConfirm}>
            Confirm live deploy
          </Button>
        </div>
        <span className="font-mono text-10 text-subtle">
          integration: {integrationId}
        </span>
      </div>
    </Banner>
  );
}
