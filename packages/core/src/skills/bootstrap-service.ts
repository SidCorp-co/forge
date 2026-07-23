import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, skillRegistrations, skills } from '../db/schema.js';
import { logger } from '../logger.js';
import { defaultStatesConfig } from '../pipeline/pipeline-config-schema.js';
import { STATUS_TO_JOB_TYPE } from '../pipeline/skill-mapping.js';
import { readAgentConfig, writeAgentConfig } from '../projects/agent-config.js';
import { resolveOrAdoptProjectSkill } from './service.js';

// ISS-737 — the seed-list of shared skills every project must carry as
// `install_only` (no stage binding), regardless of whether it registers any
// stage-mapped skills. Adding a name here is the ENTIRE change needed to make
// a builtin skill fan out to every project (new + backfill) — no per-skill
// function, no new call site. Mirrors `TEMPLATE_SETS` below: the skill body
// still ships as a global builtin template (needs a deploy), this list only
// says which builtins get force-adopted everywhere.
// ISS-733 seeded the first entry: the interactive onboarding chat skill, run
// manually triggered from web to drive turn 1 of a chat session.
const SHARED_INSTALL_ONLY_SKILLS: ReadonlyArray<string> = ['forge-onboard'];

/**
 * Idempotent: for each seed-list entry, adopt the project's own copy
 * (cloning the global template on first call) and flip it `install_only` if
 * not already. Per-entry try/catch — a server that hasn't deployed one
 * builtin template yet (no global row) or any other failure on one entry
 * must never block the rest of the seed-list or the surrounding bootstrap
 * call, since this is additive backfill, not the bootstrap's core job (stage
 * skills + pipeline preset).
 */
export async function ensureSharedInstallOnlySkills(projectId: string): Promise<void> {
  for (const skillName of SHARED_INSTALL_ONLY_SKILLS) {
    try {
      const skillId = await resolveOrAdoptProjectSkill(projectId, skillName);
      if (!skillId) continue;
      await db
        .update(skills)
        .set({ installOnly: true })
        .where(and(eq(skills.id, skillId), eq(skills.installOnly, false)));
    } catch (err) {
      logger.error(
        { err, projectId, skillName },
        'bootstrap-service: ensureSharedInstallOnlySkills failed for one entry',
      );
    }
  }
}

// ISS-2A: idempotent first-run bootstrap. Binds the 7 stage-mapped global
// `forge-*` skills to the project, applies the Balanced pipelineConfig
// preset (only when no preset is set yet), and returns the result. Re-running
// the call after the project is already bootstrapped is a no-op.

// ISS-453 — named skill template sets. Each entry is a stage→skill binding the
// bootstrap materialises via clone-on-first-use. `forge-default` is derived
// from STATUS_TO_JOB_TYPE so it reproduces the original inline loop exactly
// (regression-safe); adding a set is a data entry here, not new code.
const TEMPLATE_SETS: Record<string, ReadonlyArray<{ stage: string; skillName: string }>> = {
  'forge-default': Object.entries(STATUS_TO_JOB_TYPE).flatMap(([status, mapping]) =>
    mapping ? [{ stage: status, skillName: `forge-${mapping.type}` }] : [],
  ),
};

const BALANCED_PRESET = {
  enabled: true,
  autoTriage: true,
  // Clarify opt-in is explicit: the builtin seed ships no forge-clarify
  // global skill, so the `confirmed` stage soft-skips (missing_skill) to
  // `clarified` until a project registers one AND flips this toggle.
  autoClarify: false,
  autoPlan: true,
  autoCode: false,
  autoReview: true,
  autoTest: true,
  autoFix: true,
  autoRelease: false,
} as const;

// ISS-453 — named pipelineConfig presets. Only `balanced` is wired today;
// Stable/Aggressive plug in later as new entries (data only, no handler code).
export type PipelinePreset = Readonly<Record<keyof typeof BALANCED_PRESET, boolean>>;
const PIPELINE_PRESETS: Record<string, PipelinePreset> = {
  balanced: BALANCED_PRESET,
};

/** Thrown when the requested template set name is not registered. */
export class UnknownTemplateSetError extends Error {
  readonly code = 'UNKNOWN_TEMPLATE_SET';
  readonly templateSet: string;
  constructor(templateSet: string) {
    super(`unknown template set '${templateSet}'`);
    this.name = 'UnknownTemplateSetError';
    this.templateSet = templateSet;
  }
}

/** Thrown when the requested pipelineConfig preset name is not registered. */
export class UnknownPipelinePresetError extends Error {
  readonly code = 'UNKNOWN_PIPELINE_PRESET';
  readonly preset: string;
  constructor(preset: string) {
    super(`unknown preset '${preset}'`);
    this.name = 'UnknownPipelinePresetError';
    this.preset = preset;
  }
}

/**
 * Thrown when no stage template resolves to a bindable skill — the server's
 * builtin skill seed has not run, so a fresh bootstrap has nothing to bind.
 */
export class SkillSeedMissingError extends Error {
  readonly code = 'NO_GLOBAL_SKILLS';
  constructor() {
    super('no skill templates available — server skill seed has not run');
    this.name = 'SkillSeedMissingError';
  }
}

export interface BootstrapSelection {
  templateSet: ReadonlyArray<{ stage: string; skillName: string }>;
  preset: PipelinePreset;
}

/**
 * Resolve template-set + preset names to their data tables, failing fast
 * (before any mutation or access check the caller performs afterwards) on an
 * unknown name.
 */
export function resolveBootstrapSelection(
  templateSetName: string,
  presetName: string,
): BootstrapSelection {
  const templateSet = TEMPLATE_SETS[templateSetName];
  if (!templateSet) throw new UnknownTemplateSetError(templateSetName);
  const preset = PIPELINE_PRESETS[presetName];
  if (!preset) throw new UnknownPipelinePresetError(presetName);
  return { templateSet, preset };
}

export interface BootstrapResult {
  alreadyBootstrapped: boolean;
  skillsBound: number;
  pipelineEnabled: boolean;
}

/**
 * Idempotent first-run skills bootstrap for a project (ISS-2A / ISS-453).
 * Caller is responsible for authorization; `userId` is recorded as
 * `registeredBy` on the created stage registrations.
 */
export async function bootstrapProjectSkills(
  projectId: string,
  userId: string,
  { templateSet, preset }: BootstrapSelection,
): Promise<BootstrapResult> {
  // Already bootstrapped? Return current state, no mutation.
  const existing = await db
    .select({ id: skillRegistrations.id })
    .from(skillRegistrations)
    .where(eq(skillRegistrations.projectId, projectId))
    .limit(1);

  const currentAc = (await readAgentConfig(projectId)) ?? {};
  const currentPipeline = (currentAc.pipelineConfig ?? {}) as Record<string, unknown>;

  if (existing.length > 0) {
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(skillRegistrations)
      .where(eq(skillRegistrations.projectId, projectId));

    // ISS-108 — backfill `states` for already-bootstrapped projects that
    // pre-date this field. Skipped when operator already wrote a `states`
    // entry (their value wins). Avoids a separate reseed flow.
    if (currentPipeline.states === undefined) {
      await writeAgentConfig(projectId, {
        ...currentAc,
        pipelineConfig: { ...currentPipeline, states: defaultStatesConfig() },
      });
    }

    const result = {
      alreadyBootstrapped: true,
      skillsBound: Number(countRows[0]?.count ?? 0),
      pipelineEnabled: currentPipeline.enabled === true,
    };

    // ISS-737 — backfill: a project bootstrapped before a seed-list entry
    // existed still gets its install_only copy, without re-running (or
    // re-registering) the stage seed. Runs last so it never shifts the
    // pipelineConfig write above.
    await ensureSharedInstallOnlySkills(projectId);

    return result;
  }

  // Single path: each stage binds a PROJECT-owned skill. Materialise one by
  // cloning the same-name global `forge-<type>` template into this project
  // (clone-on-first-use); a global is never registered directly. Stages whose
  // template is absent (partial builtin seed) are skipped. See
  // docs/skills-scope-playbook.md.
  const toInsert: Array<{
    projectId: string;
    skillId: string;
    stage: string;
    registeredBy: string;
  }> = [];
  for (const { stage, skillName } of templateSet) {
    const skillId = await resolveOrAdoptProjectSkill(projectId, skillName);
    if (!skillId) continue;
    toInsert.push({ projectId, skillId, stage, registeredBy: userId });
  }

  if (toInsert.length === 0) {
    throw new SkillSeedMissingError();
  }

  await db.insert(skillRegistrations).values(toInsert);

  // Apply the selected preset (Balanced by default) only when no
  // pipelineConfig.enabled flag has been set yet — never clobber a user's
  // deliberate config.
  const shouldSetPreset = currentPipeline.enabled === undefined;
  if (shouldSetPreset) {
    await writeAgentConfig(projectId, {
      ...currentAc,
      pipelineConfig: {
        ...currentPipeline,
        ...preset,
        states: defaultStatesConfig(),
      },
    });
  } else if (currentPipeline.states === undefined) {
    // Preset stays untouched but ensure `states` is populated so the
    // orchestrator can rely on the field.
    await writeAgentConfig(projectId, {
      ...currentAc,
      pipelineConfig: { ...currentPipeline, states: defaultStatesConfig() },
    });
  }

  // ISS-737 — seed the project's install_only copies of every shared skill
  // alongside the stage-mapped skills, so a fresh project can immediately use
  // them (e.g. trigger the onboarding chat once a runner is bound). Runs last
  // so it never shifts the pipelineConfig write above.
  await ensureSharedInstallOnlySkills(projectId);

  return {
    alreadyBootstrapped: false,
    skillsBound: toInsert.length,
    pipelineEnabled: shouldSetPreset ? preset.enabled : currentPipeline.enabled === true,
  };
}

export interface FanOutResult {
  totalProjects: number;
  succeeded: number;
  failed: number;
}

/**
 * Cross-project sweep: run `ensureSharedInstallOnlySkills` for every existing
 * project, so a name added to `SHARED_INSTALL_ONLY_SKILLS` reaches projects
 * that were bootstrapped before the entry existed and never hit the
 * per-project bootstrap endpoint again. Best-effort per project — one
 * project's failure must not abort the sweep (mirrors the migration pattern
 * in `knowledge/migrate-project-facts.ts`).
 */
export async function fanOutSharedInstallOnlySkills(): Promise<FanOutResult> {
  const rows = await db.select({ id: projects.id }).from(projects);

  let succeeded = 0;
  let failed = 0;
  for (const { id } of rows) {
    try {
      await ensureSharedInstallOnlySkills(id);
      succeeded++;
    } catch (err) {
      logger.error(
        { err, projectId: id },
        'bootstrap-service: fanOutSharedInstallOnlySkills failed for one project',
      );
      failed++;
    }
  }

  const result: FanOutResult = { totalProjects: rows.length, succeeded, failed };
  logger.info(result, 'bootstrap-service: fan-out sweep complete');
  return result;
}
