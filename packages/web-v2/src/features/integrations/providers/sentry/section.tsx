"use client";

import {
  Badge,
  Banner,
  Button,
  CardTitle,
  Field,
  Input,
  SettingsSection,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useDeleteProviderIntegration,
  useIntegrationsList,
  useIsOrgAdmin,
  useOrgConnectionLocked,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../../hooks";
import type {
  IntegrationSummary,
  IntegrationTestResult,
  SentryConfig,
} from "../../types";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl, agentAccessBody, agentAccessDeniedReason, mayWriteAgentAccess} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { sentry } from "./index";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";
import {
  initialTargets,
  rowInvalid,
  SentryTargetsField,
  type TargetRow,
  toTargets,
} from "./targets-field";
import { STATE_WORDS } from "../../derive";

interface FormState {
  authToken: string;
  host: string;
  targets: TargetRow[];
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as Partial<SentryConfig>;
  return {
    authToken: "",
    host: cfg.host ?? "",
    targets: initialTargets(cfg.targets),
  };
}

/**
 * ISS-524 / ISS-526 / ISS-1380 — Sentry integration config form. One connection (host + masked,
 * write-only auth token) is shared by the projects bound to it; THIS project's integration holds its
 * own LIST of labelled targets (backend / frontend / mobile …), picked from the Sentry projects the
 * token can read. The official `@sentry/mcp-server` MCP tools reach this project's agents only where
 * the binding's `agentAccess` grant is on; the target list is surfaced in the agent's prompt so it
 * queries the right org/project, and no agent can name a target another project's integration holds.
 * Test connection validates the token against Sentry `GET /api/0/organizations/`.
 */
export function SentrySection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === "sentry"),
    [list.data],
  );

  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);

  // Re-seed the form whenever the loaded integration identity changes.
  const [form, setForm] = useState<FormState>(() => initialForm(existing));
  const [seededFor, setSeededFor] = useState<string | null>(existing?.id ?? null);
  if ((existing?.id ?? null) !== seededFor) {
    setForm(initialForm(existing));
    setSeededFor(existing?.id ?? null);
  }

  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [listRequested, setListRequested] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const keyRequired = !existing; // a brand-new integration must carry a token
  const hostRequired = !existing || !form.host.trim();
  const hasInvalidTarget = form.targets.some(rowInvalid);
  // Org-shared credential: only an org owner/admin may change config/secrets/
  // active. Test connection stays enabled (binding-level, project admin OK).
  const orgLocked = useOrgConnectionLocked(projectId, existing?.connectionId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  // The host and token belong to the shared connection, so an org-owned one locks them; the targets
  // are this project's own and stay editable, which is why a lock does not disable the save.
  const canSave =
    form.host.trim().length > 0 &&
    (!keyRequired || form.authToken.trim().length >= 8) &&
    !hasInvalidTarget &&
    !create.isPending &&
    !update.isPending;
  const storedHost = ((existing?.config ?? {}) as Partial<SentryConfig>).host ?? "";

  async function handleSave() {
    setTestResult(null);
    setTestError(null);
    if (existing) {
      // Only what changed at the connection tier is sent: any connection-tier key makes the server
      // ask for an org admin, which a project admin editing their own targets is not.
      const hostChanged = !orgLocked && form.host.trim() !== storedHost;
      await update.mutateAsync({
        id: existing.id,
        body: {
          config: {
            targets: toTargets(form.targets),
            ...(hostChanged ? { host: form.host.trim() } : {}),
          },
          ...(form.authToken.trim() && !orgLocked
            ? { secrets: { authToken: form.authToken.trim() } }
            : {}),
        },
      });
      setForm((f) => ({ ...f, authToken: "" }));
    } else {
      await create.mutateAsync({
        provider: "sentry",
        role: "service",
        config: { host: form.host.trim(), targets: toTargets(form.targets) },
        secrets: { authToken: form.authToken.trim() },
        ...agentAccessBody(sentry.agentPathKind, agentAccess),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
      setForm((f) => ({ ...f, authToken: "" }));
    }
  }

  async function handleTest() {
    if (!existing) return;
    setTestResult(null);
    setTestError(null);
    try {
      const res = await test.mutateAsync(existing.id);
      setTestResult(res);
    } catch (err) {
      setTestError(formatApiError(err));
    }
  }


  return (
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Sentry</CardTitle>
          {existing && (
            <Badge tone={existing.active ? "green" : "neutral"}>
              {existing.active ? "Active" : STATE_WORDS.off}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Store one Sentry host + auth token, then pick the Sentry projects this project&apos;s
          agents may read (e.g. backend, frontend, mobile). The official Sentry MCP tools reach
          this project&apos;s agents only once the grant below is on; the target list is then
          shared with them so they query the right org/project.
        </p>

        <Field
          label="Sentry host"
          hint="The Sentry instance host without scheme, e.g. logs.canawan.com or sentry.io."
          required={hostRequired}
        >
          <Input
            value={form.host}
            onChange={(e) => set("host", e.target.value)}
            placeholder="logs.canawan.com"
            disabled={orgLocked}
          />
        </Field>

        <Field
          label="Auth token"
          hint={
            existing
              ? "A token is stored. Leave blank to keep it; enter a new one to rotate."
              : "Sentry user auth token (sntryu-…). Stored encrypted; never shown again."
          }
          required={keyRequired}
        >
          <Input
            type="password"
            autoComplete="off"
            placeholder={existing ? "•••••••• (unchanged)" : "sntryu_…"}
            value={form.authToken}
            onChange={(e) => set("authToken", e.target.value)}
            disabled={orgLocked}
          />
        </Field>

        {orgLocked && (
          <p className="fg-body-sm text-muted">
            Org-shared credential — only an org owner/admin can change its host and token. This project&apos;s Sentry projects below stay editable.
          </p>
        )}

        {!existing && (
          <ConnectionOwnerField
            projectId={projectId}
            value={ownerOrgId}
            onChange={setOwnerOrgId}
          />
        )}

        <SentryTargetsField
          projectId={projectId}
          integrationId={existing?.id}
          host={form.host}
          authToken={form.authToken}
          loading={list.isPending}
          credentialUnsaved={
            Boolean(existing) &&
            !orgLocked &&
            (form.host.trim() !== storedHost || form.authToken.trim() !== "")
          }
          listRequested={listRequested}
          onRequestList={() => setListRequested(true)}
          rows={form.targets}
          onChange={(next) => set("targets", next)}
        />

        {testError && <Banner tone="danger">{testError}</Banner>}
        {testResult &&
          (testResult.status === "ok" ? (
            <Banner tone="success">
              {testResult.message ?? "Connected."}
            </Banner>
          ) : (
            <Banner tone="danger">
              {testResult.message ?? "Connection failed"}
            </Banner>
          ))}

        {existing ? (
          <AgentAccessControl
            projectId={projectId}
            binding={existing}
            canEdit={true}
            disabledReason={agentAccessDeniedReason("direct-mcp")}
          />
        ) : (
          <AgentAccessChoice
            value={agentAccess}
            onChange={setAgentAccess}
            pathKind={sentry.agentPathKind}
            canEdit={mayWriteAgentAccess(sentry.agentPathKind, { canEditProject: true, isOrgAdmin })}
            disabledReason={agentAccessDeniedReason("direct-mcp")}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              onClick={handleSave}
              loading={create.isPending || update.isPending}
              disabled={!canSave}
            >
              {existing ? "Save" : "Create integration"}
            </Button>
            {existing && (
              <Button
                variant="secondary"
                onClick={handleTest}
                loading={test.isPending}
              >
                Test connection
              </Button>
            )}
          </div>
          {existing && (
            <div className="flex items-center gap-4">
              <IntegrationEnabledControl
                projectId={projectId}
                binding={existing}
              />
              <Button
                variant="danger"
                icon="trash"
                loading={remove.isPending}
                onClick={() => remove.mutate(existing.id)}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
