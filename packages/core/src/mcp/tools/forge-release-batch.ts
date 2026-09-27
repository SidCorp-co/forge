/**
 * `forge_release_batch` — every call a `release_batch` job's prompt names, on
 * the credential the job's pane already holds.
 *
 * A pool job opens in the project's provisioned checkout, whose `.mcp.json`
 * carries the per-(device × project) workspace credential core minted at
 * provision. The deploy half of a release rides it (`forge_coolify_deploy`),
 * and so does the recording half here, so a box holding only what its daemon
 * holds can say what it did to production (ISS-1211). The REST routes stay
 * the door for a person's own token.
 *
 * `finish` and `abort` call the same service functions the REST routes call.
 * This is a second door onto one close, not a second close: `finish` takes the
 * attempt and answers, and the verdict is read with `state`.
 */

import type { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { acceptReleaseBatchFinish } from '../../release-batch/finish-job.js';
import { announceMethod } from '../../release-batch/method.js';
import { RELEASE_BATCH_SKILL, RELEASE_BATCH_TOOL } from '../../release-batch/plan.js';
import {
  finishedForSentence,
  finishRefusal as finishHttpRefusal,
  recordRefusal,
} from '../../release-batch/refusals.js';
import {
  abortReleaseBatch,
  findReleaseBatchRun,
  loadReleaseBatchContext,
  ReleaseBatchAbortedError,
  ReleaseFinishedForOtherCommitError,
  ReleaseFinishInFlightError,
  ReleaseNotVerifiedError,
  ReleaseProbesUndeclaredError,
  ReleaseVersionMissingError,
} from '../../release-batch/service.js';
import { readReleaseRunState } from '../../release-batch/state.js';
import {
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalActor,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    action: z.enum(['get', 'state', 'method', 'finish', 'abort']),
    projectId: z.uuid().optional(),
    runId: z.uuid(),
    /** method: the skill the run loaded. */
    skill: z.string().trim().min(1).max(200).optional(),
    /** method: false when the skill would not load. */
    loaded: z.boolean().optional(),
    /** method: the run's own words about what it loaded, or why it could not. */
    detail: z.string().trim().max(4_000).optional(),
    /** finish: the SHA pushed to the production branch, for the probes to match. */
    commit: z.string().trim().max(200).optional(),
    /** abort: why. */
    reason: z.string().trim().max(2_000).optional(),
    /** abort: what to do with a roster whose run already promoted. Absent is `hold` (ISS-1199). */
    promotedRoster: z.enum(['hold', 'return-to-gate']).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** A refusal as MCP carries one: the code first, then the sentence, then what the REST body held. */
function refusal(code: string, message: string, details?: unknown): Error {
  const tail = details === undefined ? '' : `\n${JSON.stringify(details)}`;
  return new Error(`${code}: ${message}${tail}`);
}

function fromHttp(err: HTTPException): Error {
  const cause = (err.cause ?? {}) as { code?: string } & Record<string, unknown>;
  const { code, ...rest } = cause;
  return refusal(code ?? 'CONFLICT', err.message, Object.keys(rest).length > 0 ? rest : undefined);
}

/**
 * A credential that can read this batch and not record its outcome is refused
 * at the read. The read is the run's first act, so this is the refusal before
 * production changes that the recording half would otherwise make after.
 */
function assertCanRecord(principal: McpPrincipal): void {
  if (!principal.scopes.includes('write')) {
    throw refusal(
      'RELEASE_CREDENTIAL_CANNOT_RECORD',
      'this token lacks the `write` scope, so it could read this batch and could not finish or abort it. ' +
        'A release run records its outcome on the credential it starts on, or it does not start: change nothing, ' +
        'and end the turn saying the credential cannot record the release.',
    );
  }
}

async function assertRunOfProject(runId: string, projectId: string): Promise<void> {
  const run = await findReleaseBatchRun(runId);
  if (!run || run.projectId !== projectId) {
    throw new Error('NOT_FOUND: release batch not found in this project');
  }
}

function finishRefusal(err: unknown): Error {
  if (err instanceof ReleaseNotVerifiedError || err instanceof ReleaseProbesUndeclaredError) {
    return fromHttp(recordRefusal(err));
  }
  if (err instanceof ReleaseVersionMissingError) {
    return refusal('RELEASE_VERSION_MISSING', err.message);
  }
  if (err instanceof ReleaseFinishInFlightError) {
    return refusal(
      'RELEASE_FINISH_IN_FLIGHT',
      `a finish for ${err.inFlightCommit ?? 'no named commit'} is already running on this batch, and this call names ` +
        `${err.askedCommit ?? 'no commit'}. Read it with ${RELEASE_BATCH_TOOL} action=state runId=${err.where.runId}: ` +
        '`finish.state` ends at `finished` or `failed`, and a new finish is taken once that one has failed.',
      { requestId: err.requestId, inFlightCommit: err.inFlightCommit },
    );
  }
  if (err instanceof ReleaseFinishedForOtherCommitError) {
    return refusal(
      'RELEASE_FINISHED_FOR_OTHER_COMMIT',
      `${finishedForSentence(err)} Read what it recorded with ${RELEASE_BATCH_TOOL} action=state runId=${err.where.runId}.`,
      { requestId: err.requestId, finishedCommit: err.finishedCommit },
    );
  }
  if (err instanceof ReleaseBatchAbortedError) {
    // The same account the REST door gives and the finish record stores: one sentence per abort.
    const http = finishHttpRefusal(err);
    if (http) return fromHttp(http);
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function run(principal: McpPrincipal, input: Input, projectId: string): Promise<unknown> {
  const { runId } = input;
  switch (input.action) {
    case 'get':
      return await loadReleaseBatchContext(runId);
    case 'state': {
      const state = await readReleaseRunState(runId);
      if (!state || state.projectId !== projectId) {
        throw new Error('NOT_FOUND: release batch not found in this project');
      }
      return state;
    }
    case 'method': {
      if (input.loaded === undefined) {
        throw new Error(
          `BAD_REQUEST: method needs \`loaded\` — true with skill="${RELEASE_BATCH_SKILL}", or false with a detail saying why it would not load`,
        );
      }
      if (!input.skill) {
        throw new Error(
          `BAD_REQUEST: method needs \`skill\`, the name of the skill the run loaded`,
        );
      }
      return announceMethod({
        runId,
        skill: input.skill,
        loaded: input.loaded,
        detail: input.detail,
      });
    }
    case 'finish': {
      try {
        const accepted = await acceptReleaseBatchFinish(runId, principalActor(principal), {
          commit: input.commit,
        });
        return { runId, finish: accepted.finish };
      } catch (err) {
        throw finishRefusal(err);
      }
    }
    case 'abort': {
      const result = await abortReleaseBatch(
        runId,
        input.reason ?? 'aborted by agent',
        principal.userId,
        { promotedRoster: input.promotedRoster },
      );
      return { aborted: true, releasedIds: result.claimsCleared, ...result };
    }
  }
}

export const forgeReleaseBatchTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: RELEASE_BATCH_TOOL,
  description:
    'Read and record one release batch from inside the release_batch job that runs it — the calls its prompt names, ' +
    'on the credential the job already holds. Actions: `get` (the batch context: roster, release notes, branches, deploy plan; ' +
    'call it FIRST), `state` (roster, attempts, live reading, bounds, announced method), `method` (announce the method loaded: ' +
    '`skill` + `loaded`, optional `detail`; a Coolify deploy is refused until this run has recorded something, and this is the ' +
    'call that records it first), `finish` (`commit` = the SHA pushed to ' +
    'production; answers at once with the attempt at `accepted`, and the server then reads the probes and closes every claimed issue ' +
    'on its own — read `state` → `finish.state` for `finished` or `failed`, whose `refusal` says why; a new `finish` after a `failed` one ' +
    'starts a new attempt), `abort` (`reason`; closes nothing and leaves closed the issues a finish already closed, answered as `alreadyClosed`; ' +
    'on a run that recorded no promotion it releases every claim and moves the issues still at `releasing` back to the release gate, answered as `recovered` — ' +
    'a roster whose run already promoted is left at `releasing` still claimed unless `promotedRoster: "return-to-gate"` names the settlement, which returns it ' +
    'to the release gate for `POST /release-records` to close against what production is serving). ' +
    'Every action needs `runId`, and a token with the write scope: a credential that could read the batch but not record it is ' +
    'refused at `get`, before anything changes.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const projectId = await resolveEffectiveProjectId(ctx, input.projectId ?? null);
    await assertPrincipalIsWriter(ctx.principal, projectId);
    assertCanRecord(ctx.principal);
    await assertRunOfProject(input.runId, projectId);
    return run(ctx.principal, input, projectId);
  },
});
