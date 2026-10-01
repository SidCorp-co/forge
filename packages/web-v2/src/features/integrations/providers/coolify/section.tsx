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
} from "@/design";
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

const NEW_BINDING = "new";

function bindingName(row: IntegrationSummary): string {
  return row.label || `binding ${row.id.slice(0, 8)}`;
}

export function CoolifySection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === "coolify"),
    [list.data],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? rows[0]?.id ?? NEW_BINDING;
  const existing = useMemo(() => rows.find((i) => i.id === selected), [rows, selected]);
  const options = [
    ...rows.map((r) => ({ value: r.id, label: bindingName(r) })),
    { value: NEW_BINDING, label: "New binding" },
  ];

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
          {rows.length > 0 && (
            <SegmentedControl<string> value={selected} onChange={setPicked} options={options} />
          )}
          {/* Remount the panel per binding so its form state re-seeds. */}
          <BindingPanel
            key={selected}
            projectId={projectId}
            existing={existing}
            onRefetch={() => list.refetch()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

interface BindingPanelProps {
  projectId: string;
  existing: IntegrationSummary | undefined;
  onRefetch: () => void;
}

function BindingPanel({
  projectId,
  existing,
  onRefetch,
}: BindingPanelProps) {
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
    if (!window.confirm(`Delete the Coolify integration ${bindingName(existing)}?`))
      return;
    remove.mutate(existing.id);
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-subtle p-4">
      <p className="fg-body-sm text-muted">
        Which environment this binding deploys is the project document&apos;s: name it in{" "}
        <code>environments.&lt;name&gt;.deployment.binding</code>
        {existing ? (
          <>
            {" "}as <code>{existing.id}</code>
          </>
        ) : null}{" "}
        and write the document with <code>PUT /api/projects/:id/config</code>. A binding no
        environment names is never dispatched.
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

      {existing && (
        <ProdGateSection
          integrationId={existing.id}
          confirmPending={confirmProd.isPending}
          onConfirm={() => confirmProd.mutate(existing.id)}
        />
      )}
    </div>
  );
}

/**
 * The production approval gate. Whether a release deploys to production without it is the
 * project document's production environment (`deployment.trigger: "on-land"`), not a switch here.
 */
function ProdGateSection({
  integrationId,
  confirmPending,
  onConfirm,
}: {
  integrationId: string;
  confirmPending: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-lg border border-subtle bg-sunken p-3">
        <span className="fg-label text-subtle">Live approval gate</span>
        <span className="fg-body-sm text-muted">
          Where this binding reaches production — it is the binding the production environment
          names, or deploys to an application that one does — a production deploy waits for the
          confirmation below unless that environment deploys on land
          (<code>deployment.trigger: &quot;on-land&quot;</code>). Confirming any other binding is
          refused.
        </span>
      </div>
      <ProdConfirmBanner
        integrationId={integrationId}
        pending={confirmPending}
        onConfirm={onConfirm}
      />
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
