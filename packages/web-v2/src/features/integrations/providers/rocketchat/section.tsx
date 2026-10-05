"use client";

// ISS-609 — One binding per project: the org-shared bot credential (server URL + bot PAT + bot user
// id) lives on the connection; the rooms this project listens on (`rids`, 1..20) are binding-tier.
// Saving any of it hot-reloads the live bot socket server-side — no core restart.

import { Badge, Field, Input } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import { AgentAccessControl } from "../../components/agent-access-control";
import { useIntegrationsList, useOrgConnectionLocked, useUpdateProviderIntegration } from "../../hooks";
import type { IntegrationSummary } from "../../types";
import { BindingRowActions, healthBadge, OrgLockedNote, TestOutcome, useBindingTest } from "../shared";
import { AddRocketchatForm } from "./add-form";
import type { RocketchatReadConfig } from "./config";
import { RoomsField } from "./rooms-field";

export function RocketchatSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const binding = useMemo(() => (list.data?.items ?? []).find((i) => i.provider === "rocketchat"), [list.data]);

  if (list.isLoading) return <p className="fg-body-sm text-muted">Loading…</p>;
  if (!binding) return <AddRocketchatForm projectId={projectId} />;
  return (
    <div className="flex flex-col gap-4">
      <RocketchatBindingPanel projectId={projectId} binding={binding} />
    </div>
  );
}

function RocketchatBindingPanel({ projectId, binding }: { projectId: string; binding: IntegrationSummary }) {
  const update = useUpdateProviderIntegration(projectId);
  const list = useIntegrationsList(projectId);
  const test = useBindingTest(projectId, () => list.refetch());
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);
  const cfg = binding.config as RocketchatReadConfig;
  const savedRids = useMemo(() => cfg.rids ?? [], [cfg.rids]);
  const [authToken, setAuthToken] = useState("");
  const [botUserId, setBotUserId] = useState("");
  const [showRotate, setShowRotate] = useState(false);
  const badge = healthBadge(binding, { needsReauth: "Bot credential rejected" });

  async function write(body: { config?: { rids: string[] }; secrets?: Record<string, string> }) {
    test.setError(null);
    try {
      await update.mutateAsync({ id: binding.id, body });
      return true;
    } catch (err) {
      test.setError(formatApiError(err));
      return false;
    }
  }

  async function saveCredential() {
    const secrets: Record<string, string> = {};
    if (authToken.trim()) secrets.authToken = authToken.trim();
    if (botUserId.trim()) secrets.userId = botUserId.trim();
    if (Object.keys(secrets).length === 0 || !(await write({ secrets }))) return;
    setAuthToken("");
    setBotUserId("");
    setShowRotate(false);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="fg-body-sm font-semibold">{cfg.serverUrl ?? "Rocket.Chat"}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <p className="fg-body-sm text-muted">
        The bot answers @-mentions in the bound rooms, reads the discussion, and can capture it as a{" "}
        <span className="font-mono">draft</span> Forge issue. A human moves drafts to{" "}
        <span className="font-mono">open</span> to start the pipeline.
      </p>
      <TestOutcome error={test.error} result={test.result} okFallback="Bot credential OK" />
      <RoomsField
        projectId={projectId}
        bindingId={binding.id}
        savedRids={savedRids}
        saving={update.isPending}
        onSave={(rids) => write({ config: { rids } })}
      />
      {showRotate && !orgLocked && (
        <RotateFields authToken={authToken} onAuthToken={setAuthToken} botUserId={botUserId} onBotUserId={setBotUserId} />
      )}
      {orgLocked && <OrgLockedNote />}
      <BindingRowActions
        projectId={projectId}
        binding={binding}
        orgLocked={orgLocked}
        rotating={showRotate}
        setRotating={setShowRotate}
        rotateLabel="Rotate credential"
        saveLabel="Save credential"
        onSave={saveCredential}
        saving={update.isPending}
        saveDisabled={!authToken.trim() && !botUserId.trim()}
        onTest={() => test.run(binding.id)}
        testing={test.pending}
        confirmDelete="Disconnect the Rocket.Chat bot from this project?"
        deleteLabel="Disconnect"
      />
      <AgentAccessControl
        projectId={projectId}
        binding={binding}
        canEdit={!orgLocked}
        disabledReason="Org-shared credential — only an org owner/admin can grant it."
      />
    </div>
  );
}

function RotateFields(p: {
  authToken: string;
  onAuthToken: (v: string) => void;
  botUserId: string;
  onBotUserId: (v: string) => void;
}) {
  return (
    <>
      <Field label="New bot auth token" hint="Personal-access token of the bot user. Leave blank to keep the current one.">
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="bot PAT…"
          value={p.authToken}
          onChange={(e) => p.onAuthToken(e.target.value)}
        />
      </Field>
      <Field label="Bot user ID" hint="Only needed if the bot account changed.">
        <Input placeholder="bot user id…" value={p.botUserId} onChange={(e) => p.onBotUserId(e.target.value)} />
      </Field>
    </>
  );
}
