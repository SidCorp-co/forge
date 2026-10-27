"use client";

// ISS-1036 — Google service account (project settings → Integrations → Google
// Sheets). One binding per project: the account's JSON key lives on the
// connection, which an org can share across every project; the spreadsheet this
// project reads by default is binding-tier, so two projects on one credential
// each keep their own sheet.

import { Badge, Banner, Button, ErrorState, Field, Input, Textarea } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useIntegrationsList,
  useProjectIntegrationActs,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../../hooks";
import type {IntegrationSummary, IntegrationTestResult} from "../../types";
import type { GoogleReadConfig } from "./config";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl,
  agentAccessBody,
  grantOnConnectWho,
  mayGrantOnConnect,
} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { google } from "./index";
import {
  bindsRemovedConnection,
  IntegrationEnabledControl,
  keyLockedLine,
} from "../../components/integration-enabled-control";
import { bindingBadge, bindingForRow } from "../../derive";
import { DisconnectFromProject } from "../../components/disconnect-from-project";

/** What Google's own check found, under the badge that names the state as the row does: the five
 *  findings name five next actions, and `needs_scope` must not read as "re-enter the credential".
 *  Keyed on the check's finding, so an open breaker over a passing check is not called a missing sheet. */
const GOOGLE_CHECK_SAYS: Record<string, string> = {
  needs_reauth: "Google rejected the service account key.",
  needs_scope: "The sheet is not shared with the service account.",
  degraded: "No default sheet is set to read.",
};

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

export function GoogleSection({ projectId, bindingId }: { projectId: string; bindingId?: string }) {
  const list = useIntegrationsList(projectId);
  const binding = useMemo(
    () => bindingForRow(list.data?.items, "google", bindingId),
    [list.data, bindingId],
  );

  if (list.isLoading) return <p className="fg-body-sm text-muted">Loading…</p>;
  if (list.isError)
    return (
      <ErrorState title="Couldn't load this project's integrations"
        message={`Could not read this project's integrations, so whether a Google account is already connected is unknown. ${formatApiError(list.error)}`}
        error={list.error} onRetry={() => list.refetch()}
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
  const list = useIntegrationsList(projectId);
  // The key is the connection's tier and the default sheet the binding's, each offered by what core
  // says this reader may change (ISS-1421 r27).
  const keyLocked = !binding.acts.saveKey;
  const bindingLocked = !binding.acts.change;

  const cfg = binding.config as GoogleReadConfig;
  const savedSheet = cfg.defaultSpreadsheetId ?? "";
  const [sheetDraft, setSheetDraft] = useState<string | null>(null);
  const sheetValue = sheetDraft ?? savedSheet;
  const [keyJson, setKeyJson] = useState("");
  const [showRotate, setShowRotate] = useState(false);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const badge = bindingBadge(binding);
  const says =
    binding.active && binding.breakerOpenedAt === null
      ? GOOGLE_CHECK_SAYS[binding.lastHealthStatus ?? ""]
      : undefined;

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


  return (
    <div className="flex flex-col gap-3 border-t border-subtle pt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="fg-body-sm font-semibold">
          {cfg.clientEmail ?? "Google service account"}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {says ? <p className="fg-body-sm text-muted">{says}</p> : null}

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
            disabled={bindingLocked}
          />
          {!bindingLocked && (
            <Button
              variant="secondary"
              size="sm"
              loading={update.isPending}
              disabled={sheetDraft === null || sheetValue.trim() === savedSheet}
              onClick={saveDefaultSheet}
            >
              Save
            </Button>
          )}
        </div>
      </Field>

      <ShareHint clientEmail={cfg.clientEmail} />

      {showRotate && !keyLocked && (
        <Field
          label="New service-account key"
          hint="Paste the whole JSON key file Google issued. Forge keeps the previous key for 24 hours and signs in with it wherever Google refuses the new one."
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

      {keyLocked && <p className="fg-body-sm text-muted">{keyLockedLine(binding.acts)}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {!keyLocked &&
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
        {!bindsRemovedConnection(binding) && (
        <Button variant="secondary" onClick={handleTest} loading={test.isPending}>
          Test
        </Button>
        )}
        <DisconnectFromProject
          projectId={projectId}
          binding={binding}
          subject={"the Google service account"}
        />
      </div>

      <IntegrationEnabledControl projectId={projectId} binding={binding} />

      <AgentAccessControl projectId={projectId} binding={binding} />
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
  const may = useProjectIntegrationActs(projectId);
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
    <div className="flex flex-col gap-4 border-t border-subtle pt-4">
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
        canEdit={mayGrantOnConnect(google.agentPathKind, may)}
        disabledReason={grantOnConnectWho(google.agentPathKind, may)}
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
