import { describe, expect, it } from 'vitest';
import { DISPATCH_GUIDE } from '../guides/dispatch-guide.js';
import { agentOpening, supportBrief } from './prompt.js';

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
  it('the room brief has the assistant offer a picture guide and ask the master for it on a yes', () => {
    for (const b of briefs) {
      expect(b).toContain('show them the screen as they see it, not words alone');
      expect(b).toContain(
        'on their plain yes, ask the master of the project that owns the screen for it with support.record { kind: request, project }',
      );
      expect(b).toContain('say in the thread that the guide will follow');
      expect(b).toContain('made away from production with test data');
      expect(b).toContain('one PDF in one message, never one message per step');
    }
  });

  it('the dispatch guide has the master build it on test data and post one PDF in the thread', () => {
    expect(guide).toContain('**A screen guide a room asked for.**');
    expect(guide).toContain('non-production environment with test data');
    expect(guide).toContain("never with a customer's data");
    expect(guide).toContain('goes as one PDF with one picture per step, in one message');
    expect(guide).toContain("post it with `attachments` in the asker's thread");
  });
});
