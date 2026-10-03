import { describe, expect, it } from 'vitest';
import { CommentIntentRefused, defaultIntent, resolveIntent } from './service.js';

describe('a comment intent', () => {
  it('is taken as sent when it is in the closed set', () => {
    for (const intent of ['question', 'decision', 'note'] as const) {
      expect(resolveIntent(intent, false, 'hi')).toEqual({ intent, warning: null });
    }
  });

  it('is refused by name, with the valid set, when it is not', () => {
    expect(() => resolveIntent('feedback', false, 'hi')).toThrow(CommentIntentRefused);
    try {
      resolveIntent('feedback', false, 'hi');
    } catch (err) {
      expect((err as CommentIntentRefused).code).toBe('COMMENT_INTENT_UNKNOWN');
      expect((err as Error).message).toContain('send one of: question, decision, note');
    }
  });

  it("defaults a person's comment to question and warns that it did", () => {
    const { intent, warning } = resolveIntent(undefined, false, 'can you check the export?');
    expect(intent).toBe('question');
    expect(warning).toContain('COMMENT_INTENT_DEFAULTED');
  });

  it("defaults an agent's comment, or any record, to note", () => {
    expect(defaultIntent(true, 'done')).toBe('note');
    const record = [
      '```forge-record',
      'left: in_progress',
      '```',
      '`forge-record: park · contract 1`',
    ].join('\n');
    expect(defaultIntent(false, record)).toBe('note');
  });
});
