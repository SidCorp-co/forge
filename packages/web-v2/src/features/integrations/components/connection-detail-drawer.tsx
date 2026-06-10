"use client";

import { useMemo, useState } from "react";
import { ErrorState, SegmentedControl, Skeleton, SlideOver, Tabs } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useConnectionBindings, useConnections, useIntegrationsList } from "../hooks";
import { cardProvider, getCapabilities } from "../derive";
import type { DrillableProvider } from "../derive";
import type { BindingSummary, IntegrationEnvironment, StatusCard } from "../types";
import { CoolifySection } from "./coolify-section";
import { DeliveryLogViewer } from "./delivery-log-viewer";
import { EpodsystemSection } from "./epodsystem-section";
import { PostmanSection } from "./postman-section";
import { ENV_LABEL, PROVIDER_LABEL, StatusPill } from "./status-pill";

/** Adaptive connection detail (ISS-402). Opened from a directory provider card;
 *  renders the provider's existing config+actions section (Test / Rotate /
 *  Disconnect) and — ONLY when the adapter declares `hasDeliveryLog` — a
 *  read-only delivery-log tab. The env split (staging/prod) shows only when
 *  `hasEnvironments`. MCP-injection providers therefore get a single config
 *  pane with no empty delivery-log box.
 *
 *  ISS-408/F3: the Configuration tab now also renders a `BindingsSection`
 *  listing every project + environment the underlying connection is bound to
 *  (the "Projects using this connection" payoff of the connection-sharing
 *  cutover). */

const ENV_OPTIONS: { value: IntegrationEnvironment; label: string }[] = [
  { value: "staging", label: "Staging" },
  { value: "prod", label: "Production" },
];

function ProviderSection({ provider, projectId }: { provider: DrillableProvider; projectId: string }) {
  if (provider === "coolify") return <CoolifySection projectId={projectId} />;
  if (provider === "postman") return <PostmanSection projectId={projectId} />;
  return <EpodsystemSection projectId={projectId} />;
}

/** Resolve the binding (and therefore the owning connection) the drawer is
 *  currently scoped to. For `hasEnvironments` providers (Coolify) the card key
 *  carries the env suffix (`coolify:staging`); for the others a single binding
 *  per project covers the provider. */
function useBindingForCard(
  projectId: string,
  provider: DrillableProvider,
  envHint: IntegrationEnvironment | null,
): BindingSummary | undefined {
  const list = useIntegrationsList(projectId);
  return useMemo(() => {
    const rows = (list.data?.items ?? []).filter((i) => i.provider === provider);
    if (envHint) return rows.find((r) => r.environment === envHint);
    return rows[0];
  }, [list.data, provider, envHint]);
}

function BindingsSection({
  connectionId,
  currentProjectId,
  currentEnv,
}: {
  connectionId: string;
  currentProjectId: string;
  currentEnv: IntegrationEnvironment | null;
}) {
  const bindingsQ = useConnectionBindings(connectionId);
  const projectsQ = useProjectsIncludingArchived();
  // Org-owned connections (shared across the org) get a badge so it's clear
  // the credential isn't personal; managing it requires org admin.
  const connectionsQ = useConnections();
  const isOrgOwned =
    connectionsQ.data?.items.find((c) => c.id === connectionId)?.ownerType === "org";

  // Project-id -> display name for friendly rendering (falls back to the raw
  // id so a missing/archived project still reads correctly).
  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQ.data ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsQ.data]);

  return (
    <section className="mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="fg-h4">Projects using this connection</h3>
        {isOrgOwned && (
          <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
            org-shared
          </span>
        )}
      </div>
      {bindingsQ.isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : bindingsQ.isError ? (
        <ErrorState
          message={formatApiError(bindingsQ.error)}
          onRetry={() => bindingsQ.refetch()}
        />
      ) : (
        <BindingsList
          items={bindingsQ.data?.items ?? []}
          projectNames={projectNames}
          currentProjectId={currentProjectId}
          currentEnv={currentEnv}
        />
      )}
    </section>
  );
}

function BindingsList({
  items,
  projectNames,
  currentProjectId,
  currentEnv,
}: {
  items: BindingSummary[];
  projectNames: Map<string, string>;
  currentProjectId: string;
  currentEnv: IntegrationEnvironment | null;
}) {
  if (items.length === 0) {
    return (
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        Only this project uses this connection.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((b) => {
        const isCurrent =
          b.projectId === currentProjectId && (currentEnv === null || b.environment === currentEnv);
        const name = projectNames.get(b.projectId) ?? b.projectId;
        return (
          <li
            key={b.id}
            className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2"
          >
            <span className="truncate text-fg">{name}</span>
            <span className="fg-body-sm text-muted">{ENV_LABEL[b.environment]}</span>
            {isCurrent && (
              <span className="fg-body-sm ml-auto rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                this project
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DeliveryLogPane({
  provider,
  projectId,
  hasEnvironments,
}: {
  provider: DrillableProvider;
  projectId: string;
  hasEnvironments: boolean;
}) {
  const [env, setEnv] = useState<IntegrationEnvironment>("staging");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === provider),
    [list.data, provider],
  );
  // hasEnvironments providers can carry one binding per environment; otherwise
  // there is a single binding for the provider.
  const binding = hasEnvironments ? rows.find((r) => r.environment === env) : rows[0];

  return (
    <div className="flex flex-col gap-3">
      {hasEnvironments && (
        <SegmentedControl<IntegrationEnvironment> value={env} onChange={setEnv} options={ENV_OPTIONS} />
      )}
      <DeliveryLogViewer projectId={projectId} bindingId={binding?.id ?? null} />
    </div>
  );
}

function ConfigPane({
  provider,
  projectId,
  envFromCardKey,
}: {
  provider: DrillableProvider;
  projectId: string;
  envFromCardKey: IntegrationEnvironment | null;
}) {
  const binding = useBindingForCard(projectId, provider, envFromCardKey);
  return (
    <>
      <ProviderSection provider={provider} projectId={projectId} />
      {binding?.connectionId && (
        <BindingsSection
          connectionId={binding.connectionId}
          currentProjectId={projectId}
          currentEnv={envFromCardKey}
        />
      )}
    </>
  );
}

export function ConnectionDetailDrawer({
  projectId,
  card,
  onClose,
}: {
  projectId: string;
  card: StatusCard | null;
  onClose: () => void;
}) {
  const provider = card ? (cardProvider(card.key) as DrillableProvider) : null;
  const caps = getCapabilities(card);
  const [tab, setTab] = useState<"config" | "deliveries">("config");

  if (!card || !provider) return null;

  // env suffix on the card key (`coolify:staging`) → IntegrationEnvironment;
  // non-env providers (postman/epodsystem) collapse to `null`.
  const envSuffix = card.key.includes(":")
    ? (card.key.split(":")[1] as IntegrationEnvironment | undefined) ?? null
    : null;
  const envFromCardKey: IntegrationEnvironment | null = caps.hasEnvironments ? envSuffix : null;

  const title = (
    <span className="flex items-center gap-2.5">
      <span>{PROVIDER_LABEL[provider] ?? card.label}</span>
      <StatusPill card={card} />
    </span>
  );

  return (
    <SlideOver open={Boolean(card)} onClose={onClose} title={title} width={560}>
      <div className="flex flex-col gap-4 px-5 py-4">
        {caps.hasDeliveryLog ? (
          <>
            <Tabs
              tabs={[
                { value: "config", label: "Configuration" },
                { value: "deliveries", label: "Delivery log" },
              ]}
              value={tab}
              onChange={(v) => setTab(v as "config" | "deliveries")}
            />
            {tab === "config" ? (
              <ConfigPane
                provider={provider}
                projectId={projectId}
                envFromCardKey={envFromCardKey}
              />
            ) : (
              <DeliveryLogPane
                provider={provider}
                projectId={projectId}
                hasEnvironments={caps.hasEnvironments}
              />
            )}
          </>
        ) : (
          <ConfigPane provider={provider} projectId={projectId} envFromCardKey={envFromCardKey} />
        )}
      </div>
    </SlideOver>
  );
}
