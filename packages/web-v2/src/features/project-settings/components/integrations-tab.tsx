"use client";

// Project settings → Integrations — the FULL per-project management surface
// (ISS-429): live status cards with config/Test/Rotate/Disconnect drill-in,
// the Agent MCP servers preview, and the ISS-408/F3 "Share an existing
// connection" Card. The workspace `/integrations` page is the owner-scoped
// connection directory; everything project-scoped lives here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  Button,
  Field,
  SectionTitle,
  Select,
  type SelectOption,
  SettingsSection,
} from "@/design";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice,
  agentAccessBody,
  grantOnConnectWho,
  mayGrantOnConnect,
} from "@/features/integrations/components/agent-access-control";
import { onlyWho } from "@/features/integrations/components/integration-enabled-control";
import { ProjectIntegrationsPanel } from "@/features/integrations/components/project-integrations-panel";
import { connectionPickerLabels } from "@/features/integrations/connection-identity";
import { cardProvider, isProviderCard } from "@/features/integrations/derive";
import {
  useBindExistingConnection,
  useConnections,
  useIntegrationsList,
  useIntegrationsStatus,
  useProjectIntegrationActs,
} from "@/features/integrations/hooks";
import { probeIsUsable, VERIFY_KEY, VERIFY_PROBE_SECTION } from "@/features/integrations/components/verify-probe-field";
import { providerLabel, providerModule } from "@/features/integrations/providers/registry";
import { formatApiError } from "@/lib/api/error";
import { replaceLocationSearch, useLocationSearch } from "@/lib/utils/use-location-search";
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
import type {
  AgentAccess,
  BindingRole,
  DeployStage,
  IntegrationSummary,
} from "@/features/integrations/types";

// What the binding is FOR — DECLARED by the person, never derived from the
// provider: the same epodsystem connection is a deploy target on a storefront
// project and a plain service on one that only borrows its MCP.
const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "service", label: "Service — a project-wide facility" },
  { value: "deploy", label: "Deploy target — somewhere Forge deploys to" },
];

// A deploy binding serves one or both. A service binding serves neither, which is
// why the control below is not merely disabled under `service` — it is unmounted
// and its value dropped.
const STAGE_CHOICES: { value: DeployStage; label: string; hint: string }[] = [
  { value: "preview", label: "Preview", hint: "deployed so people can see it before it counts" },
  { value: "live", label: "Live", hint: "real users are on it" },
];

/** The section an "add a live deploy target" link lands on, named by its `?add=` and its id. */
export const LIVE_DEPLOY_TARGET = "live-deploy-target";


/** The providers this tab can start a live deploy target on, named as their rows name them. */
function useDeployProviders(projectId: string): { provider: string; label: string }[] {
  const status = useIntegrationsStatus(projectId);
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const card of status.data?.cards ?? []) {
      const provider = cardProvider(card.key);
      if (!providerCanDeploy(provider) || !isProviderCard(card.key) || seen.has(provider)) continue;
      seen.set(provider, card.label.replace(/\s*\(.*\)$/, ""));
    }
    return [...seen].map(([provider, label]) => ({ provider, label }));
  }, [status.data]);
}

function ShareExistingCard({
  projectId,
  addingLiveTarget,
  onConnect,
}: {
  projectId: string;
  /** Arrived to add a live deploy target: Deploy target is picked and Live ticked already. */
  addingLiveTarget: boolean;
  /** Open a provider's own setup on this tab, to connect one that is not connected yet. */
  onConnect: (provider: string) => void;
}) {
  const connectionsQ = useConnections();
  const bind = useBindExistingConnection();
  const [connectionId, setConnectionId] = useState<string>("");
  const [role, setRole] = useState<BindingRole>("service");
  const [stages, setStages] = useState<DeployStage[]>([]);
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [formError, setFormError] = useState<string | null>(null);

  // Only a connection the share door takes is offered: active, holding its credential, and one the
  // reader manages, since the door refuses anyone else's (ISS-1421 r27).
  const eligible = useMemo(
    () =>
      (connectionsQ.data?.items ?? []).filter(
        (c) => c.active && c.hasSecrets && c.access?.canManage === true,
      ),
    [connectionsQ.data],
  );

  const connectionOptions: SelectOption[] = useMemo(
    () => {
      const labels = connectionPickerLabels(eligible);
      return eligible.map((c) => ({ value: c.id, label: labels.get(c.id) ?? c.id }));
    },
    [eligible],
  );

  const isEmpty = !connectionsQ.isLoading && eligible.length === 0;

  const selected = eligible.find((c) => c.id === connectionId);
  const provider = selected?.provider;
  const canDeploy = provider === undefined ? true : providerCanDeploy(provider);
  const providerName = provider ? providerLabel(provider) : "this provider";
  // No binding exists yet, so the risk class comes off the provider's own module. `none` renders no
  // control at all — that provider has no agent path for a grant to open.
  const agentPathKind = provider ? (providerModule(provider)?.agentPathKind ?? "none") : "none";
  const may = useProjectIntegrationActs(projectId);
  const deployProviders = useDeployProviders(projectId);

  // Arriving to add a live deploy target, the one connection Forge can deploy to is picked too.
  const onlyDeployable = useMemo(() => {
    const deployable = eligible.filter((c) => providerCanDeploy(c.provider));
    return deployable.length === 1 ? deployable[0] : undefined;
  }, [eligible]);

  useEffect(() => {
    if (!addingLiveTarget) return;
    setRole("deploy");
    setStages(["live"]);
    if (onlyDeployable) setConnectionId((cur) => cur || onlyDeployable.id);
  }, [addingLiveTarget, onlyDeployable]);

  function chooseRole(next: BindingRole) {
    setRole(next);
    setFormError(null);
    if (next === "service") setStages([]);
  }

  function toggleStage(stage: DeployStage) {
    setFormError(null);
    setStages((cur) => (cur.includes(stage) ? cur.filter((s) => s !== stage) : [...cur, stage]));
  }

  function submit() {
    if (!connectionId) return;
    if (role === "deploy" && !canDeploy) {
      setFormError(
        `Forge cannot deploy to ${providerName} — it has no deploy adapter. Share it as a service, or pick a connection Forge can deploy to.`,
      );
      return;
    }
    if (role === "deploy" && stages.length === 0) {
      setFormError("Choose at least one stage — a deploy target has to serve Preview, Live or both.");
      return;
    }
    setFormError(null);
    bind.mutate(
      {
        id: connectionId,
        body: {
          projectId,
          role,
          ...(role === "deploy" ? { stages } : {}),
          ...agentAccessBody(agentPathKind, agentAccess),
        },
      },
      {
        onSuccess: () => {
          setConnectionId("");
          setRole("service");
          setStages([]);
          setAgentAccess(AGENT_ACCESS_CLOSED);
        },
      },
    );
  }

  return (
    <SettingsSection id={LIVE_DEPLOY_TARGET}>
      <SectionTitle className="fg-h3 mb-1">Share an existing connection</SectionTitle>
      <p className="fg-body-sm mb-4 text-muted">
        Bind one of your connections to this project without re-entering the credential. The
        connection&apos;s owner keeps it; this project gets a webhook secret of its own. A live
        deploy target is a connection shared as <b>Deploy target</b> with <b>Live</b> ticked; one
        you have not connected yet starts from its provider on this tab.
      </p>

      {may && !may.connect ? (
        <Banner tone="info">
          {`${onlyWho(may.whoConnects)} can share a connection with this project.`}
        </Banner>
      ) : isEmpty ? (
        <div className="flex flex-col gap-3" data-testid="no-connection">
          <p className="fg-body-sm text-fg">
            You have no connection to share yet. Connect the place this project deploys to, then
            share it here as <b>Deploy target</b> with <b>Live</b> ticked.
          </p>
          <div className="flex flex-wrap gap-2">
            {deployProviders.map(({ provider: p, label }) => (
              <Button
                key={p}
                variant={addingLiveTarget ? "primary" : "secondary"}
                size="sm"
                onClick={() => onConnect(p)}
              >
                Connect {label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Connection" required>
            <Select
              options={connectionOptions}
              value={connectionId}
              onChange={(v) => {
                setConnectionId(v);
                setFormError(null);
              }}
              placeholder={connectionsQ.isLoading ? "Loading…" : "Select a connection…"}
              disabled={connectionsQ.isLoading || bind.isPending}
            />
          </Field>
          <Field label="What is it for" required>
            <Select
              options={ROLE_SELECT_OPTIONS}
              value={role}
              onChange={(v) => chooseRole(v as BindingRole)}
              disabled={!connectionId || bind.isPending}
            />
          </Field>
          {role === "deploy" && !canDeploy && (
            <Banner tone="attention">
              Forge cannot deploy to {providerName} — it has no deploy adapter. Share it as a
              service instead.
            </Banner>
          )}
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
                      disabled={bind.isPending}
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
          <AgentAccessChoice
            value={agentAccess}
            onChange={setAgentAccess}
            pathKind={agentPathKind}
            canEdit={mayGrantOnConnect(agentPathKind, may) && !bind.isPending}
            disabledReason={grantOnConnectWho(agentPathKind, may)}
          />
          {formError && <Banner tone="attention">{formError}</Banner>}
          {bind.isError && <Banner tone="danger">{formatApiError(bind.error)}</Banner>}
          <Button
            variant="primary"
            className="self-start"
            onClick={submit}
            loading={bind.isPending}
            disabled={!connectionId || bind.isPending}
          >
            Share with this project
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}

/**
 * The live deploy binding a "declare a probe" link is about: the first one a release cannot read a
 * probe from, else the first one there is. Only a provider with a drawer here is a candidate, since
 * the landing opens that drawer; null where no live deploy binding has one.
 */
export function probeLandingFor(bindings: readonly IntegrationSummary[]): IntegrationSummary | null {
  const live = bindings.filter(
    (b) =>
      b.role === "deploy" &&
      b.stages.includes("live") &&
      b.active !== false &&
      providerModule(b.provider)?.drillable === true,
  );
  return live.find((b) => !probeIsUsable(b.config?.[VERIFY_KEY])) ?? live[0] ?? null;
}

export function IntegrationsTab({ projectId }: { projectId: string }) {
  // Arriving to add one puts this section first, so the link lands on what it names.
  const params = new URLSearchParams(useLocationSearch());
  const addingLiveTarget = params.get("add") === LIVE_DEPLOY_TARGET;
  const [connecting, setConnecting] = useState<{
    provider: string;
    stage?: DeployStage;
    focus?: string;
  } | null>(null);
  const clearConnecting = useCallback(() => setConnecting(null), []);
  // Arriving to declare a probe opens the drawer of the binding the gap is about, once, on its
  // Verify probe section (ISS-1339 r2): the tab's top has no field for it.
  const landingOnProbe = params.get("field") === VERIFY_PROBE_SECTION;
  const bindings = useIntegrationsList(landingOnProbe ? projectId : undefined);
  const landed = useRef(false);
  const closed = useRef(false);
  // A read that finds no binding while a refresh is still out does not spend the landing: the
  // refresh may bring the binding the link was about. A new arrival on the link is a new mount: it
  // comes from another tab of the screen.
  useEffect(() => {
    if (!landingOnProbe || landed.current || !bindings.data) return;
    const target = probeLandingFor(bindings.data.items);
    if (!target) {
      if (!bindings.isFetching) landed.current = true;
      return;
    }
    landed.current = true;
    setConnecting({ provider: target.provider, stage: "live", focus: VERIFY_PROBE_SECTION });
  }, [landingOnProbe, bindings.data, bindings.isFetching]);
  // The drawer the link opened has closed: a reload is not a second arrival on the link. The param
  // can come back after it, when the leave guard steps Back off its own entry onto the page's.
  const dropProbeLanding = useCallback(() => {
    closed.current = landed.current;
    const url = new URL(window.location.href);
    if (url.searchParams.get("field") !== VERIFY_PROBE_SECTION) return;
    url.searchParams.delete("field");
    replaceLocationSearch(`${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => {
    if (landingOnProbe && closed.current) dropProbeLanding();
  }, [landingOnProbe, dropProbeLanding]);
  const share = (
    <ShareExistingCard
      projectId={projectId}
      addingLiveTarget={addingLiveTarget}
      onConnect={(provider) => setConnecting({ provider, stage: "live" })}
    />
  );
  return (
    <div className="flex flex-col gap-6">
      {addingLiveTarget && share}
      <ProjectIntegrationsPanel
        projectId={projectId}
        openProvider={connecting}
        onOpenProvider={clearConnecting}
        onDrawerClose={dropProbeLanding}
      />
      {!addingLiveTarget && share}
    </div>
  );
}
