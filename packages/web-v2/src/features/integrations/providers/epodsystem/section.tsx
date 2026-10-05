"use client";

import { Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useState } from "react";
import { AgentAccessControl, agentAccessDeniedReason } from "../../components/agent-access-control";
import { useIntegrationsList, useOrgConnectionLocked, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { BindingRowHeader, MultiBindingSection } from "../multi-binding";
import { BindingRowActions, healthBadge, OrgLockedNote, TestOutcome, useBindingTest } from "../shared";
import { AddEpodsystemForm } from "./add-form";
import type { EpodsystemReadConfig } from "./config";
import { ThemePanel } from "./theme-panel";

/** ISS-395 / ISS-558 — one or more storefronts per project, each its own labelled binding. */
export function EpodsystemSection({ projectId }: { projectId: string }) {
  return (
    <MultiBindingSection
      projectId={projectId}
      provider="epodsystem"
      title="Epodsystem storefronts"
      intro={
        <>
          Connect one or more Epodsystem storefronts to this project. Each storefront needs its own{" "}
          <span className="font-mono">crmk_</span> API key. The first (unlabeled) connection is the default.
          Extra connections require a unique kebab-case label (e.g. <span className="font-mono">partner-a</span>).
        </>
      }
      emptyText="No Epodsystem storefronts configured."
      addLabel="Add storefront"
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
  const badge = healthBadge(binding, {
    ok: config.storeName ? `Connected to ${config.storeName}` : "Connected",
    error: "Invalid key",
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
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <BindingRowHeader binding={binding} isDefault={isDefault} badge={badge} />
      <TestOutcome error={test.error} result={test.result} />
      {showKeyField && (
        <Field label="New API key" hint="Enter the new crmk_ key to rotate. Leave blank to keep the current key.">
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
        rotateLabel="Rotate key"
        saveLabel="Save key"
        onSave={handleSaveKey}
        saving={update.isPending}
        saveDisabled={!apiKey.trim()}
        onTest={() => test.run(binding.id)}
        testing={test.pending}
        confirmDelete={`Delete the "${binding.label || "default"}" Epodsystem integration for this project?`}
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
