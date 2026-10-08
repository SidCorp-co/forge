// The long tail: a question no report query answers is computed by a script a sandbox executor runs
// over a snapshot of report runs the asker made this turn, and over what it reads of the project by
// GET as the asker (REQ-32 BC-16, REQ-37). Every check is made here, before any
// adapter sees data, in the order a refusal is most useful: an executor enabled at all, the asker's
// `assistant.exec`, the door, the project's `compute` setting, the limits, the turn's caps, the
// inputs, the project's data policy on `report.exec`, and only then an adapter the setting admits
// and that can run it now.
// What comes back is data (frames and capped, scrubbed logs), stored with the request, and drawn by
// a block that is labelled computed. Both doors (the chat's forge_compute and Agent mode's REST)
// call `computeExecution` and answer alike.

import { randomUUID } from 'node:crypto';
import {
  type ComputeRequest,
  EXECUTION_DEFAULT_LIMITS,
  EXECUTION_LIMITS,
  EXECUTION_LOG_CAP_BYTES,
  EXECUTION_MAX_LIMITS,
  EXECUTION_TURN_CAPS,
  EXECUTION_TURN_WINDOW_MS,
  EXECUTOR_DATA_STAYS_WITH_TEAM,
  type ExecutionLimit,
  ExecutionLimitsSchema,
  ExecutionRequestSchema,
  type ExecutionResult,
  ExecutionResultSchema,
  type ExecutionScope,
  type Executor,
} from '@forge/contracts/report-executions';
import type { ReportFrame } from '@forge/contracts/report-queries';
import { scrubLogText, scrubSecretsDeep } from '@forge/observability';
import { dataPolicyOf, egressAt } from '../lib/data-egress.js';
import { RefusalError } from '../lib/refusal.js';
import { requireHeld } from '../permissions/index.js';
import { recordExecution, turnSpend } from './executions.js';
import {
  type ComputePolicy,
  executorPorts,
  refuseExecution,
  registeredExecutors,
} from './executors.js';
import { type ReportAsker, reportsPorts } from './ports.js';
import { readReportRun } from './runs.js';

/**
 * Which door asked, and the turn it counts against. A chat turn names its room and the runs its own
 * forge_report and forge_template calls returned; a REST caller has no turn, so its inputs and caps
 * run over its credential's last EXECUTION_TURN_WINDOW_MS.
 */
export type ComputeDoor =
  | { kind: 'chat'; conversationId: string; turnKey: string; turnRuns: ReadonlySet<string> }
  | { kind: 'rest'; turnKey: string };

/** One execution's answer: the result, the block source that draws it, and what it read. */
export interface ComputeAnswer extends ExecutionResult {
  source: { executionId: string };
  scriptFingerprint: string;
  inputs: string[];
  computed: true;
}

const WINDOW_MIN = EXECUTION_TURN_WINDOW_MS / 60_000;

// a turn's executions run one at a time in this process, so its caps are read against what it has
// already spent and not raced past by a parallel call
const turnQueue = new Map<string, Promise<unknown>>();

function oneAtATime<T>(turnKey: string, fn: () => Promise<T>): Promise<T> {
  const before = turnQueue.get(turnKey) ?? Promise.resolve();
  const run = before.then(fn, fn);
  const settled = run.catch(() => undefined);
  turnQueue.set(turnKey, settled);
  void settled.then(() => {
    if (turnQueue.get(turnKey) === settled) turnQueue.delete(turnKey);
  });
  return run;
}

/** The limits one execution runs under: the defaults, overridden by name; past a maximum is refused. */
export function executionLimits(asked: ComputeRequest['limits']): Record<ExecutionLimit, number> {
  const limits: Record<ExecutionLimit, number> = { ...EXECUTION_DEFAULT_LIMITS };
  for (const name of EXECUTION_LIMITS) {
    const given = asked?.[name];
    if (given !== undefined) limits[name] = given;
  }
  for (const name of EXECUTION_LIMITS) {
    if (limits[name] > EXECUTION_MAX_LIMITS[name]) {
      throw refuseExecution(
        'EXECUTION_LIMIT_REFUSED',
        `limits.${name} is ${limits[name]}, past the most one execution may ask for (${EXECUTION_MAX_LIMITS[name]}); ask for ${EXECUTION_MAX_LIMITS[name]} or less`,
        `/limits/${name}`,
      );
    }
  }
  const parsed = ExecutionLimitsSchema.safeParse(limits);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw refuseExecution(
      'EXECUTION_LIMIT_REFUSED',
      `limits.${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}; limits are { wallMs >= 1, cpu >= 0.1, memoryMb >= 16, outputBytes >= 1 }`,
      `/limits/${issue?.path.join('/') ?? ''}`,
    );
  }
  return parsed.data;
}

/** Refuses the call where the turn has spent what its caps allow, naming the cap and what is left. */
export function turnCapRefusal(
  spent: { calls: number; wallMs: number; outputBytes: number },
  limits: Record<ExecutionLimit, number>,
): RefusalError | null {
  const caps = EXECUTION_TURN_CAPS;
  if (spent.calls >= caps.calls) {
    return refuseExecution(
      'EXECUTION_TURN_CAP_REACHED',
      `this turn has run ${spent.calls} execution(s), its cap of ${caps.calls} calls; answer from what they returned`,
    );
  }
  const wallLeft = Math.max(0, caps.wallMs - spent.wallMs);
  if (limits.wallMs > wallLeft) {
    return refuseExecution(
      'EXECUTION_TURN_CAP_REACHED',
      `this turn has ${Math.floor(wallLeft)} ms of its ${caps.wallMs} ms wall-time cap left, and this execution asks for limits.wallMs ${limits.wallMs}; ask for ${Math.floor(wallLeft)} or less, or answer from what ran`,
      '/limits/wallMs',
    );
  }
  const bytesLeft = Math.max(0, caps.outputBytes - spent.outputBytes);
  if (limits.outputBytes > bytesLeft) {
    return refuseExecution(
      'EXECUTION_TURN_CAP_REACHED',
      `this turn has ${bytesLeft} bytes of its ${caps.outputBytes}-byte output cap left, and this execution asks for limits.outputBytes ${limits.outputBytes}; ask for ${bytesLeft} or less, or answer from what ran`,
      '/limits/outputBytes',
    );
  }
  return null;
}

/** Why the project's setting bars an adapter, or null where it admits it. */
function policyBar(adapter: Executor, policy: ComputePolicy): string | null {
  if (policy.zdrOnly === true && !adapter.zdrEligible) {
    return `${adapter.id} is not ZDR-eligible, and the project's compute.zdrOnly admits only one that is`;
  }
  if (policy.thirdParty !== true && !EXECUTOR_DATA_STAYS_WITH_TEAM.includes(adapter.dataLeavesTo)) {
    return `${adapter.id} sends the data to ${adapter.dataLeavesTo}, and the project's compute.thirdParty is ${policy.thirdParty === false ? 'false' : 'unset'}; a project admin admits a third-party sandbox with compute.thirdParty: true`;
  }
  return null;
}

/**
 * The first registered adapter the project's setting admits and that can take the computation now.
 * Where the setting admits none, `EXECUTION_NO_ADAPTER_ALLOWED`; where it admits some and none of
 * them can run it now, `EXECUTOR_UNAVAILABLE`. Either names why each adapter is out, and nothing
 * has been sent to any of them.
 */
async function admittedAdapter(
  adapters: readonly Executor[],
  policy: ComputePolicy,
  project: { id: string; language: ComputeRequest['language'] },
): Promise<Executor> {
  const barred: string[] = [];
  const unavailable: string[] = [];
  for (const adapter of adapters) {
    const bar = policyBar(adapter, policy);
    if (bar !== null) {
      barred.push(bar);
      continue;
    }
    const can = await adapter.availableFor({ ...project, compute: policy });
    if (can === true) return adapter;
    unavailable.push(`${adapter.id}: ${can.unavailable}`);
  }
  if (unavailable.length > 0) {
    throw refuseExecution(
      'EXECUTOR_UNAVAILABLE',
      `no sandbox can run this computation now, so nothing was sent anywhere: ${[...unavailable, ...barred].join('; ')}. Answer from a report query (forge_report) instead`,
    );
  }
  throw refuseExecution(
    'EXECUTION_NO_ADAPTER_ALLOWED',
    `no executor enabled on this deployment may run this project's computation: ${barred.join('; ')}. A request is never routed to a sandbox the project's setting does not admit`,
  );
}

/** The frames of the runs a computation reads, each read back as the asker and of this turn. */
async function inputFrames(
  runIds: readonly string[],
  args: { projectId: string; asker: ReportAsker; door: ComputeDoor; now: Date },
): Promise<{ ids: string[]; frames: ReportFrame[] }> {
  const ids = [...new Set(runIds)];
  const frames: ReportFrame[] = [];
  for (const [i, runId] of ids.entries()) {
    if (args.door.kind === 'chat' && !args.door.turnRuns.has(runId)) {
      throw refuseExecution(
        'EXECUTION_INPUT_REFUSED',
        `inputs.${i}: run ${runId} was not made by this turn; a computation reads only runs this turn's forge_report or forge_template returned, never a table or an older run. Run the query first`,
        `/inputs/${i}`,
      );
    }
    const run = await readReportRun({
      runId,
      userId: args.asker.userId,
      agency: args.asker.agency,
      projectId: args.projectId,
      now: args.now,
    });
    if (
      args.door.kind === 'rest' &&
      args.now.getTime() - Date.parse(run.asOf) > EXECUTION_TURN_WINDOW_MS
    ) {
      throw refuseExecution(
        'EXECUTION_INPUT_REFUSED',
        `inputs.${i}: run ${runId} was read at ${run.asOf}, more than ${WINDOW_MIN} minutes ago; a computation reads only runs made for it, so run the query again`,
        `/inputs/${i}`,
      );
    }
    frames.push(run.frame);
  }
  return { ids, frames };
}

const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** A log kept to EXECUTION_LOG_CAP_BYTES and scrubbed of secrets; a cut says how much was cut. */
function keptLog(text: string): string {
  const scrubbed = scrubLogText(text);
  const bytes = Buffer.from(scrubbed, 'utf8');
  if (bytes.length <= EXECUTION_LOG_CAP_BYTES) return scrubbed;
  const kept = bytes.subarray(0, EXECUTION_LOG_CAP_BYTES).toString('utf8').replace(/�+$/, '');
  return `${kept}\n[cut: ${bytes.length - EXECUTION_LOG_CAP_BYTES} more bytes]`;
}

/** Runs the adapter and holds its answer to the port's contract; a failure names the adapter. */
async function executeOn(
  adapter: Executor,
  request: ReturnType<typeof ExecutionRequestSchema.parse>,
  scope: ExecutionScope,
): Promise<ExecutionResult> {
  let raw: unknown;
  try {
    raw = await adapter.execute(request, scope);
  } catch (err) {
    throw refuseExecution(
      'EXECUTOR_FAILED',
      `the ${adapter.id} executor could not run the computation: ${scrubLogText(err instanceof Error ? err.message : String(err))}. Nothing ran; say so in the reply`,
    );
  }
  const parsed = ExecutionResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.adapter !== adapter.id) {
    const why = parsed.success
      ? `it named itself "${parsed.data.adapter}"`
      : parsed.error.issues
          .map((i) => `${i.path.join('.') || '(result)'}: ${i.message}`)
          .join('; ');
    throw refuseExecution(
      'EXECUTOR_FAILED',
      `the ${adapter.id} executor answered outside the port's contract (${why}); its answer is not kept or shown`,
    );
  }
  return parsed.data;
}

/**
 * Runs one computation for the asker through `door`, stores it, and answers its frames with the
 * block source that draws them. Refused by name, and nothing run, at the first check that fails.
 */
export async function computeExecution(args: {
  projectId: string;
  request: ComputeRequest;
  asker: ReportAsker;
  /** The token the asker came with, which bounds what the script may read as them; null for a session. */
  viaTokenId: string | null;
  door: ComputeDoor;
  now?: Date;
}): Promise<ComputeAnswer> {
  const adapters = registeredExecutors();
  const { projectId, request, asker, door } = args;
  requireHeld(asker.access, 'assistant.exec', 'running a computation in a sandbox');
  let conversationId: string | null = null;
  if (door.kind === 'chat') {
    const room = await reportsPorts().roomOf(door.conversationId, asker.userId);
    if (room.adapter !== 'web') {
      throw refuseExecution(
        'EXECUTION_DOOR_FORBIDDEN',
        `conversation ${door.conversationId} is a ${room.adapter} room, and an external chat door never runs a computation; answer from a report query instead`,
        '/conversationId',
      );
    }
    if (!room.projectIds.includes(projectId)) {
      throw refuseExecution(
        'EXECUTION_DOOR_FORBIDDEN',
        `conversation ${door.conversationId} is about ${room.projectIds.join(', ') || 'no project'}, not project ${projectId}`,
        '/projectId',
      );
    }
    conversationId = door.conversationId;
  }
  const policy = await executorPorts().computePolicyOf(projectId);
  if (policy?.enabled !== true) {
    throw refuseExecution(
      'EXECUTION_DISABLED',
      `project ${projectId} has not turned computation on (its project document's compute.enabled is ${policy === undefined ? 'unset' : 'false'}), so no script runs over its data; answer from a report query instead. A project admin turns it on with compute: { enabled: true }`,
    );
  }
  const limits = executionLimits(request.limits);
  return oneAtATime(door.turnKey, async () => {
    const now = args.now ?? new Date();
    const spent = await turnSpend(door.turnKey, new Date(now.getTime() - EXECUTION_TURN_WINDOW_MS));
    const capped = turnCapRefusal(spent, limits);
    if (capped) throw capped;
    const inputs = await inputFrames(request.inputs, { projectId, asker, door, now });
    const level = await dataPolicyOf(projectId);
    const egress = egressAt(
      level,
      'report.exec',
      inputs.frames,
      'the input snapshot of a computation',
    );
    if (!egress.ok) throw new RefusalError([egress.refusal], egress.refusal.code);
    const adapter = await admittedAdapter(adapters, policy, {
      id: projectId,
      language: request.language,
    });
    const result = await executeOn(
      adapter,
      ExecutionRequestSchema.parse({
        language: request.language,
        script: request.script,
        inputs: scrubSecretsDeep(egress.value),
        limits,
      }),
      { projectId, conversationId, askedBy: asker.userId, viaTokenId: args.viaTokenId },
    );
    const logs = { stdout: keptLog(result.logs.stdout), stderr: keptLog(result.logs.stderr) };
    let frames = scrubSecretsDeep(result.frames);
    let stopped = result.stopped ?? null;
    let error = result.error ?? null;
    const frameBytes = bytesOf(frames);
    if (frameBytes > limits.outputBytes) {
      frames = [];
      stopped = 'outputBytes';
      error = {
        name: 'OutputLimit',
        message: `the frames came to ${frameBytes} bytes, past this execution's limits.outputBytes of ${limits.outputBytes}; none of them is kept or drawn`,
      };
    }
    const record = await recordExecution({
      id: randomUUID(),
      projectId,
      conversationId,
      turnKey: door.turnKey,
      askedBy: asker.userId,
      askedAgency: asker.agency,
      adapter: adapter.id,
      adapterExecutionId: result.executionId,
      language: request.language,
      script: request.script,
      inputRunIds: inputs.ids,
      limits,
      exit: result.exit,
      stopped,
      durationMs: result.durationMs,
      outputBytes: bytesOf(frames) + bytesOf(logs),
      frames,
      logs,
      error,
      reads: result.reads,
      createdAt: now,
    });
    return {
      executionId: record.executionId,
      adapter: record.adapter,
      exit: record.exit,
      durationMs: record.durationMs,
      ...(record.stopped ? { stopped: record.stopped } : {}),
      frames: record.frames,
      logs: record.logs,
      ...(record.error ? { error: record.error } : {}),
      reads: record.reads,
      source: { executionId: record.executionId },
      scriptFingerprint: record.scriptFingerprint,
      inputs: inputs.ids,
      computed: true,
    };
  });
}
