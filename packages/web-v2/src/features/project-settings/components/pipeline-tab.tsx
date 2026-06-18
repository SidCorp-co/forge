"use client";

// Project settings → Pipeline. Master `enabled` flag + a per-stage mode selector
// (Auto / Manual / Skip) wired in-line to the skill that runs at that stage.
// Reads/writes the FULL pipelineConfig (the PATCH schema requires `states`), so
// we round-trip the fetched object and only override the keys we surface — per
// step runner/model overrides + per-state sessionGroup survive a save. When the
// `pipelineControl` flag is off, core 404s and we render an info empty-state.
//
// One selector replaces the old on/off toggle: the three backend knobs a stage
// depends on (autoX toggle, states[x].enabled, states[x].mode) collapse into one
// choice (see types.ts deriveJobStageMode / applyJobStageMode). Checkpoint states
// with no skill (deploying/tested/pass/staging) render as gate rows — Manual
// (park, wait for a human) or Skip (bypass) only, no Auto.
//
// Skill binding is integrated here (not a separate Library trip): each job row
// has a skill picker that registers/unregisters the stage immediately via the
// skills API. A stage set to Auto with no skill blocks Save (core would reject
// it), and the row shows the gap.
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Icon,
  SegmentedControl,
  type SegmentOption,
  Select,
  type SelectOption,
  Skeleton,
  Toggle,
} from "@/design";
import { formatApiError, formatPipelineConfigError } from "@/lib/api/error";
import {
  useAdoptSkill,
  useRegisterSkill,
  useSkillRegistrations,
  useSkills,
  useUnregisterSkill,
} from "@/features/skills/hooks";
import { usableSkillOptions, type UsableSkillOption } from "@/features/skills/types";
import { isFeatureOff, usePipelineConfig, useUpdatePipelineConfig } from "../hooks";
import { McpServersSection } from "./mcp-servers-section";
import { SessionGroupsSection } from "./session-groups-section";
import { MergeStatesSection } from "./merge-states-section";
import {
  applyCheckpointMode,
  applyJobStageMode,
  CHECKPOINT_STAGES,
  deriveCheckpointMode,
  deriveJobStageMode,
  isCheckpointGated,
  PIPELINE_LADDER,
  PRIMARY_CHECKPOINT,
  STEP_TOGGLE_LABELS,
  type PipelineConfig,
  type StageMode,
  type StepToggleKey,
} from "../types";

const JOB_MODE_OPTIONS: SegmentOption<StageMode>[] = [
  { value: "auto", label: "Auto" },
  { value: "manual", label: "Manual" },
  { value: "skip", label: "Skip" },
];

// Checkpoints have no skill, so "Auto" is shown for a uniform control but
// disabled (nothing to auto-run) — only Manual (hold) / Skip are selectable.
const CHECKPOINT_MODE_OPTIONS: SegmentOption<StageMode>[] = [
  { value: "auto", label: "Auto", disabled: true, title: "No skill at this stage — nothing to auto-run" },
  { value: "manual", label: "Manual" },
  { value: "skip", label: "Skip" },
];

/** SegmentedControl has no `disabled` prop — wrap to dim + block interaction. */
function ModeControl({
  options,
  value,
  onChange,
  disabled,
}: {
  options: SegmentOption<StageMode>[];
  value: StageMode;
  onChange: (v: StageMode) => void;
  disabled: boolean;
}) {
  if (disabled) {
    return (
      <div className="pointer-events-none opacity-50">
        <SegmentedControl options={options} value={value} onChange={() => {}} />
      </div>
    );
  }
  return <SegmentedControl options={options} value={value} onChange={onChange} />;
}

function StageRow({
  label,
  hint,
  warning,
  skillPicker,
  control,
}: {
  label: string;
  hint?: string;
  warning?: ReactNode;
  skillPicker?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="fg-label text-fg">{label}</p>
        {hint && <p className="fg-caption text-muted">{hint}</p>}
        {warning}
      </div>
      <div className="flex flex-none items-center gap-3">
        {skillPicker}
        {control}
      </div>
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

  // Skill registry + per-stage bindings — drives each job row's picker.
  const skillsQ = useSkills(projectId);
  const regsQ = useSkillRegistrations(projectId);
  const register = useRegisterSkill(projectId);
  const unregister = useUnregisterSkill(projectId);
  const adopt = useAdoptSkill(projectId);
  const skillPending = register.isPending || unregister.isPending || adopt.isPending;

  // Local working copy of the full config — preserves opaque keys on save.
  const [draft, setDraft] = useState<PipelineConfig | null>(null);
  useEffect(() => {
    if (cfgQ.data) setDraft(cfgQ.data.pipelineConfig);
  }, [cfgQ.data]);

  // stage (issueStatus) → currently-registered skill id.
  const skillByStage = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of regsQ.data?.registrations ?? []) m.set(r.stage, r.skillId);
    return m;
  }, [regsQ.data]);

  // One pickable entry per skill name: a project skill binds directly; a global
  // template (not yet adopted) is offered as `adopt:<id>` and cloned on select.
  const usable = useMemo(() => usableSkillOptions(skillsQ.data ?? []), [skillsQ.data]);
  const noSkillsAtAll = (skillsQ.data?.length ?? 0) === 0;

  const optionValue = (o: UsableSkillOption) =>
    o.kind === "project" ? o.skillId : `adopt:${o.globalSkillId}`;

  // Per-stage picker: the stage's conventional skill (e.g. forge-triage) is
  // sorted first and tagged "(recommended)"; any other skill stays selectable.
  function stagePicker(recommendedName: string): {
    options: SelectOption[];
    recommendedValue: string | null;
  } {
    const ordered = [...usable].sort((a, b) => {
      if (a.name === recommendedName) return -1;
      if (b.name === recommendedName) return 1;
      return a.name.localeCompare(b.name);
    });
    const options: SelectOption[] = [
      { value: "", label: "— No skill —" },
      ...ordered.map((o) => {
        const base = o.kind === "project" ? o.name : `${o.name} · template`;
        return {
          value: optionValue(o),
          label: o.name === recommendedName ? `${base} (recommended)` : base,
        };
      }),
    ];
    const rec = usable.find((o) => o.name === recommendedName);
    return { options, recommendedValue: rec ? optionValue(rec) : null };
  }

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
              message="Per-project pipeline configuration isn't enabled on this deployment. Stages run on their built-in defaults."
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

  // Keep the ladder tidy: always show the canonical `staging` gate, but surface
  // the legacy checkpoints (deploying/tested/pass) ONLY when a project actively
  // gates on them (mode:"manual" — e.g. dodgeprint's `tested`). Skipped or
  // default checkpoints stay hidden. Decided from the saved config so rows don't
  // flicker mid-edit.
  const checkpointVisible = (status: string) =>
    status === PRIMARY_CHECKPOINT || isCheckpointGated(server, status);

  const dirty =
    (server.enabled !== false) !== masterEnabled ||
    PIPELINE_LADDER.some((row) =>
      row.kind === "job"
        ? deriveJobStageMode(server, row.toggle, STEP_TOGGLE_LABELS[row.toggle].stage) !==
          deriveJobStageMode(draft, row.toggle, STEP_TOGGLE_LABELS[row.toggle].stage)
        : deriveCheckpointMode(server, row.status) !== deriveCheckpointMode(draft, row.status),
    );

  // Job stages set to Auto but with no skill bound — core rejects these on save,
  // so we surface + block here instead.
  const missingSkillSteps = (
    PIPELINE_LADDER.filter((r) => r.kind === "job") as { kind: "job"; toggle: StepToggleKey }[]
  )
    .map((r) => r.toggle)
    .filter(
      (k) =>
        masterEnabled &&
        deriveJobStageMode(draft, k, STEP_TOGGLE_LABELS[k].stage) === "auto" &&
        !skillByStage.has(STEP_TOGGLE_LABELS[k].stage),
    );

  const libraryHref = slug ? `/projects/${slug}/library?tab=skills` : undefined;

  function setJobMode(key: StepToggleKey, status: string, mode: StageMode) {
    setDraft((d) => (d ? applyJobStageMode(d, key, status, mode) : d));
  }
  function setCheckpointMode(status: string, mode: StageMode) {
    if (mode === "auto") return; // checkpoints have no skill — never Auto
    setDraft((d) => (d ? applyCheckpointMode(d, status, mode) : d));
  }

  async function changeSkill(stage: string, value: string) {
    if (!value) {
      if (skillByStage.has(stage)) unregister.mutate(stage);
      return;
    }
    if (value.startsWith("adopt:")) {
      // Adopt-on-select: clone the global template into a project skill, then
      // bind that copy — the global itself is never registrable.
      const created = await adopt.mutateAsync(value.slice("adopt:".length));
      await register.mutateAsync({ skillId: created.id, stage });
      return;
    }
    register.mutate({ skillId: value, stage });
  }

  const skillDisabled = !canEdit || skillsQ.isLoading || regsQ.isLoading || skillPending;

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Pipeline</h2>
        <p className="fg-body-sm mb-1 text-muted">
          Pick how each stage runs. <b>Auto</b> = the pipeline runs it automatically. <b>Manual</b>{" "}
          = the issue stops here and waits for a human to advance it (an approval gate). <b>Skip</b>{" "}
          = the stage is bypassed and the pipeline jumps to the next one. <b>Tested</b> is the
          pre-production gate (Manual = stop for approval before release, or Skip — no skill); other
          checkpoints appear only if this project uses them.
        </p>
        {libraryHref && (
          <p className="fg-caption mb-4">
            <Link href={libraryHref} className="text-accent-text hover:underline">
              Manage or create skills in Library →
            </Link>
          </p>
        )}

        {noSkillsAtAll && canEdit && (
          <div className="mb-4">
            <Banner tone="info">
              No skills are available to this project yet. Skills are authored on a paired device (or
              via MCP) and appear in{" "}
              {libraryHref ? (
                <Link href={libraryHref} className="underline">
                  Library
                </Link>
              ) : (
                "Library"
              )}{" "}
              — sync one before a stage can run on Auto.
            </Banner>
          </div>
        )}

        <div className="divide-y divide-line">
          <StageRow
            label="Pipeline enabled"
            hint="Master switch — when off, no stage auto-dispatches."
            control={
              <Toggle
                checked={masterEnabled}
                onChange={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))}
                disabled={!canEdit}
                aria-label="Pipeline enabled"
              />
            }
          />
          {PIPELINE_LADDER.map((row) => {
            if (row.kind === "checkpoint") {
              if (!checkpointVisible(row.status)) return null;
              const meta = CHECKPOINT_STAGES.find((c) => c.status === row.status);
              if (!meta) return null;
              const mode = deriveCheckpointMode(draft, row.status);
              return (
                <StageRow
                  key={`cp-${row.status}`}
                  label={meta.label}
                  hint={meta.hint}
                  control={
                    <ModeControl
                      options={CHECKPOINT_MODE_OPTIONS}
                      value={mode}
                      onChange={(v) => setCheckpointMode(row.status, v)}
                      disabled={!canEdit || !masterEnabled}
                    />
                  }
                />
              );
            }
            const meta = STEP_TOGGLE_LABELS[row.toggle];
            const mode = deriveJobStageMode(draft, row.toggle, meta.stage);
            const { options, recommendedValue } = stagePicker(meta.skillName);
            const needsSkill = masterEnabled && mode === "auto" && !skillByStage.has(meta.stage);
            return (
              <StageRow
                key={row.toggle}
                label={meta.label}
                hint={meta.hint}
                warning={
                  needsSkill ? (
                    <div className="mt-0.5">
                      <p
                        className="fg-caption flex items-center gap-1"
                        style={{ color: "var(--amberw-600)" }}
                      >
                        <Icon name="alert" size={12} />
                        No skill registered — Auto won&apos;t run. Pick one or set Manual/Skip.
                      </p>
                      {recommendedValue && (
                        <button
                          type="button"
                          disabled={skillDisabled}
                          onClick={() => void changeSkill(meta.stage, recommendedValue)}
                          className="fg-caption mt-0.5 text-accent-text hover:underline disabled:opacity-50"
                        >
                          Use {meta.skillName}
                        </button>
                      )}
                    </div>
                  ) : undefined
                }
                skillPicker={
                  <div className="w-40 sm:w-52">
                    <Select
                      options={options}
                      value={skillByStage.get(meta.stage) ?? ""}
                      onChange={(v) => void changeSkill(meta.stage, v)}
                      disabled={skillDisabled}
                      placeholder="No skill"
                      invalid={needsSkill}
                    />
                  </div>
                }
                control={
                  <ModeControl
                    options={JOB_MODE_OPTIONS}
                    value={mode}
                    onChange={(v) => setJobMode(row.toggle, meta.stage, v)}
                    disabled={!canEdit || !masterEnabled}
                  />
                }
              />
            );
          })}
        </div>

        {canEdit && (
          <div className="mt-4 space-y-3">
            {missingSkillSteps.length > 0 && (
              <Banner tone="attention">
                {missingSkillSteps.map((k) => STEP_TOGGLE_LABELS[k].label).join(", ")}{" "}
                {missingSkillSteps.length === 1 ? "is" : "are"} set to Auto but{" "}
                {missingSkillSteps.length === 1 ? "needs" : "need"} a skill. Pick one in the row
                above, or switch to Manual/Skip.
              </Banner>
            )}
            {update.isError && (
              <Banner tone="danger" onDismiss={() => update.reset()}>
                {formatPipelineConfigError(update.error)}
              </Banner>
            )}
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty || missingSkillSteps.length > 0}
              onClick={() => update.mutate(draft)}
              className="min-h-11"
            >
              Save pipeline config
            </Button>
          </div>
        )}

        {/* Project-default MCP servers — round-trips the full fetched config. */}
        <McpServersSection projectId={projectId} config={server} canEdit={canEdit} />

        {/* Session groups — round-trips the full fetched config. */}
        <SessionGroupsSection projectId={projectId} config={server} canEdit={canEdit} />

        {/* Merge points (mergeStates) — round-trips the full fetched config. */}
        <MergeStatesSection projectId={projectId} config={server} canEdit={canEdit} />
      </CardContent>
    </Card>
  );
}
