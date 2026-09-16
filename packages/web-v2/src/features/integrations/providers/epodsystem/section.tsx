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
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
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
  BindingRole,
  DeployStage,
  IntegrationSummary,
  IntegrationTestResult,
} from "../../types";
import type { EpodsystemReadConfig } from "./config";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  AgentAccessControl, agentAccessBody, agentAccessDeniedReason, mayWriteAgentAccess} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { epodsystem } from "./index";
import { IntegrationEnabledControl } from "../../components/integration-enabled-control";

// Scopes a website build needs to publish themes + toggle commerce/cache.
const REQUIRED_SCOPES = ["products:write", "webstore:write", "settings:write"];

// Kebab-case label: starts with alphanumeric, followed by alphanumeric or dashes.
const LABEL_REGEX = /^[a-z0-9][a-z0-9-]*$/;

// cm:edge contract -> packages/web-v2/src/features/project-settings/components/integrations-tab.tsx — the same two declarations, worded the same way, because the two create forms reach the same columns
const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "service", label: "Service — a project-wide facility" },
  { value: "deploy", label: "Deploy target — somewhere Forge deploys to" },
];

const STAGE_CHOICES: { value: DeployStage; label: string; hint: string }[] = [
  { value: "preview", label: "Preview", hint: "the draft theme, seen before it counts" },
  { value: "live", label: "Live", hint: "the published theme real customers are on" },
];

interface BadgeView {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

function badgeFor(existing: IntegrationSummary | undefined): BadgeView {
  if (!existing) return { label: "Not configured", tone: "amber" };
  if (!existing.active) return { label: "Disabled", tone: "neutral" };
  if (existing.lastHealthStatus === "ok") {
    const name = (existing.config as EpodsystemReadConfig).storeName;
    return {
      label: name ? `Connected to ${name}` : "Connected",
      tone: "green",
    };
  }
  if (existing.lastHealthStatus === "error")
    return { label: "Invalid key", tone: "red" };
  return { label: "Untested", tone: "neutral" };
}

/**
 * ISS-395 / ISS-387 / ISS-558 — Epodsystem storefront integration config.
 * ISS-558: supports multiple stores per project — renders a list of bindings
 * plus an Add form. Each binding has its own label (empty = default).
 */
export function EpodsystemSection({ projectId }: { projectId: string }) {
  const list = useIntegrationsList(projectId);

  // All epodsystem bindings, oldest first (matches resolver ordering).
  const epodsystemBindings = useMemo(
    () =>
      (list.data?.items ?? [])
        .filter((i) => i.provider === "epodsystem")
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [list.data],
  );

  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Epodsystem storefronts</CardTitle>
          {epodsystemBindings.length > 0 && (
            <Badge tone="green">{epodsystemBindings.length} connected</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="fg-body-sm text-muted">
            Connect one or more Epodsystem storefronts to this project. Each
            storefront needs its own{" "}
            <span className="font-mono">crmk_</span> API key. The first
            (unlabeled) connection is the default. Extra connections require a
            unique kebab-case label (e.g.{" "}
            <span className="font-mono">partner-a</span>).
          </p>

          {list.isLoading && (
            <p className="fg-body-sm text-muted">Loading…</p>
          )}

          {!list.isLoading && epodsystemBindings.length === 0 && (
            <p className="fg-body-sm text-muted italic">
              No Epodsystem storefronts configured.
            </p>
          )}

          {epodsystemBindings.map((binding, idx) => (
            <EpodsystemBindingRow
              key={binding.id}
              projectId={projectId}
              binding={binding}
              isDefault={idx === 0}
            />
          ))}

          {showAddForm ? (
            <AddEpodsystemForm
              projectId={projectId}
              hasDefault={epodsystemBindings.length > 0}
              onCancel={() => setShowAddForm(false)}
              onCreated={() => setShowAddForm(false)}
            />
          ) : (
            <div>
              <Button
                variant="secondary"
                onClick={() => setShowAddForm(true)}
              >
                Add storefront
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Per-binding row
// ─────────────────────────────────────────────────────────────

interface EpodsystemBindingRowProps {
  projectId: string;
  binding: IntegrationSummary;
  isDefault: boolean;
}

function EpodsystemBindingRow({
  projectId,
  binding,
  isDefault,
}: EpodsystemBindingRowProps) {
  const update = useUpdateProviderIntegration(projectId);
  const test = useTestIntegration(projectId);
  const remove = useDeleteProviderIntegration(projectId);
  const list = useIntegrationsList(projectId);
  const orgLocked = useOrgConnectionLocked(projectId, binding.connectionId);

  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKeyField, setShowKeyField] = useState(false);

  const badge = badgeFor(binding);
  const bindingLabel = (binding as { label?: string }).label ?? "";

  async function handleSaveKey() {
    if (!apiKey.trim()) return;
    setError(null);
    try {
      await update.mutateAsync({
        id: binding.id,
        body: { secrets: { apiKey: apiKey.trim() } },
      });
      setApiKey("");
      setShowKeyField(false);
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  async function handleTest() {
    setTestResult(null);
    setError(null);
    try {
      const res = await test.mutateAsync(binding.id);
      setTestResult(res);
      list.refetch();
    } catch (err) {
      setError(formatApiError(err));
    }
  }


  function handleDelete() {
    const label = bindingLabel || "default";
    if (
      !window.confirm(
        `Delete the "${label}" Epodsystem integration for this project?`,
      )
    )
      return;
    remove.mutate(binding.id);
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {bindingLabel ? (
            <span className="font-mono text-sm font-semibold">
              {bindingLabel}
            </span>
          ) : (
            <span className="fg-body-sm font-semibold text-muted">
              default
            </span>
          )}
          {isDefault && (
            <Badge tone="neutral">default</Badge>
          )}
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>

      {error && <Banner tone="danger">{error}</Banner>}
      {testResult &&
        (testResult.status === "ok" ? (
          <Banner tone="success">
            {testResult.message ?? "Connection OK"}
          </Banner>
        ) : (
          <Banner tone="danger">
            {testResult.message ?? "Connection failed"}
          </Banner>
        ))}

      {showKeyField && (
        <Field
          label="New API key"
          hint="Enter the new crmk_ key to rotate. Leave blank to keep the current key."
        >
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

      {orgLocked && (
        <p className="fg-body-sm text-muted">
          Org-shared credential — only an org owner/admin can change it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!orgLocked && (
          showKeyField ? (
            <>
              <Button
                variant="primary"
                onClick={handleSaveKey}
                loading={update.isPending}
                disabled={!apiKey.trim()}
              >
                Save key
              </Button>
              <Button variant="secondary" onClick={() => setShowKeyField(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setShowKeyField(true)}>
              Rotate key
            </Button>
          )
        )}
        <Button
          variant="secondary"
          onClick={handleTest}
          loading={test.isPending}
        >
          Test
        </Button>
        <IntegrationEnabledControl projectId={projectId} binding={binding} />
        <Button
          variant="danger"
          icon="trash"
          loading={remove.isPending}
          onClick={handleDelete}
        >
          Delete
        </Button>
      </div>

      <AgentAccessControl
        projectId={projectId}
        binding={binding}
        canEdit={true}
        disabledReason={agentAccessDeniedReason("direct-mcp")}
      />

      <ThemePanel config={binding.config as EpodsystemReadConfig} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Add-storefront form
// ─────────────────────────────────────────────────────────────

interface AddEpodsystemFormProps {
  projectId: string;
  hasDefault: boolean;
  onCancel: () => void;
  onCreated: () => void;
}

function AddEpodsystemForm({
  projectId,
  hasDefault,
  onCancel,
  onCreated,
}: AddEpodsystemFormProps) {
  const create = useCreateProviderIntegration(projectId);
  const isOrgAdmin = useIsOrgAdmin(projectId);
  const [ownerOrgId, setOwnerOrgId] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [role, setRole] = useState<BindingRole>("service");
  const [stages, setStages] = useState<DeployStage[]>([]);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [error, setError] = useState<string | null>(null);

  const canDeploy = providerCanDeploy("epodsystem");

  const labelError =
    label && !LABEL_REGEX.test(label)
      ? "Label must be kebab-case (lowercase letters, numbers, dashes; e.g. partner-a)"
      : null;

  const canSubmit =
    apiKey.trim().length >= 8 &&
    (!hasDefault || (label.trim().length > 0 && !labelError)) &&
    !create.isPending;

  // cm:guard the role picker CLEARS the stages it hides. A hidden control whose value
  // still submits is how a service binding reaches the server carrying a stage, which
  // the database refuses by constraint (`integration_bindings_role_stages_chk`) — a 500
  // where the form could simply not have sent it.
  function chooseRole(next: BindingRole) {
    setRole(next);
    setError(null);
    if (next === "service") setStages([]);
  }

  function toggleStage(stage: DeployStage) {
    setError(null);
    setStages((cur) =>
      cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage],
    );
  }

  async function handleCreate() {
    setError(null);
    // cm:guard this refusal is the FORM's, said before the round trip and naming the
    // remedy: the database refuses a deploy binding with no stage, and "400 Bad Request"
    // names neither the field nor what a valid value looks like.
    if (role === "deploy" && stages.length === 0) {
      setError(
        "Choose at least one stage — a deploy target has to serve Preview, Live or both.",
      );
      return;
    }
    try {
      // cm:guard the two arms are written out rather than spread onto one object: the create body is
      // discriminated on `role`, a spread collapses to the union `BindingRole` that no arm admits,
      // and the discriminant is what makes a service binding carrying a stage a compile error here
      // instead of a 500 from the `integration_bindings_role_stages_chk` constraint.
      const common = {
        provider: "epodsystem",
        config: {},
        secrets: { apiKey: apiKey.trim() },
        ...agentAccessBody(epodsystem.agentPathKind, agentAccess),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(ownerOrgId ? { orgId: ownerOrgId } : {}),
      } as const;
      await create.mutateAsync(
        role === "deploy"
          ? { ...common, role: "deploy", stages: stages as [DeployStage, ...DeployStage[]] }
          : { ...common, role: "service" },
      );
      onCreated();
    } catch (err) {
      setError(formatApiError(err));
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-subtle p-4">
      <span className="fg-label font-semibold">Add storefront</span>

      <ConnectionOwnerField
        projectId={projectId}
        value={ownerOrgId}
        onChange={setOwnerOrgId}
      />

      {hasDefault && (
        <Field
          label="Label"
          hint="Unique kebab-case name for this storefront (e.g. partner-a). Required for extra connections."
          required
        >
          <Input
            placeholder="partner-a"
            value={label}
            onChange={(e) => setLabel(e.target.value.toLowerCase())}
          />
          {labelError && (
            <p className="fg-body-sm text-danger">{labelError}</p>
          )}
        </Field>
      )}

      <Field
        label="API key"
        hint="Epodsystem API key (crmk_…). Stored encrypted; never shown again."
        required
      >
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="crmk_…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </Field>

      <Field
        label="What is it for"
        hint="A storefront this project publishes to is a deploy target. One it only borrows (an MCP, a product feed) is a service."
        required
      >
        <Select
          options={ROLE_SELECT_OPTIONS}
          value={role}
          onChange={(v) => chooseRole(v as BindingRole)}
          disabled={create.isPending}
        />
      </Field>

      {role === "deploy" && canDeploy && (
        <Field label="Which stages" required>
          <div className="flex flex-col gap-2">
            {STAGE_CHOICES.map((choice) => (
              <label key={choice.value} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={stages.includes(choice.value)}
                  onChange={() => toggleStage(choice.value)}
                  disabled={create.isPending}
                />
                <span className="fg-body-sm">
                  {choice.label}
                  <span className="text-muted"> — {choice.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
      )}

      {role === "deploy" && !canDeploy && (
        <Banner tone="attention">
          Forge cannot deploy to Epodsystem — it has no deploy adapter. Add it as a service
          instead.
        </Banner>
      )}

      <AgentAccessChoice
        value={agentAccess}
        onChange={setAgentAccess}
        pathKind={epodsystem.agentPathKind}
        canEdit={mayWriteAgentAccess(epodsystem.agentPathKind, { canEditProject: true, isOrgAdmin })}
      />

      {error && <Banner tone="danger">{error}</Banner>}

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={handleCreate}
          loading={create.isPending}
          disabled={!canSubmit}
        >
          Add storefront
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Read-only theme panel
// ─────────────────────────────────────────────────────────────

function ThemePanel({ config }: { config: EpodsystemReadConfig }) {
  const storefrontUrl = config.domain
    ? `https://${config.domain}`
    : config.storeSlug
      ? `https://${config.storeSlug}.epodsystem.com`
      : null;
  const scopes = config.scopes ?? null;
  const hasWildcard = scopes?.includes("*") ?? false;
  const missingScopes =
    scopes && !hasWildcard
      ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
      : [];

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-sunken p-3">
      <span className="fg-label text-subtle">Store &amp; themes</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
        <dt className="text-subtle">Store</dt>
        <dd>
          {config.storeName ?? config.storeSlug ?? "— (run Test)"}
          {config.storeId && (
            <span className="text-subtle"> · #{config.storeId}</span>
          )}
          {config.orgId && (
            <span className="text-subtle"> · org {config.orgId}</span>
          )}
        </dd>
        <dt className="text-subtle">Domain</dt>
        <dd>{config.domain ?? "—"}</dd>
        <dt className="text-subtle">Theme (main / prod)</dt>
        <dd>
          {config.themeId ?? "—"}
          {config.themeName && (
            <span className="text-subtle"> · {config.themeName}</span>
          )}
        </dd>
        <dt className="text-subtle">Theme (draft / staging)</dt>
        <dd>{config.draftThemeId ?? "— (created at build time)"}</dd>
        <dt className="text-subtle">Commerce</dt>
        <dd>
          {config.commerceEnabled == null
            ? "—"
            : config.commerceEnabled
              ? "enabled"
              : "disabled"}
        </dd>
        <dt className="text-subtle">Scopes</dt>
        <dd>{scopes ? (hasWildcard ? "full (*)" : scopes.join(", ")) : "—"}</dd>
      </dl>
      {missingScopes.length > 0 && (
        <Banner tone="attention">
          Key is missing scope(s): <b>{missingScopes.join(", ")}</b> —
          builds/publish may fail.
        </Banner>
      )}
      {storefrontUrl && (
        <a
          href={storefrontUrl}
          target="_blank"
          rel="noreferrer"
          className="text-[13px] font-semibold text-accent hover:underline"
        >
          Open storefront ↗
        </a>
      )}
      <p className="fg-body-sm text-subtle">
        Builds run on a draft theme (previewed via a token on this domain);
        publish (draft → live) and rollback run through the website
        pipeline&apos;s release stage.
      </p>
    </div>
  );
}
