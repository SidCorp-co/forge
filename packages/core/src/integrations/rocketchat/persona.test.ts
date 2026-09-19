/**
 * ISS-1086 — a turn cut before the room went quiet is told so in its persona, and
 * one that settled is not. The wiring from cut reason to room line is what is
 * under test; the composer's null-drop is `compose.test.ts`'s.
 */

import { describe, expect, it } from 'vitest';
import { MID_CONVERSATION_INSTRUCTION } from '../../assistant/door-persona.js';
import { midConversationLine, rocketChatChannelLines, rocketChatPersona } from './persona.js';

const persona = (cut: 'quiet' | 'deadline' | 'overflow' | null | undefined) =>
  rocketChatPersona('Forge', 'alice', { botName: 'Babo', cut });

describe('what a cut window tells the room turn', () => {
  it('carries the mid-conversation instruction when cut by the deadline (criterion 14)', () => {
    expect(persona('deadline')).toContain(MID_CONVERSATION_INSTRUCTION);
  });

  it('carries it when cut for overflow (criterion 15)', () => {
    expect(persona('overflow')).toContain(MID_CONVERSATION_INSTRUCTION);
  });

  it.each(['deadline', 'overflow'] as const)(
    'tells a %s turn each of the four behaviours in words',
    (reason) => {
      const text = persona(reason);
      expect(text).toContain(
        'Answer only the questions actually asked in the messages you were given',
      );
      expect(text).toContain('do not claim the room agreed on anything');
      expect(text).toContain('Prefer one short, targeted contribution over a summary of the room');
      expect(text).toContain('decline the turn');
    },
  );

  it('carries nothing of it when the window settled on quiet (criterion 16)', () => {
    expect(persona('quiet')).not.toContain(MID_CONVERSATION_INSTRUCTION);
    expect(persona('quiet')).not.toMatch(/Mid-conversation turn/);
  });

  it('reads a missing reason as quiet', () => {
    expect(midConversationLine(null)).toBeNull();
    expect(midConversationLine(undefined)).toBeNull();
    expect(persona(undefined)).toBe(persona('quiet'));
  });

  it('adds the line to the room lines and nowhere else', () => {
    const quiet = rocketChatChannelLines('alice', { botName: 'Babo', cut: 'quiet' });
    const cut = rocketChatChannelLines('alice', { botName: 'Babo', cut: 'deadline' });
    expect(cut).toHaveLength(quiet.length + 1);
    expect(cut[cut.length - 1]).toBe(`- Mid-conversation turn: ${MID_CONVERSATION_INSTRUCTION}`);
  });
});
