import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the product API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

// The repository host is the one thing this world does not serve: the build's change request is
// opened against a recorded stand-in, and everything up to it (grant, confirmer, box push) is real.
const opened = vi.hoisted(
  () => [] as { head: string; base: string; title: string; body?: string }[],
);
// what the projection says of a change request once its host reports it merged
const merged = vi.hoisted(() => new Set<number>());
vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => ({
    bindingId: '00000000-0000-4000-8000-000000000001',
    provider: 'github',
    fullName: 'acme/test-project',
    openChangeRequest: async (args: {
      head: string;
      base: string;
      title: string;
      body?: string;
    }) => {
      opened.push(args);
      return {
        number: 70 + opened.length,
        url: `https://github.com/acme/test-project/pull/${70 + opened.length}`,
        title: args.title,
        state: 'open',
        draft: false,
        headRef: args.head,
        headSha: 'b'.repeat(40),
        baseRef: args.base,
        baseSha: null,
      };
    },
  }),
  projectOpenedPullRequest: async () => {},
  changeRequestOpen: async (_bindingId: string, number: number) =>
    !merged.has(number),
}));

import { BASE, GrantedRoom } from '../helpers/support-grants-world.js';

// REQ-75 r5: a room's binding is its whole setup (BC-25), says why it is not answering (BC-26),
// grants its session named abilities (BC-27) and refuses an ungranted one by name, saying who can
// grant it (BC-28). Each ability is driven here as the session calls it, against the stand-in box
// that runs host commands and pushes builds as forge-runner does.

const g = new GrantedRoom();
const w = g.w;
let roomId = '';
let devTarget = '';
let liveTarget = '';
const sessionDoes = (...a: Parameters<GrantedRoom['sessionDoes']>) => g.sessionDoes(...a);
const proposal = (code: string) => g.proposal(code);
const deploysQueued = (bindingId: string) => g.deploysQueued(bindingId);

beforeAll(async () => {
  await g.start();
  ({ roomId, devTarget, liveTarget } = g);
}, 120_000);

afterAll(() => w.stop());

describe('REQ-75 r5: an ungranted ability is refused by name and says who grants it (BC-28)', () => {
  it('refuses a host command, posts why in the thread, records it, and runs nothing on the box', async () => {
    const before = w.box.acts.length;
    const { thread, out } = await sessionDoes({
      action: 'command',
      host: 'mta1',
      command: 'systemctl status postfix',
    });
    expect(out).toMatchObject({ isError: true });
    expect(JSON.stringify(out)).toContain('SUPPORT_ABILITY_NOT_GRANTED');
    const lines = await w.untilLines((ls) =>
      ls.some((l) => l.tmid === thread && l.text.includes('not granted `run_commands`')),
    );
    const said = lines.find((l) => l.tmid === thread)?.text ?? '';
    expect(said).toContain('This room holds `read_checkout`, `file_items`.');
    expect(said).toMatch(
      /a project admin \(.+\) grants it in Project settings → Integrations → Rocket\.Chat/,
    );
    expect(w.box.acts.length).toBe(before);
    const refused = (await w.actions(roomId)).filter(
      (a) => a.kind === 'refused' && a.tool === 'command',
    );
    expect(refused.length).toBeGreaterThan(0);
  });

  it('refuses a build, a deploy and an issue move the room does not hold', async () => {
    for (const [args, ability] of [
      [
        {
          action: 'build',
          branch: 'fix/blank-invoice',
          title: 'Fix the blank invoice',
          summary: 'Template read an unset locale.',
        },
        'build',
      ],
      [{ action: 'deploy', target: devTarget }, 'deploy'],
      [{ action: 'move_issue', issue: 'ISS-1', to: 'closed' }, 'deliver'],
    ] as const) {
      const { out } = await sessionDoes(args as Record<string, unknown>);
      expect(JSON.stringify(out), ability).toContain(`not granted \`${ability}\``);
    }
    expect(w.box.acts.filter((a) => a.event === 'build.push')).toEqual([]);
    expect(await deploysQueued(devTarget)).toBe(0);
  });
});

describe('REQ-75 r5: a binding is the whole setup and refuses a grant that could never act (BC-25, BC-27)', () => {
  it('refuses a grant whose ability names nothing it reaches, or a deploy target this project does not bind', async () => {
    const noHost = await w.regrant({
      ...BASE,
      grants: { abilities: ['run_commands'], confirmers: ['alice'] },
    });
    expect(noHost.status).toBe(422);
    expect(JSON.stringify(noHost.body)).toContain('names no host');
    const stranger = await w.regrant({
      ...BASE,
      grants: {
        abilities: ['deploy'],
        deployTargets: ['00000000-0000-4000-8000-0000000000aa'],
        confirmers: ['alice'],
      },
    });
    expect(stranger.status).toBe(422);
    expect(JSON.stringify(stranger.body)).toContain('SUPPORT_GRANT_TARGET_UNKNOWN');
  });

  it('takes the grant, and the room view shows it with the group’s name and health', async () => {
    const held = await w.regrant({
      ...BASE,
      readers: 'team',
      grants: {
        abilities: ['read_checkout', 'file_items', 'build', 'deploy', 'run_commands'],
        deployTargets: [devTarget, liveTarget],
        hosts: ['mta1', 'mail-01'],
        confirmers: ['alice'],
      },
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    await w.settleWarm();
    const [room] = await w.rooms();
    expect(room).toMatchObject({
      name: 'catalog-support',
      readers: 'team',
      grants: {
        abilities: expect.arrayContaining(['build', 'run_commands']),
        hosts: ['mta1', 'mail-01'],
      },
      health: { healthy: true, causes: [] },
    });
  });
});

describe('REQ-75 r5: what a granted room does (BC-27)', () => {
  it('runs a reading command on a named host at once, through the box, and posts what ran', async () => {
    const { thread, out } = await sessionDoes({
      action: 'command',
      host: 'mta1',
      command: 'journalctl -u postfix -n 50 | grep -i reject',
    });
    expect(out, JSON.stringify(out)).toMatchObject({ host: 'mta1', exitCode: 0, isError: false });
    expect(w.box.acts.at(-1)).toMatchObject({
      event: 'host.command',
      data: { host: 'mta1', command: 'journalctl -u postfix -n 50 | grep -i reject' },
    });
    await w.untilLines((ls) =>
      ls.some(
        (l) =>
          l.tmid === thread &&
          l.text.startsWith('Ran on mta1: `journalctl -u postfix -n 50 | grep -i reject` — exit 0'),
      ),
    );
  });

  it('refuses a host the grant does not name, by name', async () => {
    const before = w.box.acts.length;
    const { out } = await sessionDoes({ action: 'command', host: 'mta6', command: 'uptime' });
    expect(JSON.stringify(out)).toContain('may run commands on mta1, mail-01, and not on mta6');
    expect(w.box.acts.length).toBe(before);
  });

  it('holds a command that changes a host for a named confirmer: the asker’s confirm runs nothing, the confirmer’s runs it', async () => {
    const before = w.box.acts.length;
    const { thread, out } = await sessionDoes({
      action: 'command',
      host: 'mail-01',
      command: 'systemctl restart stalwart',
    });
    expect(out).toMatchObject({ pending: true, waitsOn: ['alice'] });
    const code = String(out.code);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === thread && l.text.includes('so it waits for a confirmer')),
    );
    expect(w.box.acts.length).toBe(before);
    // bob asked and is no confirmer: his confirm is refused and nothing runs
    await w.chat.say(w.chat.bob, `confirm ${code}`, thread);
    await w.untilLines((ls) =>
      ls.some(
        (l) => l.tmid === thread && l.text.startsWith('Only @alice can confirm this change.'),
      ),
    );
    expect(w.box.acts.length).toBe(before);
    await w.chat.say(w.chat.alice, `confirm ${code}`, thread);
    await w.untilLines((ls) =>
      ls.some(
        (l) =>
          l.tmid === thread && l.text.startsWith('Ran on mail-01: `systemctl restart stalwart`'),
      ),
    );
    expect(w.box.acts.at(-1)).toMatchObject({
      event: 'host.command',
      data: { host: 'mail-01', command: 'systemctl restart stalwart' },
    });
    expect(await proposal(code)).toMatchObject({ kind: 'command', state: 'ran' });
  });

  it('builds on a confirmer’s confirm: the box pushes the branch and a change request opens into dev, never production', async () => {
    const { thread, out } = await sessionDoes({
      action: 'build',
      branch: 'fix/blank-invoice',
      title: 'Fix the blank invoice PDF',
      summary: 'The invoice template read an unset locale.',
    });
    expect(out, JSON.stringify(out)).toMatchObject({ pending: true });
    const code = String(out.code);
    await w.chat.say(w.chat.alice, `confirm ${code}`, thread);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === thread && l.text.includes('opened a change request into dev')),
    );
    expect(w.box.acts.at(-1)).toMatchObject({
      event: 'build.push',
      data: { base: 'dev', branch: 'fix/blank-invoice', buildKey: roomId },
    });
    expect(opened.at(-1)).toMatchObject({ head: 'fix/blank-invoice', base: 'dev' });
    expect(opened.at(-1)?.body).toContain('confirmed by @alice');
    expect(await proposal(code)).toMatchObject({ kind: 'build', state: 'ran' });

    // a second build on the same branch adds to the change request it opened
    const again = await sessionDoes({
      action: 'build',
      branch: 'fix/blank-invoice',
      title: 'Also cover the credit note',
      summary: 'Same locale read.',
    });
    const before = opened.length;
    await w.chat.say(w.chat.alice, `confirm ${String(again.out.code)}`, again.thread);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === again.thread && l.text.includes('updates the open change request')),
    );
    expect(opened.length).toBe(before);

    // once that change request is merged, the next build on the branch opens a new one
    merged.add(70 + before);
    const after = await sessionDoes({
      action: 'build',
      branch: 'fix/blank-invoice',
      title: 'Follow-up on the invoice',
      summary: 'One more locale read.',
    });
    await w.chat.say(w.chat.alice, `confirm ${String(after.out.code)}`, after.thread);
    await w.untilLines((ls) =>
      ls.some(
        (l) => l.tmid === after.thread && l.text.includes('opened a change request into dev'),
      ),
    );
    expect(opened.length).toBe(before + 1);
  });

  it('a build the box refuses runs nothing further and says why', async () => {
    w.box.buildAnswer = () => ({ error: 'nothing to build: the working copy holds no change' });
    const { thread, out } = await sessionDoes({
      action: 'build',
      branch: 'feat/empty',
      title: 'Nothing here',
      summary: 'A build with nothing in it.',
    });
    const before = opened.length;
    await w.chat.say(w.chat.alice, `confirm ${String(out.code)}`, thread);
    await w.untilLines((ls) =>
      ls.some(
        (l) =>
          l.tmid === thread &&
          l.text === 'It did not go ahead: nothing to build: the working copy holds no change',
      ),
    );
    expect(opened.length).toBe(before);
    expect(await proposal(String(out.code))).toMatchObject({ kind: 'build', state: 'failed' });
    w.box.buildAnswer = (d) => ({ branch: d.branch, base: d.base, sha: 'c'.repeat(40), files: [] });
  });

  it('deploys a dev target on a confirmer’s confirm, and a production one waits for its approver', async () => {
    const dev = await sessionDoes({ action: 'deploy', target: devTarget });
    expect(dev.out).toMatchObject({ pending: true });
    expect(await deploysQueued(devTarget)).toBe(0);
    await w.chat.say(w.chat.alice, `confirm ${String(dev.out.code)}`, dev.thread);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === dev.thread && l.text.startsWith('Deploying')),
    );
    expect(await deploysQueued(devTarget)).toBe(1);

    const live = await sessionDoes({ action: 'deploy', target: liveTarget });
    await w.chat.say(w.chat.alice, `confirm ${String(live.out.code)}`, live.thread);
    await w.untilLines((ls) =>
      ls.some((l) => l.tmid === live.thread && l.text.includes('waits for its approver in Forge')),
    );
    expect(await deploysQueued(liveTarget)).toBe(0);
  });

  it('runs nothing on a confirm once the ability was taken away after it was proposed', async () => {
    const { thread, out } = await sessionDoes({
      action: 'command',
      host: 'mta1',
      command: 'postsuper -d ALL',
    });
    const code = String(out.code);
    const held = await w.regrant({
      ...BASE,
      readers: 'team',
      grants: { abilities: ['read_checkout', 'file_items', 'build'], confirmers: ['alice'] },
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const before = w.box.acts.length;
    // alice still confirms for the room; the grant read at her confirm no longer holds run_commands
    await w.chat.say(w.chat.alice, `confirm ${code}`, thread);
    await w.untilLines((ls) =>
      ls.some(
        (l) =>
          l.tmid === thread &&
          l.text.startsWith('It did not go ahead: This room is not granted `run_commands`'),
      ),
    );
    expect(w.box.acts.length).toBe(before);
    expect(await proposal(code)).toMatchObject({ kind: 'command', state: 'failed' });
  });
});
