"use client";

import { Button, Field, Input, SegmentedControl } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import {
  useConfirmProdDeploy,
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useOrgConnectionLocked,
  useUpdateProviderIntegration,
} from "../../hooks";
import type { CoolifyTargetInput, IntegrationSummary } from "../../types";
import { healthBadge, OrgLockedNote, ProviderCard, TestOutcome, useBindingTest } from "../shared";
import type { CoolifyReadConfig } from "./config";
import { DeployConfirmationHint, ProdGateSection } from "./gates";
import { CoolifyTargetsField } from "./targets-field";

const NEW_BINDING = "new";

function bindingName(row: IntegrationSummary): string {
  return row.label || `binding ${row.id.slice(0, 8)}`;
}

function badgeFor(existing: IntegrationSummary | undefined) {
  return healthBadge(existing, { inactive: { label: "Breaker open", tone: "red" }, error: "Last deploy failed" });
}

export function CoolifySection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const rows = useMemo(() => (list.data?.items ?? []).filter((i) => i.provider === "coolify"), [list.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? rows[0]?.id ?? NEW_BINDING;
  const existing = useMemo(() => rows.find((i) => i.id === selected), [rows, selected]);
  const options = [
    ...rows.map((r) => ({ value: r.id, label: bindingName(r) })),
    { value: NEW_BINDING, label: "New binding" },
  ];

  return (
    <ProviderCard title="Coolify deploy" badge={badgeFor(existing)}>
      {rows.length > 0 && <SegmentedControl<string> value={selected} onChange={setPicked} options={options} />}
      {/* Remount the panel per binding so its form state re-seeds. */}
      <BindingPanel key={selected} projectId={projectId} existing={existing} onRefetch={() => list.refetch()} />
    </ProviderCard>
  );
}

function seedTargets(cfg: CoolifyReadConfig): CoolifyTargetInput[] {
  return cfg.targets && cfg.targets.length > 0
    ? cfg.targets.map((t) => ({ id: t.id, label: t.label, resourceUuid: t.resourceUuid, healthUrl: t.healthUrl ?? "" }))
    : [{ label: "", resourceUuid: "" }];
}

function cleanTargets(targets: CoolifyTargetInput[]) {
  return targets
    .map((t) => ({
      ...(t.id ? { id: t.id } : {}),
      label: t.label.trim(),
      resourceUuid: t.resourceUuid.trim(),
      ...(t.healthUrl?.trim() ? { healthUrl: t.healthUrl.trim() } : {}),
    }))
    .filter((t) => t.label && t.resourceUuid);
}

/** The panel's form, seeded from the binding it edits. */
function useCoolifyForm(existing: IntegrationSummary | undefined) {
  const cfg = (existing?.config ?? {}) as CoolifyReadConfig;
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? "");
  const [targets, setTargets] = useState<CoolifyTargetInput[]>(() => seedTargets(cfg));
  const [apiToken, setApiToken] = useState("");
  // The panel mounts before the list query resolves, so re-seed when the existing row arrives —
  // otherwise a Save over a configured integration would wipe its config with empty values.
  const [seededFor, setSeededFor] = useState(existing?.id ?? null);
  if ((existing?.id ?? null) !== seededFor) {
    setSeededFor(existing?.id ?? null);
    setBaseUrl(cfg.baseUrl ?? "");
    setTargets(seedTargets(cfg));
  }
  return { baseUrl, setBaseUrl, targets, setTargets, apiToken, setApiToken };
}

function BindingPanel({
  projectId,
  existing,
  onRefetch,
}: {
  projectId: string;
  existing: IntegrationSummary | undefined;
  onRefetch: () => void;
}) {
  const create = useCreateProviderIntegration(projectId);
  const update = useUpdateProviderIntegration(projectId);
  const test = useBindingTest(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);

  const cfg = (existing?.config ?? {}) as CoolifyReadConfig;
  const { baseUrl, setBaseUrl, targets, setTargets, apiToken, setApiToken } = useCoolifyForm(existing);
  // Org-shared credential: only an org owner/admin may change the connection tier (base URL +
  // token); the deploy targets are binding-tier and stay a project admin's.
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  const bindingCfg = (existing?.bindingConfig ?? {}) as CoolifyReadConfig;
  const targetsInherited = Boolean(existing && !bindingCfg.targets?.length && cfg.targets?.length);

  async function handleSave() {
    test.reset();
    const clean = cleanTargets(targets);
    if (clean.length === 0) return test.setError("Add at least one deploy target (label + resource UUID).");
    try {
      if (existing) {
        const config: Record<string, unknown> = { targets: clean };
        if (!orgLocked && baseUrl.trim()) config.baseUrl = baseUrl.trim();
        const secrets = apiToken.trim() && !orgLocked ? { secrets: { apiToken: apiToken.trim() } } : {};
        await update.mutateAsync({ id: existing.id, body: { config, ...secrets } });
      } else {
        if (!apiToken.trim()) return test.setError("API token is required for the first save");
        await create.mutateAsync({
          provider: "coolify",
          role: "deploy",
          config: { baseUrl, targets: clean },
          secrets: { apiToken: apiToken.trim() },
          ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
        });
      }
      setApiToken("");
      onRefetch();
    } catch (err) {
      test.setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <EnvironmentNote bindingId={existing?.id} />
      <CoolifyServerFields
        projectId={projectId}
        existing={existing}
        ownerOrgId={ownerOrgId}
        setOwnerOrgId={setOwnerOrgId}
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        apiToken={apiToken}
        setApiToken={setApiToken}
        orgLocked={orgLocked}
      />
      <CoolifyTargetsField
        projectId={projectId}
        integrationId={existing?.id}
        baseUrl={baseUrl}
        apiToken={apiToken}
        targets={targets}
        onChange={setTargets}
        inherited={targetsInherited}
      />
      <TestOutcome error={test.error} result={test.result} />
      <PanelActions
        projectId={projectId}
        existing={existing}
        onSave={handleSave}
        saving={create.isPending || update.isPending}
        onTest={() => existing && test.run(existing.id)}
        testing={test.pending}
      />
    </div>
  );
}

function CoolifyServerFields(p: {
  projectId: string;
  existing: IntegrationSummary | undefined;
  ownerOrgId: string | undefined;
  setOwnerOrgId: (id: string | undefined) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  apiToken: string;
  setApiToken: (v: string) => void;
  orgLocked: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3 border-t border-line-subtle pt-3">
      <legend className="fg-label px-1 text-subtle">Coolify server · shared credential</legend>
      <p className="fg-body-sm text-muted">
        One Coolify server + API token, reused by every project bound to this connection. Forge calls it to
        trigger deploys (Forge → Coolify).
      </p>
      {!p.existing && <ConnectionOwnerField projectId={p.projectId} value={p.ownerOrgId} onChange={p.setOwnerOrgId} />}
      <Field label="Base URL" required>
        <Input
          type="url"
          value={p.baseUrl}
          onChange={(e) => p.setBaseUrl(e.target.value)}
          placeholder="https://coolify.example.com"
          disabled={p.orgLocked}
        />
      </Field>
      <Field
        label="API token"
        hint={
          p.existing
            ? "A token is stored. Leave blank to keep it; enter a new one to rotate."
            : "Coolify API token. Stored encrypted; never shown again."
        }
        required={!p.existing}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={p.apiToken}
          onChange={(e) => p.setApiToken(e.target.value)}
          placeholder={p.existing ? "•••••••• (unchanged)" : "Coolify API token"}
          disabled={p.orgLocked}
        />
      </Field>
      {p.orgLocked && (
        <OrgLockedNote>
          Org-shared credential — only an org owner/admin can change the base URL or API token. The deploy
          targets below are yours to configure per project.
        </OrgLockedNote>
      )}
    </fieldset>
  );
}

function EnvironmentNote({ bindingId }: { bindingId: string | undefined }) {
  return (
    <p className="fg-body-sm text-muted">
      Which environment this binding deploys is the project document&apos;s: name it in{" "}
      <code>environments.&lt;name&gt;.deployment.binding</code>
      {bindingId && (
        <>
          {" "}as <code>{bindingId}</code>
        </>
      )}{" "}
      on the Configuration tab of project settings. A binding no environment names is never dispatched.
    </p>
  );
}

/** Save, and on a saved binding Test / Delete and the production deploy gate. */
function PanelActions({
  projectId,
  existing,
  onSave,
  saving,
  onTest,
  testing,
}: {
  projectId: string;
  existing: IntegrationSummary | undefined;
  onSave: () => void;
  saving: boolean;
  onTest: () => void;
  testing: boolean;
}) {
  const remove = useDeleteProviderIntegration(projectId);
  const confirmProd = useConfirmProdDeploy(projectId);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onSave} loading={saving}>
          {existing ? "Save" : "Create integration"}
        </Button>
        {existing && (
          <>
            <Button variant="secondary" onClick={onTest} loading={testing}>
              Test connection
            </Button>
            <Button
              variant="danger"
              icon="trash"
              loading={remove.isPending}
              onClick={() =>
                window.confirm(`Delete the Coolify integration ${bindingName(existing)}?`) && remove.mutate(existing)
              }
            >
              Delete
            </Button>
          </>
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
    </>
  );
}
