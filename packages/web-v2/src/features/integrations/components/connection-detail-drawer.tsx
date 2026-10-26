"use client";

import { type ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  Button,
  CardTitle,
  ConfirmDialog,
  ErrorState,
  SegmentedControl,
  Skeleton,
  SlideOver,
  Tabs,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { projectCalled } from "../connection-identity";
import { useConnectionBindings, useConnections, useIntegrationsList } from "../hooks";
import { cardBindingId, cardProvider, getCapabilities } from "../derive";
import { PROVIDER_MODULES, providerLabel } from "../providers/registry";
import type { BindingSummary, DeployStage, ProjectBinding, StatusCard } from "../types";
import { AgentAccessControl } from "./agent-access-control";
import { onlyWho } from "./integration-enabled-control";
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
  bindingId,
  after,
}: {
  provider: string;
  projectId: string;
  stage: DeployStage | null;
  bindingId: string | undefined;
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
      <Section projectId={projectId} {...(stage ? { stage } : {})} {...(bindingId ? { bindingId } : {})} />
      {after}
    </Suspense>
  );
}

/** The binding (and so the connection) the drawer reads: the one its row's card names (ISS-1421
 *  r33), else the first serving the stage the card key carries (`coolify:live`), else the first. */
function useBindingForCard(
  projectId: string,
  provider: string,
  stageHint: DeployStage | null,
  bindingId: string | undefined,
): ProjectBinding | undefined {
  const list = useIntegrationsList(projectId);
  return useMemo(() => {
    const rows = (list.data?.items ?? []).filter((i) => i.provider === provider);
    if (bindingId) return rows.find((r) => r.id === bindingId);
    if (stageHint) return rows.find((r) => r.stages.includes(stageHint));
    return rows[0];
  }, [list.data, provider, stageHint, bindingId]);
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
        <ErrorState title="Couldn't load the projects using this connection"
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

/**
 * A row whose binding the list no longer holds: the rows behind the drawer are read again, so the
 * stale row leaves the list rather than opening to this sentence each time it is pressed (ISS-1421
 * r34, judge-138: "Close this drawer and open its row again" repeated until Refresh).
 */
function GoneBinding({ provider, projectId, what }: { provider: string; projectId: string; what: string }) {
  const qc = useQueryClient();
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["integrations", "status", projectId] });
  }, [qc, projectId]);
  return (
    <p className="fg-body-sm border-b border-line pb-2 text-muted">
      {`This ${providerLabel(provider)} binding is no longer on this project, so ${what}`}
    </p>
  );
}

function DeliveryLogPane({
  provider,
  projectId,
  canDeploy,
  bindingId,
}: {
  provider: string;
  projectId: string;
  canDeploy: boolean;
  bindingId: string | undefined;
}) {
  const [stage, setStage] = useState<DeployStage>("preview");
  const list = useIntegrationsList(projectId);
  const rows = useMemo(
    () => (list.data?.items ?? []).filter((i) => i.provider === provider),
    [list.data, provider],
  );
  const named = bindingId ? rows.find((r) => r.id === bindingId) : undefined;
  // A row's binding the list no longer holds logs nothing: no other binding stands in for it.
  const gone = Boolean(bindingId) && !named;
  const binding = gone
    ? undefined
    : !canDeploy
      ? (named ?? rows[0])
      : named?.stages.includes(stage)
        ? named
        : rows.find((r) => r.stages.includes(stage));

  if (gone && list.data) {
    return <GoneBinding provider={provider} projectId={projectId} what="it has no delivery log to show." />;
  }
  return (
    <div className="flex flex-col gap-3">
      {canDeploy && (
        <SegmentedControl<DeployStage> value={stage} onChange={setStage} options={STAGE_OPTIONS} />
      )}
      <DeliveryLogViewer projectId={projectId} provider={provider} bindingId={binding?.id ?? null} />
    </div>
  );
}

function ConfigPane({
  provider,
  projectId,
  stageFromCardKey,
  bindingId,
  focus,
  onProbeDirty,
}: {
  provider: string;
  projectId: string;
  stageFromCardKey: DeployStage | null;
  bindingId: string | undefined;
  focus: string | null;
  onProbeDirty: (dirty: boolean) => void;
}) {
  const binding = useBindingForCard(projectId, provider, stageFromCardKey, bindingId);
  const list = useIntegrationsList(projectId);
  const may = list.data?.may ?? null;
  // A provider this project has not connected is offered to a reader who may connect one, and
  // anyone else is told who may, rather than shown a form core refuses (ISS-1421 r27).
  const connected = (list.data?.items ?? []).some((i) => i.provider === provider);
  if (bindingId && list.data && !binding) {
    return <GoneBinding provider={provider} projectId={projectId} what="there is nothing here to change." />;
  }
  if (!connected && may && !may.connect) {
    return (
      <p className="fg-body-sm border-b border-line pb-2 text-muted">
        {`${onlyWho(may.whoConnects)} can connect ${providerLabel(provider)} to this project.`}
      </p>
    );
  }
  return (
    <>
      <ProviderSection
        provider={provider}
        projectId={projectId}
        stage={stageFromCardKey}
        bindingId={bindingId}
        after={
          // ISS-1339 r2 — what a release reads to learn the commit production serves, on every live
          // deploy binding whatever its provider; it renders itself away elsewhere.
          binding && (
            <div className="mt-4">
              <BindingVerifyProbeField
                projectId={projectId}
                binding={binding}
                focus={focus === VERIFY_PROBE_SECTION}
                onDirtyChange={onProbeDirty}
              />
            </div>
          )
        }
      />
      {/* A provider's section carries its own agents switch, with its own refusal words, so the
          pane adds one only where there is no section (ISS-1421 r8, criterion 128). */}
      {binding && !SECTIONS.has(provider) && (
        <section className="mt-4">
          <AgentAccessControl projectId={projectId} binding={binding} />
        </section>
      )}
      {/* ISS-1275 — the binding tier of the release runner label, beside the other
          binding-scoped control on this pane. It renders itself away for a binding
          that carries no live stage. */}
      {binding && (
        <section className="mt-4">
          <BindingReleaseRunnerField projectId={projectId} binding={binding} />
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
  statusReadError = null,
  statusReadFailedAt = 0,
  onRetryStatus,
  focus = null,
}: {
  projectId: string;
  card: StatusCard | null;
  onClose: () => void;
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
  // An unsaved probe edit is asked about before the drawer closes over it (ISS-1339 r3).
  const [probeDirty, setProbeDirty] = useState(false);
  const [askingDiscard, setAskingDiscard] = useState(false);
  const requestClose = () => (probeDirty ? setAskingDiscard(true) : onClose());
  // A refresh that fails after a press at the drawer's foot is shown where it is read (ISS-1421 r14),
  // every time it fails: keyed on when it failed, since a second failure reads the same (r15).
  const noticeRef = useRef<HTMLDivElement>(null);
  const failure = statusReadError ? `${statusReadFailedAt}:${statusReadError}` : null;
  useEffect(() => {
    if (failure) noticeRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [failure]);

  // The list a drawer acts from is read again as it opens: a binding cleared from another session within
  // the cache's minute otherwise opened whole, every control aimed at a row core no longer holds (r34).
  const qc = useQueryClient();
  const openedOn = card ? `${card.key}:${cardBindingId(card) ?? ""}` : null;
  useEffect(() => {
    if (openedOn) void qc.invalidateQueries({ queryKey: ["integrations", "list", projectId] });
  }, [openedOn, qc, projectId]);

  if (!card || !provider) return null;

  // Scope suffix on the card key (`coolify:live`, `coolify:preview+live`,
  // `sentry:service`) → the stage to scope the drawer to. A card whose suffix
  // names no single stage — a service binding, or one serving both — collapses
  // to `null`, which reads as "every binding of this provider".
  const scopeSuffix = card.key.includes(":") ? card.key.split(":")[1] : undefined;
  const stageFromCardKey: DeployStage | null =
    caps.canDeploy && (scopeSuffix === "preview" || scopeSuffix === "live") ? scopeSuffix : null;
  // The row's own binding: everything below reads and acts on it, never another of the provider's.
  const bindingId = cardBindingId(card);

  const title = (
    <span className="flex items-center gap-2.5">
      <span>{providerLabel(provider)}</span>
      <StatusPill card={card} />
    </span>
  );

  return (
    <SlideOver open={Boolean(card)} onClose={requestClose} title={title} width={560}>
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
        {/* The reason the row gives, from the same card: a Postman binding needing sign-in showed only
            the badge here until Test was pressed (ISS-1421 r27, judge-110 (c)). */}
        {card.configured && (card.status === "attention" || card.status === "error") && card.detail ? (
          <p className="fg-body-sm text-muted">{card.detail}</p>
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
            {/* Hidden rather than unmounted, so the log tab does not take an unsaved edit with it. */}
            <div className={tab === "config" ? "flex flex-col gap-4" : "hidden"}>
              <ConfigPane
                provider={provider}
                projectId={projectId}
                stageFromCardKey={stageFromCardKey}
                bindingId={bindingId}
                focus={focus}
                onProbeDirty={setProbeDirty}
              />
            </div>
            {tab === "deliveries" && (
              <DeliveryLogPane
                provider={provider}
                projectId={projectId}
                canDeploy={caps.canDeploy}
                bindingId={bindingId}
              />
            )}
          </>
        ) : (
          <ConfigPane
            provider={provider}
            projectId={projectId}
            stageFromCardKey={stageFromCardKey}
            bindingId={bindingId}
            focus={focus}
            onProbeDirty={setProbeDirty}
          />
        )}
      </div>
      <ConfirmDialog
        open={askingDiscard}
        title="Discard the unsaved probe?"
        message="The Verify probe has changes you have not saved. Closing the drawer discards them."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onConfirm={() => {
          setAskingDiscard(false);
          setProbeDirty(false);
          onClose();
        }}
        onClose={() => setAskingDiscard(false)}
      />
    </SlideOver>
  );
}
