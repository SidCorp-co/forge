// `runner-sandbox`, the reports Executor port's adapter on the team's own runner (REQ-32 BC-14):
// core picks a box bound to the project that declares it can confine a script, hands it the
// script, the scrubbed input frames and the limits over the box's socket, and reads the answer
// back on the device route (the ask-a-box exchange the checkout reads use, `box-ask.ts`). The box
// only runs it (ADR 0009); which box, what the limits are and what its output means are decided
// here. Where no box can run it, the computation is refused naming each box's reason before any
// frame is sent.

import {
  EXECUTION_LANGUAGES,
  EXECUTION_LIMITS,
  EXECUTION_OUTPUT_FILES,
  EXECUTOR_DATA_STAYS_ON_TEAM_RUNNER,
  type ExecutionLanguage,
  type ExecutionLimit,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  type ExecutorAvailability,
  framesFromOutput,
} from '@forge/contracts/report-executions';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { boxAsks } from './box-ask.js';
import { runnersPorts } from './ports.js';

export const RUNNER_SANDBOX_ID = 'runner-sandbox';

/** What a box's heartbeat declares: that it confines a script, which interpreters, or why not. */
export const COMPUTE_SANDBOX_CAPABILITY = 'computeSandbox';
const LANGUAGES_CAPABILITY = 'computeSandboxLanguages';
const UNAVAILABLE_CAPABILITY = 'computeSandboxUnavailable';

/** How long past the script's own wall limit core waits for the box: its start, I/O and the post. */
const ANSWER_OVERHEAD_MS = 30_000;

/** The box's answer body, as the device route takes it; checked again here before it is believed. */
export const ComputeRunAnswerSchema = z
  .object({
    projectId: z.uuid(),
    exit: z.number().int().optional(),
    durationMs: z.number().min(0).optional(),
    stopped: z.enum(EXECUTION_LIMITS).optional(),
    output: z
      .object({
        file: z.enum(EXECUTION_OUTPUT_FILES),
        text: z.string().max(5_000_000),
      })
      .strict()
      .optional(),
    stdout: z.string().max(262_144).optional(),
    stderr: z.string().max(262_144).optional(),
    error: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type ComputeRunAnswer = z.infer<typeof ComputeRunAnswerSchema>;

/** One box bound to the project, as its runner row and its last heartbeat describe it. */
export interface SandboxBox {
  deviceId: string;
  runnerId: string;
  name: string;
  runnerStatus: string;
  disabled: boolean;
  capabilities: Record<string, unknown>;
}

export interface ComputeSandboxDeps {
  boxesOf(projectId: string): Promise<SandboxBox[]>;
  listening(deviceId: string): boolean;
  send(deviceId: string, envelope: { event: string; data: unknown }): number;
  overheadMs: number;
}

async function boxesOf(projectId: string): Promise<SandboxBox[]> {
  const rows = await db
    .select({
      deviceId: runners.deviceId,
      runnerId: runners.id,
      runnerStatus: runners.status,
      name: devices.name,
      disabledAt: devices.disabledAt,
      capabilities: devices.capabilities,
    })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(eq(runners.projectId, projectId))
    .orderBy(asc(runners.createdAt));
  const seen = new Set<string>();
  const boxes: SandboxBox[] = [];
  for (const r of rows) {
    if (seen.has(r.deviceId)) continue;
    seen.add(r.deviceId);
    boxes.push({
      deviceId: r.deviceId,
      runnerId: r.runnerId,
      name: r.name,
      runnerStatus: r.runnerStatus,
      disabled: r.disabledAt !== null,
      capabilities: (r.capabilities ?? {}) as Record<string, unknown>,
    });
  }
  return boxes;
}

function defaultDeps(): ComputeSandboxDeps {
  return {
    boxesOf,
    listening: (deviceId) => runnersPorts().boxIsListening(deviceId),
    send: (deviceId, envelope) => runnersPorts().sendToBoxNow(deviceId, envelope),
    overheadMs: ANSWER_OVERHEAD_MS,
  };
}

/** Why `box` cannot run a `language` script now, or null where it can. */
export function boxBar(
  box: SandboxBox,
  language: ExecutionLanguage,
  listening: boolean,
): string | null {
  const named = `the runner box ${box.name}`;
  if (box.disabled) return `${named} is turned off`;
  if (box.runnerStatus === 'disabled' || box.runnerStatus === 'draining') {
    return `${named} is ${box.runnerStatus} for this project`;
  }
  if (!listening) return `${named} is not connected now`;
  const caps = box.capabilities;
  if (caps[COMPUTE_SANDBOX_CAPABILITY] !== true) {
    const said = caps[UNAVAILABLE_CAPABILITY];
    return typeof said === 'string' && said.trim()
      ? `${named} cannot confine a script: ${said.trim()}`
      : `${named} runs a forge-runner that predates the compute sandbox; update it on the box (\`forge-runner update\`)`;
  }
  const languages = caps[LANGUAGES_CAPABILITY];
  if (!Array.isArray(languages) || !languages.includes(language)) {
    return `${named} has no ${language} interpreter its sandbox can run (it runs ${
      Array.isArray(languages) && languages.length > 0 ? languages.join(', ') : 'none'
    })`;
  }
  return null;
}

type BoxPick = { ok: true; box: SandboxBox } | { ok: false; why: string };

/** The first bound box that can run the script now, or every box's reason it cannot. */
async function pickBox(
  projectId: string,
  language: ExecutionLanguage,
  deps: ComputeSandboxDeps,
): Promise<BoxPick> {
  const boxes = await deps.boxesOf(projectId);
  if (boxes.length === 0) {
    return {
      ok: false,
      why: 'no runner is paired with this project, so no box of the team can run a computation; pair one (`forge-runner setup`) on a Linux box with bubblewrap',
    };
  }
  const bars: string[] = [];
  for (const box of boxes) {
    const bar = boxBar(box, language, deps.listening(box.deviceId));
    if (bar === null) return { ok: true, box };
    bars.push(bar);
  }
  return { ok: false, why: bars.join('; ') };
}

/** What a run settles to: the box's answer, or why none came. */
type Settled = { ok: true; answer: ComputeRunAnswer } | { ok: false; why: string };

interface Asked {
  boxName: string;
  settle(read: Settled): void;
}

const asks = boxAsks<Asked>();

const LIMIT_ERRORS: Record<ExecutionLimit, string> = {
  wallMs: 'WallLimit',
  cpu: 'CpuLimit',
  memoryMb: 'MemoryLimit',
  outputBytes: 'OutputLimit',
};

/** The box's answer as the port's result: the output read as frames here, never on the box. */
export function resultOfAnswer(
  executionId: string,
  answer: ComputeRunAnswer,
  request: ExecutionRequest,
): ExecutionResult {
  const base = {
    executionId,
    adapter: RUNNER_SANDBOX_ID,
    exit: answer.exit ?? -1,
    durationMs: answer.durationMs ?? 0,
    logs: { stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' },
  };
  if (answer.stopped) {
    return {
      ...base,
      stopped: answer.stopped,
      frames: [],
      error: {
        name: LIMIT_ERRORS[answer.stopped],
        message: `the script ran past limits.${answer.stopped} of ${request.limits[answer.stopped]} and was stopped`,
      },
    };
  }
  if (!answer.output) {
    return {
      ...base,
      frames: [],
      error: {
        name: 'NoFrames',
        message: `the script wrote neither ${EXECUTION_OUTPUT_FILES.join(' nor ')}, so no frame came back; its output is in the logs`,
      },
    };
  }
  const read = framesFromOutput(answer.output.file, answer.output.text);
  return read.ok
    ? { ...base, frames: read.frames }
    : { ...base, frames: [], error: { name: 'FramesUnreadable', message: read.why } };
}

/** Hand the script to `box` and wait for its answer, at most the wall limit plus the overhead. */
function ask(
  box: SandboxBox,
  projectId: string,
  request: ExecutionRequest,
  deps: ComputeSandboxDeps,
): Promise<{ requestId: string; settled: Settled }> {
  const timeoutMs = request.limits.wallMs + deps.overheadMs;
  return new Promise((resolve) => {
    let requestId = '';
    const settle = (settled: Settled) => resolve({ requestId, settled });
    asks.ask(
      { boxName: box.name, settle },
      {
        deviceId: box.deviceId,
        projectId,
        event: 'compute.run',
        data: {
          projectId,
          runnerId: box.runnerId,
          language: request.language,
          script: request.script,
          inputs: request.inputs,
          limits: request.limits,
        },
        timeoutMs,
        send: (deviceId, envelope) => {
          requestId = String((envelope.data as { requestId?: unknown }).requestId ?? '');
          return deps.send(deviceId, envelope);
        },
        settle,
        unanswered: (): Settled => ({
          ok: false,
          why: `the runner box ${box.name} did not answer within ${Math.round(timeoutMs / 1000)}s; whether the script ran there is not known`,
        }),
        disconnected: (): Settled => ({
          ok: false,
          why: `the runner box ${box.name} disconnected before the script was handed over, so nothing was sent`,
        }),
      },
    );
  });
}

/** Settle the run `requestId` asked of `deviceId`. An answer nobody asked that box for is refused. */
export function answerComputeRun(
  deviceId: string,
  requestId: string,
  answer: ComputeRunAnswer,
):
  | { ok: true }
  | { ok: false; code: 'COMPUTE_RUN_NOT_ASKED' | 'COMPUTE_RUN_MALFORMED'; detail?: string } {
  const entry = asks.take(requestId, deviceId, answer.projectId);
  if (!entry) return { ok: false, code: 'COMPUTE_RUN_NOT_ASKED' };
  if (answer.error !== undefined) {
    entry.settle({
      ok: false,
      why: `the runner box ${entry.boxName} could not run it: ${answer.error}`,
    });
    return { ok: true };
  }
  const missing = (['exit', 'durationMs', 'stdout', 'stderr'] as const).filter(
    (k) => answer[k] === undefined,
  );
  if (missing.length > 0) {
    const why = `it named no ${missing.join(', ')}, and an answer without an error names them all`;
    entry.settle({
      ok: false,
      why: `the runner box ${entry.boxName} answered outside the compute.run contract: ${why}`,
    });
    return { ok: false, code: 'COMPUTE_RUN_MALFORMED', detail: why };
  }
  entry.settle({ ok: true, answer });
  return { ok: true };
}

/** The adapter, registered by the process entry on every deployment: whether it runs is the boxes'. */
export function createRunnerSandboxExecutor(over: Partial<ComputeSandboxDeps> = {}): Executor {
  const deps: ComputeSandboxDeps = { ...defaultDeps(), ...over };
  return {
    id: RUNNER_SANDBOX_ID,
    mode: 'invoked',
    isolation:
      "bubblewrap on a Linux runner the team paired with the project: no network, a read-only system with the box's home, temp and runtime trees emptied, a throwaway working directory, and caps on wall time, address space, CPU time and file size",
    network: 'none',
    dataLeavesTo: EXECUTOR_DATA_STAYS_ON_TEAM_RUNNER,
    // nothing leaves the team: the box keeps no copy past the run
    zdrEligible: true,

    async availableFor(project): Promise<ExecutorAvailability> {
      if (!EXECUTION_LANGUAGES.includes(project.language)) {
        return { unavailable: `${project.language} is not a language the sandbox runs` };
      }
      const pick = await pickBox(project.id, project.language, deps);
      return pick.ok ? true : { unavailable: pick.why };
    },

    async execute(request, scope): Promise<ExecutionResult> {
      const pick = await pickBox(scope.projectId, request.language, deps);
      if (!pick.ok) throw new Error(`no box can run it now, so nothing was sent: ${pick.why}`);
      const { requestId, settled } = await ask(pick.box, scope.projectId, request, deps);
      if (!settled.ok) throw new Error(settled.why);
      return resultOfAnswer(requestId, settled.answer, request);
    },
  };
}
