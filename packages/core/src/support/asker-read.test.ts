import { describe, expect, it } from 'vitest';
import { markUntrusted } from '../lib/untrusted-text.js';
import { readerFor, rolesOfAccount } from './asker-read.js';
import {
  aroundMessage,
  SUPPORT_MEMBER_SOURCE,
  THREAD_BOT_SOURCE,
  type ThreadLine,
} from './thread-context.js';

// @direct-test-of packages/core/src/support/asker-read.ts
// @direct-test-of packages/core/src/support/thread-context.ts
//
// ISS-1250 (epod thread, 16/11): the owner's 02:21 ruling ("language per the setting, English by
// default") answered the epod master's 02:18 post (the new errors read in Vietnamese), and the room
// agent, knowing nothing of him nor of that post, read it as one about its own settings. `asker` is
// the door it reads both through; these are its pure parts.

const line = (
  role: ThreadLine['role'],
  content: string,
  id: string | null,
  who: string | null = null,
): ThreadLine => ({
  role,
  content,
  authorLabel: who,
  authorKey: who ? `u-${who}` : null,
  externalId: id,
});
const member = (text: string) => markUntrusted(text, { source: SUPPORT_MEMBER_SOURCE });

describe('the thread around a message', () => {
  const lines: ThreadLine[] = [
    line('user', 'keep the CLI errors short', 'm1', 'chuong'),
    line('user', 'what about the theme?', 'b1', 'bob'),
    line('user', 'and log them', 'm2', 'chuong'),
    ...['a', 'b', 'c', 'd', 'e'].map((x) => line('user', `chatter ${x}`, `c${x}`, 'bob')),
    line('system', 'stayed silent: chatter', null),
    line('assistant', 'ePOD v1.4.2 is live: the new errors read in Vietnamese.', 'm3'),
    line('user', '@babo language per the setting, English by default', 'm4', 'chuong'),
    line('user', 'later line', 'm5', 'bob'),
  ];

  it('hands the post the ruling answers, and what its writer said earlier, never what came after', () => {
    const around = aroundMessage(lines, 'm4', 'u-chuong');
    // ISS-1425: a bot's post (a master's among them) and a member's line reach the turn framed
    expect(around.recent.at(-1)).toEqual({
      from: 'bot',
      text: markUntrusted('ePOD v1.4.2 is live: the new errors read in Vietnamese.', {
        source: THREAD_BOT_SOURCE,
      }),
    });
    expect(around.recent).toHaveLength(6);
    const said = around.recent.map((l) => l.text).join('\n');
    expect(said).not.toContain('stayed silent: chatter');
    expect(said).not.toContain('later line');
    expect(said).not.toContain('@babo language per the setting, English by default');
    expect(around.theirEarlier).toEqual([
      { from: 'chuong', text: member('keep the CLI errors short') },
      { from: 'chuong', text: member('and log them') },
    ]);
  });
});

describe('who is asking, from their Forge account', () => {
  it('reads the organization owner as the owner, and an admin or project admin as a deciding builder', () => {
    expect(rolesOfAccount('owner', [])).toEqual(['product', 'technical']);
    expect(rolesOfAccount('member', [{ role: 'admin' }])).toEqual(['product', 'technical']);
    expect(rolesOfAccount('member', [{ role: 'member' }])).toEqual(['technical']);
    expect(rolesOfAccount(null, [{ role: 'viewer' }])).toEqual(['user']);
    expect(readerFor('owner', { roles: ['user'] }, ['product', 'technical'])).toBe('owner');
  });

  it('lets the record a person confirmed say how deep a reply goes, else the account', () => {
    expect(readerFor('member', { roles: ['user'] }, ['technical'])).toBe('plain');
    expect(readerFor('member', null, ['technical'])).toBe('detail');
    expect(readerFor(null, null, ['user'])).toBe('plain');
  });
});
