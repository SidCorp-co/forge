import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, projects, skillRegistrations } from '../db/schema.js';
import { resolveMergeStates } from '../issues/merged-at.js';
import { logger } from '../logger.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  type PipelineConfigPatchInput,
  STAGE_NAMES,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';
import { PIPELINE_STEPS } from './registry.js';
import type { StagesConfig } from './state-machine.js';
import { validateStatesConfig } from './state-machine.js';
import { STAGE_FORWARD } from './state-machine.js';

/**
 * Typed errors thrown by {@link updatePipelineConfig}. REST and MCP callers
 * each map these to their own response shape; the service stays transport-
 * agnostic.
 */
export type PipelineConfigErrorCode =
  | 'OPEN_LOCKED_ON'
  | 'STAGE_HAS_ISSUES'
  | 'AUTO_STAGE_NEEDS_SKILL'
  | 'MISSING_SKILL_FOR_ENABLED_STAGE'
  | 'DEAD_END_CONFIG'
  | 'MERGE_STATE_DISABLED'
  | 'PROJECT_NOT_FOUND';

export class PipelineConfigError extends Error {
  readonly code: PipelineConfigErrorCode;
  readonly details: Record<string, unknown>;
  constructor(
    code: PipelineConfigErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PipelineConfigError';
    this.code = code;
    this.details = details;
  }
}

export interface UpdatePipelineConfigInput {
  projectId: string;
  patch: PipelineConfigPatchInput;
}

export interface UpdatePipelineConfigResult {
  pipelineConfig: PipelineConfig;
  /**
   * Non-blocking advisories surfaced after a successful update. ISS-239 —
   * populated when a stage is enabled in `states` but has no skill
   * registration AND is not gated by `MISSING_SKILL_FOR_ENABLED_STAGE`
   * (i.e. stages outside the PIPELINE_STEPS auto-toggle set, like
   * `deploying`, `pass`, `staging`, `tested`). Issues at those stages will
   * auto-skip past them via STAGE_FORWARD at runtime; the warning lets the
   * operator know without rejecting the patch.
   */
  warnings: string[];
}

/**
 * Validate + atomically merge a pipeline-config patch onto the project's
 * `agentConfig` jsonb document. Authorization is the caller's responsibility
 * — both REST (`PATCH /projects/:id/pipeline-config`) and MCP
 * (`forge_config` action=`update`) gate on owner before invoking this.
 *
 * ISS-232 Phase 3 — the sibling `runnerFallback` field was removed; the
 * v2 selector picks primary → standby deterministically with no type-
 * chain fallback. `agentConfig.runnerFallback` rows that survived from
 * v1 are left alone (no destructive migration), but they no longer feed
 * the dispatcher.
 */
export async function updatePipelineConfig(
  input: UpdatePipelineConfigInput,
): Promise<UpdatePipelineConfigResult> {
  const { projectId } = input;
  const pipelinePatch = input.patch;

  const mergeDoc: Record<string, unknown> = {};
  if (Object.keys(pipelinePatch).length > 0) {
    mergeDoc.pipelineConfig = pipelinePatch;
  }

  if (Object.keys(mergeDoc).length > 0) {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) throw new PipelineConfigError('PROJECT_NOT_FOUND', 'project not found');
    const currentAc = (row.agentConfig ?? {}) as Record<string, unknown>;
    const currentPipeline = (currentAc.pipelineConfig ?? {}) as Record<string, unknown>;
    const nextDoc: Record<string, unknown> = {};
    if (mergeDoc.pipelineConfig) {
      const nextPipeline = {
        ...currentPipeline,
        ...(mergeDoc.pipelineConfig as object),
      };
      const patchStates = (pipelinePatch as { states?: StagesConfig }).states;
      if (patchStates) {
        if (patchStates.open && patchStates.open.enabled === false) {
          throw new PipelineConfigError('OPEN_LOCKED_ON', 'open stage cannot be disabled');
        }

        const stagesBeingDisabled = (
          Object.entries(patchStates) as Array<[string, { enabled?: boolean } | undefined]>
        )
          .filter(([, v]) => v?.enabled === false)
          .map(([stage]) => stage as IssueStatus);
        if (stagesBeingDisabled.length > 0) {
          const blocking = await db
            .select({ id: issues.id, status: issues.status })
            .from(issues)
            .where(
              and(eq(issues.projectId, projectId), inArray(issues.status, stagesBeingDisabled)),
            );
          if (blocking.length > 0) {
            throw new PipelineConfigError(
              'STAGE_HAS_ISSUES',
              'cannot disable stages while issues are at those stages',
              {
                blockingIssueIds: blocking.map((b) => b.id),
                stagesBlocked: Array.from(new Set(blocking.map((b) => b.status))),
              },
            );
          }
        }

        const mergedStatesForRule3 = (nextPipeline as { states?: StagesConfig }).states ?? {};
        // ISS-382 — delta-validation. Only require a skill for a stage this
        // patch actually TRANSITIONS into enabled+auto. A patch that merely
        // re-asserts an already-auto stage must not trip this rule — the
        // session-groups editor resends the full `states` map (states is
        // wholesale-replaced, and GET read-normalizes every stage to
        // enabled:true/mode:'auto'), so without the delta a sessionGroup-only
        // save would 409 on any project lacking skills for some auto stage.
        // The symmetric top-level autoX toggle rule below still guards the
        // enable-without-skill failure mode on every patch.
        const currentStates = (currentPipeline as { states?: StagesConfig }).states ?? {};
        // Treat an absent/partial stage as the runtime default (enabled+auto),
        // so a stage with no stored override is NOT seen as transitioning into
        // auto when the patch spells out the defaults explicitly.
        const isAutoEnabled = (sc?: { enabled?: boolean; mode?: 'auto' | 'manual' }) =>
          (sc?.enabled ?? true) !== false && (sc?.mode ?? 'auto') === 'auto';
        const needRegistration = (
          Object.entries(mergedStatesForRule3) as Array<
            [string, { enabled?: boolean; mode?: 'auto' | 'manual' } | undefined]
          >
        )
          .filter(
            ([stage, v]) => isAutoEnabled(v) && !isAutoEnabled(currentStates[stage as IssueStatus]),
          )
          .map(([stage]) => stage as IssueStatus);
        if (needRegistration.length > 0) {
          const regs = await db
            .select({ stage: skillRegistrations.stage })
            .from(skillRegistrations)
            .where(
              and(
                eq(skillRegistrations.projectId, projectId),
                inArray(skillRegistrations.stage, needRegistration),
              ),
            );
          const have = new Set(regs.map((r) => r.stage));
          const missing = needRegistration.filter((s) => !have.has(s));
          if (missing.length > 0) {
            throw new PipelineConfigError(
              'AUTO_STAGE_NEEDS_SKILL',
              'auto-mode stages require a registered skill',
              { stagesMissingSkill: missing },
            );
          }
        }
      }

      // ISS-238 — symmetric rule for the top-level `auto<Stage>` toggles. The
      // per-state `mode==='auto'` check above only catches stages an operator
      // explicitly switched to auto mode. The actual production failure mode
      // (Anhome, 2026-05-26) was a project with `autoReview=true` and no
      // `developed` skill — the toggle defaults to checking against any
      // skill registration for the matching stage, regardless of mode config.
      const toggleEnabledStages: IssueStatus[] = [];
      for (const step of PIPELINE_STEPS) {
        const v = (nextPipeline as Record<string, unknown>)[step.toggle];
        const on =
          v === true ||
          (typeof v === 'object' && v !== null && (v as { enabled?: boolean }).enabled !== false);
        if (on) toggleEnabledStages.push(step.status);
      }
      if (toggleEnabledStages.length > 0) {
        const regs = await db
          .select({ stage: skillRegistrations.stage })
          .from(skillRegistrations)
          .where(
            and(
              eq(skillRegistrations.projectId, projectId),
              inArray(skillRegistrations.stage, toggleEnabledStages),
            ),
          );
        const have = new Set(regs.map((r) => r.stage));
        const missing = toggleEnabledStages.filter((s) => !have.has(s));
        if (missing.length > 0) {
          throw new PipelineConfigError(
            'MISSING_SKILL_FOR_ENABLED_STAGE',
            'enabled auto-stage toggles require a registered skill for the corresponding stage',
            { stagesMissingSkill: missing },
          );
        }
      }

      const mergedStates = (nextPipeline as { states?: StagesConfig }).states;
      const dead = validateStatesConfig(mergedStates);
      if (dead) {
        throw new PipelineConfigError(
          'DEAD_END_CONFIG',
          `Cannot disable stages with no forward path: ${dead.unreachable.join(', ')}`,
          { unreachable: dead.unreachable },
        );
      }
      // `merged_at` (the column the blocks/decomposes L2 gate keys on) is only
      // stamped when an issue transitions OUT of `mergeStates.baseBranch`
      // (see issues/merged-at.ts). If that stage is DISABLED the transition can
      // never happen, so every dependent wedges forever (silent). Reject it.
      const baseMergeState = resolveMergeStates(nextPipeline).baseBranch;
      if (mergedStates?.[baseMergeState]?.enabled === false) {
        throw new PipelineConfigError(
          'MERGE_STATE_DISABLED',
          `mergeStates.baseBranch '${baseMergeState}' is a disabled stage — merged_at can never stamp, so every blocks/decomposes dependent wedges. Point baseBranch at the enabled stage where the merge actually completes (e.g. 'testing'/'developed').`,
          { baseBranch: baseMergeState },
        );
      }
      nextDoc.pipelineConfig = nextPipeline;
    }
    const subkey = JSON.stringify(nextDoc);
    await db.execute(
      sql`UPDATE projects
          SET agent_config = COALESCE(agent_config, '{}'::jsonb) || ${subkey}::jsonb
          WHERE id = ${projectId}`,
    );
  }

  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new PipelineConfigError('PROJECT_NOT_FOUND', 'project not found');
  const ac = (row.agentConfig ?? {}) as Record<string, unknown>;
  const stored = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
  const parsed = pipelineConfigSchema.parse(stored);
  const pipelineConfig: PipelineConfig = { ...PIPELINE_CONFIG_DEFAULTS, ...parsed };

  // ISS-239 — non-blocking advisory for stages that the operator left
  // enabled (default) but for which no skill is registered AND which are
  // NOT covered by the ISS-238 hard rule (PIPELINE_STEPS-mapped stages).
  // Those stages auto-skip cleanly at runtime via STAGE_FORWARD; surface
  // the behaviour so operators aren't surprised when issues breeze past.
  const warnings = await computeStageWithoutSkillWarnings(projectId, pipelineConfig);
  const parkWarning = computeMergeStateParkWarning(pipelineConfig);
  if (parkWarning) {
    warnings.push(parkWarning);
    logger.warn(
      { projectId, warning: parkWarning },
      'mergeStates baseBranch may never stamp merged_at',
    );
  }

  return { pipelineConfig, warnings };
}

const STEP_BY_STATUS = new Map<string, (typeof PIPELINE_STEPS)[number]>(
  PIPELINE_STEPS.map((s) => [s.status, s]),
);

/**
 * Non-blocking advisory: `merged_at` only stamps when an issue transitions OUT
 * of `mergeStates.baseBranch`. If that stage can't auto-advance — it's `manual`,
 * or its pipeline-step auto-toggle (e.g. `autoRelease`) is off — issues PARK
 * there and `merged_at` never stamps, so `blocks`/`decomposes` dependents wedge
 * silently (the anhome/sid-desk class of bug). We can't statically detect a
 * no-op skill that fails to advance an enabled+auto stage, so this is a warning
 * (paired with the settings-UI surface), not a hard reject — the runtime stall
 * detector is the backstop for the cases config can't reveal.
 */
export function computeMergeStateParkWarning(cfg: PipelineConfig): string | null {
  const base = resolveMergeStates(cfg).baseBranch as string;
  const sc = (cfg.states as Record<string, { mode?: string; enabled?: boolean } | undefined>)?.[
    base
  ];
  if (sc?.mode === 'manual') {
    return `mergeStates.baseBranch '${base}' is a manual stage — the pipeline won't auto-leave it, so merged_at never stamps and blocks/decomposes dependents will wedge. Point baseBranch at the stage where the merge auto-completes.`;
  }
  const step = STEP_BY_STATUS.get(base);
  if (step && (cfg as Record<string, unknown>)[step.toggle] === false) {
    return `mergeStates.baseBranch '${base}' maps to the '${step.jobType}' step whose auto-toggle '${step.toggle}' is off — that stage never dispatches/advances, so merged_at never stamps and blocks/decomposes dependents will wedge.`;
  }
  return null;
}

/**
 * ISS-639 — True when `mergeStates.baseBranch` is a normal auto-advancing
 * stage that CAN stamp `merged_at` (see `issues/merged-at.ts`). False when
 * structurally unstampable (manual mode / auto-toggle off / stage disabled)
 * — the case the blocks-gate `closed` bypass in `dispatch-gates.ts` exists
 * for. Single source of truth shared by the gate (dispatch-time) and the
 * sweeper (park-time) so they never disagree on which projects are exempt.
 */
export function isBaseBranchStampable(cfg: PipelineConfig): boolean {
  if (computeMergeStateParkWarning(cfg) !== null) return false;
  const base = resolveMergeStates(cfg).baseBranch as string;
  const sc = (cfg.states as Record<string, { enabled?: boolean } | undefined>)?.[base];
  return sc?.enabled !== false;
}

const PIPELINE_STEPS_STAGES = new Set<string>(PIPELINE_STEPS.map((s) => s.status));

async function computeStageWithoutSkillWarnings(
  projectId: string,
  cfg: PipelineConfig,
): Promise<string[]> {
  const stagesToCheck: IssueStatus[] = [];
  for (const stage of STAGE_NAMES) {
    if (PIPELINE_STEPS_STAGES.has(stage)) continue; // gated by ISS-238 instead
    if (!(stage in STAGE_FORWARD)) continue; // no forward path → no auto-skip
    const sc = cfg.states?.[stage];
    if (sc && sc.enabled === false) continue;
    stagesToCheck.push(stage as IssueStatus);
  }
  if (stagesToCheck.length === 0) return [];

  const regs = await db
    .select({ stage: skillRegistrations.stage })
    .from(skillRegistrations)
    .where(
      and(
        eq(skillRegistrations.projectId, projectId),
        inArray(skillRegistrations.stage, stagesToCheck),
      ),
    );
  const have = new Set(regs.map((r) => r.stage));
  const warnings: string[] = [];
  for (const stage of stagesToCheck) {
    if (have.has(stage)) continue;
    const msg = `Stage '${stage}' enabled but no skill registered. Issues will auto-skip past this stage via STAGE_FORWARD.`;
    warnings.push(msg);
    logger.warn({ projectId, stage }, msg);
  }
  return warnings;
}
