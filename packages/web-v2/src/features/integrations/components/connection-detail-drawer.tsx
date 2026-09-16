"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { ErrorState, SegmentedControl, Skeleton, SlideOver, Tabs } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useConnectionBindings, useConnections, useIntegrationsList } from "../hooks";
import { cardProvider, getCapabilities } from "../derive";
import { PROVIDER_MODULES, providerLabel } from "../providers/registry";
import type { BindingSummary, DeployStage, StatusCard } from "../types";
import { AgentAccessControl } from "./agent-access-control";
import { DeliveryLogViewer } from "./delivery-log-viewer";
import { STAGE_OPTIONS, StatusPill, scopeLabel } from "./status-pill";

/** Adaptive connection detail (ISS-402). Opened from a directory provider card;
 *  renders the provider's existing config+actions section (Test / Rotate /
 *  Disconnect) and — ONLY when the adapter declares `hasDeliveryLog` — a
 *  read-only delivery-log tab. The stage split (preview/live) shows only when
 *  the adapter declares `canDeploy`. MCP-injection providers therefore get a
 *  single config pane with no empty delivery-log box.
 *
 *  ISS-408/F3: the Configuration tab now also renders a `BindingsSection`
 *  listing every project + scope the underlying connection is bound to
 *  (the "Projects using this connection" payoff of the connection-sharing
 *  cutover). */

// cm:guard built ONCE at module scope: `lazy()` returns a new component type on every call, and
// one rebuilt inside a render remounts the section — losing whatever the operator had typed into it.
const SECTIONS = new Map(
  PROVIDER_MODULES.flatMap((m) => (m.section ? [[m.provider, lazy(m.section)] as const] : [])),
);

// A provider with no section is not a provider whose section is empty — it is one this screen has
// nothing to configure for, and saying so beats rendering a blank pane under its name.
function ProviderSection({ provider, projectId }: { provider: string; projectId: string }) {
  const Section = SECTIONS.get(provider);
  if (!Section) {
    return (
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        {providerLabel(provider)} has nothing to configure here.
      </p>
    );
  }
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
      <Section projectId={projectId} />
    </Suspense>
  );
}

/** Resolve the binding (and therefore the owning connection) the drawer is
 *  currently scoped to. For `canDeploy` providers (Coolify) the card key
 *  carries the env suffix (`coolify:staging`); for the others a single binding
 *  per project covers the provider. */
function useBindingForCard(
  projectId: string,
  provider: string,
  stageHint: DeployStage | null,
): BindingSummary | undefined {
  const list = useIntegrationsList(projectId);
  return useMemo(() => {
    const rows = (list.data?.items ?? []).filter((i) => i.provider === provider);
    if (stageHint) return rows.find((r) => r.stages.includes(stageHint));
    return rows[0];
  }, [list.data, provider, stageHint]);
}

function BindingsSection({
  connectionId,
  currentProjectId,
  currentStage,
}: {
  connectionId: string;
  currentProjectId: string;
  currentStage: DeployStage | null;
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
          currentStage={currentStage}
        />
      )}
    </section>
  );
}

function BindingsList({
  items,
  projectNames,
  currentProjectId,
  currentStage,
}: {
  items: BindingSummary[];
  projectNames: Map<string, string>;
  currentProjectId: string;
  currentStage: DeployStage | null;
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
          b.projectId === currentProjectId &&
          (currentStage === null || b.stages.includes(currentStage));
        const name = projectNames.get(b.projectId) ?? b.projectId;
        return (
          <li
            key={b.id}
            className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-2"
          >
            <span className="truncate text-fg">{name}</span>
            <span className="fg-body-sm text-muted">{scopeLabel(b.role, b.stages)}</span>
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
  canDeploy,
}: {
  provider: string;
  projectId: string;
  canDeploy: boolean;
}) {
  const [stage, setStage] = useState<DeployStage>("preview");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === provider),
    [list.data, provider],
  );
  const binding = canDeploy ? rows.find((r) => r.stages.includes(stage)) : rows[0];

  return (
    <div className="flex flex-col gap-3">
      {canDeploy && (
        <SegmentedControl<DeployStage> value={stage} onChange={setStage} options={STAGE_OPTIONS} />
      )}
      <DeliveryLogViewer projectId={projectId} bindingId={binding?.id ?? null} />
    </div>
  );
}

function ConfigPane({
  provider,
  projectId,
  stageFromCardKey,
  canEdit,
}: {
  provider: string;
  projectId: string;
  stageFromCardKey: DeployStage | null;
  canEdit: boolean;
}) {
  const binding = useBindingForCard(projectId, provider, stageFromCardKey);
  return (
    <>
      <ProviderSection provider={provider} projectId={projectId} />
      {binding && (
        <section className="mt-4">
          <AgentAccessControl projectId={projectId} binding={binding} canEdit={canEdit} />
        </section>
      )}
      {binding?.connectionId && (
        <BindingsSection
          connectionId={binding.connectionId}
          currentProjectId={projectId}
          currentStage={stageFromCardKey}
        />
      )}
    </>
  );
}

export function ConnectionDetailDrawer({
  projectId,
  card,
  onClose,
  canEdit = true,
}: {
  projectId: string;
  card: StatusCard | null;
  onClose: () => void;
  canEdit?: boolean;
}) {
  const provider = card ? cardProvider(card.key) : null;
  const caps = getCapabilities(card);
  const [tab, setTab] = useState<"config" | "deliveries">("config");

  if (!card || !provider) return null;

  // Scope suffix on the card key (`coolify:live`, `coolify:preview+live`,
  // `sentry:service`) → the stage to scope the drawer to. A card whose suffix
  // names no single stage — a service binding, or one serving both — collapses
  // to `null`, which reads as "every binding of this provider".
  const scopeSuffix = card.key.includes(":") ? card.key.split(":")[1] : undefined;
  const stageFromCardKey: DeployStage | null =
    caps.canDeploy && (scopeSuffix === "preview" || scopeSuffix === "live") ? scopeSuffix : null;

  const title = (
    <span className="flex items-center gap-2.5">
      <span>{providerLabel(provider)}</span>
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
                stageFromCardKey={stageFromCardKey}
                canEdit={canEdit}
              />
            ) : (
              <DeliveryLogPane
                provider={provider}
                projectId={projectId}
                canDeploy={caps.canDeploy}
              />
            )}
          </>
        ) : (
          <ConfigPane
            provider={provider}
            projectId={projectId}
            stageFromCardKey={stageFromCardKey}
            canEdit={canEdit}
          />
        )}
      </div>
    </SlideOver>
  );
}
