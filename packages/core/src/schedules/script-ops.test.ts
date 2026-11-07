import type { ScriptOpsDeclaration } from '@forge/contracts/script-sandbox';
import { scriptOpsSchema } from '@forge/contracts/script-sandbox';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCTION_WATCH_OPS,
  PRODUCTION_WATCH_PARAMS,
  PRODUCTION_WATCH_SCRIPT,
} from '../guides/script-schedules-guide.js';
import { runScript } from '../sandbox/run.js';
import { classifyCommand } from '../support/command-class.js';
import { provideSchedulesPorts } from './ports.js';
import { openFiler } from './script-feedback.js';
import { openOpsCaller, opsArgv, opsRefusals } from './script-ops.js';

/**
 * @direct-test-of packages/core/src/schedules/script-ops.ts
 * @direct-test-of packages/core/src/schedules/script-feedback.ts
 * @direct-test-of packages/core/src/guides/script-schedules-guide.ts
 */

// REQ-87 BC-1..3 without a database: a declared call is read-only on the forge-ops target or refused
// by name; an undeclared call never reaches the box; a filing that does not fit is refused by name;
// and the example watch the guide ships files one item for a breach seen on two firings in a row,
// nothing for a blip, and stops once the signal recovers.

const filed: { key: string; signalKey: string; created: boolean }[] = [];
const openKeys = new Map<string, string>();

beforeAll(() => {
  provideSchedulesPorts({
    commandReads: classifyCommand,
    // the project's filer as the door behaves: an open item with the same key is joined
    fileScriptFeedback: async ({ request }: { request: { signalKey: string } }) => {
      const open = openKeys.get(request.signalKey);
      const key = open ?? `FB-${openKeys.size + 1}`;
      if (!open) openKeys.set(request.signalKey, key);
      filed.push({ key, signalKey: request.signalKey, created: !open });
      return { ok: true, key, created: !open };
    },
  } as never);
});

const decl = (calls: ScriptOpsDeclaration['calls']): ScriptOpsDeclaration => ({
  program: '/home/dev/.local/bin/forge-ops',
  calls,
});

describe('a declared call is read-only on the forge-ops target, or refused by name', () => {
  it('takes the read tools and an exec whose command only reads', () => {
    expect(
      opsRefusals(
        decl([
          { name: 'status', tool: 'status', args: { target: 't' } },
          { name: 'logs', tool: 'logs', args: { target: 't' } },
          { name: 'disk', tool: 'exec_command', args: { target: 't', command: 'df -P /' } },
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'deploy',
      { tool: 'deploy', args: { target: 't' } },
      'forge-ops deploy, which is not one of its read-only tools',
    ],
    [
      'an unknown tool',
      { tool: 'restart', args: {} },
      'forge-ops restart, which is not one of its read-only tools',
    ],
    [
      'an exec that writes',
      { tool: 'exec_command', args: { target: 't', command: 'rm -rf /tmp/x' } },
      '`rm -rf /tmp/x`, which is not read-only: rm is not a program known only to read',
    ],
    [
      'an exec that chains',
      { tool: 'exec_command', args: { target: 't', command: 'df; reboot' } },
      'which is not read-only: it holds a shell construct',
    ],
    [
      'a query',
      { tool: 'exec_command', args: { target: 't', command: 'psql -c select' } },
      'psql is not a program known only to read',
    ],
    [
      'an exec with no command',
      { tool: 'exec_command', args: { target: 't' } },
      'runs exec_command with no command',
    ],
  ])('refuses %s, naming the call', (_, call, said) => {
    const refusals = opsRefusals(decl([{ name: 'bad', ...call }]));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.code).toBe('SCRIPT_OPS_NOT_READ_ONLY');
    expect(refusals[0]?.path).toBe('/ops/calls/0');
    expect(refusals[0]?.detail).toContain('bad ');
    expect(refusals[0]?.detail).toContain(said);
  });

  it('refuses a program that is not the forge-ops CLI, and two calls of one name', () => {
    expect(
      scriptOpsSchema.safeParse({ program: '/bin/sh', calls: [{ name: 'a', tool: 'status' }] })
        .success,
    ).toBe(false);
    expect(
      scriptOpsSchema.safeParse({ program: 'forge-ops', calls: [{ name: 'a', tool: 'status' }] })
        .success,
    ).toBe(false);
    expect(
      scriptOpsSchema.safeParse(
        decl([
          { name: 'a', tool: 'status' },
          { name: 'a', tool: 'logs' },
        ]),
      ).success,
    ).toBe(false);
  });

  it('runs the CLI with the tool and its fixed arguments as one item, no shell', () => {
    const d = decl([
      { name: 'disk', tool: 'exec_command', args: { target: 't', command: 'df -P /' } },
    ]);
    expect(opsArgv(d, d.calls[0] as ScriptOpsDeclaration['calls'][number])).toEqual([
      '/home/dev/.local/bin/forge-ops',
      'exec_command',
      '{"target":"t","command":"df -P /"}',
    ]);
  });
});

describe('the ops host of one firing', () => {
  const box = () => {
    const argvs: string[][] = [];
    const run = async (argv: string[]) => {
      argvs.push(argv);
      return {
        ok: true as const,
        value: {
          name: 'x',
          exitCode: 0,
          stdout: 'up',
          stderr: '',
          truncated: false,
          timedOut: false,
          durationMs: 4,
        },
      };
    };
    return { argvs, run };
  };

  it('runs a declared call on the box and records it answered', async () => {
    const b = box();
    const ops = openOpsCaller({
      projectId: 'p',
      decl: decl([{ name: 'status', tool: 'status', args: { target: 't' } }]),
      run: b.run,
    });
    const out = await ops.call('status', null);
    expect(out).toMatchObject({ ok: true, body: { exitCode: 0, stdout: 'up' } });
    expect(b.argvs).toEqual([['/home/dev/.local/bin/forge-ops', 'status', '{"target":"t"}']]);
    expect(ops.calls()).toEqual([
      { name: 'status', outcome: 'answered', exitCode: 0, durationMs: 4 },
    ]);
  });

  it('refuses an undeclared call and one given arguments by name, with nothing asked of the box', async () => {
    const b = box();
    const ops = openOpsCaller({
      projectId: 'p',
      decl: decl([{ name: 'status', tool: 'status' }]),
      run: b.run,
    });
    const undeclared = await ops.call('deploy', null);
    const given = await ops.call('status', { target: 'other' });
    expect(undeclared).toMatchObject({ ok: false, code: 'SCRIPT_OPS_UNDECLARED' });
    expect(undeclared.ok ? '' : undeclared.message).toContain(
      'ctx.ops.deploy is not declared on this schedule; it declares status',
    );
    expect(given.ok ? '' : given.message).toContain('takes no arguments');
    expect(b.argvs).toEqual([]);
    expect(ops.calls()).toEqual([
      { name: 'deploy', outcome: 'refused', code: 'SCRIPT_OPS_UNDECLARED' },
      { name: 'status', outcome: 'refused', code: 'SCRIPT_OPS_UNDECLARED' },
    ]);
  });

  it('refuses a declared call that is not read-only at the call too', async () => {
    const b = box();
    const ops = openOpsCaller({
      projectId: 'p',
      decl: decl([{ name: 'ship', tool: 'deploy' }]),
      run: b.run,
    });
    expect(await ops.call('ship', null)).toMatchObject({
      ok: false,
      code: 'SCRIPT_OPS_NOT_READ_ONLY',
    });
    expect(b.argvs).toEqual([]);
  });

  it('names a call the box could not run, failed', async () => {
    const ops = openOpsCaller({
      projectId: 'p',
      decl: decl([{ name: 'status', tool: 'status' }]),
      run: async () => ({ ok: false, why: 'no box bound to this project is online to run it' }),
    });
    const out = await ops.call('status', null);
    expect(out.ok ? '' : out.message).toBe(
      'SCRIPT_OPS_FAILED: ctx.ops.status did not run: no box bound to this project is online to run it',
    );
    expect(ops.calls()).toEqual([{ name: 'status', outcome: 'failed', code: 'SCRIPT_OPS_FAILED' }]);
  });
});

describe('the feedback host of one firing', () => {
  it.each([
    [{ kind: 'bug', title: 'x' }, 'signalKey: '],
    [{ kind: 'contract_change', title: 'x', signalKey: 'k' }, 'kind: '],
    [{ kind: 'bug', title: 'x', signalKey: 'two words' }, 'a signal key is one word'],
    ['CDC down', 'the payload: '],
  ])('refuses %j by name, filing nothing', async (payload, said) => {
    const before = filed.length;
    const f = openFiler({ projectId: 'p', schedule: { id: 's', name: 'watch' }, fireId: 'f' });
    const out = await f.file(payload);
    expect(out).toMatchObject({ ok: false, code: 'SCRIPT_FEEDBACK_REFUSED' });
    expect(out.ok ? '' : out.message).toContain(said);
    expect(out.ok ? '' : out.message).toContain('Nothing was filed.');
    expect(filed.length).toBe(before);
    expect(f.filings()[0]).toMatchObject({
      key: null,
      created: false,
      refused: 'SCRIPT_FEEDBACK_REFUSED',
    });
  });
});

describe('the example production watch (REQ-87 BC-3, BC-5)', () => {
  const healthy = {
    posting: { p95Seconds: 4 },
    api: { p50Ms: 80, p95Ms: 400, p99Ms: 900, errorRate: 0.001 },
    cdc: { slotActive: true, taskState: 'RUNNING', lagRows: 3 },
    index: { pending: 10, stuck: 0, failed: 0 },
  };
  const cdcDown = { ...healthy, cdc: { slotActive: false, taskState: 'FAILED', lagRows: 90_000 } };
  let state: Record<string, unknown> = {};

  const fire = async (metrics: unknown) => {
    const ops = openOpsCaller({
      projectId: 'p',
      decl: PRODUCTION_WATCH_OPS,
      run: async (argv) => {
        const args = JSON.parse(argv[2] ?? '{}') as { command?: string };
        const stdout =
          argv[1] === 'status'
            ? 'epod-api running'
            : args.command?.startsWith('df')
              ? 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /'
              : JSON.stringify(metrics);
        return {
          ok: true as const,
          value: {
            name: 'x',
            exitCode: 0,
            stdout,
            stderr: '',
            truncated: false,
            timedOut: false,
            durationMs: 3,
          },
        };
      },
    });
    const filer = openFiler({
      projectId: 'p',
      schedule: { id: 's', name: 'epod watch' },
      fireId: 'f',
    });
    const r = await runScript({
      script: PRODUCTION_WATCH_SCRIPT,
      projectId: 'p',
      params: PRODUCTION_WATCH_PARAMS,
      limits: { wallMs: 5_000, memoryMb: 32, logChars: 16_000 },
      read: async () => ({ ok: false, name: 'x', message: 'no read' }),
      ops: { names: ops.names, call: ops.call },
      file: filer.file,
      state,
    });
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    if (r.state) state = r.state;
    return {
      value: r.value as { breaches: Record<string, number>; filed: string[] },
      calls: ops.calls(),
    };
  };

  it('reads healthy, files nothing, and calls only what it declares', async () => {
    const before = filed.length;
    const r = await fire(healthy);
    expect(r.value).toEqual({ breaches: {}, filed: [] });
    expect(r.calls.map((c) => [c.name, c.outcome])).toEqual([
      ['status', 'answered'],
      ['disk', 'answered'],
      ['metrics', 'answered'],
    ]);
    expect(filed.length).toBe(before);
  });

  it('files nothing for a single-run blip', async () => {
    const before = filed.length;
    expect((await fire(cdcDown)).value.filed).toEqual([]);
    expect((await fire(healthy)).value.breaches).toEqual({});
    expect(filed.length).toBe(before);
  });

  it('files exactly one item for a breach seen twice, and none while it lasts or once it recovers', async () => {
    const before = filed.length;
    expect((await fire(cdcDown)).value.filed).toEqual([]);
    const second = await fire(cdcDown);
    expect(second.value.filed).toEqual(['FB-1']);
    expect(second.value.breaches).toEqual({ 'epod:cdc': 2 });
    expect((await fire(cdcDown)).value.filed).toEqual([]);
    expect((await fire(healthy)).value).toEqual({ breaches: {}, filed: [] });
    expect(filed.slice(before)).toEqual([{ key: 'FB-1', signalKey: 'epod:cdc', created: true }]);
  });
});
