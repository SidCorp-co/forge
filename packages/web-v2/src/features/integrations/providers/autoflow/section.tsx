"use client";

import { Banner, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { useState } from "react";
import { AgentAccessControl, agentAccessDeniedReason } from "../../components/agent-access-control";
import { useIntegrationsList, useOrgConnectionLocked, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { text } from "../config-read";
import { BindingRowHeader, MultiBindingSection } from "../multi-binding";
import { BindingRowActions, healthBadge, OrgLockedNote, TestOutcome, Ticked, useBindingTest } from "../shared";
import { AddAutoflowForm } from "./add-form";
import { EMPTY_TOKENS, RefreshPairFields, tokenSecrets, tokensValid } from "./tokens";

/** Autoflow sites bound to this project: the site a project runs on, and its Backend Builder flows. */
export function AutoflowSection({ projectId }: { projectId: string }) {
  const t = useCopy();
  return (
    <MultiBindingSection
      projectId={projectId}
      provider="autoflow"
      title={t("integrations.autoflow.title")}
      intro={<Ticked text={t("integrations.autoflow.intro")} />}
      emptyText={t("integrations.autoflow.empty")}
      addLabel={t("integrations.autoflow.add")}
      renderRow={(binding, isDefault) => (
        <AutoflowBindingRow key={binding.id} projectId={projectId} binding={binding} isDefault={isDefault} />
      )}
      renderAdd={(hasDefault, onDone) => <AddAutoflowForm projectId={projectId} hasDefault={hasDefault} onDone={onDone} />}
    />
  );
}

function AutoflowBindingRow({
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
      <SiteFacts config={config} />
      {rotating && (
        <>
          <Field label={t("integrations.autoflow.newToken")} hint={t("integrations.autoflow.newTokenHint")}>
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
        onSave={saveToken}
        saving={update.isPending}
        saveDisabled={!tokensValid(tokens)}
        onTest={() => test.run(binding.id)}
        testing={test.pending}
        confirmDelete={t("integrations.autoflow.confirmDelete", { label: binding.label || "default" })}
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

function SiteFacts({ config }: { config: Record<string, unknown> }) {
  const storeName = text(config, "storeName");
  const t = useCopy();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-12">
      <dt className="text-subtle">{t("integrations.autoflow.site")}</dt>
      <dd>
        {text(config, "shop") ?? "—"}
        {storeName && <span className="text-subtle"> · {storeName}</span>}
        {text(config, "storeId") && <span className="text-subtle"> · #{text(config, "storeId")}</span>}
      </dd>
      <dt className="text-subtle">{t("integrations.autoflow.workspace")}</dt>
      <dd>{text(config, "orgId") ?? t("integrations.autoflow.runTest")}</dd>
      <dt className="text-subtle">{t("integrations.autoflow.platform")}</dt>
      <dd>{text(config, "baseUrl") ?? "https://auto.sidcorp.co"}</dd>
    </dl>
  );
}
