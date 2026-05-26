import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueStatus,
  issues,
  projects,
  skillRegistrations,
} from '../db/schema.js';
import type { StagesConfig } from './state-machine.js';
import { validateStatesConfig } from './state-machine.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  type PipelineConfigPatchInput,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';

/**
 * Typed errors thrown by {@link updatePipelineConfig}. REST and MCP callers
 * each map these to their own response shape; the service stays transport-
 * agnostic.
 */
export type PipelineConfigErrorCode =
  | 'OPEN_LOCKED_ON'
  | 'STAGE_HAS_ISSUES'
  | 'AUTO_STAGE_NEEDS_SKILL'
  | 'DEAD_END_CONFIG'
  | 'PROJECT_NOT_FOUND';

export class PipelineConfigError extends Error {
  readonly code: PipelineConfigErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: PipelineConfigErrorCode, message: string, details: Record<string, unknown> = {}) {
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
        const needRegistration = (
          Object.entries(mergedStatesForRule3) as Array<
            [string, { enabled?: boolean; mode?: 'auto' | 'manual' } | undefined]
          >
        )
          .filter(([, v]) => v && v.enabled !== false && v.mode === 'auto')
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
      const mergedStates = (nextPipeline as { states?: StagesConfig }).states;
      const dead = validateStatesConfig(mergedStates);
      if (dead) {
        throw new PipelineConfigError(
          'DEAD_END_CONFIG',
          `Cannot disable stages with no forward path: ${dead.unreachable.join(', ')}`,
          { unreachable: dead.unreachable },
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

  return { pipelineConfig };
}
