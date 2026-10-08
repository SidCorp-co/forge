// Runs inside a dedicated worker thread spawned by run.ts, and holds the isolate: QuickJS compiled to
// WebAssembly. The script runs inside that isolate, never in this thread's own JavaScript engine, so
// no object of this thread is ever reachable from it: the isolate's globals are its own, and the only
// way out is the three host functions below, each taking and answering strings. A memory limit, an
// interrupt handler at the wall cap and a stack limit bound the isolate; the host terminates this
// thread at the wall cap as well.
//
// The memory limit is the WebAssembly memory's own maximum, so an allocation past it fails inside the
// engine as "out of memory". QuickJS's malloc limit (setMemoryLimit) is not used: in this build
// malloc_usable_size is unavailable, so it counts no bytes, and a 32 MB limit let 100 MB through
// (measured on quickjs-emscripten 0.32.0, 2026-10-09).
//
// This file stays a leaf: it imports the engine and the message types and nothing else from core.

import { parentPort, workerData } from 'node:worker_threads';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  type CustomizeVariantOptions,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import type { ReadAnswer, ScriptNotice, ScriptStop, WorkerDone, WorkerStart } from './protocol.js';

// core's TypeScript libs do not declare WebAssembly.Memory, which Node has; its type is the engine's option
const WasmMemory = (
  globalThis as unknown as {
    WebAssembly: {
      Memory: new (d: {
        initial: number;
        maximum: number;
      }) => NonNullable<CustomizeVariantOptions['wasmMemory']>;
    };
  }
).WebAssembly.Memory;

const MB = 1024 * 1024;
const WASM_PAGE = 64 * 1024;
/** The pages the engine's module declares as its least memory: 16 MB, the contract's least memoryMb. */
const WASM_MIN_PAGES = 256;

const start = workerData as WorkerStart;
const port = parentPort;
if (!port) throw new Error('sandbox worker: started without a parent port');

let logLength = 0;
let logCut = false;
const output: string[] = [];
const notifications: ScriptNotice[] = [];

function keepLog(line: string): void {
  if (logCut) return;
  if (logLength + line.length > start.logChars) {
    output.push(
      `${line.slice(0, Math.max(0, start.logChars - logLength))}\n…[log cut at ${start.logChars} characters]`,
    );
    logCut = true;
    return;
  }
  output.push(line);
  logLength += line.length + 1;
}

/** What a ctx.notify argument was, as its refusal names it. */
function givenOf(v: unknown): string {
  if (v === null || v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return v.trim() === '' ? 'an empty string' : 'a string';
  return `a ${typeof v}`;
}

function notice(json: string): string | null {
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    p = null;
  }
  const r = p as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    return `ctx.notify requires a { title: string, body?, severity? } payload, and was given ${givenOf(p)}; write ctx.notify({ title: ${typeof p === 'string' ? JSON.stringify(p.slice(0, 60)) : "'…'"} })`;
  }
  if (typeof r.title !== 'string' || r.title.trim() === '') {
    return `ctx.notify requires a { title: string, body?, severity? } payload, and its title was ${givenOf(r.title)}`;
  }
  if (notifications.length >= start.notifyCap) {
    return `ctx.notify was called more than ${start.notifyCap} times in one run, its cap; the rest are not sent`;
  }
  const entry: ScriptNotice = { title: r.title };
  if (typeof r.body === 'string') entry.body = r.body;
  if (typeof r.severity === 'string') entry.severity = r.severity;
  notifications.push(entry);
  return null;
}

// The script's ctx, built inside the isolate out of the three host functions. Everything a script
// sees is the isolate's own; params and inputs arrive as JSON text and are frozen there.
function preludeSource(): string {
  return `(() => {
"use strict";
const host = globalThis.__host;
delete globalThis.__host;
const fmt = (v) => {
  if (typeof v === "string") return v;
  try { const j = JSON.stringify(v); return j === undefined ? String(v) : j; } catch { return String(v); }
};
const freeze = (v) => {
  if (v && typeof v === "object") { for (const c of Object.values(v)) freeze(c); Object.freeze(v); }
  return v;
};
const log = (...args) => { host.log(args.map(fmt).join(" ")); };
const read = (method, path) =>
  host.read(String(method), String(path)).then((text) => {
    const r = JSON.parse(text);
    if (r.ok) return r.body;
    const e = new Error(r.message);
    e.name = r.name;
    if (r.code !== undefined) e.code = r.code;
    if (r.status !== undefined) e.status = r.status;
    throw e;
  });
const refusedFetch = () => {
  throw new Error("ctx.http.fetch is refused: a script reaches no network. Read Forge with ctx.forge.get(path); use ctx.log and ctx.notify.");
};
globalThis.ctx = Object.freeze({
  log,
  params: freeze(JSON.parse(${JSON.stringify(start.paramsJson)})),
  inputs: freeze(JSON.parse(${JSON.stringify(start.inputsJson)})),
  projectId: ${JSON.stringify(start.projectId)},
  notify: (payload) => { host.notify(JSON.stringify(payload === undefined ? null : payload)); },
  http: Object.freeze({ fetch: refusedFetch }),
  forge: Object.freeze({
    get: (path, init) => read(init && init.method !== undefined ? init.method : "GET", path),
    post: (path) => read("POST", path),
    put: (path) => read("PUT", path),
    patch: (path) => read("PATCH", path),
    delete: (path) => read("DELETE", path),
  }),
});
globalThis.console = Object.freeze({ log, info: log, warn: log, error: log });
})();`;
}

function wrapped(script: string): string {
  return `(async () => {\n${script}\n})().then((v) => (v === undefined ? null : JSON.stringify(v)))`;
}

function finish(done: Omit<WorkerDone, 'type' | 'output' | 'notifications'>): void {
  const message: WorkerDone = { type: 'done', output: output.join('\n'), notifications, ...done };
  port?.postMessage(message);
}

function stopOf(message: string): ScriptStop | null {
  if (Date.now() > start.deadline || /\binterrupted\b/.test(message)) return 'wallMs';
  if (/out of memory/i.test(message)) return 'memoryMb';
  return null;
}

function capError(stop: ScriptStop, message: string): { name: string; message: string } {
  return stop === 'wallMs'
    ? {
        name: 'WallTimeLimit',
        message: `the script ran past its wall-time cap of ${start.wallMs} ms (wallMs) and was stopped`,
      }
    : {
        name: 'MemoryLimit',
        message: `the script used more than its memory cap of ${start.memoryMb} MB (memoryMb) and was stopped (${message})`,
      };
}

function errorOf(vm: QuickJSContext, handle: QuickJSHandle): { name: string; message: string } {
  try {
    const dumped = vm.dump(handle) as unknown;
    if (dumped && typeof dumped === 'object') {
      const d = dumped as { name?: unknown; message?: unknown };
      return { name: String(d.name ?? 'Error'), message: String(d.message ?? '') };
    }
    return { name: 'Error', message: String(dumped) };
  } catch {
    return { name: 'Error', message: 'the script threw a value that could not be read' };
  } finally {
    handle.dispose();
  }
}

function failWith(err: { name: string; message: string }): void {
  const stop = stopOf(`${err.name}: ${err.message}`);
  finish({
    ok: false,
    valueJson: null,
    error: stop ? capError(stop, err.message) : err,
    stopped: stop,
  });
}

async function run(): Promise<void> {
  const maxPages = Math.max(WASM_MIN_PAGES, Math.floor((start.memoryMb * MB) / WASM_PAGE));
  const wasmMemory = new WasmMemory({ initial: WASM_MIN_PAGES, maximum: maxPages });
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory }));
  const runtime = QuickJS.newRuntime();
  runtime.setMaxStackSize(start.stackBytes);
  runtime.setInterruptHandler(() => Date.now() > start.deadline);
  const vm = runtime.newContext();

  const pending = new Map<number, QuickJSDeferredPromise>();
  let nextId = 0;
  let wake: (() => void) | null = null;

  port?.on('message', (msg: ReadAnswer) => {
    if (msg?.type !== 'read-answer') return;
    const deferred = pending.get(msg.id);
    if (!deferred) return;
    pending.delete(msg.id);
    const text = vm.newString(msg.envelope);
    deferred.resolve(text);
    text.dispose();
    deferred.dispose();
    wake?.();
  });

  const host = vm.newObject();
  const stringArg = (h: QuickJSHandle | undefined): string | null =>
    h !== undefined && vm.typeof(h) === 'string' ? vm.getString(h) : null;
  vm.newFunction('log', (line) => {
    keepLog(stringArg(line) ?? '');
  }).consume((fn) => vm.setProp(host, 'log', fn));
  vm.newFunction('notify', (json) => {
    const refused = notice(stringArg(json) ?? 'null');
    if (refused) return { error: vm.newError(refused) };
  }).consume((fn) => vm.setProp(host, 'notify', fn));
  vm.newFunction('read', (method, path) => {
    const deferred = vm.newPromise();
    const id = nextId++;
    pending.set(id, deferred);
    port?.postMessage({
      type: 'read',
      id,
      method: stringArg(method) ?? '',
      path: stringArg(path) ?? '',
    });
    return deferred.handle;
  }).consume((fn) => vm.setProp(host, 'read', fn));
  vm.setProp(vm.global, '__host', host);
  host.dispose();

  const prelude = vm.evalCode(preludeSource(), 'sandbox-prelude.js');
  if (prelude.error) {
    const err = errorOf(vm, prelude.error);
    throw new Error(`sandbox prelude failed: ${err.name}: ${err.message}`);
  }
  prelude.value.dispose();

  const evaluated = vm.evalCode(wrapped(start.script), 'script.js');
  if (evaluated.error) {
    failWith(errorOf(vm, evaluated.error));
    return;
  }
  const promise = evaluated.value;

  for (;;) {
    const jobs = runtime.executePendingJobs(-1);
    if (jobs.error) {
      failWith(errorOf(vm, jobs.error));
      return;
    }
    const state = vm.getPromiseState(promise);
    if (state.type === 'fulfilled') {
      const valueJson = vm.typeof(state.value) === 'string' ? vm.getString(state.value) : null;
      state.value.dispose();
      finish({ ok: true, valueJson, error: null, stopped: null });
      return;
    }
    if (state.type === 'rejected') {
      failWith(errorOf(vm, state.error));
      return;
    }
    if (pending.size === 0) {
      finish({
        ok: false,
        valueJson: null,
        error: {
          name: 'ScriptStalled',
          message:
            'the script awaits a promise nothing will settle: no read is outstanding and no job is left to run',
        },
        stopped: null,
      });
      return;
    }
    const left = start.deadline - Date.now();
    const answered = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(0, left));
      wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    wake = null;
    if (!answered) {
      finish({ ok: false, valueJson: null, error: capError('wallMs', ''), stopped: 'wallMs' });
      return;
    }
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  failWith({ name: 'SandboxError', message });
});
