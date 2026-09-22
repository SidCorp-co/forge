import {
  applyDocumentPatch,
  comparePatchBase,
  describeConflicts,
  formatPath,
  patchLeafPaths,
} from '@forge/contracts/document-patch';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, projects, runners } from '../db/schema.js';
import { hooks } from './hooks.js';
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
  | 'CONFIG_STALE'
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
  /** Sparse: a key it does not name is untouched, `null` deletes. */
  patch: PipelineConfigPatchInput;
  /** What the caller read. Compared at the paths the patch writes, and nowhere else. */
  base: Record<string, unknown>;
}

export interface UpdatePipelineConfigResult {
  pipelineConfig: PipelineConfig;
  /** Non-blocking advisories surfaced after a successful update. */
  warnings: string[];
}

/**
 * Re-run the canonical schema over the MERGED document. The route validates the PATCH's shape;
 * a cross-field rule (`pipelineConfigSchema`'s `superRefine`) can only be violated by the pair
 * that ends up STORED — `{poolBacklog:{statuses:['draft']}}` and `{intakeGate:{enabled:true}}`
 * are each legal alone and together are what the schema exists to forbid (ISS-917 B5). An
 * already-invalid stored document keeps its amnesty, but only at the paths this patch did NOT
 * write: an error the caller just introduced is its own.
 */
function assertMergedConfigValid(
  currentPipeline: Record<string, unknown>,
  nextPipeline: Record<string, unknown>,
  writtenPaths: string[],
): void {
  const merged = pipelineConfigSchema.safeParse(nextPipeline);
  if (merged.success) return;
  const currentWasValid = pipelineConfigSchema.safeParse(currentPipeline).success;
  const issuesToRaise = currentWasValid
    ? merged.error.issues
    : merged.error.issues.filter((i) => touchesWrittenPath(i.path.join('.'), writtenPaths));
  const first = issuesToRaise[0];
  if (!first) return;
  throw new PipelineConfigError(
    'CONFIG_CONFLICT',
    first.message ?? 'the merged pipeline config is not valid',
    {
      path: first.path?.join('.') ?? '',
      conflicts: issuesToRaise.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
  );
}

/** An error at `states.open`, and one at `states.open.mode`, both belong to a patch that wrote the latter. */
function touchesWrittenPath(errorPath: string, writtenPaths: string[]): boolean {
  return writtenPaths.some(
    (written) =>
      written === errorPath ||
      written.startsWith(`${errorPath}.`) ||
      errorPath.startsWith(`${written}.`),
  );
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function assertStageChangesAreLegal(
  tx: Tx,
  projectId: string,
  patchStates: StagesConfig | undefined,
): Promise<void> {
  if (!patchStates) return;
  if (patchStates.open && patchStates.open.enabled === false) {
    throw new PipelineConfigError('OPEN_LOCKED_ON', 'open stage cannot be disabled');
  }

  const stagesBeingDisabled = (
    Object.entries(patchStates) as Array<[string, { enabled?: boolean } | undefined]>
  )
    .filter(([, v]) => v?.enabled === false)
    .map(([stage]) => stage as IssueStatus);
  if (stagesBeingDisabled.length > 0) {
    const blocking = await tx
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.status, stagesBeingDisabled)));
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

  const pooledStages = (
    Object.entries(patchStates) as Array<[string, { deviceIds?: string[] } | undefined]>
  ).filter((entry): entry is [string, { deviceIds: string[] }] =>
    Boolean(entry[1]?.deviceIds?.length),
  );
  if (pooledStages.length === 0) return;
  const wanted = Array.from(new Set(pooledStages.flatMap(([, v]) => v.deviceIds)));
  const bound = await tx
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

/**
 * What a patch is COMPARED against: the stored document with the defaults filled in for a
 * top-level key it does not have. `GET /pipeline-config` answers with those same defaults, so a
 * caller editing a stage of a project that has never saved one is comparing against what it was
 * shown. What is WRITTEN is the stored document, never this one — expanding the defaults into
 * storage would make every save persist keys the caller never named.
 */
function mergeTargetOf(stored: Record<string, unknown>): Record<string, unknown> {
  return { ...PIPELINE_CONFIG_DEFAULTS, ...stored } as Record<string, unknown>;
}

/**
 * Apply a pipeline-config patch to the project's `agentConfig` jsonb document,
 * under the compare-and-swap the caller's `base` declares. Authorization is the
 * caller's responsibility — both REST (`PATCH /projects/:id/pipeline-config`)
 * and MCP (`forge_config` action=`update`) gate on owner before invoking this.
 *
 * The read, the comparison and the write happen inside one transaction with the
 * project row locked, so two writers that read the same value end with one
 * applied and one refused rather than both applied and one lost.
 */
export async function updatePipelineConfig(
  input: UpdatePipelineConfigInput,
): Promise<UpdatePipelineConfigResult> {
  const { projectId, base } = input;
  const pipelinePatch = input.patch as Record<string, unknown>;

  if (Object.keys(pipelinePatch).length > 0) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
        .for('update');
      if (!row) throw new PipelineConfigError('PROJECT_NOT_FOUND', 'project not found');
      const currentAc = (row.agentConfig ?? {}) as Record<string, unknown>;
      const currentPipeline = (currentAc.pipelineConfig ?? {}) as Record<string, unknown>;
      const target = mergeTargetOf(currentPipeline);

      const conflicts = comparePatchBase(target, base, pipelinePatch);
      if (conflicts.length > 0) {
        throw new PipelineConfigError(
          'CONFIG_STALE',
          `the pipeline config changed since you read it — ${describeConflicts(conflicts)}. Nothing was written. Read \`GET /api/projects/:id/pipeline-config\` again and resend your change against that.`,
          { conflicts },
        );
      }

      await assertStageChangesAreLegal(
        tx,
        projectId,
        (pipelinePatch as { states?: StagesConfig }).states,
      );

      const nextStored = applyDocumentPatch(currentPipeline, pipelinePatch);
      const writtenPaths = patchLeafPaths(pipelinePatch).map(formatPath);
      assertMergedConfigValid(currentPipeline, mergeTargetOf(nextStored), writtenPaths);

      const subkey = JSON.stringify({ pipelineConfig: nextStored });
      await tx.execute(
        sql`UPDATE projects
            SET agent_config = COALESCE(agent_config, '{}'::jsonb) || ${subkey}::jsonb
            WHERE id = ${projectId}`,
      );
    });
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

  if ('statusEntryCriteria' in pipelinePatch) {
    await hooks.emit('contractInputChanged', {
      projectId,
      reason: 'the project changed which records a status entry requires',
    });
  }

  return { pipelineConfig, warnings };
}
