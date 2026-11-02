import { describe, expect, it } from 'vitest';
import { supportBrief } from './prompt.js';

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
