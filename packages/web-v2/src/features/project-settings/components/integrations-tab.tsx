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
  Select,
  type SelectOption,
} from "@/design";
import { ProjectIntegrationsPanel } from "@/features/integrations/components/project-integrations-panel";
import { PROVIDER_LABEL } from "@/features/integrations/components/status-pill";
import { useBindExistingConnection, useConnections } from "@/features/integrations/hooks";
import type { BindingRole, ConnectionSummary, DeployStage } from "@/features/integrations/types";

// What the binding is FOR. Stages are declared on the provider's own card,
// where the deploy targets are; this door only says which kind of binding it is.
const ROLE_SELECT_OPTIONS: SelectOption[] = [
  { value: "service", label: "Service — a project-wide facility" },
  { value: "deploy", label: "Deploy target — somewhere Forge deploys to" },
];

function connectionLabel(c: ConnectionSummary): string {
  const provider = PROVIDER_LABEL[c.provider] ?? c.provider;
  return c.displayName ? `${c.displayName} · ${provider}` : provider;
}

function ShareExistingCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const connectionsQ = useConnections();
  const bind = useBindExistingConnection();
  const [connectionId, setConnectionId] = useState<string>("");
  const [role, setRole] = useState<BindingRole>("service");

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

  function submit() {
    if (!connectionId) return;
    bind.mutate(
      {
        id: connectionId,
        body: {
          projectId,
          role,
          // A deploy binding must declare at least one stage; `preview` is the
          // one that cannot reach anybody's production, so it is what this door
          // opens with. The provider card is where it gets widened to `live`.
          ...(role === "deploy" ? { stages: ["preview" as DeployStage] } : {}),
        },
      },
      {
        onSuccess: () => {
          setConnectionId("");
          setRole("service");
        },
      },
    );
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Share an existing connection</h2>
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
                onChange={setConnectionId}
                placeholder={connectionsQ.isLoading ? "Loading…" : "Select a connection…"}
                disabled={connectionsQ.isLoading || bind.isPending}
              />
            </Field>
            <Field label="What is it for" required>
              <Select
                options={ROLE_SELECT_OPTIONS}
                value={role}
                onChange={(v) => setRole(v as BindingRole)}
                disabled={!connectionId || bind.isPending}
              />
            </Field>
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
      <ProjectIntegrationsPanel projectId={projectId} />
      <ShareExistingCard projectId={projectId} canEdit={canEdit} />
    </div>
  );
}
