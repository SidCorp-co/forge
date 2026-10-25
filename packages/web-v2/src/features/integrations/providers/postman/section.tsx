"use client";


import {
  Badge,
  Banner,
  Button,
  CardTitle,
  Field,
  Input,
  SegmentedControl,
  SettingsSection,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useIntegrationsList,
  useProjectIntegrationActs,
  useTestIntegration,
  useUpdateProviderIntegration,
} from "../../hooks";
import type {
  IntegrationSummary,
  IntegrationTestResult,
  PostmanConfig,
  PostmanMode,
  PostmanRegion,
} from "../../types";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl, agentAccessBody, grantOnConnectWho, mayGrantOnConnect, reachesAgentsWhile} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { postman } from "./index";
import {
  bindsRemovedConnection,
  IntegrationEnabledControl,
  keyLockedLine,
  removedKeyHint,
} from "../../components/integration-enabled-control";
import { bindingBadge } from "../../derive";
import { DisconnectFromProject } from "../../components/disconnect-from-project";

const DEFAULT_WORKSPACE = "Forge Integration";

interface FormState {
  apiKey: string;
  workspaceName: string;
  workspaceId: string;
  collectionId: string;
  region: PostmanRegion;
  mode: PostmanMode;
}

function initialForm(existing: IntegrationSummary | undefined): FormState {
  const cfg = (existing?.config ?? {}) as Partial<PostmanConfig>;
  return {
    apiKey: "",
    workspaceName: cfg.workspaceName ?? DEFAULT_WORKSPACE,
    workspaceId: cfg.workspaceId ?? "",
    collectionId: cfg.collectionId ?? "",
    region: cfg.region ?? "us",
    mode: cfg.mode ?? "minimal",
  };
}

/** Build the config payload — omits empty optional ids so we don't store "". */
function toConfig(f: FormState): PostmanConfig {
  const cfg: PostmanConfig = {
    workspaceName: f.workspaceName.trim() || DEFAULT_WORKSPACE,
    region: f.region,
    mode: f.mode,
  };
  if (f.workspaceId.trim()) cfg.workspaceId = f.workspaceId.trim();
  if (f.collectionId.trim()) cfg.collectionId = f.collectionId.trim();
  return cfg;
}

/**
 * ISS-336 — Postman integration config form. Reads/writes the per-project
 * `postman` integration via the REST CRUD endpoints. The API key is masked,
 * write-only (never returned by the API), and only sent when the operator
 * types a new one. Test connection validates the key against Postman `GET /me`.
 */
export function PostmanSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const existing = useMemo(
    () => list.data?.items.find((i) => i.provider === "postman"),
    [list.data],
  );

  const create = useCreateProviderIntegration(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);

  // Re-seed the form whenever the loaded integration identity changes.
  const [form, setForm] = useState<FormState>(() => initialForm(existing));
  const [seededFor, setSeededFor] = useState<string | null>(
    existing?.id ?? null,
  );
  if ((existing?.id ?? null) !== seededFor) {
    setForm(initialForm(existing));
    setSeededFor(existing?.id ?? null);
  }

  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(
    null,
  );
  const [testError, setTestError] = useState<string | null>(null);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const keyRequired = !existing; // a brand-new integration must carry a key
  // Its whole form is the connection's tier, offered by what core says this reader may save
  // (ISS-1421 r27); Test connection stays open to every member.
  const may = useProjectIntegrationActs(projectId);
  const keyLocked = existing ? !existing.acts.saveKey : !may?.connect;
  const canSave =
    (!keyRequired || form.apiKey.trim().length >= 8) &&
    !create.isPending &&
    !update.isPending &&
    !keyLocked;

  async function handleSave() {
    setTestResult(null);
    setTestError(null);
    if (existing) {
      await update.mutateAsync({
        id: existing.id,
        body: {
          config: { ...toConfig(form) },
          ...(form.apiKey.trim()
            ? { secrets: { apiKey: form.apiKey.trim() } }
            : {}),
        },
      });
      setForm((f) => ({ ...f, apiKey: "" }));
    } else {
      await create.mutateAsync({
        provider: "postman",
        role: "service",
        config: { ...toConfig(form) },
        secrets: { apiKey: form.apiKey.trim() },
        ...agentAccessBody(postman.agentPathKind, agentAccess),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
      setForm((f) => ({ ...f, apiKey: "" }));
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


  const testUser = testResult?.diagnostics?.user;

  return (
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Postman</CardTitle>
          {existing && (
            <Badge tone={bindingBadge(existing).tone}>{bindingBadge(existing).label}</Badge>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          Store a Postman API key and the workspace Forge writes to. Being connected is not the same
          as being usable. {reachesAgentsWhile("The official Postman MCP tools")}
        </p>

        <Field
          label="API key"
          hint={
            existing && !existing.hasSecrets
              ? removedKeyHint("key", existing.acts)
              : existing
              ? "A key is stored. Leave blank to keep it; enter a new one to rotate."
              : "Postman API key (PMAK-…). Stored encrypted; never shown again."
          }
          required={keyRequired}
        >
          <Input
            type="password"
            autoComplete="off"
            placeholder={existing?.hasSecrets ? "•••••••• (unchanged)" : "PMAK-…"}
            value={form.apiKey}
            onChange={(e) => set("apiKey", e.target.value)}
            disabled={keyLocked}
          />
        </Field>

        {existing && keyLocked && (
          <p className="fg-body-sm text-muted">{keyLockedLine(existing.acts)}</p>
        )}

        {!existing && (
          <ConnectionOwnerField
            projectId={projectId}
            value={ownerOrgId}
            onChange={setOwnerOrgId}
          />
        )}
        {/* The workspace, region and mode are the connection's, as the key is (ISS-1421 r27). */}
        <fieldset disabled={keyLocked} className="contents">
          <Field
            label="Workspace name"
            hint="The Postman workspace this project writes into."
          >
            <Input
              value={form.workspaceName}
              onChange={(e) => set("workspaceName", e.target.value)}
              placeholder={DEFAULT_WORKSPACE}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Workspace ID" hint="Optional — the workspace UUID.">
              <Input
                value={form.workspaceId}
                onChange={(e) => set("workspaceId", e.target.value)}
                placeholder="(optional)"
              />
            </Field>
            <Field
              label="Collection ID"
              hint="Optional — the collection to write."
            >
              <Input
                value={form.collectionId}
                onChange={(e) => set("collectionId", e.target.value)}
                placeholder="(optional)"
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <div className="flex flex-col gap-1.5">
              <span className="fg-label">Region</span>
              <SegmentedControl<PostmanRegion>
                value={form.region}
                onChange={(v) => set("region", v)}
                options={[
                  { value: "us", label: "US" },
                  { value: "eu", label: "EU" },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="fg-label">Mode</span>
              <SegmentedControl<PostmanMode>
                value={form.mode}
                onChange={(v) => set("mode", v)}
                options={[
                  { value: "minimal", label: "Minimal" },
                  { value: "full", label: "Full" },
                ]}
              />
            </div>
          </div>
        </fieldset>

        {testError && <Banner tone="danger">{testError}</Banner>}
        {testResult &&
          (testResult.status === "ok" ? (
            <Banner tone="success">
              Connected{testUser?.username ? ` as ${testUser.username}` : ""}
              {testUser?.email ? ` (${testUser.email})` : ""}.
            </Banner>
          ) : (
            <Banner tone="danger">
              {testResult.message ?? "Connection failed"}
            </Banner>
          ))}

        {existing ? (
          <AgentAccessControl
            projectId={projectId}
            binding={existing} />
        ) : (
          <AgentAccessChoice
            value={agentAccess}
            onChange={setAgentAccess}
            pathKind={postman.agentPathKind}
            canEdit={mayGrantOnConnect(postman.agentPathKind, may)}
            disabledReason={grantOnConnectWho(postman.agentPathKind, may)}
          />
        )}

        {existing && <IntegrationEnabledControl projectId={projectId} binding={existing} />}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-3">
            {/* Not drawn for a reader core would refuse the save; the line above names who may (ISS-1421 r27). */}
            {!keyLocked && (
              <Button
                variant="primary"
                onClick={handleSave}
                loading={create.isPending || update.isPending}
                disabled={!canSave}
              >
                {existing ? "Save" : "Create integration"}
              </Button>
            )}
            {existing && !bindsRemovedConnection(existing) && (
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
            <DisconnectFromProject
              projectId={projectId}
              binding={existing}
              subject={"Postman"}
            />
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
