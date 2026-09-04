"use client";

// cm:why the nine-row stage ladder and its per-stage skill picker were removed with the lane they configured (ISS-897): there is one dispatching status now, and the driver skill arrives as a plugin that `skill_registrations` never resolves, so a picker here had nothing left to bind — the Plugins section is where the skill actually comes from

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Banner,
  Button,
  Card,
  CardContent,
  Collapsible,
  EmptyState,
  ErrorState,
  Skeleton,
  Toggle,
} from "@/design";
import { formatApiError, formatPipelineConfigError } from "@/lib/api/error";
import { useProjectRunners } from "@/features/runners/hooks";
import { isFeatureOff, usePipelineConfig, useUpdatePipelineConfig } from "../hooks";
import { McpServersSection } from "./mcp-servers-section";
import { IntakeGateSection } from "./intake-gate-section";
import { StagePermissionsSection } from "./stage-permissions-section";
import { RunnerPoolsSection } from "./runner-pools-section";
import { AgentConfigSection } from "./agent-config-section";
import { PluginsSection } from "./plugins-section";
import { ReleaseSection } from "./release-section";
import { API_ONLY_KEYS, type PipelineConfig } from "../types";

// cm:edge contract -> packages/core/src/pipeline/autonomous-dispatch.ts — `isEntryGateClosed` reads exactly this pair on exactly this status, and CLOSED is the OR of them: a screen that read only one knob would show "on" for a project whose issues the gate is holding, which is the invisible-gate the nine-row ladder left behind when ISS-897 removed it.
const ENTRY_STATUS = "open";

type EntryGate = { enabled?: boolean; mode?: string };

function entryOf(cfg: PipelineConfig): EntryGate | undefined {
  return (cfg.states as Record<string, EntryGate> | undefined)?.[ENTRY_STATUS];
}

function entryGateOpen(cfg: PipelineConfig): boolean {
  const entry = entryOf(cfg);
  return entry?.enabled !== false && entry?.mode !== "manual";
}

// cm:guard writes BOTH knobs to a matching pair, never one. Setting `mode` alone leaves a stored `enabled: false` holding the queue behind a toggle that now reads "on" — the two knobs are one decision here and only the OR above is read.
function withEntryGate(cfg: PipelineConfig, open: boolean): PipelineConfig {
  const states = (cfg.states ?? {}) as Record<string, EntryGate>;
  return {
    ...cfg,
    states: {
      ...states,
      [ENTRY_STATUS]: {
        ...states[ENTRY_STATUS],
        enabled: open,
        mode: open ? "auto" : "manual",
      },
    },
  };
}

function StageRow({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="fg-label text-fg">{label}</p>
        {hint && <p className="fg-caption text-muted">{hint}</p>}
      </div>
      <div className="flex flex-none items-center gap-3">{control}</div>
    </div>
  );
}

export function PipelineTab({
  projectId,
  canEdit,
  slug,
}: {
  projectId: string;
  canEdit: boolean;
  slug?: string;
}) {
  const cfgQ = usePipelineConfig(projectId);
  const update = useUpdatePipelineConfig(projectId);

  const runnersQ = useProjectRunners(projectId);
  const deviceNames: Record<string, string> = {};
  for (const r of runnersQ.data ?? []) {
    if (r.deviceId && r.deviceName) deviceNames[r.deviceId] = r.deviceName;
  }

  // Local working copy of the full config — preserves opaque keys on save.
  const [draft, setDraft] = useState<PipelineConfig | null>(null);
  useEffect(() => {
    if (cfgQ.data) setDraft(cfgQ.data.pipelineConfig);
  }, [cfgQ.data]);

  if (cfgQ.isLoading) {
    return (
      <Card>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (cfgQ.isError) {
    if (isFeatureOff(cfgQ.error)) {
      return (
        <Card>
          <CardContent>
            <EmptyState
              title="Pipeline control is off"
              message="Per-project pipeline configuration isn't enabled on this deployment. Issues run on the built-in defaults."
              mascot={false}
            />
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent>
          <ErrorState message={formatApiError(cfgQ.error)} onRetry={() => cfgQ.refetch()} />
        </CardContent>
      </Card>
    );
  }

  if (!draft) return null;

  const server = cfgQ.data?.pipelineConfig ?? {};
  const masterEnabled = draft.enabled !== false;
  const dirty =
    (server.enabled !== false) !== masterEnabled || entryGateOpen(server) !== entryGateOpen(draft);
  const libraryHref = slug ? `/projects/${slug}/library?tab=skills` : undefined;

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Pipeline</h2>
        <p className="fg-body-sm mb-1 text-muted">
          An issue is picked up at <b>Queued</b>, runs as one session, and ends either at{" "}
          <b>Needs a human</b>, <b>Awaiting release</b> or closed. The session is driven by the{" "}
          <code>issue-flow</code> skill, which this project gets from a plugin — see Plugins below.
        </p>
        {libraryHref && (
          <p className="fg-caption mb-4">
            <Link href={libraryHref} className="text-accent-text hover:underline">
              Manage or create skills in Library →
            </Link>
          </p>
        )}

        <div className="divide-y divide-line">
          <StageRow
            label="Pipeline enabled"
            hint="Master switch — when off, nothing is dispatched."
            control={
              <Toggle
                checked={masterEnabled}
                onChange={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))}
                disabled={!canEdit}
                aria-label="Pipeline enabled"
              />
            }
          />
          <StageRow
            label="Start queued issues automatically"
            hint="Off holds every issue at Queued until a human starts it. The pipeline stays on — nothing else changes."
            control={
              <Toggle
                checked={entryGateOpen(draft)}
                onChange={(v) => setDraft((d) => (d ? withEntryGate(d, v) : d))}
                disabled={!canEdit || !masterEnabled}
                aria-label="Start queued issues automatically"
              />
            }
          />
        </div>

        {canEdit && (
          <div className="mt-4 space-y-3">
            {update.isError && (
              <Banner tone="danger" onDismiss={() => update.reset()}>
                {formatPipelineConfigError(update.error)}
              </Banner>
            )}
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty}
              onClick={() => update.mutate(draft)}
              className="min-h-11"
            >
              Save pipeline config
            </Button>
          </div>
        )}

        <ReleaseSection projectId={projectId} slug={slug} />

        <PluginsSection projectId={projectId} canEdit={canEdit} />

        {/* Project-default MCP servers — round-trips the full fetched config. */}
        <McpServersSection projectId={projectId} config={server} canEdit={canEdit} />

        <StagePermissionsSection config={server} deviceNames={deviceNames} />

        {/* Concurrency (maxConcurrentIssues) — round-trips the full fetched config. */}

        <RunnerPoolsSection projectId={projectId} config={server} canEdit={canEdit} />

        <IntakeGateSection projectId={projectId} config={server} canEdit={canEdit} />

        <AgentConfigSection projectId={projectId} />

        <div className="mt-6 border-t border-line pt-5">
          <Collapsible title={`Configured elsewhere — ${API_ONLY_KEYS.length} keys this screen doesn't edit`}>
            <ul className="space-y-2">
              {API_ONLY_KEYS.map((k) => (
                <li key={k.key}>
                  <p className="fg-label font-mono text-fg">{k.key}</p>
                  <p className="fg-caption text-muted">{k.reason}</p>
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      </CardContent>
    </Card>
  );
}
