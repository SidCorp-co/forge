'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { AlertBanner, Spinner } from '@/components/ui';
import { useFocusOnMount } from '../hooks/use-focus-on-mount';
import { ApiError } from '@/lib/api/client';
import { STAGE_NAMES, type StageName } from '@/features/pipeline/config/types';
import { usePipelineConfig } from '@/features/pipeline/config/hooks/use-pipeline-config';
import { usePipelineRegistry } from '@/features/pipeline/use-pipeline-registry';
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
  needs_info: 'Needs Info',
  confirmed: 'Confirmed',
  clarified: 'Clarified',
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

// Default skill names per stage are derived from the pipeline registry
// (single SSOT — see `core/pipeline/registry.ts`). Soft-skip stages
// (tested/pass/staging/deploying) are NOT in PIPELINE_STEPS, so they
// remain `undefined` in this map and the UI renders them as "no skill".
function useStageDefaultSkillNames(): Partial<Record<StageName, string>> {
  const { data: registry } = usePipelineRegistry();
  return useMemo(() => {
    if (!registry) return {};
    const out: Partial<Record<StageName, string>> = {};
    for (const step of registry.steps) {
      out[step.status as StageName] = step.skillName;
    }
    return out;
  }, [registry]);
}

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

interface UndoState {
  id: number;
  message: string;
  undo: () => void;
}

export function SkillRegistrationsSection({ projectId, isOwner }: Props) {
  const { slug } = useParams<{ slug: string }>();
  const skills = useSkills(projectId);
  const registrations = useProjectSkillRegistrations(projectId);
  const cfg = usePipelineConfig(projectId);
  const registerSkill = useRegisterSkill(projectId);
  const unregisterSkill = useUnregisterSkillByStage(projectId);
  const stageDefaultSkillNames = useStageDefaultSkillNames();
  useFocusOnMount();

  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showUndo = useCallback((message: string, fn: () => void) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    const id = Date.now();
    setUndo({ id, message, undo: fn });
    undoTimer.current = setTimeout(() => {
      setUndo((current) => (current?.id === id ? null : current));
    }, 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  const onBind = useCallback(
    async (stage: string, nextSkillId: string, previousSkillId: string | undefined) => {
      if (nextSkillId === '') {
        await unregisterSkill.mutateAsync(stage);
        if (previousSkillId) {
          showUndo('Skill unregistered. Undo', () => {
            void registerSkill.mutateAsync({ skillId: previousSkillId, stage });
            setUndo(null);
          });
        }
      } else {
        await registerSkill.mutateAsync({ skillId: nextSkillId, stage });
        showUndo('Skill registered. Undo', () => {
          if (previousSkillId) {
            void registerSkill.mutateAsync({ skillId: previousSkillId, stage });
          } else {
            void unregisterSkill.mutateAsync(stage);
          }
          setUndo(null);
        });
      }
    },
    [registerSkill, unregisterSkill, showUndo],
  );

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
  const bannerRef = useRef<HTMLDivElement>(null);

  // ISS-118 — scroll the banner into view whenever a new save/bind error
  // surfaces. Settings page is long; without this the user clicks Save and
  // sees nothing happen because the error is rendered off-screen.
  useEffect(() => {
    if (saveError || bindError) {
      bannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [saveError, bindError]);

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
        <div className="flex items-center gap-3">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
            Skills &amp; State Config
          </h2>
          {!isOwner && (
            <span className="rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-outline">
              Owner only
            </span>
          )}
        </div>
        <span className="text-[9px] font-mono text-on-surface-variant">PLC_SKL</span>
      </div>

      {undo && (
        <div className="flex items-center justify-between rounded-sm border border-outline-variant/30 bg-surface-container px-3 py-2 text-xs text-on-surface">
          <span>{undo.message.replace(' Undo', '.')}</span>
          <button
            type="button"
            onClick={undo.undo}
            className="text-[10px] font-bold uppercase tracking-widest text-primary hover:opacity-80"
          >
            Undo
          </button>
        </div>
      )}

      <p className="text-xs text-on-surface-variant">
        Bind a skill to each pipeline stage and choose whether the orchestrator runs it
        automatically or waits for a human. Disabling a stage makes the orchestrator
        auto-transition past it (soft-skip). The Open stage is locked on.
      </p>

      <div ref={bannerRef}>
        {saveError && (saveError.code === 'OPEN_LOCKED_ON' || saveError.code === 'STAGE_HAS_ISSUES' || saveError.code === 'AUTO_STAGE_NEEDS_SKILL' || saveError.code === 'DEAD_END_CONFIG') && (
          <AlertBanner variant="error">
            {saveError.code === 'OPEN_LOCKED_ON' && 'Open stage cannot be disabled.'}
            {saveError.code === 'STAGE_HAS_ISSUES' && (
              (saveError.blockingIssueIds && saveError.blockingIssueIds.length > 0) ? (
                <>
                  Cannot disable {saveError.stagesBlocked?.join(', ') ?? 'these stages'} — there are{' '}
                  {saveError.blockingIssueIds.length} issues currently at them. Move or close them
                  first.
                </>
              ) : (
                <>
                  Server rejected save: stages have live issues. Check the Issues tab to find and
                  resolve them.
                </>
              )
            )}
            {saveError.code === 'AUTO_STAGE_NEEDS_SKILL' && (
              <>
                Auto-mode stages need a registered skill: {saveError.stagesMissingSkill?.join(', ')}.
              </>
            )}
            {saveError.code === 'DEAD_END_CONFIG' && (
              <>
                Cannot disable {saveError.unreachable?.join(', ')} — no forward path remains.
              </>
            )}
          </AlertBanner>
        )}

        {bindError && (
          <AlertBanner variant="error">
            Failed to update skill binding. {bindError.code ?? ''}
          </AlertBanner>
        )}
      </div>

      <div className="rounded-sm border border-outline-variant/20 divide-y divide-outline-variant/10">
        {STAGE_NAMES.map((stage) => {
          const binding = bindingByStage.get(stage);
          const stageCfg = cfg.state.states[stage];
          const isOpen = stage === 'open';
          const defaultSkillName = stageDefaultSkillNames[stage];
          const defaultSkill = skillOptions.find((s) => s.name === defaultSkillName);
          // Soft-skip stages (tested/pass/staging/deploying) have no skill in
          // PIPELINE_STEPS — the orchestrator only soft-transitions through
          // them. Auto mode here would trip AUTO_STAGE_NEEDS_SKILL at save.
          const isSoftSkip = defaultSkillName === undefined;

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
                  disabled={!isOwner || isOpen || cfg.isSaving}
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
                      disabled={!isOwner || stageCfg.enabled === false || cfg.isSaving}
                      onChange={() => cfg.setStage(stage, { mode })}
                    />
                    {mode}
                  </label>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <select
                  value={binding?.skillId ?? ''}
                  disabled={
                    !isOwner ||
                    isSoftSkip ||
                    stageCfg.enabled === false ||
                    registerSkill.isPending ||
                    unregisterSkill.isPending
                  }
                  onChange={(e) => {
                    void onBind(stage, e.target.value, binding?.skillId);
                  }}
                  data-config-health-target={`skills.${stage}`}
                  className="min-w-0 flex-1 rounded-sm border border-outline-variant/20 bg-surface-container px-2 py-1 text-xs text-on-surface disabled:opacity-50"
                >
                  <option value="">
                    {isSoftSkip ? 'Soft-skip only — no skill' : '— Unbound —'}
                  </option>
                  {!isSoftSkip &&
                    skillOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.scope === 'project' ? '(project)' : ''}
                      </option>
                    ))}
                </select>
                {/* Deep-link into Skill Studio (ISS-277): authoring lives there;
                    this matrix only binds skills to stages. One surface, no dupe. */}
                {binding && (
                  <Link
                    href={`/projects/${slug}/skills?skill=${encodeURIComponent(binding.skillId)}`}
                    title={`Open "${binding.skillName}" in Skill Studio`}
                    className="shrink-0 text-outline hover:text-on-surface"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                )}
              </div>

              <button
                type="button"
                disabled={
                  !isOwner || cfg.isSaving || registerSkill.isPending || unregisterSkill.isPending
                }
                onClick={() => {
                  cfg.setStage(stage, {
                    enabled: true,
                    mode: isSoftSkip ? 'manual' : 'auto',
                  });
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
          disabled={!isOwner || cfg.isSaving || !cfg.isDirty}
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
