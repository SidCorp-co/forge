import { describe, expect, it } from 'vitest';
import { DISPATCH_GUIDE } from '../guides/dispatch-guide.js';
import { ROOM_AGENT_GUIDE } from '../guides/room-agent-guide.js';
import { agentOpening, supportBrief } from './prompt.js';

// ISS-1251: the brief is a map naming the room agent's guide, where each line's detail now lives;
// what the agent is taught is the brief and that guide together
const taught = (b: string): string => {
  expect(b).toContain('support.guide {}');
  return `${b}\n\n${ROOM_AGENT_GUIDE.body}`;
};

// @direct-test-of packages/core/src/support/prompt.ts
// @direct-test-of packages/core/src/guides/dispatch-guide.ts
//
// ISS-1239 (REQ-103, FB-641/FB-642, 2026-11-14): a user took many rounds to find a button because
// the channel assistant guided them in words alone, and a guide of many steps arrived as a stream of
// messages. The assistant cannot attach a file; the master can (master-posts takes pictures and a
// PDF). Neither text told either side to show the screen, so both now do, and each sentence is held here.

const flat = (s: string): string => s.split(/\s+/).join(' ');

const briefs = [
  supportBrief({ projectName: 'P', product: null, tools: [] }),
  supportBrief({
    projectName: 'P',
    product: null,
    tools: [],
    opening: agentOpening({ projectName: 'P', product: null, channels: ['#g'], ownerMode: false }),
  }),
].map(flat);

const guide = flat(DISPATCH_GUIDE.body);

describe('a person asking about a screen is shown that screen', () => {
  it('the room brief has the assistant say the steps in words and never promise a guide file', () => {
    for (const b of briefs) {
      expect(taught(b)).toContain('show them the screen as they see it: look first');
      expect(taught(b)).toContain(
        "no route carries one into a users' room, so never say a guide, a PDF or pictures will follow",
      );
      expect(taught(b)).toContain('record it with support.record { kind: request, project }');
      expect(taught(b)).not.toContain('the guide will follow');
    }
  });

  it('the dispatch guide has the master build it on test data and make one PDF', () => {
    expect(guide).toContain('**A screen guide a room asked for.**');
    expect(guide).toContain('non-production environment with test data');
    expect(guide).toContain("never with a customer's data");
    expect(guide).toContain('goes as one PDF with one picture per step, in one message');
    expect(guide).toContain('`master-tells` carries facts and no file');
    expect(guide).toContain('post it with `attachments` in that thread');
  });
});
