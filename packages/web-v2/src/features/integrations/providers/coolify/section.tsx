"use client";

import { Button, Field, Input, SegmentedControl } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
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
import { providerLabel } from "../registry";
import { healthBadge, OrgLockedNote, ProviderCard, TestOutcome, useBindingTest } from "../shared";
import type { CoolifyReadConfig } from "./config";
import { DeployConfirmationHint, ProdGateSection } from "./gates";
import { CoolifyTargetsField } from "./targets-field";

const NEW_BINDING = "new";

function bindingName(row: IntegrationSummary, t: Copy): string {
  return row.label || t("integrations.coolify.bindingN", { id: row.id.slice(0, 8) });
}

function badgeFor(existing: IntegrationSummary | undefined, t: Copy) {
  return healthBadge(existing, t, {
    inactive: { label: t("integrations.coolify.breakerOpen"), tone: "red" },
    error: t("integrations.coolify.lastDeployFailed"),
  });
}

export function CoolifySection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const rows = useMemo(() => (list.data?.items ?? []).filter((i) => i.provider === "coolify"), [list.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? rows[0]?.id ?? NEW_BINDING;
  const existing = useMemo(() => rows.find((i) => i.id === selected), [rows, selected]);
  const t = useCopy();
  const language = useInterfaceLanguage();
  const options = [
    ...rows.map((r) => ({ value: r.id, label: bindingName(r, t) })),
    { value: NEW_BINDING, label: t("integrations.coolify.newBinding") },
  ];

  return (
    <ProviderCard title={providerLabel("coolify", language)} badge={badgeFor(existing, t)}>
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
  const t = useCopy();

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
    if (clean.length === 0) return test.setError(t("integrations.coolify.needTarget"));
    try {
      if (existing) {
        const config: Record<string, unknown> = { targets: clean };
        if (!orgLocked && baseUrl.trim()) config.baseUrl = baseUrl.trim();
        const secrets = apiToken.trim() && !orgLocked ? { secrets: { apiToken: apiToken.trim() } } : {};
        await update.mutateAsync({ id: existing.id, body: { config, ...secrets } });
      } else {
        if (!apiToken.trim()) return test.setError(t("integrations.coolify.needToken"));
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
  const t = useCopy();
  return (
    <fieldset className="flex flex-col gap-3 border-t border-line-subtle pt-3">
      <legend className="fg-label px-1 text-subtle">{t("integrations.coolify.server")}</legend>
      <p className="fg-body-sm text-muted">{t("integrations.coolify.serverIntro")}</p>
      {!p.existing && <ConnectionOwnerField projectId={p.projectId} value={p.ownerOrgId} onChange={p.setOwnerOrgId} />}
      <Field label={t("integrations.gitlab.baseUrl")} required>
        <Input
          type="url"
          value={p.baseUrl}
          onChange={(e) => p.setBaseUrl(e.target.value)}
          placeholder="https://coolify.example.com"
          disabled={p.orgLocked}
        />
      </Field>
      <Field
        label={t("integrations.coolify.token")}
        hint={p.existing ? t("integrations.provider.tokenStored") : t("integrations.coolify.tokenHint")}
        required={!p.existing}
      >
        <Input
          type="password"
          autoComplete="new-password"
          value={p.apiToken}
          onChange={(e) => p.setApiToken(e.target.value)}
          placeholder={p.existing ? t("integrations.provider.unchanged") : t("integrations.secret.coolify")}
          disabled={p.orgLocked}
        />
      </Field>
      {p.orgLocked && (
        <OrgLockedNote>{t("integrations.coolify.orgLocked")}</OrgLockedNote>
      )}
    </fieldset>
  );
}

function EnvironmentNote({ bindingId }: { bindingId: string | undefined }) {
  const t = useCopy();
  return (
    <p className="fg-body-sm text-muted">
      {t("integrations.coolify.envWhere.lead")} <code>environments.&lt;name&gt;.deployment.binding</code>
      {bindingId && (
        <>
          {" "}
          {t("integrations.coolify.envWhere.as")} <code>{bindingId}</code>
        </>
      )}{" "}
      {t("integrations.coolify.envWhere.tail")}
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
  const t = useCopy();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={onSave} loading={saving}>
          {existing ? t("integrations.edit.save") : t("integrations.provider.create")}
        </Button>
        {existing && (
          <>
            <Button variant="secondary" onClick={onTest} loading={testing}>
              {t("integrations.edit.test")}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              loading={remove.isPending}
              onClick={() =>
                window.confirm(t("integrations.coolify.confirmDelete", { name: bindingName(existing, t) })) && remove.mutate(existing)
              }
            >
              {t("integrations.row.delete")}
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
