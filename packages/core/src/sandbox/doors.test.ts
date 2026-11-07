import { SCRIPT_STATE_CAP_BYTES } from '@forge/contracts/script-sandbox';
import { describe, expect, it } from 'vitest';
import {
  type ReadOutcome,
  type RunScriptInput,
  runScript,
  type ScriptFiler,
  type ScriptOpsCaller,
} from './run.js';

/**
 * @direct-test-of packages/core/src/sandbox/run.ts
 * @direct-test-of packages/core/src/sandbox/worker-entry.ts
 */

// A schedule script's doors past ctx.forge.get (REQ-87): every ctx.ops name reaches the host, which
// alone decides what runs; ctx.feedback.file hands the payload to the host; ctx.state is the object
// the last firing left, set back only as a plain object within its cap. A run handed no door is
// refused by name at it.

const limits = { wallMs: 3_000, memoryMb: 32, logChars: 16_000 };
const run = (script: string, extra: Partial<RunScriptInput> = {}) =>
  runScript({
    script,
    projectId: 'p-1',
    limits,
    read: async () => {
      throw new Error('this script was not expected to read');
    },
    ...extra,
  });

const caught = `const tried = async (f) => { try { return { ok: await f() }; } catch (e) { return { name: e.name, code: e.code ?? null, message: e.message }; } };`;

describe('ctx.ops', () => {
  it('asks the host for every name the script calls, declared or not, and hands back its answer', async () => {
    const asked: [string, unknown][] = [];
    const call: ScriptOpsCaller = async (name, args): Promise<ReadOutcome> => {
      asked.push([name, args]);
      return name === 'disk'
        ? { ok: true, body: { exitCode: 0, stdout: 'ok' } }
        : {
            ok: false,
            name: 'ScriptOpsRefused',
            code: 'SCRIPT_OPS_UNDECLARED',
            message: `${name} is not declared`,
          };
    };
    const r = await run(
      `${caught} return [await tried(() => ctx.ops.disk()), await tried(() => ctx.ops.deploy({ ref: 'main' }))];`,
      { ops: { names: ['disk'], call } },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(asked).toEqual([
      ['disk', null],
      ['deploy', { ref: 'main' }],
    ]);
    expect(r.value).toEqual([
      { ok: { exitCode: 0, stdout: 'ok' } },
      {
        name: 'ScriptOpsRefused',
        code: 'SCRIPT_OPS_UNDECLARED',
        message: 'deploy is not declared',
      },
    ]);
  });

  it('refuses every call by name on a run handed no ops door, a chat computation', async () => {
    const r = await run(`${caught} return await tried(() => ctx.ops.status());`);
    expect(r.value).toMatchObject({ code: 'SCRIPT_OPS_UNDECLARED' });
    expect(String((r.value as { message: string }).message)).toContain(
      'ctx.ops.status is refused: this script declares no ops call',
    );
  });

  it('cannot be overwritten by the script, and is no promise to await', async () => {
    const asked: string[] = [];
    const r = await run(
      `ctx.ops.status = () => 'mine'; const out = await ctx.ops.status(); return { then: typeof ctx.ops.then, out };`,
      {
        ops: {
          names: ['status'],
          call: async (name) => {
            asked.push(name);
            return { ok: true, body: 'host' };
          },
        },
      },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.value).toEqual({ then: 'undefined', out: 'host' });
    expect(asked).toEqual(['status']);
  });
});

describe('ctx.feedback.file', () => {
  it('hands the payload to the host as the script wrote it, and the key back', async () => {
    const payloads: unknown[] = [];
    const file: ScriptFiler = async (p) => {
      payloads.push(p);
      return { ok: true, body: { key: 'FB-7', created: true } };
    };
    const payload = { kind: 'bug', title: 'CDC down', signalKey: 'epod:cdc' };
    const r = await run(`return await ctx.feedback.file(${JSON.stringify(payload)});`, { file });
    expect(r.value).toEqual({ key: 'FB-7', created: true });
    expect(payloads).toEqual([payload]);
  });

  it('is refused by name where the run has no feedback door', async () => {
    const r = await run(
      `${caught} return await tried(() => ctx.feedback.file({ kind: 'bug', title: 't', signalKey: 'k' }));`,
    );
    expect(r.value).toMatchObject({
      name: 'ScriptFeedbackRefused',
      code: 'SCRIPT_FEEDBACK_REFUSED',
    });
  });
});

describe('ctx.state', () => {
  it('reads what the last firing left and returns what this one set', async () => {
    const r = await run(
      `const s = ctx.state.get(); s.n = (s.n ?? 0) + 1; ctx.state.set(s); return ctx.state.get();`,
      { state: { n: 1 } },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.state).toEqual({ n: 2 });
    expect(r.value).toEqual({ n: 2 });
  });

  it('returns no state where the script set none', async () => {
    const r = await run('return ctx.state.get();', { state: { n: 1 } });
    expect(r.value).toEqual({ n: 1 });
    expect(r.state).toBeNull();
  });

  it.each([
    ['an array', 'ctx.state.set([1])', 'takes a plain JSON object, and was given an array'],
    ['nothing', 'ctx.state.set(undefined)', 'and was given nothing'],
    [
      'a state past its cap',
      `ctx.state.set({ big: 'x'.repeat(${SCRIPT_STATE_CAP_BYTES}) })`,
      `past its cap of ${SCRIPT_STATE_CAP_BYTES}`,
    ],
  ])('refuses %s by name and keeps the last one', async (_, set, said) => {
    const r = await run(
      `${caught} const t = await tried(() => ${set}); return { t, s: ctx.state.get() };`,
      {
        state: { n: 1 },
      },
    );
    const v = r.value as { t: { code: string; message: string }; s: unknown };
    expect(v.t.code).toBe('SCRIPT_STATE_REFUSED');
    expect(v.t.message).toContain(said);
    expect(v.s).toEqual({ n: 1 });
    expect(r.state).toBeNull();
  });

  it('is refused by name where the run keeps no state', async () => {
    const r = await run(`${caught} return await tried(() => ctx.state.get());`);
    expect(r.value).toMatchObject({ code: 'SCRIPT_STATE_REFUSED' });
  });
});
