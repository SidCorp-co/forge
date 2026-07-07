// Runs inside a dedicated worker thread spawned by executor.ts. This file must
// stay a leaf module with no imports from the rest of core: the sandboxed user
// script only ever sees what this file explicitly attaches to the vm context,
// so anything imported here is implicitly "trusted" and reachable via a ctx.*
// capability — never widen this file's own imports without widening the threat
// model on purpose.
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

interface WorkerData {
  script: string;
  params: Record<string, unknown>;
}

interface NotifyPayload {
  title: string;
  body?: string;
  severity?: string;
}

interface WorkerResultMessage {
  ok: boolean;
  output: string;
  error?: string;
  notifications: NotifyPayload[];
}

const HTTP_TIMEOUT_MS = 25_000;

const output: string[] = [];
const notifications: NotifyPayload[] = [];

function formatLogArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function log(...args: unknown[]): void {
  output.push(args.map(formatLogArg).join(' '));
}

function jsonCloneReadOnly(value: unknown): unknown {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    cloned = {};
  }
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sanitizeFetchInit(init: unknown): Pick<RequestInit, 'method' | 'headers' | 'body'> {
  if (!init || typeof init !== 'object') return {};
  const { method, headers, body } = init as Record<string, unknown>;
  const result: Pick<RequestInit, 'method' | 'headers' | 'body'> = {};
  if (typeof method === 'string') result.method = method;
  if (headers !== undefined) result.headers = headers as NonNullable<RequestInit['headers']>;
  if (body !== undefined) result.body = body as NonNullable<RequestInit['body']>;
  return result;
}

async function sandboxedFetch(url: unknown, init?: unknown): Promise<Response> {
  const parsed = new URL(String(url));
  if (parsed.protocol !== 'https:') {
    throw new Error(`ctx.http.fetch only allows https:// URLs, got "${parsed.protocol}"`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(parsed, { ...sanitizeFetchInit(init), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function notify(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    throw new Error('ctx.notify requires a { title: string, body?, severity? } payload');
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.title !== 'string' || p.title.trim() === '') {
    throw new Error('ctx.notify requires a { title: string, body?, severity? } payload');
  }
  const entry: NotifyPayload = { title: p.title };
  if (typeof p.body === 'string') entry.body = p.body;
  if (typeof p.severity === 'string') entry.severity = p.severity;
  notifications.push(entry);
}

async function run(): Promise<void> {
  const { script, params } = workerData as WorkerData;

  const sandbox = {
    console: { log, warn: log, error: log },
    ctx: {
      log,
      params: jsonCloneReadOnly(params),
      notify,
      http: { fetch: sandboxedFetch },
    },
  };

  // codeGeneration:{strings:false} blocks eval()/new Function(<string>) escape
  // attempts from within the sandboxed script.
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const compiled = new vm.Script(`(async () => {\n${script}\n})()`, {
    filename: 'schedule-script.js',
  });
  await compiled.runInContext(context);
}

run()
  .then(() => {
    const result: WorkerResultMessage = { ok: true, output: output.join('\n'), notifications };
    parentPort?.postMessage(result);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const result: WorkerResultMessage = {
      ok: false,
      output: output.join('\n'),
      error: message,
      notifications,
    };
    parentPort?.postMessage(result);
  });
