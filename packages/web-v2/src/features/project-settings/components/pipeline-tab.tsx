"use client";

// Project settings → Pipeline. Master `enabled` flag + the 8 auto-stage
// toggles, each wired in-line to the skill that runs at that stage. Reads/writes
// the FULL pipelineConfig (the PATCH schema requires `states`), so we round-trip
// the fetched object and only override the keys we surface — per-step
// runner/model overrides survive a save. When the `pipelineControl` flag is off,
// core 404s and we render an info empty-state.
//
// Skill binding is integrated here (not a separate Library trip): each row has a
// skill picker that registers/unregisters the stage immediately via the skills
// API. That keeps "this stage should auto-run" and "with this skill" on one line
// and makes the save-blocking "needs a registered skill" rejection impossible to
// hit by surprise — the row shows the gap, and Save is gated until it's resolved.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Icon,
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
import { usableSkillOptions } from "@/features/skills/types";
import { isFeatureOff, usePipelineConfig, useUpdatePipelineConfig } from "../hooks";
import {
  STEP_TOGGLE_KEYS,
  STEP_TOGGLE_LABELS,
  toggleEnabled,
  type PipelineConfig,
  type StepToggleKey,
} from "../types";

function StageRow({
  label,
  hint,
  checked,
  toggleDisabled,
  onToggle,
  skill,
  skillOptions,
  skillValue,
  skillDisabled,
  onSkillChange,
  showWarning,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  toggleDisabled: boolean;
  onToggle: (v: boolean) => void;
  /** When the skill picker is hidden (master "Pipeline enabled" row). */
  skill: boolean;
  skillOptions: SelectOption[];
  skillValue: string;
  skillDisabled: boolean;
  onSkillChange: (v: string) => void;
  showWarning: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="fg-label text-fg">{label}</p>
        {hint && <p className="fg-caption text-muted">{hint}</p>}
        {showWarning && (
          <p
            className="fg-caption mt-0.5 flex items-center gap-1"
            style={{ color: "var(--amberw-600)" }}
          >
            <Icon name="alert" size={12} />
            No skill registered — this stage won&apos;t run automatically.
          </p>
        )}
      </div>
      <div className="flex flex-none items-center gap-3">
        {skill && (
          <div className="w-40 sm:w-52">
            <Select
              options={skillOptions}
              value={skillValue}
              onChange={onSkillChange}
              disabled={skillDisabled}
              placeholder="No skill"
              invalid={showWarning}
            />
          </div>
        )}
        <Toggle checked={checked} onChange={onToggle} disabled={toggleDisabled} aria-label={label} />
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

  // Skill registry + per-stage bindings — drives each row's picker.
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

  // One option per skill name: a project skill registers directly; a global
  // template (not yet adopted) is offered as `adopt:<id>` and cloned on select.
  const skillOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "— No skill —" },
      ...usableSkillOptions(skillsQ.data ?? []).map((o) =>
        o.kind === "project"
          ? { value: o.skillId, label: o.name }
          : { value: `adopt:${o.globalSkillId}`, label: `${o.name} · template` },
      ),
    ],
    [skillsQ.data],
  );
  const noSkillsAtAll = (skillsQ.data?.length ?? 0) === 0;

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

  const dirty =
    (server.enabled !== false) !== masterEnabled ||
    STEP_TOGGLE_KEYS.some((k) => toggleEnabled(server[k]) !== toggleEnabled(draft[k]));

  // Stages whose toggle is ON (and pipeline live) but have no skill bound — these
  // would be rejected by core on save, so we surface + block here instead.
  const missingSkillSteps = STEP_TOGGLE_KEYS.filter(
    (k) =>
      masterEnabled &&
      toggleEnabled(draft[k]) &&
      !skillByStage.has(STEP_TOGGLE_LABELS[k].stage),
  );

  const libraryHref = slug ? `/projects/${slug}/library?tab=skills` : undefined;

  function setToggle(key: StepToggleKey, value: boolean) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
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
          Control auto-dispatch per stage. Turning a stage off means an issue parks there until a
          human advances it. Pick the skill that runs at each stage — a stage with no skill
          can&apos;t auto-run.
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
              No skills are available to this project yet. Skills are authored on a paired device
              (or via MCP) and appear in{" "}
              {libraryHref ? (
                <Link href={libraryHref} className="underline">
                  Library
                </Link>
              ) : (
                "Library"
              )}{" "}
              — sync one before a stage can auto-run.
            </Banner>
          </div>
        )}

        <div className="divide-y divide-line">
          <StageRow
            label="Pipeline enabled"
            hint="Master switch — when off, no stage auto-dispatches."
            checked={masterEnabled}
            toggleDisabled={!canEdit}
            onToggle={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))}
            skill={false}
            skillOptions={skillOptions}
            skillValue=""
            skillDisabled
            onSkillChange={() => {}}
            showWarning={false}
          />
          {STEP_TOGGLE_KEYS.map((k) => {
            const stage = STEP_TOGGLE_LABELS[k].stage;
            const on = toggleEnabled(draft[k]);
            return (
              <StageRow
                key={k}
                label={STEP_TOGGLE_LABELS[k].label}
                hint={STEP_TOGGLE_LABELS[k].hint}
                checked={on}
                toggleDisabled={!canEdit || !masterEnabled}
                onToggle={(v) => setToggle(k, v)}
                skill
                skillOptions={skillOptions}
                skillValue={skillByStage.get(stage) ?? ""}
                skillDisabled={skillDisabled}
                onSkillChange={(v) => void changeSkill(stage, v)}
                showWarning={masterEnabled && on && !skillByStage.has(stage)}
              />
            );
          })}
        </div>

        {canEdit && (
          <div className="mt-4 space-y-3">
            {missingSkillSteps.length > 0 && (
              <Banner tone="attention">
                {missingSkillSteps.map((k) => STEP_TOGGLE_LABELS[k].label).join(", ")}{" "}
                {missingSkillSteps.length === 1 ? "needs" : "need"} a skill before{" "}
                {missingSkillSteps.length === 1 ? "it" : "they"} can run. Pick one in the row above,
                or turn the toggle off.
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
      </CardContent>
    </Card>
  );
}
