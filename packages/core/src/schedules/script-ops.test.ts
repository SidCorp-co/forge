import type { ScriptOpsDeclaration } from '@forge/contracts/script-sandbox';
import { scriptOpsSchema } from '@forge/contracts/script-sandbox';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyCommand } from '../support/command-class.js';
import { provideSchedulesPorts } from './ports.js';
import { openFiler } from './script-feedback.js';
import { openOpsCaller, opsArgv, opsRefusals } from './script-ops.js';

/**
 * @direct-test-of packages/core/src/schedules/script-ops.ts
 * @direct-test-of packages/core/src/schedules/script-feedback.ts
 */

// REQ-87 BC-1..3 without a database: a declared call is read-only on the forge-ops target or refused
// by name; an undeclared call never reaches the box; and a filing that does not fit is refused by name.

const filed: { key: string; signalKey: string; created: boolean }[] = [];
const openKeys = new Map<string, string>();

beforeAll(() => {
  provideSchedulesPorts({
    commandReads: classifyCommand,
    // the declared-read path with no box online: the pick refuses, as `support/declared-read.ts` does
    secretEnvOf: async () => ({ ok: true, env: { FORGE_OPS_TOKEN: 'tok' } }),
    projectReadBox: async () => ({
      ok: false,
      refusals: [{ detail: 'no box bound to project p has answered a heartbeat within 90s' }],
    }),
    withoutSecrets: (text: string) => text,
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
  secrets: [{ env: 'FORGE_OPS_TOKEN', secret: 'secret://ops/forge-ops-token' }],
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

  // ISS-1130: epod's watch was refused `health is not a program known only to read`, a forge-ops
  // command name read as a shell line, so no named command could ever pass
  it('takes a named forge-ops command on a service that says why it only reads, without parsing it as a shell line', () => {
    expect(
      opsRefusals(
        decl([
          {
            name: 'health',
            tool: 'exec_command',
            args: { target: 't', service: 'go-backend', command: 'health' },
            readOnlyBecause: 'the dashboard vetted health to answer the service health only',
          },
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      'with no reason it only reads',
      { args: { target: 't', service: 'go-backend', command: 'health' } },
      'without saying why it only reads: declare readOnlyBecause',
    ],
    [
      'that is a shell line, not a name',
      {
        args: { target: 't', service: 'go-backend', command: 'df -P /' },
        readOnlyBecause: 'it reads',
      },
      'which is not a command name',
    ],
  ])('refuses a named command %s, naming the call', (_, call, said) => {
    const refusals = opsRefusals(decl([{ name: 'bad', tool: 'exec_command', ...call }]));
    expect(refusals.map((r) => [r.code, r.path])).toEqual([
      ['SCRIPT_OPS_NOT_READ_ONLY', '/ops/calls/0'],
    ]);
    expect(refusals[0]?.detail).toContain(said);
  });

  it('refuses a logs tail past what forge-ops answers by name, and takes one at the limit', () => {
    const at = (tail: number) =>
      opsRefusals(decl([{ name: 'recent', tool: 'logs', args: { target: 't', tail } }]));
    expect(at(2000)).toEqual([]);
    expect(at(3000).map((r) => [r.code, r.path])).toEqual([
      ['SCRIPT_OPS_OVER_TARGET_LIMIT', '/ops/calls/0/args'],
    ]);
    expect(at(3000)[0]?.detail).toContain("past forge-ops' limit of 2000 lines");
  });

  // ISS-707: a call runs on the credential the declaration names as a project secret, never the box's
  it('refuses a declaration that names no credential secret', () => {
    const { secrets: _none, ...bare } = decl([{ name: 'a', tool: 'status' }]);
    const parsed = scriptOpsSchema.safeParse(bare);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('secrets');
    expect(scriptOpsSchema.safeParse(decl([{ name: 'a', tool: 'status' }])).success).toBe(true);
  });

  it('refuses a program that is not the forge-ops CLI, and two calls of one name', () => {
    expect(
      scriptOpsSchema.safeParse({
        ...decl([]),
        program: '/bin/sh',
        calls: [{ name: 'a', tool: 'status' }],
      }).success,
    ).toBe(false);
    expect(
      scriptOpsSchema.safeParse({
        ...decl([]),
        program: 'forge-ops',
        calls: [{ name: 'a', tool: 'status' }],
      }).success,
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

  // ISS-1190: a dropped box is one cause every call of the firing shares, thrown under its own code
  it('throws a call no box could be reached for under its own code, recorded failed', async () => {
    const why =
      'the box disconnected before it could be asked (ops.read) and did not reconnect within 75s';
    const ops = openOpsCaller({
      projectId: 'p',
      decl: decl([{ name: 'status', tool: 'status' }]),
      run: async () => ({ ok: false, why, transport: 'disconnected' }),
    });
    expect(await ops.call('status', null)).toEqual({
      ok: false,
      name: 'ScriptOpsFailed',
      code: 'SCRIPT_OPS_BOX_UNREACHABLE',
      message: `SCRIPT_OPS_BOX_UNREACHABLE: ctx.ops.status did not run: ${why}`,
    });
    expect(ops.calls()).toEqual([
      { name: 'status', outcome: 'failed', code: 'SCRIPT_OPS_BOX_UNREACHABLE' },
    ]);
  });
});

// debt ed9cd2cd: past the liveness window the project's box pick itself refuses, with no reconnect
// wait; that refusal is the same shared cause as a dropped box, never the call's own failure
it('names a call whose project has no box to pick unreachable, through the real box path', async () => {
  const ops = openOpsCaller({ projectId: 'p', decl: decl([{ name: 'status', tool: 'status' }]) });
  expect(await ops.call('status', null)).toEqual({
    ok: false,
    name: 'ScriptOpsFailed',
    code: 'SCRIPT_OPS_BOX_UNREACHABLE',
    message:
      'SCRIPT_OPS_BOX_UNREACHABLE: ctx.ops.status did not run: no box bound to project p has answered a heartbeat within 90s',
  });
  expect(ops.calls()).toEqual([
    { name: 'status', outcome: 'failed', code: 'SCRIPT_OPS_BOX_UNREACHABLE' },
  ]);
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
