"use client";

// ISS-1036 — Google service account (project settings → Integrations → Google
// Sheets). One binding per project: the account's JSON key lives on the
// connection, which an org can share across every project; the spreadsheet this
// project reads by default is binding-tier, so two projects on one credential
// each keep their own sheet.

import { Badge, type BadgeProps, Banner, Button, ErrorState, Field, Input, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useOrgConnectionLocked,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../../hooks";
import type {IntegrationSummary, IntegrationTestResult} from "../../types";
import type { GoogleReadConfig } from "./config";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl, agentAccessBody} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { google } from "./index";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";

interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

// The five verdicts name five different next actions, so none of them shares a
// label with another — `needs_scope` in particular must not read as "re-enter
// the credential", because re-entering it reproduces the state exactly.
function badgeFor(existing: IntegrationSummary | undefined): BadgeView {
  if (!existing) return { label: "Not configured", tone: "amber" };
  if (!existing.active) return { label: "Disabled", tone: "neutral" };
  if (existing.lastHealthStatus === "ok") return { label: "Connected", tone: "green" };
  if (existing.lastHealthStatus === "needs_reauth")
    return { label: "Key rejected by Google", tone: "red" };
  if (existing.lastHealthStatus === "needs_scope")
    return { label: "Sheet not shared with the account", tone: "amber" };
  if (existing.lastHealthStatus === "degraded")
    return { label: "No default sheet to read", tone: "amber" };
  if (existing.lastHealthStatus === "error") return { label: "Error", tone: "red" };
  return { label: "Untested", tone: "neutral" };
}

/** The sentence that decides whether an operator's sheet is reachable. It is
 *  the same on both panels because it is the same mistake on both. */
function ShareHint({ clientEmail }: { clientEmail: string | null | undefined }) {
  return (
    <p className="fg-body-sm text-muted">
      A service account reaches only the sheets shared with it, exactly like a
      colleague would. Open the spreadsheet in Google, press Share, and add{" "}
      {clientEmail ? (
        <span className="font-mono">{clientEmail}</span>
      ) : (
        <>the account&apos;s <span className="font-mono">client_email</span></>
      )}{" "}
      — Viewer to read it, Editor to write to it.
    </p>
  );
}

export function GoogleSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const binding = useMemo(
    () => (list.data?.items ?? []).find((i) => i.provider === "google"),
    [list.data],
  );

  if (list.isLoading) return <p className="fg-body-sm text-muted">Loading…</p>;
  if (list.isError)
    return (
      <ErrorState
        message={`Could not read this project's integrations, so whether a Google account is already connected is unknown. ${formatApiError(list.error)}`}
        onRetry={() => list.refetch()}
        mascot={false}
      />
    );
  if (!binding) return <AddGoogleForm projectId={projectId} />;
  return <GoogleBindingPanel projectId={projectId} binding={binding} />;
}

// ─────────────────────────────────────────────────────────────
// Existing binding: default sheet, credential rotate, test/toggle/delete
// ─────────────────────────────────────────────────────────────

function GoogleBindingPanel({
  projectId,
  binding,
}: {
  projectId: string;
  binding: IntegrationSummary;
}) {
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const list = useIntegrationsList(projectId);
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);

  const cfg = binding.config as GoogleReadConfig;
  const savedSheet = cfg.defaultSpreadsheetId ?? "";
  const [sheetDraft, setSheetDraft] = useState<string | null>(null);
  const sheetValue = sheetDraft ?? savedSheet;
  const [keyJson, setKeyJson] = useState("");
  const [showRotate, setShowRotate] = useState(false);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badge = badgeFor(binding);

  async function saveDefaultSheet() {
    setError(null);
    try {
      await update.mutateAsync({
        id: binding.id,
        body: { config: { defaultSpreadsheetId: sheetValue.trim() } },
      });
      setSheetDraft(null);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function saveCredential() {
    setError(null);
    if (!keyJson.trim()) return;
    try {
      await update.mutateAsync({
        id: binding.id,
        body: { secrets: { serviceAccountJson: keyJson.trim() } },
      });
      setKeyJson("");
      setShowRotate(false);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function handleTest() {
    setTestResult(null);
    setError(null);
    try {
      setTestResult(await test.mutateAsync(binding.id));
      list.refetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  function handleDelete() {
    if (!window.confirm("Disconnect the Google service account from this project?")) return;
    remove.mutate(binding.id);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="fg-body-sm font-semibold">
          {cfg.clientEmail ?? "Google service account"}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      <p className="fg-body-sm text-muted">
        Agents read and write this project&apos;s sheets through Forge. The key stays
        in Forge — no session, prompt or runner box ever receives it.
      </p>

      {error && <Banner tone="danger">{error}</Banner>}
      {testResult &&
        (testResult.status === "ok" ? (
          <Banner tone="success">{testResult.message ?? "Google connection OK"}</Banner>
        ) : (
          <Banner tone="danger">{testResult.message ?? "Connection failed"}</Banner>
        ))}

      <Field
        label="Default spreadsheet"
        hint="The sheet a call that names none is about. It is the segment between /d/ and /edit in the spreadsheet's URL. This is per project — two projects sharing one account each keep their own."
      >
        <div className="flex items-center gap-2">
          <Input
            placeholder="1AbC…xYz"
            value={sheetValue}
            onChange={(e) => setSheetDraft(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={update.isPending}
            disabled={sheetDraft === null || sheetValue.trim() === savedSheet}
            onClick={saveDefaultSheet}
          >
            Save
          </Button>
        </div>
      </Field>

      <ShareHint clientEmail={cfg.clientEmail} />

      {showRotate && !orgLocked && (
        <Field
          label="New service-account key"
          hint="Paste the whole JSON key file Google issued. The old key keeps working for 24 hours so in-flight work is not stranded."
        >
          <Textarea
            rows={5}
            autoComplete="off"
            placeholder='{"type":"service_account", …}'
            value={keyJson}
            onChange={(e) => setKeyJson(e.target.value)}
          />
        </Field>
      )}

      {orgLocked && (
        <p className="fg-body-sm text-muted">
          Org-shared credential — only an org owner/admin can change it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!orgLocked &&
          (showRotate ? (
            <>
              <Button
                variant="primary"
                onClick={saveCredential}
                loading={update.isPending}
                disabled={!keyJson.trim()}
              >
                Save key
              </Button>
              <Button variant="secondary" onClick={() => setShowRotate(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setShowRotate(true)}>
              Rotate key
            </Button>
          ))}
        <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
          Test
        </Button>
        <IntegrationEnabledControl projectId={projectId} binding={binding} />
        <Button variant="danger" icon="trash" loading={remove.isPending} onClick={handleDelete}>
          Disconnect
        </Button>
      </div>

      <AgentAccessControl
        projectId={projectId}
        binding={binding}
        canEdit={true}
        disabledReason="Org-shared credential — only an org owner/admin can grant it."
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// First-time connect form
// ─────────────────────────────────────────────────────────────

function clientEmailOf(keyJson: string): string | null {
  try {
    const parsed = JSON.parse(keyJson) as {
      type?: unknown;
      client_email?: unknown;
      private_key?: unknown;
    };
    const whole =
      parsed.type === "service_account" &&
      typeof parsed.client_email === "string" &&
      parsed.client_email.length > 0 &&
      typeof parsed.private_key === "string" &&
      parsed.private_key.includes("PRIVATE KEY");
    return whole ? (parsed.client_email as string) : null;
  } catch {
    return null;
  }
}

function AddGoogleForm({ projectId }: { projectId: string }) {
  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const [keyJson, setKeyJson] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [error, setError] = useState<string | null>(null);

  const clientEmail = clientEmailOf(keyJson);
  const canSubmit = clientEmail !== null && !create.isPending;

  async function handleCreate() {
    setError(null);
    try {
      await create.mutateAsync({
        provider: "google",
        role: "service",
        config: spreadsheetId.trim() ? { defaultSpreadsheetId: spreadsheetId.trim() } : {},
        secrets: { serviceAccountJson: keyJson.trim() },
        ...agentAccessBody(google.agentPathKind, agentAccess),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-subtle p-4">
      <span className="fg-label font-semibold">Connect a Google service account</span>
      <p className="fg-body-sm text-muted">
        In the Google Cloud console: IAM &amp; Admin → Service Accounts → Keys → Add
        key → JSON. Paste the file below. Forge stores it encrypted and makes every
        Google call itself, so no agent ever holds it.
      </p>

      <ConnectionOwnerField projectId={projectId} value={ownerOrgId} onChange={setOwnerOrgId} />

      <Field
        label="Service-account key file"
        hint="The whole JSON file, unchanged. Stored encrypted; never shown again."
        required
      >
        <Textarea
          rows={6}
          autoComplete="off"
          placeholder='{"type":"service_account", "client_email":"…", "private_key":"…"}'
          value={keyJson}
          onChange={(e) => setKeyJson(e.target.value)}
        />
      </Field>

      {keyJson.trim().length > 0 && clientEmail === null && (
        <Banner tone="attention">
          That is not a service-account key file yet — it should be JSON carrying
          <span className="font-mono"> type</span>,
          <span className="font-mono"> client_email</span> and
          <span className="font-mono"> private_key</span>.
        </Banner>
      )}

      <Field
        label="Default spreadsheet"
        hint="Optional, and worth setting now: it is what Test reads to prove the account can actually reach a sheet."
      >
        <Input
          placeholder="1AbC…xYz"
          value={spreadsheetId}
          onChange={(e) => setSpreadsheetId(e.target.value)}
        />
      </Field>

      <ShareHint clientEmail={clientEmail} />

      <AgentAccessChoice
        value={agentAccess}
        onChange={setAgentAccess}
        pathKind={google.agentPathKind}
        canEdit={true}
      />

      {error && <Banner tone="danger">{error}</Banner>}

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={handleCreate}
          loading={create.isPending}
          disabled={!canSubmit}
        >
          Connect account
        </Button>
      </div>
    </div>
  );
}
