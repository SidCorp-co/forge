"use client";

import {
  Badge,
  Banner,
  Button,
  CardTitle,
  Field,
  Input,
  Select,
  type SelectOption,
  SettingsSection,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
import { useMemo, useState } from "react";
import {
  useCreateProviderIntegration,
  useIntegrationsList,
  useProjectIntegrationActs,
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
  AgentAccessControl, agentAccessBody, grantOnConnectWho, mayGrantOnConnect} from "../../components/agent-access-control";
import type { AgentAccess } from "../../types";
import { ConnectionOwnerField } from "../../components/connection-owner-field";
import { epodsystem } from "./index";
import {
  bindsRemovedConnection,
  IntegrationEnabledControl,
  keyLockedLine,
  onlyWho,
  removedKeyHint,
} from "../../components/integration-enabled-control";
import { bindingBadge, bindingConnected, bindingForRow } from "../../derive";
import { DisconnectFromProject } from "../../components/disconnect-from-project";

// Scopes a website build needs to publish themes + toggle commerce/cache.
const REQUIRED_SCOPES = ["products:write", "webstore:write", "settings:write"];

const LABEL_REGEX = /^[a-z0-9][a-z0-9-]*$/;
/** What `LABEL_REGEX` takes, in words a person reads. */
const LABEL_RULE = "lowercase letters, numbers and dashes, starting with a letter or number";

const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "service", label: "Service — a project-wide facility" },
  { value: "deploy", label: "Deploy target — somewhere Forge deploys to" },
];

const STAGE_CHOICES: { value: DeployStage; label: string; hint: string }[] = [
  { value: "preview", label: "Preview", hint: "the draft theme, seen before it counts" },
  { value: "live", label: "Live", hint: "the published theme real customers are on" },
];

/** What a storefront is called: its label, else the store it reaches, so a removed storefront and the
 *  one connected again in its place are told apart (ISS-1421 r34, judge-138). */
export function storefrontName(binding: IntegrationSummary): string {
  const config = binding.config as EpodsystemReadConfig;
  return binding.label || config.storeName || config.storeSlug || "Unlabelled storefront";
}

/** The storefront an agent gets when it names none: the oldest switched on, as core's
 *  `forge_storefront_target` picks it from `listActiveBindingsForProjectProvider`. */
export function defaultStorefrontId(bindings: readonly IntegrationSummary[]): string | undefined {
  return [...bindings]
    .filter((b) => b.active)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]?.id;
}

/**
 * ISS-395 / ISS-387 / ISS-558 — Epodsystem storefront integration config.
 * ISS-558: supports multiple stores per project, each binding with its own label (empty = default).
 * A row's drawer holds that row's storefront alone, so every control in it acts on the binding the
 * row showed (ISS-1421 r34); with no row named, every storefront is listed.
 */
export function EpodsystemSection({ projectId, bindingId }: { projectId: string; bindingId?: string }) {
  const list = useIntegrationsList(projectId);

  const all = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === "epodsystem"),
    [list.data],
  );
  const shown = useMemo(() => {
    if (bindingId) {
      const row = bindingForRow(all, "epodsystem", bindingId);
      return row ? [row] : [];
    }
    return [...all].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [all, bindingId]);
  const defaultId = defaultStorefrontId(all);

  // Only a binding whose last check passed is connected: a key the provider refused is not.
  const connectedCount = bindingId ? 0 : shown.filter(bindingConnected).length;
  const [showAddForm, setShowAddForm] = useState(false);
  // Adding a storefront is a connect: offered by the answer the create door refuses by, and withdrawn
  // when a refusal's re-read of the list says the reader may not (ISS-1421 r29, judge-119 on 313, 319).
  const may = useProjectIntegrationActs(projectId);
  const mayAdd = may?.connect === true;

  return (
    <SettingsSection>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Epodsystem storefronts</CardTitle>
          {connectedCount > 0 && <Badge tone="green">{connectedCount} connected</Badge>}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-muted">
          {mayAdd ? "Connect one or more Epodsystem storefronts to this project." : "This project's Epodsystem storefronts."}{" "}
          Each storefront has its own{" "}
          <span className="font-mono">crmk_</span> API key, and the oldest one switched on is the
          default an agent gets when it names none.
          {mayAdd && (
            <>
              {" "}Each one after it needs a label of its own, in {LABEL_RULE} (e.g.{" "}
              <span className="font-mono">partner-a</span>).
            </>
          )}
        </p>

        {list.isLoading && (
          <p className="fg-body-sm text-muted">Loading…</p>
        )}

        {!list.isLoading && all.length === 0 && (
          <p className="fg-body-sm text-muted italic">
            No Epodsystem storefronts configured.
          </p>
        )}

        {shown.map((binding) => (
          <EpodsystemBindingRow
            key={binding.id}
            projectId={projectId}
            binding={binding}
            isDefault={binding.id === defaultId}
          />
        ))}

        {!mayAdd ? (
          may && (
            <p className="fg-body-sm text-muted">
              {`${onlyWho(may.whoConnects)} can add a storefront to this project.`}
            </p>
          )
        ) : showAddForm ? (
          <AddEpodsystemForm
            projectId={projectId}
            hasDefault={all.length > 0}
            onCancel={() => setShowAddForm(false)}
            onCreated={() => setShowAddForm(false)}
          />
        ) : (
          <Button variant="secondary" onClick={() => setShowAddForm(true)} className="self-start">
            Add storefront
          </Button>
        )}
      </div>
    </SettingsSection>
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
  const list = useIntegrationsList(projectId);
  const may = useProjectIntegrationActs(projectId);
  const keyLocked = binding ? !binding.acts.saveKey : !may?.connect;

  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKeyField, setShowKeyField] = useState(false);

  const badge = bindingBadge(binding);
  const storeName = (binding.config as EpodsystemReadConfig).storeName;
  const name = storefrontName(binding);

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



  return (
    <div className="flex flex-col gap-3 border-t border-subtle pt-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${binding.label ? "font-mono" : ""}`}>{name}</span>
          {isDefault && (
            <Badge tone="neutral">default</Badge>
          )}
        </div>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {badge.status === "connected" && storeName ? (
        <p className="fg-body-sm text-muted">Connected to {storeName}.</p>
      ) : null}

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
          hint={
            binding.hasSecrets
              ? "Enter the new crmk_ key to rotate. Leave blank to keep the current key."
              : removedKeyHint("key", binding.acts)
          }
        >
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="crmk_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={keyLocked}
          />
        </Field>
      )}

      {binding && keyLocked && (
        <p className="fg-body-sm text-muted">{keyLockedLine(binding.acts)}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!keyLocked && (
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
        {!bindsRemovedConnection(binding) && (
        <Button
          variant="secondary"
          onClick={handleTest}
          loading={test.isPending}
        >
          Test
        </Button>
        )}
        <DisconnectFromProject
          projectId={projectId}
          binding={binding}
          subject={`the "${name}" Epodsystem storefront`}
        />
      </div>

      <IntegrationEnabledControl projectId={projectId} binding={binding} />

      <AgentAccessControl
        projectId={projectId}
        binding={binding} />

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
  const may = useProjectIntegrationActs(projectId);
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
      ? `A label takes ${LABEL_RULE}, e.g. partner-a.`
      : null;

  const canSubmit =
    apiKey.trim().length >= 8 &&
    (!hasDefault || (label.trim().length > 0 && !labelError)) &&
    !create.isPending;

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
    if (role === "deploy" && stages.length === 0) {
      setError(
        "Choose at least one stage — a deploy target has to serve Preview, Live or both.",
      );
      return;
    }
    try {
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
    <div className="flex flex-col gap-4 border-t border-subtle pt-4">
      <span className="fg-label font-semibold">Add storefront</span>

      <ConnectionOwnerField
        projectId={projectId}
        value={ownerOrgId}
        onChange={setOwnerOrgId}
      />

      {hasDefault && (
        <Field
          label="Label"
          hint={`A name for this storefront no other one here has, in ${LABEL_RULE} (e.g. partner-a). Every storefront after the first needs one.`}
          required
        >
          <Input
            placeholder="partner-a"
            value={label}
            onChange={(e) => setLabel(e.target.value.toLowerCase())}
          />
          {labelError && (
            <p className="fg-body-sm fg-danger">{labelError}</p>
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
        canEdit={mayGrantOnConnect(epodsystem.agentPathKind, may)}
        disabledReason={grantOnConnectWho(epodsystem.agentPathKind, may)}
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
    <div className="flex flex-col gap-2 border-t border-subtle pt-3">
      <span className="fg-label text-subtle">Store &amp; themes</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-12">
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
          className="text-13 font-semibold text-accent hover:underline"
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
