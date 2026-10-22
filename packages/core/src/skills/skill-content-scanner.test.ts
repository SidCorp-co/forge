// ISS-614: an Anthropic key is read from `sk-ant-` where it starts a token, so a skill naming a
// record such as task-ant-colony-migration-plan is not a blocker; a key glued to a word still is.

import { describe, expect, it } from 'vitest';
import { scanSkillContent } from './skill-content-scanner.js';

const BODY = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv'.repeat(2);
const anthropic = (skillMd: string) =>
  scanSkillContent({ skillMd }).filter((f) => f.rule === 'secret.anthropic-key');

describe('the skill scanner reads an Anthropic key by where it starts', () => {
  it('passes a record id ending in sk-ant-', () => {
    expect(anthropic('Close task-ant-colony-migration-plan-2026 when done.')).toEqual([]);
  });

  it.each([
    ['alone', `key: sk-ant-api03-${BODY}`],
    ['glued to a word', `apikeysk-ant-api03-${BODY}`],
  ])('blocks a key %s, masked past its prefix', (_how, skillMd) => {
    const [finding] = anthropic(skillMd);
    expect(finding?.excerpt).toBe('sk-ant-***');
  });
});
