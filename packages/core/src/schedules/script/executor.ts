import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export const SCRIPT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 16_000;

export interface ScriptNotifyPayload {
  title: string;
  body?: string;
  severity?: string;
}

export interface RunScheduleScriptInput {
  script: string;
  params?: Record<string, unknown> | null;
  timeoutMs?: number;
}

export type RunScheduleScriptResult =
  | { status: 'success'; output: string; notifications: ScriptNotifyPayload[] }
  | { status: 'failed'; output: string; error: string; notifications: ScriptNotifyPayload[] };

interface WorkerResultMessage {
  ok: boolean;
  output: string;
  error?: string;
  notifications: ScriptNotifyPayload[];
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

// The worker's module graph is created fresh by Node and does not go through
// this file's own loader — under `tsx watch` (dev) or vitest (test) the entry
// is still raw TypeScript, so we explicitly load it via tsx's loader; the
// built dist/ output points at the already-compiled .js and needs no loader.
function resolveWorkerEntry(): { path: string; execArgv: string[] } {
  const selfPath = fileURLToPath(import.meta.url);
  if (selfPath.endsWith('.ts')) {
    return {
      path: selfPath.replace(/executor\.ts$/, 'worker-entry.ts'),
      execArgv: ['--import', 'tsx'],
    };
  }
  return { path: selfPath.replace(/executor\.js$/, 'worker-entry.js'), execArgv: [] };
}

export async function runScheduleScript(
  input: RunScheduleScriptInput,
): Promise<RunScheduleScriptResult> {
  const timeoutMs = input.timeoutMs ?? SCRIPT_TIMEOUT_MS;
  const entry = resolveWorkerEntry();

  const worker = new Worker(entry.path, {
    workerData: { script: input.script, params: input.params ?? {} },
    execArgv: entry.execArgv,
  });

  return new Promise<RunScheduleScriptResult>((resolve) => {
    let settled = false;

    const finish = (result: RunScheduleScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: 'failed', output: '', error: 'timeout', notifications: [] });
    }, timeoutMs);

    worker.once('message', (msg: WorkerResultMessage) => {
      const output = truncate(msg.output ?? '');
      if (msg.ok) {
        finish({ status: 'success', output, notifications: msg.notifications ?? [] });
      } else {
        finish({
          status: 'failed',
          output,
          error: msg.error ?? 'unknown error',
          notifications: msg.notifications ?? [],
        });
      }
    });

    worker.once('error', (err: Error) => {
      finish({ status: 'failed', output: '', error: err.message, notifications: [] });
    });

    // A worker that exits without ever posting a message (e.g. terminated
    // externally) must still resolve — never leave the caller pending.
    worker.once('exit', (code: number) => {
      finish({
        status: 'failed',
        output: '',
        error: `worker exited with code ${code} before reporting a result`,
        notifications: [],
      });
    });
  });
}
