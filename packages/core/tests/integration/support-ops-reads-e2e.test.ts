import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { refusalCodes, SupportWorld, type Turn } from '../helpers/support-world.js';

/**
 * @direct-test-of packages/core/src/support/ops-read.ts
 * @direct-test-of packages/core/src/support/ops-read-args.ts
 * @direct-test-of packages/core/src/support/checks.ts
 * @direct-test-of packages/core/src/runners/box-acts.ts
 */

// ISS-871, REQ-77 BC-3: a channel agent uses only the ops tools its binding grants, and the
// credential stays inside the tool. AdminHub's hand bot read production through two box scripts
// (a log search and fixed data verbs) and a daily check; here each is declared as a named read on the
// agent's grant, exactly as a project admin would set it on AdminHub-Support's binding, and driven as
// the agent calls it: the box is asked to run the fixed argv with the arguments as their own items,
// the answer is scrubbed before the agent reads it, and every wrong call is refused by name with
// nothing asked of the box.

const BIN = '/home/dev/forge/projects/eco-adminhub/bin';
const hub = {
  name: 'hub',
  flag: '--hub',
  description: 'which production hub: cnw is Canawan (the default), lsm is Lesmers',
  enum: ['cnw', 'lsm'],
  maxLength: 3,
};
const ref = (name: string, description: string) => ({
  name,
  description,
  required: true,
  pattern: '[A-Za-z0-9_][A-Za-z0-9_-]{0,39}',
  maxLength: 40,
});

/** The reads AdminHub-Support's binding grants: the grant JSON this issue reports. */
const ADMINHUB_READS = [
  {
    name: 'hub-logs',
    summary:
      "Search one day's AdminHub production log for a fixed string; the newest matching lines, secrets hidden",
    argv: [`${BIN}/hub-logs`],
    params: [
      {
        name: 'text',
        description: 'the fixed string: an order id, a supplier name, an exception class, a route',
        required: true,
        pattern: '[A-Za-z0-9_\\\\][^\\n]*',
        maxLength: 200,
      },
      {
        name: 'date',
        flag: '--date',
        description: 'the day, UTC; today when left out',
        pattern: '\\d{4}-\\d{2}-\\d{2}',
        maxLength: 10,
      },
      {
        name: 'log',
        flag: '--log',
        description: 'admin (the default), errors (error shapes) or alerts (system alerts)',
        enum: ['admin', 'errors', 'alerts'],
        maxLength: 6,
      },
      {
        name: 'lines',
        flag: '--lines',
        description: 'how many of the newest matching lines, 1 to 120 (default 40)',
        pattern: '[1-9][0-9]{0,2}',
        maxLength: 3,
      },
      hub,
    ],
    timeoutMs: 120_000,
  },
  {
    name: 'hub-data-suppliers',
    summary:
      'Every supplier account: token expiry and days left (EXPIRED / EXPIRING / ok), endpoint host, recent sends',
    argv: [`${BIN}/hub-data`, 'suppliers', '--json'],
    params: [
      {
        name: 'expiring_days',
        flag: '--expiring-days',
        description: 'how many days ahead counts as expiring, 0 to 365 (default 7)',
        pattern: '[0-9]{1,3}',
        maxLength: 3,
      },
      hub,
    ],
  },
  {
    name: 'hub-data-po',
    summary:
      'One purchase order: supplier, account last sent with, PO and send status, its order, the last send error',
    argv: [`${BIN}/hub-data`, 'po', '--json'],
    params: [ref('po', 'a PO code (PO001453760102901) or a PO id'), hub],
  },
  {
    name: 'hub-data-po-stats',
    summary: 'POs created in the last hours, counted per supplier by PO and send status',
    argv: [`${BIN}/hub-data`, 'po-stats', '--json'],
    params: [
      {
        name: 'supplier',
        flag: '--supplier',
        description: 'one supplier id',
        pattern: '[0-9]{1,10}',
        maxLength: 10,
      },
      {
        name: 'hours',
        flag: '--hours',
        description: 'how many hours back, 1 to 720 (default 24)',
        pattern: '[1-9][0-9]{0,2}',
        maxLength: 3,
      },
      hub,
    ],
  },
  {
    name: 'hub-data-order',
    summary: 'One order by id, reference id or origin order id: status, store, times and its POs',
    argv: [`${BIN}/hub-data`, 'order', '--json'],
    params: [ref('order', 'an order id, a reference id or an origin order id'), hub],
  },
  {
    name: 'morning-check',
    summary:
      'The AdminHub morning check: supplier tokens expiring and an ERROR spike; prints the finding, or nothing when all is well',
    argv: [`${BIN}/hub-morning-check`, '--dry-run'],
    timeoutMs: 120_000,
  },
];

const OWNER_ID = 'u-alice';
const MORNING = {
  name: 'morning-check',
  at: '01:30',
  ask: 'Run the AdminHub morning check. A finding is a supplier token expired or expiring, or an ERROR spike; say it to the team in one short message.',
};

const w = new SupportWorld();
let chat: StandInRocketChat;
let roomId = '';

const agent = (grants: Record<string, unknown>) => ({
  product: 'AdminHub, the supplier and order back office',
  readers: 'team',
  grants,
  checks: [{ ...MORNING, rid: chat.rid }],
});
const READING = { abilities: ['file_items', 'ops_reads'], owner: OWNER_ID, reads: ADMINHUB_READS };

/** A member asks in the group and the session makes one `forge_support` call for it. */
async function sessionDoes(
  args: Record<string, unknown>,
  text = 'Can you look at this?',
): Promise<{ thread: string; out: Record<string, unknown> }> {
  await w.settleWarm();
  let out: Record<string, unknown> | null = null;
  let armed = true;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from === 'forge' || !armed) continue;
      armed = false;
      out = await act({ ...args, thread: m.thread });
    }
  };
  const thread = await w.chat.say(w.chat.bob, text);
  await expect.poll(() => out, { timeout: 15_000 }).not.toBeNull();
  return { thread, out: out as unknown as Record<string, unknown> };
}

/** The `ops.read` frames the box was asked, newest last. */
const reads = () => w.box.acts.filter((a) => a.event === 'ops.read');

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  await w.bindTarget({ rids: [chat.rid], agent: agent(READING) });
  roomId = String((await w.rooms())[0]?.id);
}, 120_000);

afterAll(() => w.stop());

describe('ISS-871: a declared read runs at once through the box, with no confirmer (REQ-77 BC-3)', () => {
  it('searches the production log: the fixed argv with each argument its own item, scrubbed, recorded, nothing posted', async () => {
    w.box.readAnswer = () => ({
      exitCode: 0,
      stdout: `[2026-11-02 01:12:09] production.ERROR: PO 1453 send failed token=sk_live_abc123 bot=${chat.bot.authToken}\n`,
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 812,
    });
    const before = reads().length;
    const { thread, out } = await sessionDoes({
      action: 'read',
      name: 'hub-logs',
      args: {
        text: 'PO 1453; rm -rf /',
        date: '2026-11-02',
        log: 'errors',
        lines: 120,
        hub: 'lsm',
      },
    });
    expect(out, JSON.stringify(out)).toMatchObject({
      name: 'hub-logs',
      exitCode: 0,
      timedOut: false,
      isError: false,
    });
    expect(reads().length).toBe(before + 1);
    expect(reads().at(-1)?.data).toMatchObject({
      argv: [
        `${BIN}/hub-logs`,
        'PO 1453; rm -rf /',
        '--date',
        '2026-11-02',
        '--log',
        'errors',
        '--lines',
        '120',
        '--hub',
        'lsm',
      ],
      timeoutMs: 120_000,
    });
    // the room's own token and a credential the program printed never reach the agent
    expect(String(out.stdout)).toContain('PO 1453 send failed');
    expect(String(out.stdout)).not.toContain(chat.bot.authToken);
    expect(String(out.stdout)).not.toContain('sk_live_abc123');
    // recorded as the agent's diagnosis by name and arguments, never by the argv
    const recorded = (await w.actions(roomId)).filter(
      (a) => a.kind === 'diagnose' && a.tool === 'read' && a.thread === thread,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.input).toMatchObject({ name: 'hub-logs' });
    expect(JSON.stringify(recorded)).not.toContain(BIN);
    expect(await w.linesIn(thread)).toEqual([]);
    w.box.readAnswer = (d) => ({ exitCode: 0, stdout: `read ${JSON.stringify(d.argv)}` });
  });

  it.each([
    ['hub-data-suppliers', { expiring_days: 7 }, ['suppliers', '--json', '--expiring-days', '7']],
    ['hub-data-po', { po: 'PO001453760102901' }, ['po', '--json', 'PO001453760102901']],
    [
      'hub-data-po-stats',
      { supplier: '12', hours: '720', hub: 'cnw' },
      ['po-stats', '--json', '--supplier', '12', '--hours', '720', '--hub', 'cnw'],
    ],
    ['hub-data-order', { order: '98765432101' }, ['order', '--json', '98765432101']],
  ])('reads production data with the fixed verb %s', async (name, args, tail) => {
    const { out } = await sessionDoes({ action: 'read', name, args });
    expect(out, JSON.stringify(out)).toMatchObject({ name, exitCode: 0, isError: false });
    expect(reads().at(-1)?.data.argv).toEqual([`${BIN}/hub-data`, ...tail]);
  });

  it('takes a value exactly its parameter’s length, and a read with no parameter', async () => {
    const { out } = await sessionDoes({
      action: 'read',
      name: 'hub-logs',
      args: { text: `A${'x'.repeat(199)}` },
    });
    expect(out, JSON.stringify(out)).toMatchObject({ exitCode: 0, isError: false });
    expect(reads().at(-1)?.data.argv).toEqual([`${BIN}/hub-logs`, `A${'x'.repeat(199)}`]);
    const check = await sessionDoes({ action: 'read', name: 'morning-check' });
    expect(check.out).toMatchObject({ name: 'morning-check', isError: false });
    expect(reads().at(-1)?.data.argv).toEqual([`${BIN}/hub-morning-check`, '--dry-run']);
  });

  it('says a read the box killed at its time, cut to its cap, as the box said it', async () => {
    w.box.readAnswer = () => ({
      exitCode: null,
      stdout: 'x'.repeat(32 * 1024),
      stderr: '',
      truncated: true,
      timedOut: true,
      durationMs: 120_000,
    });
    const { out } = await sessionDoes({ action: 'read', name: 'morning-check' });
    expect(out).toMatchObject({ exitCode: null, truncated: true, timedOut: true, isError: false });
    expect(String(out.stdout)).toHaveLength(32 * 1024);
  });

  it('refuses SUPPORT_READ_FAILED where the box could not run it, never naming the program’s path', async () => {
    w.box.readAnswer = () => ({
      error: `${BIN}/hub-logs could not run on this box: No such file or directory (os error 2)`,
    });
    const { out } = await sessionDoes({ action: 'read', name: 'hub-logs', args: { text: 'x' } });
    expect(refusalCodes(out), JSON.stringify(out)).toEqual(['SUPPORT_READ_FAILED']);
    expect(JSON.stringify(out)).toContain(
      'hub-logs did not run: hub-logs could not run on this box',
    );
    expect(JSON.stringify(out)).not.toContain(BIN);
    w.box.readAnswer = (d) => ({ exitCode: 0, stdout: `read ${JSON.stringify(d.argv)}` });
  });
});

describe('ISS-871: a wrong read is refused by name and nothing is asked of the box', () => {
  it.each([
    [
      'an undeclared read',
      { name: 'hub-data-user', args: { user: '12' } },
      'SUPPORT_READ_UNDECLARED',
      'declares no read hub-data-user; it declares hub-logs, hub-data-suppliers',
    ],
    [
      'a value outside its pattern',
      { name: 'hub-logs', args: { text: 'x', date: '2026-11-2' } },
      'SUPPORT_READ_ARGS',
      'date \\"2026-11-2\\" is not a value matching',
    ],
    [
      'a value outside its enum',
      { name: 'hub-logs', args: { text: 'x', log: 'access' } },
      'SUPPORT_READ_ARGS',
      'log \\"access\\" is not one of admin | errors | alerts',
    ],
    [
      'a parameter it does not take',
      { name: 'hub-data-po', args: { po: 'PO1', sql: 'select 1' } },
      'SUPPORT_READ_ARGS',
      'hub-data-po takes no parameter sql; it takes po, hub',
    ],
    [
      'a missing required parameter',
      { name: 'hub-data-order', args: {} },
      'SUPPORT_READ_ARGS',
      'hub-data-order needs order',
    ],
    [
      'a value one past its length',
      { name: 'hub-logs', args: { text: `A${'x'.repeat(200)}` } },
      'SUPPORT_READ_ARGS',
      'text is 201 characters; it takes 1 to 200',
    ],
    [
      'a value that would read as an option',
      { name: 'hub-data-po', args: { po: '--hub' } },
      'SUPPORT_READ_ARGS',
      'po starts with -',
    ],
    [
      'a value holding a new line',
      { name: 'hub-logs', args: { text: 'a\nb' } },
      'SUPPORT_READ_ARGS',
      'text holds a control character or a new line',
    ],
  ])('refuses %s', async (_what, args, code, says) => {
    const before = reads().length;
    const { thread, out } = await sessionDoes({ action: 'read', ...args });
    expect(refusalCodes(out), JSON.stringify(out)).toEqual([code]);
    expect(JSON.stringify(out)).toContain(says);
    expect(reads().length).toBe(before);
    const refused = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && a.tool === 'read' && a.thread === thread,
    );
    expect(refused).toHaveLength(1);
    expect(await w.linesIn(thread)).toEqual([]);
  });

  it('refuses SUPPORT_ABILITY_NOT_GRANTED where the grant holds no ops_reads, naming who grants it', async () => {
    const regranted = await w.retarget({
      agent: agent({ abilities: ['file_items'], owner: OWNER_ID }),
    });
    expect(regranted.status, JSON.stringify(regranted.body)).toBe(200);
    const before = reads().length;
    const { out } = await sessionDoes({ action: 'read', name: 'hub-logs', args: { text: 'x' } });
    expect(refusalCodes(out), JSON.stringify(out)).toEqual(['SUPPORT_ABILITY_NOT_GRANTED']);
    expect(JSON.stringify(out)).toContain('not granted `ops_reads`');
    expect(reads().length).toBe(before);
    const back = await w.retarget({ agent: agent(READING) });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  });
});

describe('ISS-871: a grant that could never read is refused when it is set', () => {
  it.each([
    [
      'ops_reads with no read',
      { abilities: ['ops_reads'], owner: OWNER_ID },
      'ops_reads is granted and declares no read',
    ],
    [
      'reads without ops_reads',
      { abilities: ['file_items'], owner: OWNER_ID, reads: ADMINHUB_READS },
      'reads are declared and ops_reads is not granted',
    ],
    [
      'a program the box would look up by name',
      {
        abilities: ['ops_reads'],
        reads: [{ name: 'hub-logs', summary: 'logs', argv: ['hub-logs'] }],
      },
      'argv[0] is the program: an absolute path',
    ],
    [
      'a parameter with neither pattern nor enum',
      {
        abilities: ['ops_reads'],
        reads: [
          {
            name: 'hub-logs',
            summary: 'logs',
            argv: [`${BIN}/hub-logs`],
            params: [{ name: 'text', description: 'anything', maxLength: 20 }],
          },
        ],
      },
      'parameter text takes exactly one of pattern or enum',
    ],
  ])('refuses %s', async (_what, grants, says) => {
    const got = await w.retarget({ agent: agent(grants) });
    expect(got.status, JSON.stringify(got.body)).toBe(422);
    expect(JSON.stringify(got.body)).toContain(says);
  });

  it('lists each read to the agent by name, summary and parameters, never by its path', async () => {
    const brief = w.box.turns.filter((t) => t.event === 'agent:start').at(-1)?.text ?? '';
    expect(brief).toContain('- ops_reads:');
    expect(brief).toContain('  - hub-logs: Search one day');
    expect(brief).toContain('log? (admin (the default)');
    expect(brief).toContain('one of admin | errors | alerts');
    expect(brief).toContain('  - morning-check:');
    expect(brief).not.toContain(BIN);
  });
});

describe('ISS-871: the scheduled morning check works through the read door (REQ-77 BC-13)', () => {
  it('names the granted reads in the check it hands the agent, and the agent reads under the check', async () => {
    w.box.readAnswer = () => ({
      exitCode: 0,
      stdout:
        'hub-morning-check (forge-core-61): supplier 12 (Acme) token EXPIRING in 3 days on its api account\n',
      stderr: '',
    });
    const { fireDueChecks } = await import('../../src/support/index.js');
    await w.settleWarm();
    const out: Record<string, Record<string, unknown>> = {};
    let seen: Turn | null = null;
    w.box.model = async (turn, act) => {
      const m = turn.messages.find((x) => x.thread.startsWith('check:'));
      if (seen || !m) return;
      seen = turn;
      out.read = await act({ action: 'read', name: 'morning-check', check: m.thread });
      out.other = await act({
        action: 'read',
        name: 'morning-check',
        check: 'check:other:2026-11-02',
      });
      out.result = await act({
        action: 'check_result',
        check: m.thread,
        finding: 'Supplier 12 (Acme): its token expires in 3 days.',
      });
    };
    expect(await fireDueChecks(new Date('2026-11-02T01:30:00Z'))).toBe(1);
    await expect.poll(() => out.result, { timeout: 15_000 }).toBeDefined();
    const handed = (seen as unknown as Turn).messages.find((m) => m.thread.startsWith('check:'));
    expect(handed?.text).toContain('support.read');
    expect(handed?.text).toContain('morning-check');
    expect(handed?.text).toContain('hub-logs');
    expect(handed?.text).not.toContain(BIN);
    expect(out.read, JSON.stringify(out.read)).toMatchObject({
      name: 'morning-check',
      isError: false,
    });
    expect(String(out.read?.stdout)).toContain('token EXPIRING in 3 days');
    expect(refusalCodes(out.other)).toEqual(['SUPPORT_CHECK_UNKNOWN']);
    expect(out.result, JSON.stringify(out.result)).toMatchObject({ posted: expect.any(String) });
    const recorded = (await w.actions(roomId)).filter(
      (a) => a.kind === 'diagnose' && a.tool === 'read' && a.thread === handed?.thread,
    );
    expect(recorded).toHaveLength(1);
  });
});
