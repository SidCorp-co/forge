import { describe, expect, it } from 'vitest';
import { type ReadOutcome, runScript, type ScriptReader } from './run.js';

// The script sandbox's engine (REQ-37 BC-1, BC-3, BC-8, BC-10): a script runs in a QuickJS isolate
// in a worker; nothing of the host process is reachable from it, every cap stops it and names
// itself, and ctx.log / ctx.notify behave as schedule scripts have always used them.

const limits = { wallMs: 3_000, memoryMb: 32, logChars: 16_000 };
const noReads: ScriptReader = async () => {
  throw new Error('this script was not expected to read');
};
const run = (script: string, read: ScriptReader = noReads, extra: Partial<typeof limits> = {}) =>
  runScript({
    script,
    projectId: 'p-1',
    params: { team: 'core' },
    limits: { ...limits, ...extra },
    read,
  });

describe('a script reaches nothing of the host', () => {
  it('sees no process, require or host global', async () => {
    const r = await run(
      'ctx.log(typeof process, typeof require, typeof globalThis.process, typeof Buffer, typeof fetch)',
    );
    expect(r.status).toBe('success');
    expect(r.output).toBe('undefined undefined undefined undefined undefined');
  });

  it.each([
    ['ctx.log', 'const p = ctx.log.constructor("return process")(); ctx.log(typeof p.env)'],
    ['ctx.notify', 'const p = ctx.notify.constructor("return process")(); ctx.log(typeof p.env)'],
    [
      'ctx.forge.get',
      'const p = ctx.forge.get.constructor("return process")(); ctx.log(typeof p.env)',
    ],
  ])('finds no process through the constructor of %s', async (_, script) => {
    process.env.SANDBOX_PROBE_SECRET = 'not-a-real-secret';
    const r = await run(script);
    expect(r.status).toBe('failed');
    expect(r.error).toEqual({ name: 'ReferenceError', message: "'process' is not defined" });
    expect(r.output).not.toContain('not-a-real-secret');
  });

  it('refuses ctx.http.fetch by name', async () => {
    const r = await run('ctx.http.fetch("https://example.com")');
    expect(r.status).toBe('failed');
    expect(r.error?.message).toContain('ctx.http.fetch is refused');
  });
});

describe('each cap stops the script and names itself', () => {
  it('stops an endless loop at the wall-time cap', async () => {
    const r = await run('for (;;) {}', noReads, { wallMs: 800 });
    expect(r.stopped).toBe('wallMs');
    expect(r.error?.name).toBe('WallTimeLimit');
    expect(r.error?.message).toContain('wall-time cap of 800 ms (wallMs)');
    expect(r.durationMs).toBeLessThan(800 + 2_000);
  });

  it('stops a script awaiting a read past the wall-time cap', async () => {
    const never: ScriptReader = () => new Promise<ReadOutcome>(() => {});
    const r = await run('await ctx.forge.get("/api/projects/p-1")', never, { wallMs: 600 });
    expect(r.stopped).toBe('wallMs');
    expect(r.error?.message).toContain('(wallMs)');
  });

  it('stops a memory blow-up at the memory cap', async () => {
    const r = await run('const a = []; for (;;) a.push(new Array(1e5).fill(1));', noReads, {
      memoryMb: 24,
    });
    expect(r.stopped).toBe('memoryMb');
    expect(r.error?.name).toBe('MemoryLimit');
    expect(r.error?.message).toContain('memory cap of 24 MB (memoryMb)');
  });

  it('stops runaway recursion at the stack limit', async () => {
    const r = await run('const f = (n) => f(n + 1) + 1; f(0)');
    expect(r.status).toBe('failed');
    expect(r.error?.message).toBe('stack overflow');
  });

  it('cuts the log at its cap and says so', async () => {
    const r = await run('for (let i = 0; i < 1000; i++) ctx.log("x".repeat(100))', noReads, {
      logChars: 500,
    });
    expect(r.status).toBe('success');
    expect(r.output).toContain('[log cut at 500 characters]');
    expect(r.output.length).toBeLessThan(700);
  });

  it('names a script that awaits what nothing will settle', async () => {
    const r = await run('await new Promise(() => {})');
    expect(r.error?.name).toBe('ScriptStalled');
  });
});

describe('a schedule script keeps ctx.log, ctx.params and ctx.notify', () => {
  it('logs, reads its params frozen, notifies, and returns JSON', async () => {
    const r = await run(`
      ctx.log('team', ctx.params.team, { n: 1 });
      ctx.params.team = 'web';
      ctx.notify({ title: 'Nightly', body: 'all green', severity: 'info' });
      console.log('done');
      return { team: ctx.params.team, project: ctx.projectId };
    `);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output).toBe('team core {"n":1}\ndone');
    expect(r.notifications).toEqual([{ title: 'Nightly', body: 'all green', severity: 'info' }]);
    expect(r.value).toEqual({ team: 'core', project: 'p-1' });
  });

  it('refuses a notify without a title, as before', async () => {
    const r = await run('ctx.notify({ body: "no title" })');
    expect(r.status).toBe('failed');
    expect(r.error?.message).toContain(
      'ctx.notify requires a { title: string, body?, severity? } payload',
    );
  });
});

describe('ctx.forge.get', () => {
  it('hands the script the body the host read, and the refusal the host made, by name', async () => {
    const asked: string[] = [];
    const read: ScriptReader = async (method, path) => {
      asked.push(`${method} ${path}`);
      return method === 'GET'
        ? { ok: true, body: { path } }
        : {
            ok: false,
            name: 'ForgeReadRefused',
            code: 'SCRIPT_READ_REFUSED',
            message: `${method} refused`,
          };
    };
    const r = await run(
      `
      const body = await ctx.forge.get('/api/projects/p-1/requirements');
      const refusals = [];
      for (const call of [() => ctx.forge.post('/api/projects/p-1/requirements'), () => ctx.forge.get('/x', { method: 'DELETE' })]) {
        try { await call(); } catch (e) { refusals.push([e.name, e.code, e.message]); }
      }
      return { body, refusals };
    `,
      read,
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(asked).toEqual([
      'GET /api/projects/p-1/requirements',
      'POST /api/projects/p-1/requirements',
      'DELETE /x',
    ]);
    expect(r.value).toEqual({
      body: { path: '/api/projects/p-1/requirements' },
      refusals: [
        ['ForgeReadRefused', 'SCRIPT_READ_REFUSED', 'POST refused'],
        ['ForgeReadRefused', 'SCRIPT_READ_REFUSED', 'DELETE refused'],
      ],
    });
  });
});
