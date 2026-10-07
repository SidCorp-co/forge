"use client";

import { Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useState } from "react";
import { AgentAccessControl, agentAccessDeniedReason } from "../../components/agent-access-control";
import { useIntegrationsList, useOrgConnectionLocked, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { BindingRowHeader, MultiBindingSection } from "../multi-binding";
import { BindingRowActions, healthBadge, OrgLockedNote, TestOutcome, Ticked, useBindingTest } from "../shared";
import { AddEpodsystemForm } from "./add-form";
import type { EpodsystemReadConfig } from "./config";
import { ThemePanel } from "./theme-panel";

/** ISS-395 / ISS-558 — one or more storefronts per project, each its own labelled binding. */
export function EpodsystemSection({ projectId }: { projectId: string }) {
  const t = useCopy();
  return (
    <MultiBindingSection
      projectId={projectId}
      provider="epodsystem"
      title={t("integrations.epod.title")}
      intro={<Ticked text={t("integrations.epod.intro")} />}
      emptyText={t("integrations.epod.empty")}
      addLabel={t("integrations.epod.add")}
      renderRow={(binding, isDefault) => (
        <EpodsystemBindingRow key={binding.id} projectId={projectId} binding={binding} isDefault={isDefault} />
      )}
      renderAdd={(hasDefault, onDone) => (
        <AddEpodsystemForm projectId={projectId} hasDefault={hasDefault} onDone={onDone} />
      )}
    />
  );
}

function EpodsystemBindingRow({
  projectId,
  binding,
  isDefault,
}: {
  projectId: string;
  binding: IntegrationSummary;
  isDefault: boolean;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const list = useIntegrationsList(projectId);
  const test = useBindingTest(projectId, () => list.refetch());
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);
  const [apiKey, setApiKey] = useState("");
  const [showKeyField, setShowKeyField] = useState(false);
  const config = binding.config as EpodsystemReadConfig;
  const t = useCopy();
  const badge = healthBadge(binding, t, {
    ok: config.storeName ? t("integrations.provider.connectedTo", { target: config.storeName }) : t("integrations.status.connected"),
    error: t("integrations.epod.invalidKey"),
  });

  async function handleSaveKey() {
    if (!apiKey.trim()) return;
    test.setError(null);
    try {
      await update.mutateAsync({ id: binding.id, body: { secrets: { apiKey: apiKey.trim() } } });
      setApiKey("");
      setShowKeyField(false);
    } catch (err) {
      test.setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <BindingRowHeader binding={binding} isDefault={isDefault} badge={badge} />
      <TestOutcome error={test.error} result={test.result} />
      {showKeyField && (
        <Field label={t("integrations.epod.newKey")} hint={t("integrations.epod.newKeyHint")}>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="crmk_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={orgLocked}
          />
        </Field>
      )}
      {orgLocked && <OrgLockedNote />}
      <BindingRowActions
        projectId={projectId}
        binding={binding}
        orgLocked={orgLocked}
        rotating={showKeyField}
        setRotating={setShowKeyField}
        rotateLabel={t("integrations.epod.rotateKey")}
        saveLabel={t("integrations.edit.saveKey")}
        onSave={handleSaveKey}
        saving={update.isPending}
        saveDisabled={!apiKey.trim()}
        onTest={() => test.run(binding.id)}
        testing={test.pending}
        confirmDelete={t("integrations.epod.confirmDelete", { label: binding.label || "default" })}
      />
      <AgentAccessControl
        projectId={projectId}
        binding={binding}
        canEdit={true}
        disabledReason={agentAccessDeniedReason("direct-mcp")}
      />
      <ThemePanel config={config} />
    </div>
  );
}
