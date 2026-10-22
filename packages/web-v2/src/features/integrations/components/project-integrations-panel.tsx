"use client";

// Project-scoped integrations management (ISS-429). The full surface — status
// rows, provider config drill-in (create/Test/Rotate/Disconnect + delivery
// log), and the Agent MCP servers panel — rendered INSIDE project settings, so
// configuring a project never bounces through the workspace hub. The workspace
// `/integrations` page is now the owner connection directory.

import { type KeyboardEvent, useEffect, useState } from "react";
import { Banner, Button, ErrorState, Icon, type IconName, SectionTitle, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useIntegrationsStatus } from "../hooks";
import { cardProvider, groupCardsByProvider, isProviderCard } from "../derive";
import { providerIcon as registryIcon } from "../providers/registry";
import type { DeployStage, StatusCard } from "../types";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { McpServersPanel } from "./mcp-servers-panel";
import { StatusPill, scopeLabel } from "./status-pill";

// The status read model carries telemetry cards beside the integration ones — a runner pool, the
// database, the agent. They are not providers and have no module; their icons live here.
const TELEMETRY_CARD_ICON: Record<string, IconName> = {
  runners: "cpu",
  postgres: "archive",
  mcp: "command",
  claude: "agent",
};

function cardIcon(key: string): IconName {
  const base = key.split(":")[0] ?? key;
  return TELEMETRY_CARD_ICON[base] ?? registryIcon(base);
}

function externalRepoUrl(card: StatusCard): string | null {
  const remote = card.meta?.remoteUrl;
  if (typeof remote === "string" && /^https?:\/\//.test(remote)) {
    return remote.replace(/\.git$/, "");
  }
  return null;
}

/** The row is the whole target: Enter or Space opens it, like a click. */
function openable(label: string, onOpen?: () => void) {
  if (!onOpen) return {};
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": `Manage ${label}`,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
  };
}

function ManageLink() {
  return (
    <span className="inline-flex items-center gap-1 text-13 font-semibold text-accent">
      Manage
      <Icon name="arrowRight" size={13} />
    </span>
  );
}

/** When it was last checked, said only where it was. */
function Checked({ card }: { card: StatusCard }) {
  const when = formatRelativeTime(card.lastSyncAt);
  return when ? <span className="fg-body-sm text-subtle">Checked {when}</span> : null;
}

/** One provider, one flush row: what it is and what it says on the left, its state on the right. */
function IntegrationRow({ card, onOpen }: { card: StatusCard; onOpen?: () => void }) {
  const repoUrl = externalRepoUrl(card);
  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5 ${onOpen ? "cursor-pointer hover:bg-hover" : ""}`}
      {...openable(card.label, onOpen)}
    >
      <Icon name={cardIcon(card.key)} size={18} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1 basis-[200px]">
        <p className="fg-body font-semibold text-fg">{card.label}</p>
        <p className="fg-body-sm text-muted">{card.detail}</p>
      </div>
      <div className="flex items-center gap-4 pl-[34px] sm:pl-0">
        <Checked card={card} />
        <StatusPill card={card} />
        {repoUrl ? (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-13 font-semibold text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Open repo
            <Icon name="arrowRight" size={13} />
          </a>
        ) : null}
        {onOpen ? <ManageLink /> : null}
      </div>
    </li>
  );
}

/** Provider label with the stage parenthetical stripped (`Coolify (prod)` → `Coolify`). */
function baseProviderLabel(card: StatusCard): string {
  return card.label.replace(/\s*\(.*\)$/, "");
}

function scopeOf(card: StatusCard): string {
  const role = card.meta?.role;
  const stages = card.meta?.stages;
  if (role === "deploy" || role === "service") {
    return scopeLabel(role, Array.isArray(stages) ? (stages as DeployStage[]) : []);
  }
  return card.key.split(":")[1] ?? "";
}

/**
 * A provider with more than one binding (e.g. Coolify): its name as the row's heading, then one
 * indented row per binding with its own state and Manage. No combined health is made up.
 */
function GroupedIntegrationRows({
  provider,
  cards,
  onOpen,
}: {
  provider: string;
  cards: StatusCard[];
  onOpen?: (card: StatusCard) => void;
}) {
  return (
    <li className="py-3.5">
      <span className="inline-flex items-center gap-4">
        <Icon name={cardIcon(provider)} size={18} className="text-muted" />
        <span className="fg-body font-semibold text-fg">{baseProviderLabel(cards[0])}</span>
      </span>
      <ul className="mt-1 divide-y divide-line pl-[34px]">
        {cards.map((card) => {
          const open = onOpen ? () => onOpen(card) : undefined;
          return (
            <li
              key={card.key}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 ${open ? "cursor-pointer hover:bg-hover" : ""}`}
              {...openable(card.label, open)}
            >
              <div className="min-w-0 flex-1 basis-[200px]">
                <p className="fg-body-sm font-semibold text-fg">{scopeOf(card)}</p>
                <p className="fg-body-sm text-muted">{card.detail}</p>
              </div>
              <div className="flex items-center gap-4">
                <Checked card={card} />
                <StatusPill card={card} />
                {open ? <ManageLink /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/**
 * Full integrations management for ONE project: live status cards (click a
 * provider card to configure/test/rotate/disconnect in the drawer) + the Agent
 * MCP servers preview. Used by project settings → Integrations.
 */
/**
 * The card the drawer shows, read from the current list rather than kept from the click that opened
 * it: a save refetches the list, and a kept copy went on reading Not connected (ISS-1421). A key the
 * list no longer has is found by provider and stage — `coolify` becomes `coolify:preview` once
 * connected — and a stage no card serves reads as not set up, never as another stage's state.
 */
export function liveCard(opened: StatusCard | null, cards: StatusCard[]): StatusCard | null {
  if (!opened) return null;
  const exact = cards.find((c) => c.key === opened.key);
  if (exact) return exact;
  const provider = cardProvider(opened.key);
  const same = cards.filter((c) => cardProvider(c.key) === provider);
  const stage = opened.key.split(":")[1];
  if (!stage) return same.length === 1 ? same[0] : opened;
  const serving = same.find((c) => c.key.split(":")[1]?.split("+").includes(stage));
  if (serving) return { ...serving, key: opened.key };
  return { ...opened, status: "not_configured", configured: false, detail: "", lastSyncAt: null };
}

export function ProjectIntegrationsPanel({
  projectId,
  canEdit = true,
  openProvider = null,
  onOpenProvider,
  onDrawerClose,
}: {
  projectId: string;
  canEdit?: boolean;
  /** A provider to open the drawer on, asked for from outside the list, the stage to open it at and
   *  the section to land on; cleared once opened. */
  openProvider?: { provider: string; stage?: DeployStage; focus?: string } | null;
  onOpenProvider?: () => void;
  /** Told once the drawer has closed, so a caller that opened it from the address can say so there. */
  onDrawerClose?: () => void;
}) {
  const status = useIntegrationsStatus(projectId);
  const [selectedCard, setSelectedCard] = useState<StatusCard | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const cards = status.data?.cards ?? [];
  // A failed refresh keeps what the last read showed: the open drawer and both writes stay in view,
  // and the failure is said beside them rather than in place of them (ISS-1421 r13).
  const readError = status.isError ? formatApiError(status.error) : null;

  useEffect(() => {
    if (!openProvider) return;
    const card = cards.find((c) => cardProvider(c.key) === openProvider.provider);
    if (!card) return;
    // The drawer reads the stage it opens at off the card's key suffix (`coolify:live`).
    const { stage } = openProvider;
    setSelectedCard(stage ? { ...card, key: `${openProvider.provider}:${stage}` } : card);
    setFocus(openProvider.focus ?? null);
    onOpenProvider?.();
  }, [openProvider, cards, onOpenProvider]);

  return (
    <div className="flex flex-col gap-4">
      {status.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-[56px] w-full" />
          ))}
        </div>
      ) : status.isError && !status.data ? (
        <ErrorState message={formatApiError(status.error)} onRetry={() => status.refetch()} />
      ) : (
        <>
          {readError ? (
            <Banner
              tone="attention"
              action={
                <Button variant="ghost" size="sm" onClick={() => status.refetch()}>
                  Retry
                </Button>
              }
            >
              {`The status could not be refreshed, so it shows the last read. ${readError}`}
            </Banner>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <SectionTitle className="fg-h3">Status</SectionTitle>
            <Button variant="ghost" size="sm" icon="rerun" onClick={() => status.refetch()}>
              Refresh
            </Button>
          </div>
          <ul className="divide-y divide-line border-y border-line" data-testid="integration-rows">
            {groupCardsByProvider(cards).map((group) =>
              group.cards.length > 1 ? (
                <GroupedIntegrationRows
                  key={group.provider}
                  provider={group.provider}
                  cards={group.cards}
                  onOpen={isProviderCard(group.provider) ? (card) => setSelectedCard(card) : undefined}
                />
              ) : (
                <IntegrationRow
                  key={group.provider}
                  card={group.cards[0]}
                  onOpen={
                    isProviderCard(group.cards[0].key)
                      ? () => setSelectedCard(group.cards[0])
                      : undefined
                  }
                />
              ),
            )}
          </ul>

          <McpServersPanel projectId={projectId} canEdit={canEdit} />
        </>
      )}
      <ConnectionDetailDrawer
        projectId={projectId}
        card={liveCard(selectedCard, cards)}
        onClose={() => {
          setSelectedCard(null);
          setFocus(null);
          onDrawerClose?.();
        }}
        canEdit={canEdit}
        focus={focus}
        statusReadError={readError}
        statusReadFailedAt={status.errorUpdatedAt}
        onRetryStatus={() => status.refetch()}
      />
    </div>
  );
}
