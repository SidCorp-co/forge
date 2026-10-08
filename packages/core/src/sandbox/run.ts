// The host side of the script sandbox (REQ-37 BC-1): one run of one script in a fresh worker that
// holds a QuickJS isolate (`worker-entry.ts`). Schedule scripts and the chat's computations both run
// here. The script's only capabilities are ctx.log, ctx.params, ctx.inputs, ctx.notify and
// ctx.forge.get; a ctx.forge.get is answered by the `read` the caller hands in, in this thread, so
// whatever it holds (the owner's token among it) never enters the worker or the isolate.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  ReadAnswer,
  ScriptNotice,
  ScriptStop,
  WorkerMessage,
  WorkerStart,
} from './protocol.js';

export type { ScriptNotice, ScriptStop };

/** What one read answers the script: its JSON body, or why it failed, which the script sees thrown. */
export type ReadOutcome =
  | { ok: true; body: unknown }
  | { ok: false; name: string; code?: string; status?: number; message: string };

/** Answers a script's ctx.forge.get; given the method and path exactly as the script named them. */
export type ScriptReader = (method: string, path: string) => Promise<ReadOutcome>;

export interface ScriptLimits {
  wallMs: number;
  memoryMb: number;
  /** The most characters of ctx.log output kept. */
  logChars: number;
}

export interface RunScriptInput {
  script: string;
  projectId: string;
  params?: Record<string, unknown> | null;
  /** The frames a computation reads, handed in as ctx.inputs. */
  inputs?: readonly unknown[];
  limits: ScriptLimits;
  read: ScriptReader;
}

export interface ScriptRunResult {
  status: 'success' | 'failed';
  /** What the script returned, read back from JSON; null where it returned nothing or failed. */
  value: unknown;
  output: string;
  notifications: ScriptNotice[];
  error: { name: string; message: string } | null;
  /** The cap that stopped it, when one did; its error names it. */
  stopped: ScriptStop | null;
  durationMs: number;
}

/** The stack the isolate may use; deep recursion past it is a RangeError inside the script. */
const STACK_BYTES = 512 * 1024;
/** The most ctx.notify calls one run keeps. */
const NOTIFY_CAP = 50;
/** How long past the wall cap the host waits for the isolate to stop itself before it ends the thread. */
const KILL_GRACE_MS = 2_000;
/** The worker's own JavaScript heap; the isolate's memory is WebAssembly memory, capped by memoryMb. */
const WORKER_HEAP_MB = 64;

// The worker's module graph is created fresh by Node and does not go through this file's own
// loader: under `tsx watch` (dev) or vitest (test) the entry is still TypeScript, so the worker
// registers tsx's loader itself before importing it (no startup module on its command line); the
// built dist/ output points at the compiled .js and needs none.
function workerEntry(): { code: string | URL; eval: boolean } {
  const selfPath = fileURLToPath(import.meta.url);
  if (selfPath.endsWith('.ts')) {
    const entry = pathToFileURL(selfPath.replace(/run\.ts$/, 'worker-entry.ts')).href;
    return {
      code: `import('tsx/esm/api').then((tsx) => { tsx.register(); return import(${JSON.stringify(entry)}); });`,
      eval: true,
    };
  }
  return { code: pathToFileURL(selfPath.replace(/run\.js$/, 'worker-entry.js')), eval: false };
}

function readValue(json: string | null): { ok: true; value: unknown } | { ok: false; why: string } {
  if (json === null) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false, why: 'the script returned a value that is not JSON' };
  }
}

function envelopeOf(outcome: ReadOutcome): string {
  try {
    return JSON.stringify(outcome);
  } catch {
    return JSON.stringify({
      ok: false,
      name: 'ForgeReadFailed',
      message: 'the read answered a body that is not JSON',
    });
  }
}

export async function runScript(input: RunScriptInput): Promise<ScriptRunResult> {
  const started = Date.now();
  const deadline = started + input.limits.wallMs;
  const entry = workerEntry();
  const start: WorkerStart = {
    script: input.script,
    paramsJson: JSON.stringify(input.params ?? {}),
    inputsJson: JSON.stringify(input.inputs ?? []),
    projectId: input.projectId,
    deadline,
    wallMs: input.limits.wallMs,
    memoryMb: input.limits.memoryMb,
    stackBytes: STACK_BYTES,
    logChars: input.limits.logChars,
    notifyCap: NOTIFY_CAP,
  };
  const worker = new Worker(entry.code, {
    eval: entry.eval,
    workerData: start,
    // the worker gets an empty environment: nothing of this process's env is copied into it
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  });

  return new Promise<ScriptRunResult>((resolve) => {
    let settled = false;
    const finish = (r: Omit<ScriptRunResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve({ ...r, durationMs: Date.now() - started });
    };
    const failed = (
      error: { name: string; message: string },
      stopped: ScriptStop | null = null,
    ): Omit<ScriptRunResult, 'durationMs'> => ({
      status: 'failed',
      value: null,
      output: '',
      notifications: [],
      error,
      stopped,
    });

    const timer = setTimeout(() => {
      finish(
        failed(
          {
            name: 'WallTimeLimit',
            message: `the script ran past its wall-time cap of ${input.limits.wallMs} ms (wallMs) and was stopped`,
          },
          'wallMs',
        ),
      );
    }, input.limits.wallMs + KILL_GRACE_MS);

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'read') {
        void input
          .read(msg.method, msg.path)
          .catch(
            (err: unknown): ReadOutcome => ({
              ok: false,
              name: 'ForgeReadFailed',
              message: `the read could not be made: ${err instanceof Error ? err.message : String(err)}`,
            }),
          )
          .then((outcome) => {
            if (settled) return;
            const answer: ReadAnswer = {
              type: 'read-answer',
              id: msg.id,
              envelope: envelopeOf(outcome),
            };
            worker.postMessage(answer);
          });
        return;
      }
      const value = readValue(msg.valueJson);
      if (msg.ok && !value.ok) {
        finish({
          ...failed({ name: 'ScriptResultInvalid', message: value.why }),
          output: msg.output,
          notifications: msg.notifications,
        });
        return;
      }
      finish({
        status: msg.ok ? 'success' : 'failed',
        value: value.ok ? value.value : null,
        output: msg.output,
        notifications: msg.notifications,
        error: msg.error,
        stopped: msg.stopped,
      });
    });

    worker.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        finish(
          failed(
            {
              name: 'MemoryLimit',
              message: `the script's worker ran out of its ${WORKER_HEAP_MB} MB heap (memoryMb) and was stopped`,
            },
            'memoryMb',
          ),
        );
        return;
      }
      finish(failed({ name: 'SandboxError', message: err.message }));
    });

    // a worker that exits without a result (terminated from outside) still resolves the run
    worker.once('exit', (code: number) => {
      finish(
        failed({
          name: 'SandboxError',
          message: `the sandbox worker exited with code ${code} before reporting a result`,
        }),
      );
    });
  });
}
