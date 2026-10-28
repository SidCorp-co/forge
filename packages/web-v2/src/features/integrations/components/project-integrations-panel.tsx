"use client";

// Project-scoped integrations management (ISS-429). The full surface — status
// rows, provider config drill-in (create/Test/Rotate/Disconnect + delivery
// log), and the Agent MCP servers panel — rendered INSIDE project settings, so
// configuring a project never bounces through the workspace hub. The workspace
// `/integrations` page is now the owner connection directory.

import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { Banner, Button, ErrorState, Icon, type IconName, RetryButton, SectionTitle, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { toldApart } from "../connection-identity";
import { useIntegrationsList, useIntegrationsStatus } from "../hooks";
import { cardBindingId, cardProvider, getCapabilities, groupCardsByProvider, isProviderCard } from "../derive";
import {
  connectionTargetFor,
  providerLabel,
  providerModule,
  providerIcon as registryIcon,
} from "../providers/registry";
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

/** Whether a card's key names `stage` among the stages its binding serves (`coolify:preview+live`). */
function servesStage(card: StatusCard, stage: string): boolean {
  return card.key.split(":")[1]?.split("+").includes(stage) === true;
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

const metaText = (card: StatusCard, key: string): string | null => {
  const value = card.meta?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** What a row is called beside its stage: its label, else the store its card names, else the host
 *  it points at (ISS-1421 r34, judge-138; r35, judge-141). */
function boundName(provider: string, card: StatusCard): string | null {
  return metaText(card, "label") ?? metaText(card, "storeName") ?? connectionTargetFor(provider, card.meta ?? {});
}

/**
 * The heading of each of a provider's rows, by card key: its stage and the name that tells it from
 * the others, and where two still read alike, the day and time each was connected (`connectedAt`,
 * by binding id), then a number, by the rule the share picker names connections by (ISS-1421 r35,
 * judge-141: two unlabelled Coolify rows read "Preview / Turned off" twice).
 */
export function rowHeadings(
  provider: string,
  cards: StatusCard[],
  connectedAt: ReadonlyMap<string, string>,
): Map<string, string> {
  const base = new Map<string, string>();
  for (const card of cards) {
    const name = boundName(provider, card);
    base.set(card.key, name ? `${scopeOf(card)} · ${name}` : scopeOf(card));
  }
  const rows = cards.map((card) => ({
    id: card.key,
    createdAt: connectedAt.get(cardBindingId(card) ?? "") ?? "",
  }));
  return toldApart(rows, base, "connected");
}

/**
 * A provider with more than one binding (e.g. Coolify), or one a project holds several of side by
 * side (Epodsystem's storefronts): its name as the heading, with the button that adds another where
 * the reader may, then one indented row per binding with its own state and Manage. No combined
 * health is made up.
 */
function GroupedIntegrationRows({
  provider,
  cards,
  onOpen,
  add,
  connectedAt,
}: {
  provider: string;
  cards: StatusCard[];
  onOpen?: (card: StatusCard) => void;
  add?: { label: string; onAdd: () => void };
  connectedAt: ReadonlyMap<string, string>;
}) {
  const headings = rowHeadings(provider, cards, connectedAt);
  const providerName = baseProviderLabel(cards[0]);
  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-4">
          <Icon name={cardIcon(provider)} size={18} className="text-muted" />
          <span className="fg-body font-semibold text-fg">{providerName}</span>
        </span>
        {add ? (
          <Button variant="ghost" size="sm" icon="plus" onClick={add.onAdd}>
            {add.label}
          </Button>
        ) : null}
      </div>
      <ul className="mt-1 divide-y divide-line pl-[34px]">
        {cards.map((card) => {
          const open = onOpen ? () => onOpen(card) : undefined;
          const heading = headings.get(card.key) ?? scopeOf(card);
          return (
            <li
              key={card.key}
              className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 ${open ? "cursor-pointer hover:bg-hover" : ""}`}
              {...openable(`${providerName} ${heading}`, open)}
            >
              <div className="min-w-0 flex-1 basis-[200px]">
                <p className="fg-body-sm font-semibold text-fg">{heading}</p>
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
 * it: a save refetches the list, and a kept copy went on reading Not connected (ISS-1421). A card
 * naming a binding is followed by that binding under the key it was opened at, whatever key the list
 * gives it now — `sentry:service:<id>` becomes `sentry` once its sibling goes — and one the list no
 * longer holds reads as not set up, never as another binding serving the same stage (ISS-1421 r34).
 * Otherwise it is found by provider and stage — `coolify` becomes `coolify:preview` once connected —
 * and a stage no card serves reads as not set up.
 */
export function liveCard(opened: StatusCard | null, cards: StatusCard[]): StatusCard | null {
  if (!opened) return null;
  const notSetUp = { ...opened, status: "not_configured" as const, configured: false, detail: "", lastSyncAt: null };
  const bindingId = cardBindingId(opened);
  if (bindingId) {
    const same = cards.find((c) => cardBindingId(c) === bindingId);
    return same ? { ...same, key: opened.key } : notSetUp;
  }
  const exact = cards.find((c) => c.key === opened.key);
  if (exact) return exact;
  const provider = cardProvider(opened.key);
  const same = cards.filter((c) => cardProvider(c.key) === provider);
  const stage = opened.key.split(":")[1];
  if (!stage) return same.length === 1 ? same[0] : opened;
  const serving = same.find((c) => servesStage(c, stage));
  if (serving) return { ...serving, key: opened.key };
  return notSetUp;
}

/**
 * The card a link opens the drawer on: the provider's card serving the stage the link names, under that
 * stage's key, which the drawer reads its stage off (`coolify:live`). Where no card serves it, the
 * provider's first lends its state and never its binding, so the drawer follows no other stage's
 * binding and the stage reads as not set up (ISS-1421 r34).
 */
export function cardForLink(cards: StatusCard[], provider: string, stage?: DeployStage): StatusCard | null {
  const ofProvider = cards.filter((c) => cardProvider(c.key) === provider);
  const serving = stage ? ofProvider.find((c) => servesStage(c, stage)) : undefined;
  const card = serving ?? ofProvider[0];
  if (!card) return null;
  if (!stage) return card;
  const { bindingId: _other, ...meta } = card.meta ?? {};
  return { ...card, key: `${provider}:${stage}`, meta: serving ? card.meta : meta };
}

/** The card the add drawer opens on: the provider alone, with its capabilities and no binding. */
function addingCard(provider: string, cards: StatusCard[]): StatusCard {
  return {
    key: provider,
    label: providerLabel(provider),
    status: "not_configured",
    detail: "",
    lastSyncAt: null,
    configured: false,
    meta: { capabilities: getCapabilities(cards[0]) },
  };
}

export function ProjectIntegrationsPanel({
  projectId,
  openProvider = null,
  onOpenProvider,
  onDrawerClose,
}: {
  projectId: string;
  /** A provider to open the drawer on, asked for from outside the list, the stage to open it at and
   *  the section to land on; cleared once opened. */
  openProvider?: { provider: string; stage?: DeployStage; focus?: string } | null;
  onOpenProvider?: () => void;
  /** Told once the drawer has closed, so a caller that opened it from the address can say so there. */
  onDrawerClose?: () => void;
}) {
  const status = useIntegrationsStatus(projectId);
  // When each binding was connected, which tells two rows apart where nothing else does, and whether
  // this reader may connect another: both off the project's integration list.
  const list = useIntegrationsList(projectId);
  const may = list.data?.may ?? null;
  const connectedAt = useMemo(
    () => new Map((list.data?.items ?? []).map((item) => [item.id, item.createdAt] as const)),
    [list.data],
  );
  const [selectedCard, setSelectedCard] = useState<StatusCard | null>(null);
  // The provider a reader is adding one more of, from the button beside its rows: a row's drawer is
  // about that row alone, so adding lives on the tab (ISS-1421 r35, judge-141).
  const [adding, setAdding] = useState<StatusCard | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const cards = status.data?.cards ?? [];
  // A failed refresh keeps what the last read showed: the open drawer and both writes stay in view,
  // and the failure is said beside them rather than in place of them (ISS-1421 r13).
  const readError = status.isError ? formatApiError(status.error) : null;

  useEffect(() => {
    if (!openProvider) return;
    const card = cardForLink(cards, openProvider.provider, openProvider.stage);
    if (!card) return;
    setSelectedCard(card);
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
        <ErrorState title="Couldn't load this project's integrations" message={formatApiError(status.error)} error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <>
          {readError ? (
            <Banner
              tone="attention"
              action={
                <RetryButton variant="ghost" error={status.error} onRetry={() => void status.refetch()} />
              }
            >
              {`The status could not be refreshed, so it shows the last read. ${readError}`}
            </Banner>
          ) : null}
          {list.isError && !list.data ? (
            <Banner
              tone="attention"
              action={
                <RetryButton variant="ghost" error={list.error} onRetry={() => void list.refetch()} />
              }
            >
              {`This project's integration list could not be read, so the rows cannot say when each was connected, and nothing can be added here. ${formatApiError(list.error)}`}
            </Banner>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <SectionTitle className="fg-h3">Status</SectionTitle>
            {!status.isError && (
              <Button variant="ghost" size="sm" icon="rerun" onClick={() => status.refetch()}>
                Refresh
              </Button>
            )}
          </div>
          <ul className="divide-y divide-line border-y border-line" data-testid="integration-rows">
            {groupCardsByProvider(cards).map((group) => {
              const addLabel = providerModule(group.provider)?.addAnother;
              const holdsOne = Boolean(addLabel) && group.cards.some((c) => c.configured);
              return group.cards.length > 1 || holdsOne ? (
                <GroupedIntegrationRows
                  key={group.provider}
                  provider={group.provider}
                  cards={group.cards}
                  onOpen={isProviderCard(group.provider) ? (card) => setSelectedCard(card) : undefined}
                  connectedAt={connectedAt}
                  add={
                    addLabel && holdsOne && may?.connect
                      ? { label: addLabel, onAdd: () => setAdding(addingCard(group.provider, group.cards)) }
                      : undefined
                  }
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
              );
            })}
          </ul>

          <McpServersPanel projectId={projectId} />
        </>
      )}
      <ConnectionDetailDrawer
        projectId={projectId}
        card={adding ?? liveCard(selectedCard, cards)}
        adding={adding !== null}
        onClose={() => {
          setSelectedCard(null);
          setAdding(null);
          setFocus(null);
          onDrawerClose?.();
        }}
        focus={focus}
        statusReadError={readError}
        statusReadFailedAt={status.errorUpdatedAt}
        statusError={status.error}
        onRetryStatus={() => status.refetch()}
      />
    </div>
  );
}
