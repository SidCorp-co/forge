import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, projects, runners } from '../db/schema.js';
import { isIntegrationSentinelName, matchesIntegrationProvider } from './mcp-catalog.js';
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
  | 'MCP_SENTINEL_NOT_WRITABLE_HERE'
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

/**
 * ISS-1038 — the project-default integration sentinels have exactly ONE writer,
 * `setMcpServerSentinel`, reached from Settings → Integrations. This call
 * replaces `mcpServers` wholesale from a map the CLIENT fetched, so a Pipeline
 * tab saved from a config fetched before a sentinel was switched on would
 * switch it back off, and `pixelight` and `butlocs` would lose their whole
 * autonomous lane to a save about something else.
 *
 * Round-tripping the sentinels unchanged is fine, and is what that screen does.
 * A patch that would ADD or REMOVE one is refused BY NAME rather than having
 * the offending keys quietly dropped: dropping them would answer the caller
 * with a 200 and a stored config that is not what they sent.
 *
 * Only a literal `true` under an integration name is a sentinel; an object
 * value there is a raw custom spec, which that screen does own.
 */
function assertSentinelsUnchanged(
  patched: Record<string, unknown> | null | undefined,
  stored: Record<string, unknown> | null | undefined,
): void {
  const sentinelsOf = (m: Record<string, unknown> | null | undefined) =>
    new Set(
      Object.entries(m ?? {})
        .filter(([name, value]) => value === true && isIntegrationSentinelName(name))
        .map(([name]) => name),
    );
  const before = sentinelsOf(stored);
  const after = sentinelsOf(patched);
  const added = [...after].filter((n) => !before.has(n));
  const removed = [...before].filter((n) => !after.has(n));
  if (added.length === 0 && removed.length === 0) return;
  throw new PipelineConfigError(
    'MCP_SENTINEL_NOT_WRITABLE_HERE',
    `${[...added, ...removed].join(', ')}: a connected integration is switched on Settings → Integrations → Agent MCP servers, not through the pipeline config. Send this map with its integration entries exactly as stored (${[...before].join(', ') || 'none'}).`,
    { added, removed, stored: [...before] },
  );
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
    // ISS-1038 — read, validate and write inside ONE transaction holding a row
    // lock. The read below is what the merge is built on, and this call replaces
    // `mcpServers` wholesale from a map the CLIENT fetched earlier, so without
    // the lock two writers interleave: an operator saving the Pipeline tab from
    // a config fetched a minute ago silently erases a sentinel the Integrations
    // panel wrote in between, and the panel's one-key statement does not save
    // them from it because the loss happens on this side. The lock does not make
    // the client's map fresher — it makes the two writes serial, so the second
    // one merges onto what the first actually stored.
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for('update')
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

        // ISS-1038 — the row lock above serialises the two writers of this
        // document; it cannot make a client's map fresher, and a whole-map
        // `mcpServers` patch carries whatever the client last fetched. Only
        // this refuses the stale one. `states[x].mcpServers` is untouched: a
        // stage-scoped sentinel is a deliberate narrower answer and stays
        // editable on that screen.
        if ((pipelinePatch as { mcpServers?: unknown }).mcpServers !== undefined) {
          assertSentinelsUnchanged(
            nextPipeline.mcpServers as Record<string, unknown> | null | undefined,
            currentPipeline.mcpServers as Record<string, unknown> | null | undefined,
          );
        }

        assertMergedConfigValid(currentPipeline, nextPipeline);
        nextDoc.pipelineConfig = nextPipeline;
      }
      const subkey = JSON.stringify(nextDoc);
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

  return { pipelineConfig, warnings };
}

/**
 * ISS-1038 — the ONE writer of a project-default integration sentinel, behind
 * `PUT /:projectId/integrations/mcp-injection/:provider`.
 *
 * `updatePipelineConfig` above replaces `mcpServers` wholesale from whatever
 * map the client last fetched, which is the `wholesale-config-clobber`
 * affordance; the Integrations panel's switch knows one provider's answer and
 * nothing about the rest of the map, so it must not be a second instance of it.
 * Here the read and the write are one transaction under a `FOR UPDATE` row
 * lock, so a read-modify-write of the `mcpServers` key is serialised against
 * the other writer rather than racing it.
 *
 * Disabling removes EVERY literal-`true` key matching the provider, not just
 * the bare name: a project whose only declaration is `epodsystem_store_a: true`
 * is switched ON as far as the resolver is concerned, so deleting only
 * `epodsystem` would leave the panel showing a switch that changes nothing —
 * this issue's own defect, one level down. Object-valued keys are left alone:
 * they are raw custom specs, not sentinels, and this switch does not own them.
 *
 * The value written is the bare boolean and never a credential: the provider's
 * key stays in the integration store and is rendered into a dispatch payload
 * only.
 *
 * Authorization is the caller's, as it is for `updatePipelineConfig`.
 */
// cm:guard the read and the write are ONE transaction holding the row lock. Split them and this is the clobber it exists to avoid, because the map written would be one read before somebody else's write.
// cm:edge lockstep -> packages/core/src/pipeline/mcp-catalog.ts — `matchesIntegrationProvider` decides what this removes and what `projectDeclaredProviders` calls declared; a provider that matches in one and not the other is a switch that disagrees with the panel above it
export async function setMcpServerSentinel(input: {
  projectId: string;
  name: string;
  enabled: boolean;
}): Promise<void> {
  const { projectId, name, enabled } = input;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update')
      .limit(1);
    if (!row) throw new PipelineConfigError('PROJECT_NOT_FOUND', 'project not found');

    const currentAc = (row.agentConfig ?? {}) as Record<string, unknown>;
    const currentPipeline = (currentAc.pipelineConfig ?? {}) as Record<string, unknown>;
    const currentServers = (currentPipeline.mcpServers ?? {}) as Record<string, unknown>;

    const nextServers: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(currentServers)) {
      // Drop every matching sentinel when disabling; keep everything else,
      // including an object spec stored under a matching name.
      if (!enabled && value === true && matchesIntegrationProvider(key, name)) continue;
      nextServers[key] = value;
    }
    if (enabled) nextServers[name] = true;

    // Validate the document this write PROJECTS, on the same terms the patch
    // path uses: a merge that fails while the stored document parses clean is
    // this write's own doing and is refused; one that was already failing is
    // not answered with a rule the caller did not break.
    assertMergedConfigValid(currentPipeline, { ...currentPipeline, mcpServers: nextServers });

    // `jsonb_set` needs the parent to exist, so seed `pipelineConfig` with `||`
    // in the same expression when it does not. The path is a real `text[]`
    // built with ARRAY[...]: a JSON-shaped literal cast to text[] reads as
    // 22P02 `malformed array literal` at the server, which a mocked
    // `db.execute` cannot show and which the integration suite caught.
    await tx.execute(
      sql`UPDATE projects
          SET agent_config = jsonb_set(
            COALESCE(agent_config, '{}'::jsonb)
              || jsonb_build_object(
                   'pipelineConfig',
                   COALESCE(agent_config -> 'pipelineConfig', '{}'::jsonb)
                 ),
            ARRAY['pipelineConfig', 'mcpServers'],
            ${JSON.stringify(nextServers)}::jsonb,
            true
          )
          WHERE id = ${projectId}`,
    );
  });
}
