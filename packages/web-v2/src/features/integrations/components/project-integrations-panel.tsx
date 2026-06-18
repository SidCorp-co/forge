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
import type { StatusCard } from "../types";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { McpServersPanel } from "./mcp-servers-panel";
import { ENV_LABEL, StatusPill } from "./status-pill";

const PROVIDER_ICON: Record<string, IconName> = {
  github: "github",
  coolify: "server",
  runners: "cpu",
  postgres: "archive",
  mcp: "command",
  sentry: "shield",
  claude: "agent",
};

function providerIcon(key: string): IconName {
  return PROVIDER_ICON[key.split(":")[0] ?? key] ?? "link";
}

function externalRepoUrl(card: StatusCard): string | null {
  if (card.key !== "github") return null;
  const remote = card.meta?.remoteUrl;
  if (typeof remote === "string" && /^https?:\/\//.test(remote)) {
    return remote.replace(/\.git$/, "");
  }
  return null;
}

function IntegrationCard({ card, onOpen }: { card: StatusCard; onOpen?: () => void }) {
  const lastSync = formatRelativeTime(card.lastSyncAt);
  const repoUrl = externalRepoUrl(card);
  const transport =
    card.key === "github" && typeof card.meta?.transport === "string"
      ? (card.meta.transport as string)
      : null;
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
              <Icon name={providerIcon(card.key)} size={18} className="text-muted" />
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
            {repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                Open repo
                <Icon name="arrowRight" size={13} />
              </a>
            ) : clickable ? (
              <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent">
                Manage
                <Icon name="arrowRight" size={13} />
              </span>
            ) : null}
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

/** Human env label for a sub-row: prefer the card's `meta.environment`, fall
 *  back to the `provider:<env>` key suffix, then to the raw value. */
function envLabel(card: StatusCard): string {
  const env =
    (typeof card.meta?.environment === "string" ? card.meta.environment : undefined) ??
    card.key.split(":")[1] ??
    "";
  return ENV_LABEL[env] ?? env;
}

/**
 * One consolidated card for an env-split provider (e.g. Coolify): a single
 * provider header followed by one sub-row per environment. Each sub-row keeps
 * its own status pill, last-health detail, synced time, and a Manage
 * affordance that opens the drawer scoped to that environment's card — so
 * per-env drill-in / Test / Rotate / Disconnect is unchanged. No aggregate
 * health pill in the header (we never fabricate combined health).
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
            <Icon name={providerIcon(provider)} size={18} className="text-muted" />
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
                    <span className="fg-body-sm font-semibold">{envLabel(card)}</span>
                    <StatusPill card={card} />
                  </div>
                  <p className="fg-body-sm text-muted">{card.detail}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="fg-body-sm text-subtle">
                      {lastSync ? `synced ${lastSync}` : "no sync data"}
                    </span>
                    {clickable ? (
                      <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-accent">
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
export function ProjectIntegrationsPanel({ projectId }: { projectId: string }) {
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

          <McpServersPanel projectId={projectId} />

          {/* Drill-in: provider cards open an adaptive connection detail drawer
              (config + Test/Rotate/Disconnect, plus delivery log when the
              adapter declares hasDeliveryLog). ISS-402. */}
          <ConnectionDetailDrawer
            projectId={projectId}
            card={selectedCard}
            onClose={() => setSelectedCard(null)}
          />
        </>
      )}
    </div>
  );
}
