import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, projects, runners } from '../db/schema.js';
import {
  PIPELINE_CONFIG_DEFAULTS,
  type PipelineConfig,
  type PipelineConfigPatchInput,
  pipelineConfigSchema,
} from './pipeline-config-schema.js';
import type { StagesConfig } from './state-machine.js';

/**
 * Typed errors thrown by {@link updatePipelineConfig}. REST and MCP callers
 * each map these to their own response shape; the service stays transport-
 * agnostic.
 */
export type PipelineConfigErrorCode =
  | 'OPEN_LOCKED_ON'
  | 'STAGE_HAS_ISSUES'
  | 'STAGE_POOL_UNKNOWN_RUNNER'
  | 'CONFIG_CONFLICT'
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
  /** Non-blocking advisories surfaced after a successful update. */
  warnings: string[];
}

/**
 * Re-run the canonical schema over the MERGED document.
 *
 * The route validates the PATCH; a cross-field rule (`pipelineConfigSchema`'s
 * `superRefine`) can only be violated by the pair that ends up STORED, and a
 * patch carrying one half of a forbidden pair passes on its own. ISS-917 B5 is
 * exactly that shape: `{poolBacklog:{statuses:['draft']}}` then
 * `{intakeGate:{enabled:true}}` are each individually legal and together are
 * the state the schema exists to make unrepresentable.
 */
// cm:guard refuse only what THIS write creates. If the stored config already fails the schema, the patch did not cause it and blocking here would answer an operator's unrelated edit with a rule they did not break — and leave them no way to edit their way out. A merge that fails while the current document parses clean is the write's own doing, and that is the only case refused.
// cm:edge contract -> packages/core/src/pipeline/pipeline-config-schema.ts — every `superRefine` there reaches a two-write ordering ONLY through this call; a cross-field rule added there with no merged-doc check is enforceable on a single PATCH and bypassable by two.
function assertMergedConfigValid(
  currentPipeline: Record<string, unknown>,
  nextPipeline: Record<string, unknown>,
): void {
  const merged = pipelineConfigSchema.safeParse(nextPipeline);
  if (merged.success) return;
  if (!pipelineConfigSchema.safeParse(currentPipeline).success) return;
  const first = merged.error.issues[0];
  throw new PipelineConfigError(
    'CONFIG_CONFLICT',
    first?.message ?? 'the merged pipeline config is not valid',
    {
      path: first?.path?.join('.') ?? '',
      conflicts: merged.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
  );
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
      const nextPipeline = { ...currentPipeline, ...(mergeDoc.pipelineConfig as object) };
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

        // cm:why validated at WRITE time because the runtime failure is invisible: a pool naming a device with no runner on this project produces an unplaceable job that sits `queued` while the fleet reads healthy — rejecting the patch is the only place an operator learns about the typo
        const pooledStages = (
          Object.entries(patchStates) as Array<[string, { deviceIds?: string[] } | undefined]>
        ).filter((entry): entry is [string, { deviceIds: string[] }] =>
          Boolean(entry[1]?.deviceIds?.length),
        );
        if (pooledStages.length > 0) {
          const wanted = Array.from(new Set(pooledStages.flatMap(([, v]) => v.deviceIds)));
          const bound = await db
            .select({ deviceId: runners.deviceId })
            .from(runners)
            .where(and(eq(runners.projectId, projectId), inArray(runners.deviceId, wanted)));
          const have = new Set(bound.map((r) => r.deviceId));
          const unknown = pooledStages
            .map(([stage, v]) => ({ stage, deviceIds: v.deviceIds.filter((d) => !have.has(d)) }))
            .filter((e) => e.deviceIds.length > 0);
          if (unknown.length > 0) {
            throw new PipelineConfigError(
              'STAGE_POOL_UNKNOWN_RUNNER',
              'stage runner pool names a device with no runner on this project',
              { stagesWithUnknownDevices: unknown },
            );
          }
        }
      }

      assertMergedConfigValid(currentPipeline, nextPipeline);
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

  const warnings: string[] = [];

  return { pipelineConfig, warnings };
}
