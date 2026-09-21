"use client";

// Project-scoped integrations management (ISS-429). The full surface — status
// cards, provider config drill-in (create/Test/Rotate/Disconnect + delivery
// log), and the Agent MCP servers panel — rendered INSIDE project settings, so
// configuring a project never bounces through the workspace hub. The workspace
// `/integrations` page is now the owner connection directory.

import { type KeyboardEvent, useState } from "react";
import { Button, Card, CardContent, ErrorState, Icon, type IconName, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { useIntegrationsStatus } from "../hooks";
import { groupCardsByProvider, isProviderCard } from "../derive";
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

function IntegrationCard({ card, onOpen }: { card: StatusCard; onOpen?: () => void }) {
  const lastSync = formatRelativeTime(card.lastSyncAt);
  const repoUrl = externalRepoUrl(card);
  const transport = typeof card.meta?.transport === "string" ? card.meta.transport : null;
  const clickable = Boolean(onOpen);

  return (
    <Card>
      <CardContent>
        <div
          className={`flex min-h-[120px] flex-col gap-2.5 ${clickable ? "cursor-pointer" : ""}`}
          {...(clickable
            ? {
                role: "button",
                tabIndex: 0,
                "aria-label": `Manage ${card.label}`,
                onClick: onOpen,
                onKeyDown: (e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen?.();
                  }
                },
              }
            : {})}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <Icon name={cardIcon(card.key)} size={18} className="text-muted" />
              <span className="fg-h3">{card.label}</span>
            </span>
            <StatusPill card={card} />
          </div>

          <p className="fg-body-sm text-muted">{card.detail}</p>

          {transport && (
            <p className="fg-body-sm text-subtle">
              transport: <span className="font-mono">{transport}</span>
            </p>
          )}

          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <span className="fg-body-sm text-subtle">
              {lastSync ? `synced ${lastSync}` : "no sync data"}
            </span>
            <span className="inline-flex items-center gap-3">
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
              {clickable ? (
                <span className="inline-flex items-center gap-1 text-13 font-semibold text-accent">
                  Manage
                  <Icon name="arrowRight" size={13} />
                </span>
              ) : null}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Provider label with the env parenthetical stripped (`Coolify (prod)` →
 *  `Coolify`), used as the consolidated card's header. */
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
 * One consolidated card for a provider with more than one binding (e.g.
 * Coolify): a single provider header followed by one sub-row per binding. Each
 * sub-row keeps its own status pill, last-health detail, synced time, and a
 * Manage affordance that opens the drawer scoped to that binding's card. No
 * aggregate health pill in the header (we never fabricate combined health).
 */
function GroupedIntegrationCard({
  provider,
  cards,
  onOpen,
}: {
  provider: string;
  cards: StatusCard[];
  onOpen?: (card: StatusCard) => void;
}) {
  return (
    <Card>
      <CardContent>
        <div className="flex min-h-[120px] flex-col gap-3">
          <span className="inline-flex items-center gap-2">
            <Icon name={cardIcon(provider)} size={18} className="text-muted" />
            <span className="fg-h3">{baseProviderLabel(cards[0])}</span>
          </span>

          <div className="flex flex-col divide-y divide-[var(--border-subtle)]">
            {cards.map((card) => {
              const lastSync = formatRelativeTime(card.lastSyncAt);
              const clickable = Boolean(onOpen);
              const open = () => onOpen?.(card);
              return (
                <div
                  key={card.key}
                  className={`flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0 ${
                    clickable ? "cursor-pointer" : ""
                  }`}
                  {...(clickable
                    ? {
                        role: "button",
                        tabIndex: 0,
                        "aria-label": `Manage ${card.label}`,
                        onClick: open,
                        onKeyDown: (e: KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            open();
                          }
                        },
                      }
                    : {})}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="fg-body-sm font-semibold">{scopeOf(card)}</span>
                    <StatusPill card={card} />
                  </div>
                  <p className="fg-body-sm text-muted">{card.detail}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="fg-body-sm text-subtle">
                      {lastSync ? `synced ${lastSync}` : "no sync data"}
                    </span>
                    {clickable ? (
                      <span className="inline-flex items-center gap-1 text-13 font-semibold text-accent">
                        Manage
                        <Icon name="arrowRight" size={13} />
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Full integrations management for ONE project: live status cards (click a
 * provider card to configure/test/rotate/disconnect in the drawer) + the Agent
 * MCP servers preview. Used by project settings → Integrations.
 */
export function ProjectIntegrationsPanel({
  projectId,
  canEdit = true,
}: {
  projectId: string;
  canEdit?: boolean;
}) {
  const status = useIntegrationsStatus(projectId);
  const [selectedCard, setSelectedCard] = useState<StatusCard | null>(null);

  return (
    <div className="flex flex-col gap-4">
      {status.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-[148px] w-full" />
          ))}
        </div>
      ) : status.isError ? (
        <ErrorState message={formatApiError(status.error)} onRetry={() => status.refetch()} />
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" icon="rerun" onClick={() => status.refetch()}>
              Refresh
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {groupCardsByProvider(status.data?.cards ?? []).map((group) =>
              group.cards.length > 1 ? (
                <GroupedIntegrationCard
                  key={group.provider}
                  provider={group.provider}
                  cards={group.cards}
                  onOpen={
                    isProviderCard(group.provider)
                      ? (card) => setSelectedCard(card)
                      : undefined
                  }
                />
              ) : (
                <IntegrationCard
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
          </div>

          <McpServersPanel projectId={projectId} canEdit={canEdit} />

          <ConnectionDetailDrawer
            projectId={projectId}
            card={selectedCard}
            onClose={() => setSelectedCard(null)}
            canEdit={canEdit}
          />
        </>
      )}
    </div>
  );
}
