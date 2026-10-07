"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import {
  PageSectionTitle,
  ErrorState,
  Skeleton,
  SlideOver,
  Tabs,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useProjectsIncludingArchived } from "@/features/projects/hooks";
import { useConnectionBindings, useConnections, useIntegrationsList } from "../hooks";
import { cardProvider, getCapabilities } from "../derive";
import { PROVIDER_MODULES, providerLabel } from "../providers/registry";
import type { BindingSummary, StatusCard } from "../types";
import { AgentAccessControl } from "./agent-access-control";
import { DeliveryLogViewer } from "./delivery-log-viewer";
import { BindingReleaseRunnerField } from "./release-runner-field";
import { StatusPill, scopeLabel } from "./status-pill";

/** Adaptive connection detail (ISS-402). Opened from a directory provider card;
 *  renders the provider's existing config+actions section (Test / Rotate /
 *  Disconnect) and — ONLY when the adapter declares `hasDeliveryLog` — a
 *  read-only delivery-log tab, scoped to the binding the card stands for.
 *  MCP-injection providers therefore get a
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
function ProviderSection({ provider, projectId }: { provider: string; projectId: string }) {
  const Section = SECTIONS.get(provider);
  const t = useCopy();
  const language = useInterfaceLanguage();
  if (!Section) {
    return (
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        {t("integrations.detail.nothingToConfigure", { provider: providerLabel(provider, language) })}
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
 *  scoped to: the one the card's `meta.bindingId` names, and the provider's
 *  only binding where the card names none. */
function useBindingForCard(
  projectId: string,
  provider: string,
  bindingId: string | null,
): BindingSummary | undefined {
  const list = useIntegrationsList(projectId);
  return useMemo(() => {
    const rows = (list.data?.items ?? []).filter((i) => i.provider === provider);
    if (bindingId) return rows.find((r) => r.id === bindingId);
    return rows[0];
  }, [list.data, provider, bindingId]);
}

function BindingsSection({
  connectionId,
  currentProjectId,
}: {
  connectionId: string;
  currentProjectId: string;
}) {
  const bindingsQ = useConnectionBindings(connectionId);
  const t = useCopy();
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
        <PageSectionTitle>{t("integrations.detail.projectsUsing")}</PageSectionTitle>
        {isOrgOwned && (
          <span className="fg-body-sm rounded-pill bg-sunken px-2 py-0.5 text-subtle">
            {t("integrations.detail.orgShared")}
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
        />
      )}
    </section>
  );
}

function BindingsList({
  items,
  projectNames,
  currentProjectId,
}: {
  items: BindingSummary[];
  projectNames: Map<string, string>;
  currentProjectId: string;
}) {
  const t = useCopy();
  if (items.length === 0) {
    return (
      <p className="fg-body-sm rounded-md border border-line bg-surface px-3 py-2 text-muted">
        {t("integrations.detail.onlyThisProject")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line-subtle">
      {items.map((b) => {
        const isCurrent = b.projectId === currentProjectId;
        const name = projectNames.get(b.projectId) ?? b.projectId;
        return (
          <li
            key={b.id}
            className="flex items-center gap-3 py-2"
          >
            <span className="truncate text-fg">{name}</span>
            <span className="fg-body-sm text-muted">{scopeLabel(b.role, t)}</span>
            {isCurrent && (
              <span className="fg-body-sm ml-auto rounded-pill bg-sunken px-2 py-0.5 text-subtle">
                {t("integrations.detail.thisProject")}
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
  bindingId,
}: {
  provider: string;
  projectId: string;
  bindingId: string | null;
}) {
  const binding = useBindingForCard(projectId, provider, bindingId);
  return (
    <div className="flex flex-col gap-3">
      <DeliveryLogViewer projectId={projectId} bindingId={binding?.id ?? null} />
    </div>
  );
}

function ConfigPane({
  provider,
  projectId,
  bindingId,
  canEdit,
}: {
  provider: string;
  projectId: string;
  bindingId: string | null;
  canEdit: boolean;
}) {
  const binding = useBindingForCard(projectId, provider, bindingId);
  return (
    <>
      <ProviderSection provider={provider} projectId={projectId} />
      {binding && (
        <section className="mt-4">
          <AgentAccessControl projectId={projectId} binding={binding} canEdit={canEdit} />
        </section>
      )}
      {/* ISS-1275 — the binding tier of the release runner label, beside the other
          binding-scoped control on this pane. It renders itself away for a binding
          no environment can name. */}
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
  const t = useCopy();
  const language = useInterfaceLanguage();

  if (!card || !provider) return null;

  const bindingId = typeof card.meta?.bindingId === "string" ? card.meta.bindingId : null;

  const title = (
    <span className="flex items-center gap-2.5">
      <span>{providerLabel(provider, language)}</span>
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
                { value: "config", label: t("integrations.detail.config") },
                { value: "deliveries", label: t("integrations.detail.deliveries") },
              ]}
              value={tab}
              onChange={(v) => setTab(v as "config" | "deliveries")}
            />
            {tab === "config" ? (
              <ConfigPane
                provider={provider}
                projectId={projectId}
                bindingId={bindingId}
                canEdit={canEdit}
              />
            ) : (
              <DeliveryLogPane
                provider={provider}
                projectId={projectId}
                bindingId={bindingId}
              />
            )}
          </>
        ) : (
          <ConfigPane
            provider={provider}
            projectId={projectId}
            bindingId={bindingId}
            canEdit={canEdit}
          />
        )}
      </div>
    </SlideOver>
  );
}
