import { describe, expect, it } from 'vitest';
import { operationsBrief } from './ops-prompt.js';
import { agentOpening, grantsLine, recentBlock, supportBrief, toolsLine } from './prompt.js';
import {
  ANSWER_THE_ASKER,
  DONE_ONLY_WHEN_CHECKED,
  linksOnWeb,
  NO_PERMISSION_TALK,
} from './room-conduct.js';

const brief = supportBrief({ projectName: 'P', product: null, tools: [] });

// ISS-861 (owner, 2026-11-01): the channel agent is told what it is for and the one limit a change
// meets — a person's plain yes, cited with support.agree — never a numbered script to walk.
describe('the support brief states goals, and the consent a change waits on', () => {
  it('carries no numbered how-to-work script', () => {
    expect(brief).not.toContain('How to work:');
    expect(brief).not.toMatch(/\n\d\. /);
    expect(brief).toContain('What you are for: answer, diagnose, fix and record');
  });

  it('keeps the consent and the claim a change waits on, in the agent own words', () => {
    expect(brief).toContain(
      'only once they agree in plain words and you cite that message with support.agree',
    );
    expect(brief).toContain('never claim it ran or was recorded until agree says so');
    // ISS-1243 item 17: a filing asked for by its asker is agreed by the request itself.
    expect(brief).toContain(
      'their asking is their agreement, so cite it with support.agree at once',
    );
    expect(brief).not.toContain('runs or is filed only once they agree');
    expect(brief).not.toContain("cite the asker's plain yes");
    expect(brief).not.toContain('type a code');
  });

  // ISS-1162 (REQ-75 BC-12): a diagnose posts nothing in the room; its check is on the action.
  it('says a diagnose posts nothing in the room and its check is recorded on the action', () => {
    expect(brief).not.toContain('the group sees each check');
    expect(brief).toContain(
      'a diagnose posts nothing in the room and each check is recorded on its action',
    );
  });

  // ISS-1205 (FB-607, L-47): work that can be done now is done now; a later time names what it waits on.
  it('does work now, and books a later time only naming what it waits on', () => {
    for (const readers of ['team', 'users'] as const) {
      const text = supportBrief({
        projectName: 'P',
        product: null,
        tools: [],
        config: { readers } as NonNullable<Parameters<typeof supportBrief>[0]['config']>,
      });
      expect(text).toContain('Work you can do now, do now, in this turn');
      expect(text).toContain('say in the task what it waits for');
      // ISS-1208 (FB-609): a reply answers every part of the message, or names the part it cannot yet.
      expect(text).toContain(
        'answer each question the message asked and cover each item it asked for',
      );
      // ISS-1211 (FB-613, agenfold L-46): look a fact up before asking a person for it.
      expect(text).toContain('Before you ask a person for a fact or recommend a change');
      // ISS-1214 (FB-618, agenfold L-74): a person's choice goes in, in their words, replacing what it corrects.
      expect(text).toContain("A person's choice or correction");
      expect(text).toContain('replaces the line it corrects');
      // ISS-1217 (FB-621, agenfold L-17): an organization is not its workspaces; act on the one named.
      expect(text).toContain('which organization holds which workspaces');
      expect(text).toContain('a workspace rename renames the workspace, never its organization');
    }
  });
});

// ISS-1032 (owner, 2026-11-06): where the agent has no permission it goes to the master and waits
// for the master's answer, never answering first; #sid-email told a user a mailbox was shared.
describe('the room brief teaches an ask it cannot do to wait on the master', () => {
  const channel = supportBrief({
    projectName: 'P',
    product: null,
    tools: [],
    opening: agentOpening({
      projectName: 'P',
      product: null,
      channels: ['#mail'],
      ownerMode: false,
    }),
  });

  it('routes it to the owning project’s master, holds once, and replies only with what was done', () => {
    expect(channel).toContain(
      'a request through support.record { project } to the master of the project that owns it',
    );
    expect(channel).toContain('post one reply that it went to the team');
    expect(channel).toContain(
      'reply again only with what that master did or decided once you are told it, never done before then and never options or steps the master has not given',
    );
    expect(channel).toContain('save the one reply that an ask went to the team');
  });

  it('tells a result as what the team said or shipped, never done before it', () => {
    for (const text of [brief, channel]) {
      expect(text).toContain(
        'You are told once recorded work is answered, live or will not be done, with what the team said or shipped',
      );
      expect(text).toContain('never call it done before then');
    }
  });
});

// ISS-1039 (#sid-email, 2026-11-06): a share was granted and a person said so in the thread by hand,
// outside Forge's door; the agent, finding no record, posted that it was still not shared. The brief
// taught "never done before the master confirms" and not the converse: an item's state comes from the
// record alone, and a claim the record does not back goes to the owning master, with one holding reply.
describe('the room brief states an item only from the record, either way', () => {
  const channel = supportBrief({
    projectName: 'P',
    product: null,
    tools: [],
    opening: agentOpening({
      projectName: 'P',
      product: null,
      channels: ['#mail'],
      ownerMode: false,
    }),
  });

  it('asserts neither done nor not done from what the record does not show', () => {
    for (const text of [brief, channel]) {
      expect(text).toContain(
        "never call it done before then, nor not done: an item's state is only what the record shows (that result, or a master's post through Forge)",
      );
      expect(text).toContain(
        "where the thread claims a state the record does not show, or the asker asks for one you cannot read, ask the owning project's master with support.record { project }, post one holding reply, and wait, asserting neither",
      );
    }
  });
});

// ISS-1011: a project may bind several support APIs (one Agenfold workspace each); the session reads
// which one each tool reads, so it can say which workspace it checked.
describe('the tools line names the binding each tool reads', () => {
  it('labels every tool of every binding with its binding', () => {
    const line = toolsLine([
      {
        name: 'machines_moc',
        kind: 'diagnose',
        method: 'GET',
        path: '/m',
        summary: 'list machines',
        binding: 'moc',
      },
      {
        name: 'machines_sid',
        kind: 'diagnose',
        method: 'GET',
        path: '/m',
        summary: 'list machines',
        binding: 'sidcorp',
      },
    ]);
    expect(line).toContain('- machines_moc (diagnose) on moc: list machines');
    expect(line).toContain('- machines_sid (diagnose) on sidcorp: list machines');
  });
});

// ISS-1243 (owner, 2026-11-15): the agent decided the project and whether to answer from the words
// alone; both briefs now tell it to read the routing signals first, gather before it asks, ask one
// short question at most, stay silent where nothing needs saying, and record every decision.
describe('every room brief decides each message from its meaning and records it', () => {
  const opening = agentOpening({
    projectName: 'P',
    product: null,
    channels: ['g1'],
    ownerMode: false,
  }).join('\n\n');
  it.each([
    ['the support brief', brief],
    ['the channel agent opening', opening],
  ])('%s routes by the signals, gathers before asking, and records the decision', (_, text) => {
    expect(text).toContain('record the decision with support.decide');
    expect(text).toContain("read its head's `routing` first, before any guess");
    expect(text).toContain('on a vague message gather on your own first (decision gather)');
    expect(text).toContain(
      'ask the person one short question (decision ask) only once that is exhausted',
    );
    expect(text).toContain('asks no "ok?" of anyone whose own request already agrees to it');
  });
});

// ISS-1243 (owner 2026-11-15, AdminHub-Support): every room agent keeps permission talk out of a work
// thread (item 12), says done only once live and checked criterion by criterion (item 18), and
// answers the asker with the deliverable asked for, short (item 19), in each brief it is handed.
describe('every room agent brief carries the room conduct', () => {
  const channel = supportBrief({
    projectName: 'P',
    product: null,
    tools: [],
    opening: agentOpening({ projectName: 'P', product: null, channels: ['#c'], ownerMode: false }),
  });
  const operations = operationsBrief({
    role: { name: 'ops', persona: 'You are ops.', grants: ['read'] } as unknown as Parameters<
      typeof operationsBrief
    >[0]['role'],
    scope: 'org',
    reach: [],
  });

  it('sends a permission need to the technical channel, never the thread', () => {
    for (const text of [brief, channel, operations]) {
      expect(text).toContain(NO_PERMISSION_TALK);
      expect(text).toContain('support.technical');
    }
    expect(brief).not.toContain('Forge posts nothing, so tell the person in your own words');
    expect(operations).not.toContain('who can do it instead');
  });

  it('says done only once live and checked against each thing asked', () => {
    for (const text of [brief, channel, operations]) expect(text).toContain(DONE_ONLY_WHEN_CHECKED);
  });

  it('answers the asker with the deliverable asked for, short, steps only for a guide', () => {
    for (const text of [brief, channel, operations]) expect(text).toContain(ANSWER_THE_ASKER);
  });

  // ISS-1250 (epod, 16/11): the operations room explained its grants and sent the owner to settings,
  // told its role's acts alone and to name who can grant the rest. Every brief now hands an act on
  // with ask_master, never says who could grant it, and links the web app, never the API host.
  it('hands an act it cannot make to the master, and tells no thread who could grant it', () => {
    expect(operations).toMatch(/Your acts: [^.]*\bask_master\b[^.]*\./);
    expect(operations).toContain('you hand on and never explain');
    for (const text of [brief, channel, operations, grantsLine({ abilities: [] } as never)]) {
      expect(text).not.toContain('naming who can grant it');
      expect(text).not.toContain("say in the persona's words what you could not do");
    }
    expect(NO_PERMISSION_TALK).toContain('support.ask_master');
    expect(NO_PERMISSION_TALK).toContain('never send anyone, the owner included, to a page');
    for (const text of [brief, channel, operations]) {
      expect(text).toContain(linksOnWeb('http://localhost:3000'));
    }
  });
});

// ISS-1250 (epod 16/11 02:21): the owner's ruling answered a post the epod master had just made in
// the thread, which the warm session never saw; each turn now hands a thread's last lines with it.
describe('a turn carries the last lines of its thread', () => {
  const line = (role: 'user' | 'assistant' | 'system', content: string, id: string | null) => ({
    role,
    content,
    authorLabel: role === 'user' ? 'chuong' : null,
    externalId: id,
  });

  it('holds the post just made there, frames a member as data, and leaves out what it hands', () => {
    const block = recentBlock(
      { thread: 't1' },
      [
        line('assistant', 'ePOD v1.4.2: the new errors read in Vietnamese.', 'm1'),
        line('system', 'stayed silent: chatter', null),
        line('user', 'ok', 'm2'),
        line('user', '@babo language per the setting, English by default', 'm3'),
      ],
      new Set(['m3']),
    );
    expect(block).toContain('"recent"');
    expect(block).toContain('bot: ePOD v1.4.2: the new errors read in Vietnamese.');
    expect(block).toContain('chuong: ');
    expect(block).not.toContain('English by default');
    expect(block).not.toContain('stayed silent');
  });

  it('is nothing for a thread with no line before the handed ones', () => {
    expect(recentBlock({ thread: 't1' }, [line('user', 'hi', 'm1')], new Set(['m1']))).toBeNull();
  });
});
