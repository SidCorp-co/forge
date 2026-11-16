import { describe, expect, it } from 'vitest';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { actCard, mapLine } from './act-cards.js';
import { operationsBrief } from './ops-prompt.js';
import { agentOpening, grantsLine, SUPPORT_MAP_ACTS, supportBrief, toolsLine } from './prompt.js';
import { linksOnWeb, ROOM_MAP_ACTS, roomConductLines } from './room-conduct.js';

// ISS-1251: a map line is its act's card's lead situation, rendered; the card is the one text
const NO_PERMISSION_TALK = mapLine('ask_master');
const DONE_ONLY_WHEN_CHECKED = mapLine('releases');
const ANSWER_THE_ASKER = mapLine('asker');

// ISS-1251: the brief is a map naming the room agent's guide, where each line's detail now lives;
// what the agent is taught is the brief and that guide together
const taught = (b: string): string => {
  expect(b).toContain('support.guide {}');
  return `${b}\n\n${ROOM_AGENT_GUIDE.body}`;
};

const brief = supportBrief({ projectName: 'P', product: null, tools: [] });

// ISS-861 (owner, 2026-11-01): the channel agent is told what it is for and the one limit a change
// meets — a person's plain yes, cited with support.agree — never a numbered script to walk.
describe('the support brief states goals, and the consent a change waits on', () => {
  it('carries no numbered how-to-work script', () => {
    expect(taught(brief)).not.toContain('How to work:');
    expect(brief).not.toMatch(/\n\d\. /);
    expect(taught(brief)).toContain('What you are for: answer, diagnose, fix and record');
  });

  it('keeps the consent and the claim a change waits on, in the agent own words', () => {
    expect(taught(brief)).toContain(
      'only once they agree in plain words and you cite that message with support.agree',
    );
    expect(taught(brief)).toContain('never claim it ran or was recorded until agree says so');
    // ISS-1243 item 17: a filing asked for by its asker is agreed by the request itself.
    expect(taught(brief)).toContain(
      'their asking is their agreement, so cite it with support.agree at once',
    );
    expect(taught(brief)).not.toContain('runs or is filed only once they agree');
    expect(taught(brief)).not.toContain("cite the asker's plain yes");
    expect(taught(brief)).not.toContain('type a code');
  });

  // ISS-1162 (REQ-75 BC-12): a diagnose posts nothing in the room; its check is on the action.
  it('says a diagnose posts nothing in the room and its check is recorded on the action', () => {
    expect(taught(brief)).not.toContain('the group sees each check');
    expect(taught(brief)).toContain(
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
      expect(taught(text)).toContain('Work you can do now, do now, in this turn');
      expect(taught(text)).toContain('say in the task what it waits for');
      // ISS-1208 (FB-609): a reply answers every part of the message, or names the part it cannot yet.
      expect(taught(text)).toContain(
        'answer each question the message asked and cover each item it asked for',
      );
      // ISS-1211 (FB-613, agenfold L-46): look a fact up before asking a person for it.
      expect(taught(text)).toContain('Before you ask a person for a fact or recommend a change');
      // ISS-1214 (FB-618, agenfold L-74): a person's choice goes in, in their words, replacing what it corrects.
      expect(taught(text)).toContain("A person's choice or correction");
      expect(taught(text)).toContain('replaces the line it corrects');
      // ISS-1217 (FB-621, agenfold L-17): an organization is not its workspaces; act on the one named.
      expect(taught(text)).toContain('which organization holds which workspaces');
      expect(taught(text)).toContain(
        'a workspace rename renames the workspace, never its organization',
      );
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
    expect(taught(channel)).toContain(
      'a request through support.record { project } to the master of the project that owns it',
    );
    expect(taught(channel)).toContain('post one reply that it went to the team');
    expect(taught(channel)).toContain(
      'reply again only with what that master did or decided once you are told it, never done before then and never options or steps the master has not given',
    );
    expect(taught(channel)).toContain('save the one reply that an ask went to the team');
  });

  it('tells a result as what the team said or shipped, never done before it', () => {
    for (const text of [brief, channel]) {
      expect(taught(text)).toContain(
        'You are told once recorded work is answered, live or will not be done, with what the team said or shipped',
      );
      expect(taught(text)).toContain('never call it done before then');
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
      expect(taught(text)).toContain(
        "never call it done before then, nor not done: an item's state is only what the record shows (that result, or a master's post through Forge)",
      );
      expect(taught(text)).toContain(
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
  const opening = supportBrief({
    projectName: 'P',
    product: null,
    tools: [],
    opening: agentOpening({ projectName: 'P', product: null, channels: ['g1'], ownerMode: false }),
  });
  it.each([
    ['the support brief', brief],
    ['the channel agent brief', opening],
  ])('%s routes by the signals, gathers before asking, and records the decision', (_, text) => {
    expect(taught(text)).toContain('record the decision with support.decide');
    expect(taught(text)).toContain("read its head's `routing` first, before any guess");
    expect(taught(text)).toContain('on a vague message gather on your own first (decision gather)');
    expect(taught(text)).toContain(
      'ask the person one short question (decision ask) only once that is exhausted',
    );
    expect(taught(text)).toContain(
      'asks no "ok?" of anyone whose own request already agrees to it',
    );
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
      expect(taught(text)).toContain(NO_PERMISSION_TALK);
      expect(taught(text)).toContain('support.technical');
    }
    expect(taught(brief)).not.toContain(
      'Forge posts nothing, so tell the person in your own words',
    );
    expect(operations).not.toContain('who can do it instead');
  });

  it('says done only once live and checked against each thing asked', () => {
    for (const text of [brief, channel, operations])
      expect(taught(text)).toContain(DONE_ONLY_WHEN_CHECKED);
  });

  it('answers the asker with the deliverable asked for, short, steps only for a guide', () => {
    for (const text of [brief, channel, operations])
      expect(taught(text)).toContain(ANSWER_THE_ASKER);
  });

  // ISS-1250 (epod, 16/11): the operations room explained its grants and sent the owner to settings,
  // told its role's acts alone and to name who can grant the rest. Every brief now teaches it to read
  // who asks and the thread (asker), hand an act on with ask_master, and link the web app.
  it('hands an act it cannot make to the master, and tells no thread who could grant it', () => {
    expect(operations).toMatch(/Your acts: [^.]*\bask_master\b[^.]*\./);
    expect(operations).toContain('you hand on and never explain');
    for (const text of [brief, channel, operations, grantsLine({ abilities: [] } as never)]) {
      expect(text).not.toContain('naming who can grant it');
      expect(text).not.toContain("say in the persona's words what you could not do");
    }
    expect(NO_PERMISSION_TALK).toContain('support.ask_master');
    expect(NO_PERMISSION_TALK).toContain('never send anyone, the owner included, to a page');
    expect(actCard('ask_master').situations[1]?.do).toContain('a refusal is a problem to solve');
    // who is asking, and the thread around the ruling, are read through asker before acting on it
    expect(ANSWER_THE_ASKER).toContain('support.asker { thread, message }');
    expect(ANSWER_THE_ASKER).toContain('to the owner, the decision or result first');
    expect(operations).toMatch(/Your acts: [^.]*\basker\b[^.]*\./);
    expect(taught(brief)).toContain('read them with support.asker');
    for (const text of [brief, channel, operations]) {
      expect(taught(text)).toContain(linksOnWeb('http://localhost:3000'));
    }
  });
});

// ISS-1251 (owner 2026-11-16, prompt-is-a-map): the brief is a map of situations and their doors, its
// detail in the room agent's guide; every map line opens on the situation it is for.
describe('the room brief is a map of situations', () => {
  it('opens each map and conduct line on its situation, and stays short', () => {
    for (const line of [...SUPPORT_MAP_ACTS.map(mapLine), ...roomConductLines('http://w')]) {
      expect(line).toMatch(/^- When [^:]+: /);
    }
    expect(brief.length).toBeLessThan(5_000);
    expect(ROOM_AGENT_GUIDE.body).toContain('### Deciding each message');
  });

  // ISS-1251 (owner 2026-11-16, one capability, one card): the brief repeats no act's teaching
  // beside its card; each map line is the card's lead situation, naming the act it reaches for, so
  // a card's text change is the brief's change
  it('renders each map line from the card of the act it names', () => {
    for (const act of [...SUPPORT_MAP_ACTS, ...ROOM_MAP_ACTS]) {
      const line = mapLine(act);
      const [lead] = actCard(act).situations;
      expect(line, act).toContain(`support.${act}`);
      expect(line, act).toContain(lead?.when);
      expect(brief, act).toContain(line);
    }
  });

  it('carries the member record’s line, so a writer the record lacks is kept (ISS-1251 proof 1)', () => {
    expect(brief).toContain(mapLine('member'));
    expect(mapLine('member')).toContain('support.member { member, roles, message }');
  });
});
