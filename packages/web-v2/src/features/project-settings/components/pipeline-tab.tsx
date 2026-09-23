"use client";


import type { ReactNode } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  CardContent,
  Collapsible,
  EmptyState,
  ErrorState,
  SectionTitle,
  Skeleton,
  Toggle,
} from "@/design";
import { formatApiError, } from "@/lib/api/error";
import { useProjectRunners } from "@/features/runners/hooks";
import { useSettingsDraft } from "../draft";
import { isFeatureOff, usePipelineConfig, useUpdatePipelineConfig } from "../hooks";
import { McpServersSection } from "./mcp-servers-section";
import { IntakeGateSection } from "./intake-gate-section";
import { PoolBacklogSection } from "./pool-backlog-section";
import { AssistantWeeklySection } from "./assistant-weekly-section";
import { KnowledgePromotionSection } from "./knowledge-promotion-section";
import { StagePermissionsSection } from "./stage-permissions-section";
import { RunnerPoolsSection } from "./runner-pools-section";
import { PluginsSection } from "./plugins-section";
import { ReleaseSection } from "./release-section";
import {
  API_ONLY_KEYS,
  type PipelineConfig,
  type PipelineStateConfig,
  sectionWrite,
} from "../types";
import { SaveRefusedBanner } from "./save-refused-banner";

const ENTRY_STATUS = "open";


function entryOf(cfg: PipelineConfig): PipelineStateConfig | undefined {
  return (cfg.states as Record<string, PipelineStateConfig> | undefined)?.[ENTRY_STATUS];
}

function entryGateOpen(cfg: PipelineConfig): boolean {
  const entry = entryOf(cfg);
  return entry?.enabled !== false && entry?.mode !== "manual";
}

function withEntryGate(cfg: PipelineConfig, open: boolean): PipelineConfig {
  const states = (cfg.states ?? {}) as Record<string, PipelineStateConfig>;
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

/** The two switches this card owns — the master one and the entry gate — and no other key
 *  of the document, so a section below saving from the same page load is not touched. */
function masterSlice(cfg: PipelineConfig): PipelineConfig {
  return {
    enabled: cfg.enabled,
    states: { [ENTRY_STATUS]: { enabled: entryOf(cfg)?.enabled, mode: entryOf(cfg)?.mode } },
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

  // The two switches this card owns, and only those: every other key of the document belongs
  // to a section below, which holds its own draft over the same read.
  const seeded = masterSlice(cfgQ.data?.pipelineConfig ?? {});
  const held = useSettingsDraft(seeded);
  const draft = held.draft;

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

  const server = cfgQ.data?.pipelineConfig ?? {};
  const masterEnabled = draft.enabled !== false;
  const dirty = held.dirty;
  const libraryHref = slug ? `/projects/${slug}/library?tab=skills` : undefined;

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-1">Pipeline</SectionTitle>
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
                onChange={(v) => held.setDraft((d) => ({ ...d, enabled: v }))}
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
                onChange={(v) => held.setDraft((d) => withEntryGate(d, v))}
                disabled={!canEdit || !masterEnabled}
                aria-label="Start queued issues automatically"
              />
            }
          />
        </div>

        {canEdit && (
          <div className="mt-4 space-y-3">
            <SaveRefusedBanner
              projectId={projectId}
              error={update.isError ? update.error : null}
              onDismiss={() => update.reset()}
              draft={held}
            />
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty}
              onClick={() => update.mutate(sectionWrite(masterSlice(server), draft))}
              className="min-h-11"
            >
              Save pipeline config
            </Button>
          </div>
        )}

        <ReleaseSection projectId={projectId} slug={slug} />

        <PluginsSection projectId={projectId} canEdit={canEdit} />

        <McpServersSection projectId={projectId} config={server} canEdit={canEdit} />

        <StagePermissionsSection
          projectId={projectId}
          config={server}
          canEdit={canEdit}
          deviceNames={deviceNames}
        />

        <RunnerPoolsSection projectId={projectId} config={server} canEdit={canEdit} />

        <IntakeGateSection projectId={projectId} config={server} canEdit={canEdit} />

        <PoolBacklogSection projectId={projectId} config={server} canEdit={canEdit} />

        <KnowledgePromotionSection projectId={projectId} config={server} canEdit={canEdit} />

        <AssistantWeeklySection projectId={projectId} config={server} canEdit={canEdit} />

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
