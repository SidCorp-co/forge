"use client";

// Project settings → Integrations — the FULL per-project management surface
// (ISS-429): live status cards with config/Test/Rotate/Disconnect drill-in,
// the Agent MCP servers preview, and the ISS-408/F3 "Share an existing
// connection" Card. The workspace `/integrations` page is the owner-scoped
// connection directory; everything project-scoped lives here.
import { useMemo, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CardContent,
  Field,
  SectionTitle,
  Select,
  type SelectOption,
} from "@/design";
import {
  AGENT_ACCESS_CLOSED,
  AgentAccessChoice, agentAccessBody, agentAccessDeniedReason, mayWriteAgentAccess} from "@/features/integrations/components/agent-access-control";
import { ProjectIntegrationsPanel } from "@/features/integrations/components/project-integrations-panel";
import { useBindExistingConnection, useConnections, useIsOrgAdmin } from "@/features/integrations/hooks";
import { providerLabel, providerModule } from "@/features/integrations/providers/registry";
import { formatApiError } from "@/lib/api/error";
import { providerCanDeploy } from "@forge/contracts/deploy-capability";
import type {
  AgentAccess,
  BindingRole,
  ConnectionSummary,
} from "@/features/integrations/types";

// What the binding is FOR — DECLARED by the person, never derived from the
// provider: the same epodsystem connection is a deploy target on a storefront
// project and a plain service on one that only borrows its MCP.
const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "service", label: "Service — a project-wide facility" },
  { value: "deploy", label: "Deploy target — somewhere Forge deploys to" },
];

function connectionLabel(c: ConnectionSummary): string {
  const provider = providerLabel(c.provider);
  return c.displayName ? `${c.displayName} · ${provider}` : provider;
}

function ShareExistingCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const connectionsQ = useConnections();
  const bind = useBindExistingConnection();
  const [connectionId, setConnectionId] = useState<string>("");
  const [role, setRole] = useState<BindingRole>("service");
  const [agentAccess, setAgentAccess] = useState<AgentAccess>(AGENT_ACCESS_CLOSED);
  const [formError, setFormError] = useState<string | null>(null);

  // Only active connections with a stored credential are eligible to share —
  // a soft-deleted or secret-less row would fail server-side (loadOwnedConnection
  // rejects active=false). Filtering here keeps the picker honest.
  const eligible = useMemo(
    () => (connectionsQ.data?.items ?? []).filter((c) => c.active && c.hasSecrets),
    [connectionsQ.data],
  );

  const connectionOptions: SelectOption[] = useMemo(
    () => eligible.map((c) => ({ value: c.id, label: connectionLabel(c) })),
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
  const isOrgAdmin = useIsOrgAdmin(projectId);

  function chooseRole(next: BindingRole) {
    setRole(next);
    setFormError(null);
  }

  function submit() {
    if (!connectionId) return;
    if (role === "deploy" && !canDeploy) {
      setFormError(
        `Forge cannot deploy to ${providerName} — it has no deploy adapter. Share it as a service, or pick a connection Forge can deploy to.`,
      );
      return;
    }
    setFormError(null);
    bind.mutate(
      {
        id: connectionId,
        body: {
          projectId,
          role,
          ...agentAccessBody(agentPathKind, agentAccess),
        },
      },
      {
        onSuccess: () => {
          setConnectionId("");
          setRole("service");
          setAgentAccess(AGENT_ACCESS_CLOSED);
        },
      },
    );
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-1">Share an existing connection</SectionTitle>
        <p className="fg-body-sm mb-4 text-muted">
          Bind one of your connections to this project without re-entering the credential. The
          connection&apos;s owner keeps it; this project gets a webhook secret of its own.
        </p>

        {!canEdit ? (
          <Banner tone="info">
            Only the project owner can share a connection with this project.
          </Banner>
        ) : isEmpty ? (
          <Banner tone="info">
            You don&apos;t have any connections yet. Create one on the Integrations hub first.
          </Banner>
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
              <p className="fg-body-sm text-muted">
                Which environment this binding deploys is the project document&apos;s: name the
                binding in <code>environments.&lt;name&gt;.deployment.binding</code> and write the
                document on the Configuration tab.
              </p>
            )}
            <AgentAccessChoice
              value={agentAccess}
              onChange={setAgentAccess}
              pathKind={agentPathKind}
              canEdit={mayWriteAgentAccess(agentPathKind, { canEditProject: canEdit, isOrgAdmin }) && !bind.isPending}
              disabledReason={agentAccessDeniedReason(agentPathKind)}
            />
            {formError && <Banner tone="attention">{formError}</Banner>}
            {bind.isError && <Banner tone="danger">{formatApiError(bind.error)}</Banner>}
            <div>
              <Button
                variant="primary"
                onClick={submit}
                loading={bind.isPending}
                disabled={!connectionId || bind.isPending}
              >
                Share with this project
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsTab({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ProjectIntegrationsPanel projectId={projectId} canEdit={canEdit} />
      <ShareExistingCard projectId={projectId} canEdit={canEdit} />
    </div>
  );
}
