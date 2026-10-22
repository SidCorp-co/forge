"use client";

import { type ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  Button,
  CardTitle,
  ErrorState,
  SegmentedControl,
  Skeleton,
  SlideOver,
  Tabs,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { projectCalled } from "../connection-identity";
import { useConnectionBindings, useConnections, useIntegrationsList } from "../hooks";
import { cardProvider, getCapabilities } from "../derive";
import { PROVIDER_MODULES, providerLabel } from "../providers/registry";
import type { BindingSummary, DeployStage, StatusCard } from "../types";
import { AgentAccessControl } from "./agent-access-control";
import { DeliveryLogViewer } from "./delivery-log-viewer";
import { BindingReleaseRunnerField } from "./release-runner-field";
import { STAGE_OPTIONS, StatusPill, scopeLabel } from "./status-pill";
import { BindingVerifyProbeField, VERIFY_PROBE_SECTION } from "./verify-probe-field";

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

const SECTIONS = new Map(
  PROVIDER_MODULES.flatMap((m) => (m.section ? [[m.provider, lazy(m.section)] as const] : [])),
);

// A provider with no section is not a provider whose section is empty — it is one this screen has
// nothing to configure for, and saying so beats rendering a blank pane under its name.
// `after` is drawn once the section is: a control below a lazy section that it moves down as it
// arrives is a control a link has already scrolled to and lost (ISS-1339 r2).
function ProviderSection({
  provider,
  projectId,
  stage,
  after,
}: {
  provider: string;
  projectId: string;
  stage: DeployStage | null;
  after?: ReactNode;
}) {
  const Section = SECTIONS.get(provider);
  if (!Section) {
    return (
      <>
        <p className="fg-body-sm border-b border-line pb-2 text-muted">
          {providerLabel(provider)} has nothing to configure here.
        </p>
        {after}
      </>
    );
  }
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full" />}>
      <Section projectId={projectId} {...(stage ? { stage } : {})} />
      {after}
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

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsQ.data ?? []) map.set(p.id, p.name);
    return map;
  }, [projectsQ.data]);

  return (
    <section className="mt-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <CardTitle>Projects using this connection</CardTitle>
        {isOrgOwned && (
          <span className="fg-body-sm shrink-0 whitespace-nowrap rounded-pill bg-sunken px-2 py-0.5 text-subtle">
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
          projectsRead={projectsQ.isSuccess}
          currentProjectId={currentProjectId}
          currentStage={currentStage}
        />
      )}
    </section>
  );
}

export function BindingsList({
  items,
  projectNames,
  projectsRead,
  currentProjectId,
  currentStage,
}: {
  items: BindingSummary[];
  projectNames: Map<string, string>;
  projectsRead: boolean;
  currentProjectId: string;
  currentStage: DeployStage | null;
}) {
  if (items.length === 0) {
    return (
      <p className="fg-body-sm border-b border-line pb-2 text-muted">
        Only this project uses this connection.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line">
      {items.map((b) => {
        const isCurrent =
          b.projectId === currentProjectId &&
          (currentStage === null || b.stages.includes(currentStage));
        const name = projectCalled(projectNames.get(b.projectId), projectsRead);
        return (
          <li
            key={b.id}
            className="flex items-center gap-3 py-2"
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
  focus,
}: {
  provider: string;
  projectId: string;
  stageFromCardKey: DeployStage | null;
  canEdit: boolean;
  focus: string | null;
}) {
  const binding = useBindingForCard(projectId, provider, stageFromCardKey);
  return (
    <>
      <ProviderSection
        provider={provider}
        projectId={projectId}
        stage={stageFromCardKey}
        after={
          // ISS-1339 r2 — what a release reads to learn the commit production serves, on every live
          // deploy binding whatever its provider; it renders itself away elsewhere.
          binding && (
            <div className="mt-4">
              <BindingVerifyProbeField
                projectId={projectId}
                binding={binding}
                canEdit={canEdit}
                focus={focus === VERIFY_PROBE_SECTION}
              />
            </div>
          )
        }
      />
      {/* A provider's section carries its own agents switch, with its own refusal words, so the
          pane adds one only where there is no section (ISS-1421 r8, criterion 128). */}
      {binding && !SECTIONS.has(provider) && (
        <section className="mt-4">
          <AgentAccessControl projectId={projectId} binding={binding} canEdit={canEdit} />
        </section>
      )}
      {/* ISS-1275 — the binding tier of the release runner label, beside the other
          binding-scoped control on this pane. It renders itself away for a binding
          that carries no live stage. */}
      {binding && (
        <section className="mt-4">
          <BindingReleaseRunnerField
            projectId={projectId}
            binding={binding}
            canEdit={canEdit}
          />
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
  statusReadError = null,
  statusReadFailedAt = 0,
  onRetryStatus,
  focus = null,
}: {
  projectId: string;
  card: StatusCard | null;
  onClose: () => void;
  canEdit?: boolean;
  /** The section a link opened the drawer for, scrolled to and focused once it is drawn. */
  focus?: string | null;
  /** Why the Integrations tab's last status read failed, said here so the open drawer stays open. */
  statusReadError?: string | null;
  /** When that read failed: a second failure with the same words is still a new one to show. */
  statusReadFailedAt?: number;
  onRetryStatus?: () => void;
}) {
  const provider = card ? cardProvider(card.key) : null;
  const caps = getCapabilities(card);
  const [tab, setTab] = useState<"config" | "deliveries">("config");
  // A refresh that fails after a press at the drawer's foot is shown where it is read (ISS-1421 r14),
  // every time it fails: keyed on when it failed, since a second failure reads the same (r15).
  const noticeRef = useRef<HTMLDivElement>(null);
  const failure = statusReadError ? `${statusReadFailedAt}:${statusReadError}` : null;
  useEffect(() => {
    if (failure) noticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [failure]);

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
        {statusReadError ? (
          // In the drawer's flow, above the first field: it pushes the form down and never covers a control.
          <div ref={noticeRef} className="scroll-mt-4">
          <Banner
            tone="attention"
            action={
              onRetryStatus ? (
                <Button variant="ghost" size="sm" onClick={onRetryStatus}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {`The status could not be refreshed, so the state above is the last one read. ${statusReadError}`}
          </Banner>
          </div>
        ) : null}
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
                focus={focus}
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
            focus={focus}
          />
        )}
      </div>
    </SlideOver>
  );
}
