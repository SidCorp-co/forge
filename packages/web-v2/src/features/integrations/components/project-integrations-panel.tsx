"use client";

// Project settings → Integrations: one flush table of what this project is connected to — the
// declared repository first, then one row per binding of every provider core presents, then the
// providers it could connect. Each row opens the provider's drawer (create / Test / Rotate /
// Disconnect + delivery log); connecting the repository is its provider row's act alone. Core health (runners, database, MCP mount) is not listed: nothing
// here can connect it, and the screens that own it already show it.

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  Button,
  ErrorState,
  Icon,
  type IconName,
  PageSection,
  PageSectionHeader,
  PageSectionTitle,
  Skeleton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { productCopy } from "@/lib/i18n/product-copy";
import { formatRelativeTime } from "@/lib/utils/format";
import { useIntegrationsList, useIntegrationsStatus } from "../hooks";
import { cardProvider, deriveDirectoryStatus, isProviderCard } from "../derive";
import { connectionTargetFor, providerIcon, providerLabel } from "../providers/registry";
import type { BindingSummary, StatusCard } from "../types";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { McpServersPanel } from "./mcp-servers-panel";
import { StatusPill } from "./status-pill";

const ROLE_WORDS = new Set(["Service", "Source", "Deploy"]);

function isRepositoryCard(card: Pick<StatusCard, "key">): boolean {
  return card.key === "repository" || card.key.endsWith(":repository");
}

function metaText(card: StatusCard, key: string): string | null {
  const value = card.meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The provider's own name on a card, without the binding parenthetical core appends. */
function providerName(card: StatusCard): string {
  return card.label.replace(/\s*\(.*\)$/, "");
}

/** What tells this binding apart, as core named it; a bare role word tells nothing and is not shown. */
function bindingName(card: StatusCard): string | null {
  const name = metaText(card, "name");
  return name && !ROLE_WORDS.has(name) ? name : null;
}

function healthText(card: StatusCard): string | null {
  if (!card.configured && !isRepositoryCard(card)) return null;
  const synced = formatRelativeTime(card.lastSyncAt);
  return synced ? `${card.detail} · ${synced}` : card.detail;
}

interface Row {
  card: StatusCard;
  icon: IconName;
  name: string;
  sub: string | null;
  target: string | null;
  targetHref: string | null;
  health: string | null;
}

function rowsOf(cards: StatusCard[], bindings: Map<string, BindingSummary>): Row[] {
  const repository = cards.filter(isRepositoryCard);
  const providers = cards.filter((c) => !isRepositoryCard(c));
  const connected = providers.filter((c) => c.configured);
  const open = providers.filter((c) => !c.configured);
  return [
    ...repository.map((card) => ({
      card,
      icon: "branch" as IconName,
      name: "Repository",
      sub: metaText(card, "provider") ? providerLabel(metaText(card, "provider") as string) : null,
      target: metaText(card, "repository"),
      targetHref: metaText(card, "remoteUrl")?.startsWith("https://") ? metaText(card, "remoteUrl") : null,
      health: healthText(card),
    })),
    ...[...connected, ...open].map((card) => {
      const provider = cardProvider(card.key);
      const bindingId = metaText(card, "bindingId");
      const binding = bindingId ? bindings.get(bindingId) : undefined;
      return {
        card,
        icon: providerIcon(provider),
        name: providerName(card),
        sub: bindingName(card),
        target: binding ? connectionTargetFor(provider, binding.config) : null,
        targetHref: null,
        health: healthText(card),
      };
    }),
  ];
}

/** The anchor a row is reached by: the repository row links to the provider row that connects it. */
function rowAnchor(card: Pick<StatusCard, "key">): string {
  return `integration-${card.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** The provider row that owns connecting the declared repository, where core names one. */
function connectOwner(cards: StatusCard[]): StatusCard | null {
  const repository = cards.find(isRepositoryCard);
  const provider = repository && deriveDirectoryStatus(repository) !== "connected" ? metaText(repository, "connectProvider") : null;
  return provider ? (cards.find((c) => !isRepositoryCard(c) && cardProvider(c.key) === provider) ?? null) : null;
}

/**
 * The repository row reads its state and never connects anything itself: where a provider row owns
 * the connect act, it links there (one act, one place), and focuses that row's own button.
 */
function RepositoryAction({
  card,
  canEdit,
  owner,
}: {
  card: StatusCard;
  canEdit: boolean;
  owner: StatusCard | null;
}) {
  const t = productCopy();
  const remote = metaText(card, "remoteUrl");
  if (deriveDirectoryStatus(card) === "connected") {
    return remote?.startsWith("https://") ? (
      <a
        href={remote}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-13 font-semibold text-accent hover:underline"
      >
        Open repo
        <Icon name="arrowRight" size={13} />
      </a>
    ) : null;
  }
  if (!canEdit) return null;
  if (owner) {
    const provider = providerName(owner);
    const anchor = rowAnchor(owner);
    return (
      <a
        href={`#${anchor}`}
        aria-label={t("integrations.repository.connectOn.label", {
          provider,
          repository: metaText(card, "repository") ?? t("integrations.repository.theRepository"),
        })}
        onClick={(e) => {
          const row = document.getElementById(anchor);
          if (!row) return;
          e.preventDefault();
          row.scrollIntoView?.({ block: "center" });
          row.querySelector<HTMLButtonElement>("button")?.focus();
        }}
        className="inline-flex items-center gap-1 text-13 font-semibold text-accent hover:underline"
      >
        {t("integrations.repository.connectOn", { provider })}
        <Icon name="arrowDown" size={13} />
      </a>
    );
  }
  return (
    <Link href="?tab=repo" className="text-13 font-semibold text-accent hover:underline">
      Set repository
    </Link>
  );
}

function IntegrationRow({
  row,
  canEdit,
  onOpen,
  owner,
}: {
  row: Row;
  canEdit: boolean;
  onOpen: (card: StatusCard) => void;
  /** The provider row that connects the declared repository, where one does. */
  owner: StatusCard | null;
}) {
  const { card } = row;
  const label = row.sub ? `${row.name} ${row.sub}` : row.name;
  const target = row.target ? (
    row.targetHref ? (
      <a href={row.targetHref} target="_blank" rel="noreferrer" className="font-mono text-muted hover:underline">
        {row.target}
      </a>
    ) : (
      <span className="font-mono text-muted">{row.target}</span>
    )
  ) : null;
  const ownsRepositoryConnect = owner !== null && owner.key === card.key;
  const tourConnect = isRepositoryCard(card) ? owner === null : ownsRepositoryConnect;
  return (
    <TR id={rowAnchor(card)}>
      <TD className="align-top">
        <span className="flex min-w-0 items-start gap-2">
          <Icon name={row.icon} size={16} className="mt-0.5 shrink-0 text-muted" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="fg-label text-fg">
              {row.name}
              {row.sub && <span className="font-normal text-muted"> · {row.sub}</span>}
            </span>
            <span className="sm:hidden">
              <StatusPill card={card} />
            </span>
            {target && <span className="[overflow-wrap:anywhere] sm:hidden">{target}</span>}
            {row.health && <span className="text-subtle sm:hidden">{row.health}</span>}
          </span>
        </span>
      </TD>
      <TD className="hidden align-top sm:table-cell">
        <StatusPill card={card} />
      </TD>
      <TD className="hidden align-top [overflow-wrap:anywhere] sm:table-cell">{target}</TD>
      <TD className="hidden max-w-[52ch] align-top text-muted sm:table-cell">{row.health}</TD>
      <TD className="text-right align-top whitespace-nowrap" data-tour={tourConnect ? "int-connect" : undefined}>
        {isRepositoryCard(card) ? (
          <RepositoryAction card={card} canEdit={canEdit} owner={owner} />
        ) : !isProviderCard(card.key) ? null : card.configured ? (
          <Button variant="ghost" size="sm" aria-label={`Manage ${label}`} onClick={() => onOpen(card)}>
            Manage
          </Button>
        ) : canEdit ? (
          <Button
            variant={ownsRepositoryConnect ? "primary" : "secondary"}
            size="sm"
            aria-label={`Connect ${label}`}
            onClick={() => onOpen(card)}
          >
            Connect
          </Button>
        ) : null}
      </TD>
    </TR>
  );
}

/**
 * Full integrations management for ONE project: the flush table (a row's action opens the provider
 * drawer) and the Agent MCP servers preview. Used by project settings → Integrations.
 */
export function ProjectIntegrationsPanel({
  projectId,
  canEdit = true,
}: {
  projectId: string;
  canEdit?: boolean;
}) {
  const status = useIntegrationsStatus(projectId);
  const list = useIntegrationsList(projectId);
  const [selectedCard, setSelectedCard] = useState<StatusCard | null>(null);
  const cards = useMemo(() => status.data?.cards ?? [], [status.data]);
  const bindings = useMemo(
    () => new Map((list.data?.bindings ?? []).map((b) => [b.id, b])),
    [list.data],
  );
  const rows = useMemo(() => rowsOf(cards, bindings), [cards, bindings]);
  const owner = useMemo(() => connectOwner(cards), [cards]);
  const connectedCount = rows.filter((r) => deriveDirectoryStatus(r.card) === "connected").length;

  const connectProvider = (provider: string) => {
    const card = cards.find((c) => !isRepositoryCard(c) && cardProvider(c.key) === provider);
    if (card) setSelectedCard(card);
  };

  return (
    <div className="flex flex-col gap-10">
      <PageSection>
        <PageSectionHeader className="border-b-0 pt-0">
          <span className="flex items-baseline gap-3">
            <PageSectionTitle>Integrations</PageSectionTitle>
            {status.data && (
              <span className="fg-body-sm text-subtle">
                {connectedCount} of {rows.length} connected
              </span>
            )}
          </span>
          <Button variant="ghost" size="sm" icon="rerun" onClick={() => status.refetch()}>
            Refresh
          </Button>
        </PageSectionHeader>
        {status.isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : status.isError ? (
          <ErrorState message={formatApiError(status.error)} onRetry={() => status.refetch()} />
        ) : (
          <Table aria-label="Integrations" data-tour="int-status">
            <THead>
              <TR>
                <TH>Integration</TH>
                <TH className="hidden sm:table-cell">Status</TH>
                <TH className="hidden sm:table-cell">Target</TH>
                <TH className="hidden sm:table-cell">Health</TH>
                <TH className="text-right">
                  <span className="sr-only">Action</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => (
                <IntegrationRow
                  key={row.card.key}
                  row={row}
                  canEdit={canEdit}
                  onOpen={setSelectedCard}
                  owner={owner}
                />
              ))}
            </TBody>
          </Table>
        )}
      </PageSection>

      <McpServersPanel projectId={projectId} canEdit={canEdit} onConnect={connectProvider} />

      <ConnectionDetailDrawer
        projectId={projectId}
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
        canEdit={canEdit}
      />
    </div>
  );
}
