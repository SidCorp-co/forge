import { CHAT_CORRECTION_THRESHOLD } from '@forge/contracts/lessons';
import { describe, expect, it } from 'vitest';
import { chatClassifyPrompt, correctionReason, keepsCorrection } from './consumers.js';

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

  // ISS-1251: the reply is read against the thread it answers, and an open reading is said, never guessed
  it('reads the thread before the reply, and keeps an open reading said on the correction', () => {
    const prompt = chatClassifyPrompt('Ok, I will answer in English.', 'No, I meant the app.', [
      { who: 'assistant', label: 'Babo', text: 'The new app errors are in Vietnamese.' },
      { who: 'person', label: 'owner', text: 'Use the project language.' },
    ]);
    expect(prompt).toContain('Read the thread first');
    expect(prompt).toContain('Assistant: The new app errors are in Vietnamese.');
    expect(prompt).toContain('Person (owner): Use the project language.');
    const said = { correction: true, confidence: 0.9, what: 'Either reading.' };
    expect(correctionReason({ ...said, ambiguous: true })).toBe(
      'Either reading. (The thread leaves this reading open.)',
    );
    expect(correctionReason(said)).toBe('Either reading.');
  });
});
