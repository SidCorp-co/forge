"use client";

import {
  Badge,
  type BadgeProps,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  type SelectOption,
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
import type { AgentAccess, BindingRole, IntegrationSummary, IntegrationTestResult } from "../../types";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl,
  agentAccessBody,
  agentAccessDeniedReason,
  mayWriteAgentAccess,
} from "../../components/agent-access-control";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";
import { text } from "../config-read";
import { autoflow } from "./index";

// cm:edge contract -> packages/core/src/integrations/autoflow/schemas.ts — the site slug and the token prefix it refuses otherwise.
const SHOP_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LABEL_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const TOKEN_PREFIX = "sat_";
const REFRESH_PREFIX = "srt_";
const CLIENT_PREFIX = "mcpc_";

/** The refresh pair is optional, but the platform redeems a refresh token only with its client. */
function refreshPairError(refreshToken: string, clientId: string): string | null {
  const r = refreshToken.trim();
  const c = clientId.trim();
  if (!r && !c) return null;
  if (!r.startsWith(REFRESH_PREFIX)) return "The refresh token is the srt_… issued beside the access token.";
  if (!c.startsWith(CLIENT_PREFIX)) return "The client id is the mcpc_… the token pair was issued to.";
  return null;
}

function tokenSecrets(token: string, refreshToken: string, clientId: string): Record<string, string> {
  return {
    accessToken: token.trim(),
    ...(refreshToken.trim() ? { refreshToken: refreshToken.trim(), clientId: clientId.trim() } : {}),
  };
}

function RefreshPairFields({
  refreshToken,
  clientId,
  onRefreshToken,
  onClientId,
}: {
  refreshToken: string;
  clientId: string;
  onRefreshToken: (v: string) => void;
  onClientId: (v: string) => void;
}) {
  const error = refreshPairError(refreshToken, clientId);
  return (
    <>
      <Field
        label="Refresh token"
        hint="Optional. With it Forge renews the 12-hour access token itself, before it expires; without it the site needs a new token every day."
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="srt_…"
          value={refreshToken}
          onChange={(e) => onRefreshToken(e.target.value)}
        />
      </Field>
      <Field label="Client id" hint="The OAuth client the tokens were issued to; required with a refresh token.">
        <Input placeholder="mcpc_…" value={clientId} onChange={(e) => onClientId(e.target.value)} />
        {error && <p className="fg-body-sm text-danger">{error}</p>}
      </Field>
    </>
  );
}

const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "source", label: "Source — the site this project builds" },
  { value: "deploy", label: "Deploy target — where a release publishes" },
  { value: "service", label: "Service — a project-wide facility" },
];

function badgeFor(binding: IntegrationSummary): { label: string; tone: NonNullable<BadgeProps["tone"]> } {
  if (!binding.active) return { label: "Disabled", tone: "neutral" };
  if (binding.lastHealthStatus === "ok") {
    const name = text(binding.config, "storeName");
    return { label: name ? `Connected to ${name}` : "Connected", tone: "green" };
  }
  if (binding.lastHealthStatus === "needs_reauth") return { label: "Needs sign-in", tone: "red" };
  if (binding.lastHealthStatus === "error") return { label: "Error", tone: "red" };
  return { label: "Untested", tone: "neutral" };
}

/** Autoflow sites bound to this project: the site a project runs on, and its Backend Builder flows. */
export function AutoflowSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);
  const bindings = useMemo(
    () =>
      (list.data?.items ?? [])
        .filter((i) => i.provider === "autoflow")
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [list.data],
  );
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Autoflow sites</CardTitle>
          {bindings.length > 0 && <Badge tone="green">{bindings.length} connected</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="fg-body-sm text-muted">
            A project that runs on Autoflow builds one site and its flows through the shop MCP. Each
            binding names the site (<span className="font-mono">shop</span>, the{" "}
            <span className="font-mono">&lt;shop&gt;</span> of{" "}
            <span className="font-mono">&lt;shop&gt;.auto.sidcorp.co</span>) and holds the OAuth access
            token (<span className="font-mono">sat_…</span>) minted for that site. An access token lives
            12 hours; stored with its refresh token (<span className="font-mono">srt_…</span>), Forge renews it
            itself.
          </p>
          {list.isLoading && <p className="fg-body-sm text-muted">Loading…</p>}
          {!list.isLoading && bindings.length === 0 && (
            <p className="fg-body-sm text-muted italic">No Autoflow site configured.</p>
          )}
          {bindings.map((binding, idx) => (
            <AutoflowBindingRow key={binding.id} projectId={projectId} binding={binding} isDefault={idx === 0} />
          ))}
          {adding ? (
            <AddAutoflowForm
              projectId={projectId}
              hasDefault={bindings.length > 0}
              onDone={() => setAdding(false)}
            />
          ) : (
            <Button className="self-start" variant="secondary" onClick={() => setAdding(true)}>
              Add site
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
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
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const list = useIntegrationsList(projectId);
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);
  const [token, setToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [rotating, setRotating] = useState(false);
  const [result, setResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const badge = badgeFor(binding);
  const label = (binding as { label?: string }).label ?? "";
  const config = binding.config ?? {};
  const shop = text(config, "shop");

  async function saveToken() {
    setError(null);
    try {
      await update.mutateAsync({
        id: binding.id,
        body: { secrets: tokenSecrets(token, refreshToken, clientId) },
      });
      setToken("");
      setRefreshToken("");
      setClientId("");
      setRotating(false);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function runTest() {
    setResult(null);
    setError(null);
    try {
      setResult(await test.mutateAsync(binding.id));
      list.refetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  function handleDelete() {
    if (!window.confirm(`Delete the "${label || "default"}" Autoflow site binding for this project?`)) return;
    remove.mutate(binding);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">{label || "default"}</span>
          {isDefault && <Badge tone="neutral">default</Badge>}
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {binding.lastHealthStatus === "needs_reauth" && binding.lastHealthDetail && !result && (
        <Banner tone="danger">{binding.lastHealthDetail}</Banner>
      )}
      {result && (
        <Banner tone={result.status === "ok" ? "success" : "danger"}>
          {result.message ?? (result.status === "ok" ? "Connection OK" : "Connection failed")}
        </Banner>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-12">
        <dt className="text-subtle">Site</dt>
        <dd>
          {shop ?? "—"}
          {text(config, "storeName") && <span className="text-subtle"> · {text(config, "storeName")}</span>}
          {text(config, "storeId") && <span className="text-subtle"> · #{text(config, "storeId")}</span>}
        </dd>
        <dt className="text-subtle">Workspace</dt>
        <dd>{text(config, "orgId") ?? "— (run Test)"}</dd>
        <dt className="text-subtle">Platform</dt>
        <dd>{text(config, "baseUrl") ?? "https://auto.sidcorp.co"}</dd>
      </dl>
      {rotating && (
        <Field label="New access token" hint="A sat_ token minted for this same site.">
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="sat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
      )}
      {rotating && (
        <RefreshPairFields
          refreshToken={refreshToken}
          clientId={clientId}
          onRefreshToken={setRefreshToken}
          onClientId={setClientId}
        />
      )}
      {orgLocked && (
        <p className="fg-body-sm text-muted">Org-shared credential — only an org owner/admin can change it.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!orgLocked &&
          (rotating ? (
            <>
              <Button
                variant="primary"
                onClick={saveToken}
                loading={update.isPending}
                disabled={
                  !token.trim().startsWith(TOKEN_PREFIX) || refreshPairError(refreshToken, clientId) !== null
                }
              >
                Save token
              </Button>
              <Button variant="secondary" onClick={() => setRotating(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setRotating(true)}>
              Replace token
            </Button>
          ))}
        <Button variant="secondary" onClick={runTest} loading={test.isPending}>
          Test
        </Button>
        <IntegrationEnabledControl projectId={projectId} binding={binding} />
        <Button variant="danger" icon="trash" loading={remove.isPending} onClick={handleDelete}>
          Delete
        </Button>
      </div>
      <AgentAccessControl
        projectId={projectId}
        binding={binding}
        canEdit={true}
        disabledReason={agentAccessDeniedReason("direct-mcp")}
      />
    </div>
  );
}

function AddAutoflowForm({
  projectId,
  hasDefault,
  onDone,
}: {
  projectId: string;
  hasDefault: boolean;
  onDone: () => void;
}) {
  const create = useCreateProviderIntegration(projectId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [shop, setShop] = useState("");
  const [token, setToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [role, setRole] = useState<BindingRole>("source");
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [error, setError] = useState<string | null>(null);

  const shopError = shop && !SHOP_REGEX.test(shop) ? "The site slug: lowercase letters, digits and dashes." : null;
  const tokenError =
    token && !token.trim().startsWith(TOKEN_PREFIX)
      ? "The shop MCP admits only the OAuth access token (sat_…); a wmk_ API key or srt_ refresh token is refused there."
      : null;
  const labelError = label && !LABEL_REGEX.test(label) ? "Label must be kebab-case (e.g. staging)." : null;
  const canSubmit =
    SHOP_REGEX.test(shop) &&
    token.trim().startsWith(TOKEN_PREFIX) &&
    refreshPairError(refreshToken, clientId) === null &&
    (!hasDefault || (label.length > 0 && !labelError)) &&
    !create.isPending;

  async function handleCreate() {
    setError(null);
    try {
      await create.mutateAsync({
        provider: "autoflow",
        role,
        config: { shop },
        secrets: tokenSecrets(token, refreshToken, clientId),
        ...agentAccessBody(autoflow.agentPathKind, agentAccess),
        ...(label ? { label } : {}),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      });
      onDone();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-subtle p-4">
      <span className="fg-label font-semibold">Add site</span>
      <ConnectionOwnerField projectId={projectId} value={ownerOrgId} onChange={setOwnerOrgId} />
      {hasDefault && (
        <Field label="Label" hint="Unique kebab-case name for this binding." required>
          <Input placeholder="staging" value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} />
          {labelError && <p className="fg-body-sm text-danger">{labelError}</p>}
        </Field>
      )}
      <Field label="Site (shop)" hint="The <shop> of <shop>.auto.sidcorp.co." required>
        <Input placeholder="hop" value={shop} onChange={(e) => setShop(e.target.value.toLowerCase())} />
        {shopError && <p className="fg-body-sm text-danger">{shopError}</p>}
      </Field>
      <Field
        label="Access token"
        hint="Minted by signing in to Sidcorp Auto through an MCP client and picking this workspace and site. Stored encrypted."
        required
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="sat_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        {tokenError && <p className="fg-body-sm text-danger">{tokenError}</p>}
      </Field>
      <RefreshPairFields
        refreshToken={refreshToken}
        clientId={clientId}
        onRefreshToken={setRefreshToken}
        onClientId={setClientId}
      />
      <Field label="What is it for" required>
        <Select options={ROLE_SELECT_OPTIONS} value={role} onChange={(v) => setRole(v as BindingRole)} />
      </Field>
      <AgentAccessChoice
        value={agentAccess}
        onChange={setAgentAccess}
        pathKind={autoflow.agentPathKind}
        canEdit={mayWriteAgentAccess(autoflow.agentPathKind, { canEditProject: true, isOrgAdmin })}
      />
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={handleCreate} loading={create.isPending} disabled={!canSubmit}>
          Add site
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
