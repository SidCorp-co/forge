'use client';

import { useEffect, useMemo, useRef } from 'react';
import { AlertBanner, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api/client';
import { STAGE_NAMES, type StageName } from '@/features/pipeline/config/types';
import { usePipelineConfig } from '@/features/pipeline/config/hooks/use-pipeline-config';
import {
  useProjectSkillRegistrations,
  useRegisterSkill,
  useSkills,
  useUnregisterSkillByStage,
} from '@/features/skill/hooks/use-skills';

interface Props {
  projectId: string;
  isOwner: boolean;
}

const STAGE_LABELS: Record<StageName, string> = {
  open: 'Open',
  confirmed: 'Confirmed',
  approved: 'Approved',
  developed: 'Developed',
  testing: 'Testing',
  tested: 'Tested',
  pass: 'Pass',
  staging: 'Staging',
  deploying: 'Deploying',
  reopen: 'Reopen',
  released: 'Released',
};

const STAGE_DEFAULT_SKILL_NAMES: Partial<Record<StageName, string>> = {
  open: 'forge-triage',
  confirmed: 'forge-plan',
  approved: 'forge-code',
  developed: 'forge-review',
  testing: 'forge-test',
  reopen: 'forge-fix',
  released: 'forge-release',
  // tested/pass/staging/deploying have no skill — soft-skip only.
};

// Map backend error `cause.code` to a human-friendly inline message + the
// affected stage list, when the backend returned one in `cause`.
interface MutationErrorShape {
  code?: string;
  blockingIssueIds?: string[];
  stagesBlocked?: string[];
  stagesMissingSkill?: string[];
  unreachable?: string[];
}

function readErrorCause(err: unknown): MutationErrorShape | null {
  if (err instanceof ApiError) {
    // Core throws HTTPException with `cause: { code, ... }`. The Hono error
    // middleware serializes `cause` as the body, and api/client.ts unpacks
    // top-level `code` into the error itself + the rest into `details`.
    const details = err.details as MutationErrorShape | undefined;
    if (details) return { ...details, code: err.code ?? details.code };
    return { code: err.code };
  }
  return null;
}

export function SkillRegistrationsSection({ projectId, isOwner }: Props) {
  const skills = useSkills(projectId);
  const registrations = useProjectSkillRegistrations(projectId);
  const cfg = usePipelineConfig(projectId);
  const registerSkill = useRegisterSkill(projectId);
  const unregisterSkill = useUnregisterSkillByStage(projectId);

  const bindingByStage = useMemo(() => {
    const map = new Map<string, { skillId: string; skillName: string }>();
    for (const r of registrations.data?.registrations ?? []) {
      map.set(r.stage, { skillId: r.skillId, skillName: r.skillName });
    }
    return map;
  }, [registrations.data]);

  const skillOptions = useMemo(() => {
    const all = skills.data?.data ?? [];
    return all.filter((s) => {
      if (!s.skillMd || s.skillMd.trim().length === 0) return false;
      if (s.scope === 'global') return true;
      return s.projectId === projectId;
    });
  }, [skills.data, projectId]);

  const saveError = readErrorCause(cfg.error);
  const bindError = readErrorCause(registerSkill.error ?? unregisterSkill.error);

  const bannerRef = useRef<HTMLDivElement | null>(null);
  // Scroll the banner into view when the save failure surfaces, so the user
  // sees it without scrolling back up from the Save button at the bottom.
  useEffect(() => {
    if (saveError?.code && bannerRef.current) {
      bannerRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [saveError?.code]);

  if (!isOwner) return null;

  if (skills.isLoading || registrations.isLoading || cfg.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          04. Skills &amp; State Config
        </h2>
        <span className="text-[9px] font-mono text-on-surface-variant">SKL_SYS_04</span>
      </div>

      <p className="text-xs text-on-surface-variant">
        Bind a skill to each pipeline stage and choose whether the orchestrator runs it
        automatically or waits for a human. Disabling a stage makes the orchestrator
        auto-transition past it (soft-skip). The Open stage is locked on.
      </p>

      {saveError && (saveError.code === 'OPEN_LOCKED_ON' || saveError.code === 'STAGE_HAS_ISSUES' || saveError.code === 'AUTO_STAGE_NEEDS_SKILL' || saveError.code === 'DEAD_END_CONFIG') && (
        <div ref={bannerRef}>
          <AlertBanner variant="error">
            {saveError.code === 'OPEN_LOCKED_ON' && 'Open stage cannot be disabled.'}
            {saveError.code === 'STAGE_HAS_ISSUES' && (
              saveError.blockingIssueIds && saveError.blockingIssueIds.length > 0 ? (
                <>
                  Cannot disable {saveError.stagesBlocked?.join(', ') ?? 'these stages'} —{' '}
                  {saveError.blockingIssueIds.length} issue
                  {saveError.blockingIssueIds.length === 1 ? '' : 's'} currently at them. Move or
                  close them first.
                </>
              ) : (
                <>
                  Server rejected save: stages have live issues. Open the Issues tab to find and
                  resolve them.
                </>
              )
            )}
            {saveError.code === 'AUTO_STAGE_NEEDS_SKILL' && (
              <>
                Auto-mode stages need a registered skill:{' '}
                {saveError.stagesMissingSkill?.join(', ')}.
              </>
            )}
            {saveError.code === 'DEAD_END_CONFIG' && (
              <>
                Cannot disable {saveError.unreachable?.join(', ')} — no forward path remains.
              </>
            )}
          </AlertBanner>
        </div>
      )}

      {bindError && (
        <AlertBanner variant="error">
          Failed to update skill binding. {bindError.code ?? ''}
        </AlertBanner>
      )}

      <div className="rounded-sm border border-outline-variant/20 divide-y divide-outline-variant/10">
        {STAGE_NAMES.map((stage) => {
          const binding = bindingByStage.get(stage);
          const stageCfg = cfg.state.states[stage];
          const isOpen = stage === 'open';
          const defaultSkillName = STAGE_DEFAULT_SKILL_NAMES[stage];
          const defaultSkill = skillOptions.find((s) => s.name === defaultSkillName);

          return (
            <div
              key={stage}
              className="grid grid-cols-[150px_90px_140px_1fr_90px] items-center gap-3 px-4 py-3"
            >
              <div className="flex flex-col">
                <span className="text-xs font-medium text-on-surface">{STAGE_LABELS[stage]}</span>
                <span className="text-[9px] font-mono text-outline">STG_{stage.toUpperCase()}</span>
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-on-surface-variant">
                <input
                  type="checkbox"
                  checked={stageCfg.enabled !== false}
                  disabled={isOpen || cfg.isSaving}
                  onChange={(e) => cfg.setStage(stage, { enabled: e.target.checked })}
                />
                Enabled
              </label>

              <div className="flex gap-3 text-xs text-on-surface-variant">
                {(['auto', 'manual'] as const).map((mode) => (
                  <label key={mode} className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      name={`mode-${stage}`}
                      value={mode}
                      checked={(stageCfg.mode ?? 'auto') === mode}
                      disabled={stageCfg.enabled === false || cfg.isSaving}
                      onChange={() => cfg.setStage(stage, { mode })}
                    />
                    {mode}
                  </label>
                ))}
              </div>

              <select
                value={binding?.skillId ?? ''}
                disabled={
                  stageCfg.enabled === false ||
                  registerSkill.isPending ||
                  unregisterSkill.isPending
                }
                onChange={(e) => {
                  const skillId = e.target.value;
                  if (skillId === '') {
                    void unregisterSkill.mutateAsync(stage);
                  } else {
                    void registerSkill.mutateAsync({ skillId, stage });
                  }
                }}
                className="rounded-sm border border-outline-variant/20 bg-surface-container px-2 py-1 text-xs text-on-surface disabled:opacity-50"
              >
                <option value="">— Unbound —</option>
                {skillOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.scope === 'project' ? '(project)' : ''}
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={
                  cfg.isSaving || registerSkill.isPending || unregisterSkill.isPending
                }
                onClick={() => {
                  cfg.setStage(stage, { enabled: true, mode: 'auto' });
                  if (defaultSkill && binding?.skillId !== defaultSkill.id) {
                    void registerSkill.mutateAsync({ skillId: defaultSkill.id, stage });
                  }
                }}
                className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-on-surface disabled:opacity-50"
              >
                Reset
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={() => void cfg.save()}
          disabled={cfg.isSaving || !cfg.isDirty}
          className="bg-gradient-to-br from-primary to-tertiary text-on-primary px-6 py-2 text-[10px] font-black uppercase tracking-[0.15em] rounded-sm hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {cfg.isSaving ? 'Saving…' : 'Save state config'}
        </button>
        {cfg.isDirty && (
          <button
            type="button"
            onClick={cfg.reset}
            disabled={cfg.isSaving}
            className="text-[10px] font-medium uppercase tracking-[0.15em] text-on-surface-variant hover:text-on-surface"
          >
            Discard
          </button>
        )}
      </div>
    </section>
  );
}
