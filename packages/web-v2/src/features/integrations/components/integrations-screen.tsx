"use client";

import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  HelpButton,
  Icon,
  type IconName,
  Select,
  Skeleton,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useIntegrationsStatus } from "../hooks";
import { DIRECTORY_STATUS_META, deriveDirectoryStatus, isProviderCard } from "../derive";
import type { StatusCard } from "../types";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";

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

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Status dot rendered as icon + text + tinted pill (never color-only — a11y).
 *  The directory state is derived client-side (ISS-402): a tripped breaker and
 *  the server `attention` bucket both read Degraded; no fabricated health. */
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

function IntegrationCard({ card, onOpen }: { card: StatusCard; onOpen?: () => void }) {
  const lastSync = relativeTime(card.lastSyncAt);
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

export function IntegrationsScreen() {
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string>("");

  // Default the selector to the first project once the list loads.
  useEffect(() => {
    if (!projectId && projects.data && projects.data.length > 0) {
      setProjectId(projects.data[0].id);
    }
  }, [projects.data, projectId]);

  const status = useIntegrationsStatus(projectId || undefined);
  const [selectedCard, setSelectedCard] = useState<StatusCard | null>(null);

  const options = useMemo(
    () => (projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
    [projects.data],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="fg-h2">Integrations</h1>
          <p className="fg-body-sm text-muted">
            Live connection status for this project&apos;s external services.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {options.length > 0 && (
            <div className="w-[200px]">
              <Select options={options} value={projectId} onChange={setProjectId} />
            </div>
          )}
          <HelpButton
            summary="A real-time view of the services this project depends on — GitHub, Coolify deploys, runners, Postgres, the MCP server, Sentry, and Claude. Each card shows a live status (icon + text, never color alone) and the last sync where one exists. Cards reflect only real backing data; providers with no signal show 'Not configured'."
            actions={[
              "Switch project with the selector to inspect another project",
              "Open repo — jump to the GitHub remote (HTTPS remotes only)",
            ]}
            docPath="docs/guides/integrations.md"
          />
        </div>
      </div>

      {projects.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-[148px] w-full" />
          ))}
        </div>
      ) : projects.isError ? (
        <ErrorState message={formatApiError(projects.error)} onRetry={() => projects.refetch()} />
      ) : options.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title="No projects"
              message="Create a project to see its integrations."
              mascot={false}
            />
          </CardContent>
        </Card>
      ) : status.isLoading ? (
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

          {/* Drill-in: provider cards open an adaptive connection detail drawer
              (config + Test/Rotate/Disconnect, plus delivery log when the
              adapter declares hasDeliveryLog). ISS-402. */}
          {projectId && (
            <ConnectionDetailDrawer
              projectId={projectId}
              card={selectedCard}
              onClose={() => setSelectedCard(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
