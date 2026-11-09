/**
 * @direct-test-of packages/core/src/guides/script-schedules-guide.ts
 * @direct-test-of packages/core/src/schedules/script-ops.ts
 */

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
import { openOpsCaller } from './script-ops.js';

// The served watch on a box it cannot reach: the checks a dropped box could not run share one cause,
// so they file one item naming the box connection, never a breach per check. A check that ran and
// failed on its own still reads per check, and a real breach files as it always has.

/** Every filing request as the door received it: title and severity included. */
const requests: { signalKey: string; title: string; severity?: string; body?: string }[] = [];
const openKeys = new Map<string, string>();

beforeAll(() => {
  provideSchedulesPorts({
    commandReads: classifyCommand,
    // the project's filer as the door behaves: an open item with the same key is joined
    fileScriptFeedback: async ({ request }: { request: (typeof requests)[number] }) => {
      requests.push(request);
      const open = openKeys.get(request.signalKey);
      const key = open ?? `FB-${openKeys.size + 1}`;
      if (!open) openKeys.set(request.signalKey, key);
      return { ok: true, key, created: !open };
    },
  } as never);
});

describe('the example production watch on a box it cannot reach (ISS-1190)', () => {
  let state: Record<string, unknown> = {};
  const answered = (stdout: string, exitCode = 0) => ({
    ok: true as const,
    value: {
      name: 'x',
      exitCode,
      stdout,
      stderr: exitCode === 0 ? '' : 'forge-ops: unknown command',
      truncated: false,
      timedOut: false,
      durationMs: 3,
    },
  });
  const dropped = {
    ok: false as const,
    why: 'the box disconnected before it could be asked (ops.read) and did not reconnect within 75s',
    transport: 'disconnected' as const,
  };

  /** One firing where `answer` decides each call by its name. */
  const fire = async (
    answer: (name: string) => Awaited<ReturnType<Parameters<typeof openOpsCaller>[0]['run'] & {}>>,
  ) => {
    const ops = openOpsCaller({
      projectId: 'p',
      decl: PRODUCTION_WATCH_OPS,
      run: async (argv) => {
        const args = JSON.parse(argv[2] ?? '{}') as { command?: string };
        return answer(argv[1] === 'status' ? 'status' : (args.command ?? ''));
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
    return r.value as { breaches: Record<string, number>; filed: string[] };
  };

  it('throws a call no box could be reached for under its own code, recorded failed', async () => {
    const ops = openOpsCaller({
      projectId: 'p',
      decl: PRODUCTION_WATCH_OPS,
      run: async () => dropped,
    });
    expect(await ops.call('status', null)).toEqual({
      ok: false,
      name: 'ScriptOpsFailed',
      code: 'SCRIPT_OPS_BOX_UNREACHABLE',
      message: `SCRIPT_OPS_BOX_UNREACHABLE: ctx.ops.status did not run: ${dropped.why}`,
    });
    expect(ops.calls()).toEqual([
      { name: 'status', outcome: 'failed', code: 'SCRIPT_OPS_BOX_UNREACHABLE' },
    ]);
  });

  it('files one item naming the box connection for every check it could not reach, below high and not a breach', async () => {
    const before = requests.length;
    expect((await fire(() => dropped)).filed).toEqual([]);
    const second = await fire(() => dropped);
    expect(second.filed).toHaveLength(1);
    const made = requests.slice(before);
    expect(made).toHaveLength(1);
    expect(made[0]?.signalKey).toBe('epod:watch-blind-box');
    expect(made[0]?.title).not.toMatch(/breach/i);
    expect(made[0]?.title).toMatch(/box/i);
    expect(['low', 'medium']).toContain(made[0]?.severity);
    for (const check of ['status', 'disk', 'metrics']) expect(made[0]?.body).toContain(check);
  });

  it('still reads a check that ran and failed for its own reason per check, beside the box item', async () => {
    state = {};
    const before = requests.length;
    const own = (name: string) => (name === 'disk' ? answered('', 2) : dropped);
    await fire(own);
    await fire(own);
    const made = requests
      .slice(before)
      .map((r) => r.signalKey)
      .sort();
    expect(made).toEqual(['epod:watch-blind-box', 'epod:watch-blind-disk']);
    for (const r of requests.slice(before)) {
      expect(r.title).not.toMatch(/breach/i);
      expect(r.severity).not.toBe('high');
    }
  });

  it('files a real breach as before, one high item per signal', async () => {
    state = {};
    const before = requests.length;
    const metrics = {
      posting: { p95Seconds: 4 },
      api: { p50Ms: 80, p95Ms: 400, p99Ms: 900, errorRate: 0.001 },
      cdc: { slotActive: false, taskState: 'FAILED', lagRows: 90_000 },
      index: { pending: 10, stuck: 0, failed: 0 },
    };
    const breach = (name: string) =>
      name === 'status'
        ? answered('epod-api running')
        : name === 'disk'
          ? answered(
              'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /',
            )
          : answered(JSON.stringify(metrics));
    await fire(breach);
    await fire(breach);
    expect(requests.slice(before)).toEqual([
      expect.objectContaining({
        signalKey: 'epod:cdc',
        severity: 'high',
        title: 'Production breach confirmed twice: epod:cdc',
      }),
    ]);
  });
});
