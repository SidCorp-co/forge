import { CHAT_CORRECTION_THRESHOLD } from '@forge/contracts/lessons';
import { describe, expect, it } from 'vitest';
import { chatClassifyPrompt, keepsCorrection } from './consumers.js';

describe('a chat reply is kept as a correction only above the threshold (REQ-50 BC-1)', () => {
  it('keeps a correction at the threshold with a sentence, and nothing below it', () => {
    const at = {
      correction: true,
      confidence: CHAT_CORRECTION_THRESHOLD,
      what: 'It missed the consent box.',
    };
    expect(keepsCorrection(at)).toBe(true);
    expect(keepsCorrection({ ...at, confidence: CHAT_CORRECTION_THRESHOLD - 0.01 })).toBe(false);
    expect(keepsCorrection({ ...at, correction: false })).toBe(false);
    expect(keepsCorrection({ ...at, what: '  ' })).toBe(false);
    expect(keepsCorrection(null)).toBe(false);
  });

  it('asks about both messages, cut to a bounded length', () => {
    const prompt = chatClassifyPrompt('a'.repeat(9000), 'No, the other ward.');
    expect(prompt).toContain('Person:\nNo, the other ward.');
    expect(prompt.length).toBeLessThan(6000);
  });
});
