"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/utils/format";
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
import type { CardStatus, StatusCard } from "../types";
import { CoolifySection } from "./coolify-section";
import { EpodsystemSection } from "./epodsystem-section";
import { PostmanSection } from "./postman-section";

const STATUS_META: Record<
  CardStatus,
  { icon: IconName; label: string; fg: string; bg: string }
> = {
  connected: { icon: "check", label: "Connected", fg: "var(--green-600)", bg: "var(--green-50)" },
  attention: { icon: "alert", label: "Attention", fg: "var(--amberw-600)", bg: "var(--amberw-50)" },
  error: { icon: "alert", label: "Error", fg: "var(--red-600)", bg: "var(--red-50)" },
  not_configured: {
    icon: "dot",
    label: "Not configured",
    fg: "var(--fg-subtle)",
    bg: "var(--bg-sunken)",
  },
};

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
function StatusPill({ status }: { status: CardStatus }) {
  const m = STATUS_META[status];
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

function IntegrationCard({ card }: { card: StatusCard }) {
  const lastSync = formatRelativeTime(card.lastSyncAt);
  const repoUrl = externalRepoUrl(card);
  const transport =
    card.key === "github" && typeof card.meta?.transport === "string"
      ? (card.meta.transport as string)
      : null;

  return (
    <Card>
      <CardContent>
        <div className="flex min-h-[120px] flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <Icon name={providerIcon(card.key)} size={18} className="text-muted" />
              <span className="fg-h3">{card.label}</span>
            </span>
            <StatusPill status={card.status} />
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
              >
                Open repo
                <Icon name="arrowRight" size={13} />
              </a>
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
              <IntegrationCard key={card.key} card={card} />
            ))}
          </div>

          {/* Editable per-project integration config. ISS-336 (Postman) +
              ISS-395 (Epodsystem + Coolify, ported from v1). */}
          {projectId && (
            <div className="mt-2 flex flex-col gap-4">
              <EpodsystemSection projectId={projectId} />
              <CoolifySection projectId={projectId} />
              <PostmanSection projectId={projectId} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
