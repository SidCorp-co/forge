"use client";

// Project settings → Integrations. ISS-408/F3 adds a "Share an existing
// connection" Card on top of the existing deep-link Card: an admin can bind an
// owner-scoped connection to this project (+ env) WITHOUT re-entering the
// credential. The full per-project integration config still lives at the
// workspace `/integrations` hub (ISS-395 AC4) — this tab does not duplicate the
// provider forms; the secondary Card deep-links there.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banner,
  Button,
  Card,
  CardContent,
  Field,
  Select,
  type SelectOption,
} from "@/design";
import { useBindExistingConnection, useConnections } from "@/features/integrations/hooks";
import type { ConnectionSummary, IntegrationEnvironment } from "@/features/integrations/types";

const ENVIRONMENT_OPTIONS: SelectOption[] = [
  { value: "staging", label: "Staging" },
  { value: "prod", label: "Production" },
];

const PROVIDER_LABEL: Record<string, string> = {
  coolify: "Coolify deploy",
  postman: "Postman",
  epodsystem: "Epodsystem",
};

function connectionLabel(c: ConnectionSummary): string {
  const provider = PROVIDER_LABEL[c.provider] ?? c.provider;
  return c.displayName ? `${c.displayName} · ${provider}` : provider;
}

function ShareExistingCard({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const connectionsQ = useConnections();
  const bind = useBindExistingConnection();
  const [connectionId, setConnectionId] = useState<string>("");
  const [environment, setEnvironment] = useState<IntegrationEnvironment>("staging");

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
      { id: connectionId, body: { projectId, environment } },
      {
        onSuccess: () => {
          setConnectionId("");
          setEnvironment("staging");
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
            <Field label="Environment" required>
              <Select
                options={ENVIRONMENT_OPTIONS}
                value={environment}
                onChange={(v) => setEnvironment(v as IntegrationEnvironment)}
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

function ConfigureNewCard() {
  const router = useRouter();
  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Configure a new integration</h2>
        <p className="fg-body-sm mb-4 text-muted">
          Add or rotate credentials for Epodsystem storefront, Coolify deploy
          (staging/prod, webhook secret, production gate), and Postman on the workspace
          Integrations hub. Connection testing and secret rotation happen there.
        </p>
        <Button variant="secondary" icon="link" onClick={() => router.push("/integrations")}>
          Open Integrations
        </Button>
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
      <ShareExistingCard projectId={projectId} canEdit={canEdit} />
      <ConfigureNewCard />
    </div>
  );
}
