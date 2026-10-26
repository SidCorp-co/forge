"use client";


import {
  Badge,
  Banner,
  Button,
  CardTitle,
  Field,
  Input,
  SegmentedControl,
  Toggle,
  SettingsSection,
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
  AgentAccessControl,
  agentAccessBody,
  grantOnConnectWho,
  mayGrantOnConnect,
} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import {
  bindsRemovedConnection,
  IntegrationEnabledControl,
  keyLockedLine,
  onlyWho,
  removedKeyHint,
} from "../../components/integration-enabled-control";
import { coolify } from "./index";
import { CoolifyTargetsField } from "./targets-field";
import { DisconnectFromProject } from "../../components/disconnect-from-project";
import { STAGE_OPTIONS } from "../../components/status-pill";
import {
  useConfirmProdDeploy,
  useConnections,
  useCreateProviderIntegration,
  useIntegrationsList,
  useProjectIntegrationActs,
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
import { bindingBadge } from "../../derive";
import { connectionLabels, connectionName } from "../../connection-identity";
import { connectionTargetFor } from "../registry";

export function CoolifySection({ projectId, stage: openedAt }: { projectId: string; stage?: DeployStage }) {
  const [stage, setStage] = useState<DeployStage>(openedAt ?? "preview");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === "coolify"),
    [list.data],
  );
  // Every coolify binding serving this stage — a stage may hold more than one
  // and core never picks among them (ISS-1046 rule 3). This panel edits the
  // first; the connection drawer lists them all.
  const existing = useMemo(() => rows.find((i) => i.stages.includes(stage)), [rows, stage]);
  const reachesLive = useMemo(() => bindingReachesLive(rows, existing), [rows, existing]);

  return (
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Coolify</CardTitle>
          <Badge tone={bindingBadge(existing).tone}>
            {bindingBadge(existing).label}
          </Badge>
        </div>
      </div>
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
          reachesLive={reachesLive}
          onRefetch={() => list.refetch()}
        />
      </div>
    </SettingsSection>
  );
}

interface EnvPanelProps {
  projectId: string;
  stage: DeployStage;
  existing: IntegrationSummary | undefined;
  reachesLive: boolean;
  onRefetch: () => void;
}

const appsOf = (binding: IntegrationSummary): string[] =>
  ((binding.bindingConfig as CoolifyReadConfig).targets ?? []).map((t) => t.resourceUuid).filter(Boolean);

/** Core's own rule for a deploy a person confirms: it carries live, or deploys an application a
 *  live binding also deploys (`bindingReachesLive`, ISS-1421 r30 review on criterion 344). */
function bindingReachesLive(rows: IntegrationSummary[], binding: IntegrationSummary | undefined): boolean {
  if (!binding) return false;
  if (binding.stages.includes("live")) return true;
  const live = new Set(rows.filter((r) => r.stages.includes("live")).flatMap(appsOf));
  return appsOf(binding).some((u) => live.has(u));
}

function StagePanel({
  projectId,
  stage,
  existing,
  reachesLive,
  onRefetch,
}: EnvPanelProps) {
  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
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
  // The connection tier (base URL + token) and the binding's own (its deploy targets) are each
  // offered by what core says this reader may do with them, the rule its PATCH refuses by; a guess
  // in the web offered a plain project member both, then core refused them (ISS-1421 r27).
  const may = useProjectIntegrationActs(projectId);
  const keyLocked = existing ? !existing.acts.saveKey : !may?.connect;
  const bindingLocked = existing ? !existing.acts.change : !may?.connect;
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
        // Each tier is sent only by a reader core takes it from.
        const config: Record<string, unknown> = bindingLocked ? {} : { targets: cleanTargets };
        if (!keyLocked && baseUrl.trim()) config.baseUrl = baseUrl.trim();
        await update.mutateAsync({
          id: existing.id,
          body: {
            ...(Object.keys(config).length > 0 ? { config } : {}),
            ...(apiToken.trim() && !keyLocked
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

  return (
    <div
      className={`flex flex-col gap-4 border-t pt-4 ${isLive ? "border-red" : "border-subtle"}`}
    >
      <p className="fg-body-sm text-muted">
        {isLive
          ? "⚠ Live — manual confirmation gate before every deploy."
          : "Preview — auto-dispatch on release."}
      </p>

      <fieldset className="flex flex-col gap-3 border-t border-subtle pt-3">
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
            disabled={keyLocked}
          />
        </Field>
        <Field
          label="API token"
          hint={
            existing && !existing.hasSecrets
              ? removedKeyHint("token", existing.acts)
              : existing
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
            placeholder={existing?.hasSecrets ? "•••••••• (unchanged)" : "Coolify API token"}
            disabled={keyLocked}
          />
        </Field>
        {existing && keyLocked && <p className="fg-body-sm text-muted">{keyLockedLine(existing.acts)}</p>}
      </fieldset>

      {/* The binding's own tier: disabled as one for a reader core would refuse it (ISS-1421 r27). */}
      <fieldset disabled={bindingLocked} className="contents">
      <CoolifyTargetsField
        projectId={projectId}
        stage={stage}
        integrationId={existing?.id}
        baseUrl={baseUrl}
        apiToken={apiToken}
        targets={targets}
        onChange={setTargets}
        inherited={targetsInherited}
        canFixCredentials={!keyLocked && !(existing && bindsRemovedConnection(existing))}
        canEditTargets={!bindingLocked}
      />
      </fieldset>
      {!existing && may && !may.connect && (
        <p className="fg-body-sm text-muted">{`${onlyWho(may.whoConnects)} can connect Coolify to this project.`}</p>
      )}

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
        <AgentAccessControl projectId={projectId} binding={existing} />
      ) : (
        <AgentAccessChoice
          value={agentAccess}
          onChange={setAgentAccess}
          pathKind={coolify.agentPathKind}
          canEdit={mayGrantOnConnect(coolify.agentPathKind, may)}
          disabledReason={grantOnConnectWho(coolify.agentPathKind, may)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!(keyLocked && bindingLocked) && (
          <Button variant="primary" onClick={handleSave} loading={saving}>
            {existing ? "Save" : "Create integration"}
          </Button>
        )}
        {existing && !bindsRemovedConnection(existing) && (
          <Button
            variant="secondary"
            onClick={handleTest}
            loading={test.isPending}
          >
            Test connection
          </Button>
        )}
        {existing && (
          <DisconnectFromProject
            projectId={projectId}
            binding={existing}
            subject={`Coolify (${stage})`}
          />
        )}
      </div>

      {/* The switch a turned-off target is turned back on with, which the agents line names (ISS-1421 r11). */}
      {existing && <IntegrationEnabledControl projectId={projectId} binding={existing} />}

      {existing && <DeployConfirmationHint />}

      {reachesLive && existing && (
        <fieldset disabled={bindingLocked} className="contents">
          <ProdGateSection
            projectId={projectId}
            binding={existing}
            isLive={isLive}
            whoConfirms={bindingLocked ? existing.acts.whoChanges : null}
            confirmPending={confirmProd.isPending}
            onConfirm={() => confirmProd.mutate(existing.id)}
          />
        </fieldset>
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
/**
 * The connection a live gate deploys through, as the reader knows it: its name, else where it
 * points. Never its id, which no reader can act on (ISS-1421 r30).
 */
function useGateConnection(binding: IntegrationSummary): string {
  const connections = useConnections();
  const coolifies = (connections.data?.items ?? []).filter((c) => c.provider === "coolify");
  const own = coolifies.find((c) => c.id === binding.connectionId);
  const label = own ? connectionLabels(coolifies, false).get(own.id) : undefined;
  if (own && label && connectionName(own)) return `the connection ${label}`;
  if (own && label && connectionTargetFor("coolify", own.config)) return `the connection at ${label}`;
  const target = connectionTargetFor("coolify", binding.config);
  return target ? `the connection at ${target}` : "this project's Coolify connection";
}

function ProdGateSection({
  projectId,
  binding,
  isLive,
  whoConfirms,
  confirmPending,
  onConfirm,
}: {
  projectId: string;
  binding: IntegrationSummary;
  /** False on a preview binding the gate holds because it deploys what a live binding deploys. */
  isLive: boolean;
  /** Who may confirm, where this reader may not; core confirms only for them (ISS-1421 r31). */
  whoConfirms: string | null;
  confirmPending: boolean;
  onConfirm: () => void;
}) {
  const through = useGateConnection(binding);
  const cfgQ = usePipelineConfig(projectId);
  const update = useUpdatePipelineConfig(projectId);
  // The pipeline config's door needs an owner or admin of the organization (ISS-1421 r27).
  const may = useProjectIntegrationActs(projectId);
  const settingsLocked = may !== null && !may.changeProjectSettings;

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
        <div className="flex flex-col gap-1 border-t border-subtle pt-3">
          <span className="fg-label text-subtle">Live approval gate</span>
          <span className="fg-body-sm text-muted">
            Pipeline control is disabled for this project, so auto-approve
            can&apos;t be configured here. Live deploys stay behind the manual
            gate below.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1 border-t border-subtle pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="fg-label text-subtle">
              Auto-approve production deploys
            </span>
            <Toggle
              checked={autoProd}
              onChange={handleToggle}
              disabled={update.isPending || cfgQ.isLoading || !cfgQ.data || settingsLocked}
              aria-label="Auto-approve production deploys"
            />
          </div>
          {settingsLocked && (
            <span className="fg-body-sm text-muted">{`${onlyWho(may.whoChangesProjectSettings)} can change this.`}</span>
          )}
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
            <span className="fg-body-sm text-subtle">{`Through ${through}.`}</span>
          </div>
        </Banner>
      ) : (
        <ProdConfirmBanner
          through={through}
          isLive={isLive}
          whoConfirms={whoConfirms}
          pending={confirmPending}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}

function DeployConfirmationHint() {
  return (
    <div className="flex flex-col gap-1 border-t border-subtle pt-3">
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
  through,
  isLive,
  whoConfirms,
  pending,
  onConfirm,
}: {
  through: string;
  isLive: boolean;
  whoConfirms: string | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Banner tone="attention">
      <div className="flex flex-col gap-2">
        <span className="fg-label">Live approval gate</span>
        {!isLive && (
          <span className="fg-body-sm" data-testid="preview-gate-why">
            This preview binding deploys an application a live binding deploys, so its deploys wait
            here for a confirm as live ones do.
          </span>
        )}
        <span className="fg-body-sm">
          Live deploys never auto-dispatch. Click confirm when ready to release
          the gate for an in-flight pipeline run.
        </span>
        <Button size="sm" loading={pending} onClick={onConfirm} className="self-start">
          Confirm live deploy
        </Button>
        {whoConfirms && (
          <span className="fg-body-sm text-muted" data-testid="confirm-who">{`${onlyWho(whoConfirms)} can confirm a live deploy.`}</span>
        )}
        <span className="fg-body-sm text-subtle">{`Through ${through}.`}</span>
      </div>
    </Banner>
  );
}
