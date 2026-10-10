"use client";

import { Banner, Field, Input, Property, PropertyList } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useState } from "react";
import { AgentAccessControl, agentAccessDeniedReason } from "../../components/agent-access-control";
import { useIntegrationsList, useOrgConnectionLocked, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { text } from "../config-read";
import { BindingRowHeader, MultiBindingSettings } from "../multi-binding";
import { BindingRowActions, healthBadge, OrgLockedNote, TestOutcome, useBindingTest } from "../shared";
import { AddAutoflowForm } from "./add-form";
import { EMPTY_TOKENS, RefreshPairFields, tokenSecrets, tokensValid } from "./tokens";

/** Autoflow sites bound to this project: the site a project runs on, and its Backend Builder flows. */
export function AutoflowSettings({ projectId }: { projectId: string }) {
  const t = useCopy();
  return (
    <MultiBindingSettings
      projectId={projectId}
      provider="autoflow"
      title={t("integrations.autoflow.title")}
      emptyText={t("integrations.autoflow.empty")}
      addLabel={t("integrations.autoflow.add")}
      renderRow={(binding, isDefault) => (
        <AutoflowBinding key={binding.id} projectId={projectId} binding={binding} isDefault={isDefault} />
      )}
      renderAdd={(hasDefault, onDone) => <AddAutoflowForm projectId={projectId} hasDefault={hasDefault} onDone={onDone} />}
    />
  );
}

function AutoflowBinding({
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
  const test = useBindingTest(projectId, () => void list.refetch());
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);
  const [tokens, setTokens] = useState(EMPTY_TOKENS);
  const [rotating, setRotating] = useState(false);
  const config = binding.config ?? {};
  const storeName = text(config, "storeName");
  const t = useCopy();
  const language = useInterfaceLanguage();
  const badge = healthBadge(binding, t, {
    ok: storeName ? t("integrations.provider.connectedTo", { target: storeName }) : t("integrations.status.connected"),
    needsReauth: t("integrations.autoflow.needsSignIn"),
  });

  async function saveToken() {
    test.setError(null);
    try {
      await update.mutateAsync({ id: binding.id, body: { secrets: tokenSecrets(tokens) } });
      setTokens(EMPTY_TOKENS);
      setRotating(false);
    } catch (err) {
      test.setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <BindingRowHeader binding={binding} isDefault={isDefault} badge={badge} monoDefault />
      {test.error && <Banner tone="danger">{test.error}</Banner>}
      {binding.lastHealthStatus === "needs_reauth" && binding.lastHealthDetail && !test.result && (
        <Banner tone="danger">{binding.lastHealthSays ? said(binding.lastHealthSays, language) : binding.lastHealthDetail}</Banner>
      )}
      <TestOutcome result={test.result} />
      <SiteDetails config={config} />
      {rotating && (
        <>
          <Field label={t("integrations.autoflow.newToken")}>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="sat_…"
              value={tokens.token}
              onChange={(e) => setTokens({ ...tokens, token: e.target.value })}
            />
          </Field>
          <RefreshPairFields value={tokens} onChange={setTokens} />
        </>
      )}
      {orgLocked && <OrgLockedNote />}
      <BindingRowActions
        projectId={projectId}
        binding={binding}
        orgLocked={orgLocked}
        rotating={rotating}
        setRotating={setRotating}
        rotateLabel={t("integrations.autoflow.replaceToken")}
        saveLabel={t("integrations.autoflow.saveToken")}
        onSave={() => void saveToken()}
        saving={update.isPending}
        saveDisabled={!tokensValid(tokens)}
        onTest={() => void test.run(binding.id)}
        testing={test.pending}
        confirmDelete={t("integrations.autoflow.confirmDelete", { label: binding.label || t("integrations.provider.defaultLabel") })}
      />
      <AgentAccessControl
        projectId={projectId}
        binding={binding}
        canEdit={true}
        disabledReason={agentAccessDeniedReason("direct-mcp")}
      />
    </div>
  );
}

function SiteDetails({ config }: { config: Record<string, unknown> }) {
  const storeName = text(config, "storeName");
  const t = useCopy();
  return (
    <PropertyList>
      <Property label={t("integrations.autoflow.site")}>
        {text(config, "shop") ?? "—"}
        {storeName && <span className="text-subtle"> · {storeName}</span>}
        {text(config, "storeId") && <span className="text-subtle"> · #{text(config, "storeId")}</span>}
      </Property>
      <Property label={t("integrations.autoflow.workspace")}>{text(config, "orgId") ?? t("integrations.autoflow.runTest")}</Property>
      <Property label={t("integrations.autoflow.platform")}>{text(config, "baseUrl") ?? "https://auto.sidcorp.co"}</Property>
    </PropertyList>
  );
}
