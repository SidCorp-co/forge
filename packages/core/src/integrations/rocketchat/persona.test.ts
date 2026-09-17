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

  it('carries nothing of it when the window settled on quiet (criterion 16)', () => {
    expect(persona('quiet')).not.toContain(MID_CONVERSATION_INSTRUCTION);
    expect(persona('quiet')).not.toMatch(/MID-CONVERSATION/);
  });

  // cm:guard an absent reason is a row claimed before the column existed, and it reads exactly as `quiet` here as it does in the router's detail: two readings of one null would be the two that disagree.
  it('reads a missing reason as quiet', () => {
    expect(midConversationLine(null)).toBeNull();
    expect(midConversationLine(undefined)).toBeNull();
    expect(persona(undefined)).toBe(persona('quiet'));
  });

  it('adds the line to the room lines and nowhere else', () => {
    const quiet = rocketChatChannelLines('alice', { botName: 'Babo', cut: 'quiet' });
    const cut = rocketChatChannelLines('alice', { botName: 'Babo', cut: 'deadline' });
    expect(cut).toHaveLength(quiet.length + 1);
    expect(cut[cut.length - 1]).toBe(`- ${MID_CONVERSATION_INSTRUCTION}`);
  });
});
