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
import { DIRECTORY_STATUS_META, deriveDirectoryStatus, isProviderCard } from "../derive";
import type { StatusCard } from "../types";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { McpServersPanel } from "./mcp-servers-panel";

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

/** Status dot rendered as icon + text + tinted pill (never color-only — a11y). */
function StatusPill({ card }: { card: StatusCard }) {
  const m = DIRECTORY_STATUS_META[deriveDirectoryStatus(card)];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[12px] font-semibold"
      style={{ color: m.fg, background: m.bg }}
    >
      <Icon name={m.icon} size={13} />
      {m.label}
    </span>
  );
}

function externalRepoUrl(card: StatusCard): string | null {
  if (card.key !== "github") return null;
  const remote = card.meta?.remoteUrl;
  if (typeof remote === "string" && /^https?:\/\//.test(remote)) {
    return remote.replace(/\.git$/, "");
  }
  return null;
}

export function IntegrationCard({ card, onOpen }: { card: StatusCard; onOpen?: () => void }) {
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
            {(status.data?.cards ?? []).map((card) => (
              <IntegrationCard
                key={card.key}
                card={card}
                onOpen={isProviderCard(card.key) ? () => setSelectedCard(card) : undefined}
              />
            ))}
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
