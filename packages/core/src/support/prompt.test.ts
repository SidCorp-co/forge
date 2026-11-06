import { describe, expect, it } from 'vitest';
import { agentOpening, supportBrief, toolsLine } from './prompt.js';

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
    expect(brief).not.toContain('type a code');
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
