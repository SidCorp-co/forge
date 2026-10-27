"use client";

// Project settings → Pipeline. One page, one form: every section below edits a part of the same
// draft, and the one save bar at the foot writes whatever moved — the pipeline-config document as
// one patch, and the plugins list, which lives in the project's agent config, as the second write.

import { ISSUE_STATUS_LABELS } from "@forge/contracts/issue-vocabulary";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import {
  Banner,
  Collapsible,
  EmptyState,
  ErrorState,
  SectionTitle,
  type SettingsForm,
  SettingsFormBar,
  Skeleton,
  Toggle,
  useSettingsForm,
  SettingsSection,
} from "@/design";
import { useProject } from "@/features/projects/hooks";
import { useProjectRunners } from "@/features/runners/hooks";
import { formatApiError, formatApiReason } from "@/lib/api/error";
import {
  isFeatureOff,
  usePipelineConfig,
  useUpdatePipelineConfig,
  useUpdatePlugins,
} from "../hooks";
import {
  entryGateOpen,
  type PipelineDraft,
  pipelineComparable,
  pipelineSchema,
  pipelineWrites,
  readPipeline,
  withEntryGate,
} from "../pipeline-form";
import {
  API_ONLY_KEYS,
  type PipelineConfig,
  type PluginDesignation,
  type ProjectAgentConfig,
} from "../types";
import { AssistantWeeklySection } from "./assistant-weekly-section";
import { IntakeGateSection } from "./intake-gate-section";
import { KnowledgePromotionSection } from "./knowledge-promotion-section";
import { McpServersSection } from "./mcp-servers-section";
import { PluginsSection } from "./plugins-section";
import { PoolBacklogSection } from "./pool-backlog-section";
import { RunnerPoolsSection, unknownPoolDevices } from "./runner-pools-section";
import { SaveRefusedBanner } from "./save-refused-banner";
import { StagePermissionsSection } from "./stage-permissions-section";

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

/** A heading over related sections, so ten of them read as three decisions rather than a list. */
function PipelineGroup({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="mt-10" aria-label={title}>
      <h3 className="fg-h3 text-fg">{title}</h3>
      <p className="fg-caption text-muted">{hint}</p>
      {children}
    </section>
  );
}

/** Why Save is held, or null: a pool naming a device no runner answers for, once the runners are read
 *  (unread runners name none unknown, ISS-1229 r48), else a field marked invalid. */
export function pipelineSaveHold(args: {
  states: PipelineDraft["states"];
  runners: readonly { deviceId?: string | null }[] | undefined;
  invalid: boolean;
}): string | null {
  if (unknownPoolDevices(args.states, args.runners ?? null).length > 0) {
    return "A runner pool names a device this project has no runner for. Clear that pool before saving.";
  }
  return args.invalid ? "Fix what is marked above before saving." : null;
}

function PipelinePage({
  projectId,
  canEdit,
  slug,
  config,
  plugins,
  readRevision,
}: {
  projectId: string;
  canEdit: boolean;
  slug?: string;
  /** The pipeline-config document as stored. */
  config: PipelineConfig;
  /** Changes each time that document is read, even when it read the same thing. */
  readRevision: number;
  /** The plugins the project designates, as stored. */
  plugins: PluginDesignation[];
}) {
  // A refused save is said once, by the banners in the save bar.
  const update = useUpdatePipelineConfig(projectId, { toastFailure: false });
  const updatePlugins = useUpdatePlugins(projectId, { toastFailure: false });
  const runnersQ = useProjectRunners(projectId);
  const [pluginsFailure, setPluginsFailure] = useState<{ configSaved: boolean; reason: string } | null>(
    null,
  );

  const deviceNames: Record<string, string> = {};
  for (const r of runnersQ.data ?? []) {
    if (r.deviceId && r.deviceName) deviceNames[r.deviceId] = r.deviceName;
  }

  const read = useMemo(() => readPipeline(config, plugins), [config, plugins]);
  const form: SettingsForm<PipelineDraft> = useSettingsForm<PipelineDraft>({
    read,
    schema: pipelineSchema,
    comparable: pipelineComparable,
    readRevision,
  });
  const draft = form.draft;

  const blockedBy = pipelineSaveHold({ states: draft.states, runners: runnersQ.data, invalid: form.invalid });

  async function save() {
    setPluginsFailure(null);
    update.reset();
    updatePlugins.reset();
    await form.save(async (held) => {
      const writes = pipelineWrites(form.seeded, held, config);
      if (writes.config) await update.mutateAsync(writes.config);
      if (writes.plugins) {
        try {
          await updatePlugins.mutateAsync(writes.plugins);
        } catch (err) {
          setPluginsFailure({ configSaved: writes.config !== null, reason: formatApiReason(err) });
          throw err;
        }
      }
    });
  }

  const masterEnabled = draft.enabled !== false;
  const libraryHref = slug ? `/projects/${slug}/library?tab=skills` : undefined;
  const saving = update.isPending || updatePlugins.isPending;

  return (
    <>
      <SettingsSection>
        <SectionTitle className="fg-h3 mb-1">Pipeline</SectionTitle>
        <p className="fg-body-sm mb-1 text-muted">
          An issue is picked up at <b>Open</b>, runs as one session, and ends either at{" "}
          <b>Needs info</b>, <b>{ISSUE_STATUS_LABELS.awaiting_release}</b> or closed. The session is driven by the{" "}
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
                onChange={(v) => form.setDraft((d) => ({ ...d, enabled: v }))}
                disabled={!canEdit}
                aria-label="Pipeline enabled"
              />
            }
          />
          <StageRow
            label="Start queued issues automatically"
            hint="Off holds every issue at Open until a human starts it. The pipeline stays on — nothing else changes."
            control={
              <Toggle
                checked={entryGateOpen(draft)}
                onChange={(open) => form.setDraft((d) => withEntryGate(d, open))}
                disabled={!canEdit || !masterEnabled}
                aria-label="Start queued issues automatically"
              />
            }
          />
        </div>

        <PipelineGroup
          title="What a session gets"
          hint="The skills, tools and permissions every session on this project starts with."
        >
          <PluginsSection form={form} canEdit={canEdit} />
          <McpServersSection form={form} canEdit={canEdit} />
          <StagePermissionsSection config={config} form={form} canEdit={canEdit} deviceNames={deviceNames} />
        </PipelineGroup>

        <PipelineGroup
          title="Where and when work is taken"
          hint="Which machines take which stage, and what is let into the queue."
        >
          <RunnerPoolsSection projectId={projectId} form={form} canEdit={canEdit} slug={slug} />
          <IntakeGateSection form={form} canEdit={canEdit} />
          <PoolBacklogSection form={form} canEdit={canEdit} />
        </PipelineGroup>

        <PipelineGroup
          title="Background work"
          hint="Jobs that run on a schedule rather than for one issue."
        >
          <KnowledgePromotionSection form={form} canEdit={canEdit} />
          <AssistantWeeklySection
            projectId={projectId}
            form={form}
            canEdit={canEdit}
            savedEnabled={config.assistantWeekly?.enabled === true}
          />
        </PipelineGroup>

        <div className="mt-6 border-t border-line pt-5">
          <Collapsible flat title={`Configured elsewhere — ${API_ONLY_KEYS.length} keys this screen doesn't edit`}>
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
      </SettingsSection>

      {canEdit && (
        <SettingsFormBar
          dirty={form.dirty}
          saving={saving}
          blockedBy={blockedBy}
          onSave={() => void save().catch(() => undefined)}
          onDiscard={() => {
            update.reset();
            updatePlugins.reset();
            setPluginsFailure(null);
            form.discard();
          }}
        >
          <SaveRefusedBanner
            projectId={projectId}
            error={update.isError ? update.error : null}
            onDismiss={() => update.reset()}
            draft={form}
          />
          {pluginsFailure && (
            <Banner tone="danger" onDismiss={() => setPluginsFailure(null)}>
              {pluginsFailure.configSaved
                ? "The pipeline settings were saved, but the plugins were not. "
                : "The plugins were not saved. "}
              {pluginsFailure.reason} Your plugin edits are still here — Save sends them again.
            </Banner>
          )}
        </SettingsFormBar>
      )}
    </>
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
  const projectQ = useProject(projectId);

  if (cfgQ.isLoading || projectQ.isLoading) {
    return (
      <SettingsSection>
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      </SettingsSection>
    );
  }

  if (cfgQ.isError) {
    if (isFeatureOff(cfgQ.error)) {
      return (
        <SettingsSection>
          <EmptyState
            title="Pipeline control is off"
            message="Per-project pipeline configuration isn't enabled on this deployment. Issues run on the built-in defaults."
            mascot={false}
          />
        </SettingsSection>
      );
    }
    return (
      <SettingsSection>
        <ErrorState title="Couldn't load the pipeline settings" message={formatApiError(cfgQ.error)} error={cfgQ.error} onRetry={() => cfgQ.refetch()} />
      </SettingsSection>
    );
  }

  if (projectQ.isError || !projectQ.data) {
    return (
      <SettingsSection>
        <ErrorState title="Couldn't load this project"
          message={projectQ.error ? formatApiError(projectQ.error) : "The project could not be read."}
          error={projectQ.error} onRetry={() => projectQ.refetch()}
        />
      </SettingsSection>
    );
  }

  const agentConfig = (projectQ.data.agentConfig ?? {}) as ProjectAgentConfig;
  return (
    <PipelinePage
      projectId={projectId}
      canEdit={canEdit}
      slug={slug}
      config={cfgQ.data?.pipelineConfig ?? {}}
      readRevision={cfgQ.dataUpdatedAt}
      plugins={agentConfig.plugins ?? []}
    />
  );
}
