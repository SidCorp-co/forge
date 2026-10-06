"use client";

import { Banner, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useState } from "react";
import { AgentAccessControl, agentAccessDeniedReason } from "../../components/agent-access-control";
import { useIntegrationsList, useOrgConnectionLocked, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { text } from "../config-read";
import { BindingRowHeader, MultiBindingSection } from "../multi-binding";
import { BindingRowActions, healthBadge, OrgLockedNote, TestOutcome, useBindingTest } from "../shared";
import { AddAutoflowForm } from "./add-form";
import { EMPTY_TOKENS, RefreshPairFields, tokenSecrets, tokensValid } from "./tokens";

/** Autoflow sites bound to this project: the site a project runs on, and its Backend Builder flows. */
export function AutoflowSection({ projectId }: { projectId: string }) {
  return (
    <MultiBindingSection
      projectId={projectId}
      provider="autoflow"
      title="Autoflow sites"
      intro={
        <>
          A project that runs on Autoflow builds one site and its flows through the shop MCP. Each binding
          names the site (<span className="font-mono">shop</span>, the{" "}
          <span className="font-mono">&lt;shop&gt;</span> of{" "}
          <span className="font-mono">&lt;shop&gt;.auto.sidcorp.co</span>) and holds the OAuth access token (
          <span className="font-mono">sat_…</span>) minted for that site. An access token lives 12 hours;
          stored with its refresh token (<span className="font-mono">srt_…</span>), Forge renews it itself.
        </>
      }
      emptyText="No Autoflow site configured."
      addLabel="Add site"
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
  const badge = healthBadge(binding, {
    ok: storeName ? `Connected to ${storeName}` : "Connected",
    needsReauth: "Needs sign-in",
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
        <Banner tone="danger">{binding.lastHealthDetail}</Banner>
      )}
      <TestOutcome result={test.result} />
      <SiteFacts config={config} />
      {rotating && (
        <>
          <Field label="New access token" hint="A sat_ token minted for this same site.">
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
        rotateLabel="Replace token"
        saveLabel="Save token"
        onSave={saveToken}
        saving={update.isPending}
        saveDisabled={!tokensValid(tokens)}
        onTest={() => test.run(binding.id)}
        testing={test.pending}
        confirmDelete={`Delete the "${binding.label || "default"}" Autoflow site binding for this project?`}
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
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-12">
      <dt className="text-subtle">Site</dt>
      <dd>
        {text(config, "shop") ?? "—"}
        {storeName && <span className="text-subtle"> · {storeName}</span>}
        {text(config, "storeId") && <span className="text-subtle"> · #{text(config, "storeId")}</span>}
      </dd>
      <dt className="text-subtle">Workspace</dt>
      <dd>{text(config, "orgId") ?? "— (run Test)"}</dd>
      <dt className="text-subtle">Platform</dt>
      <dd>{text(config, "baseUrl") ?? "https://auto.sidcorp.co"}</dd>
    </dl>
  );
}
