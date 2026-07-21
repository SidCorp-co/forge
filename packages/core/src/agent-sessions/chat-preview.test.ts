import { describe, expect, it } from 'vitest';
import { extractTurnPreview } from './chat-preview.js';

describe('extractTurnPreview', () => {
  it('returns a plain string turn as-is', () => {
    expect(extractTurnPreview('Hello there')).toBe('Hello there');
  });

  it('joins Anthropic-style text blocks', () => {
    expect(
      extractTurnPreview([
        { type: 'text', text: 'First line' },
        { type: 'text', text: 'second line' },
      ]),
    ).toBe('First line second line');
  });

  it('returns null for tool-only content', () => {
    expect(extractTurnPreview([{ type: 'tool_use', name: 'Bash', input: {} }])).toBeNull();
  });

  it('returns null for empty/whitespace-only content', () => {
    expect(extractTurnPreview('   ')).toBeNull();
    expect(extractTurnPreview([])).toBeNull();
    expect(extractTurnPreview(null)).toBeNull();
  });

  it('strips a leading [Context: …] decoration', () => {
    expect(extractTurnPreview('[Context: viewing /issues/ISS-1] Can you check this?')).toBe(
      'Can you check this?',
    );
  });

  it('returns null for a [RESULT_ERROR] runner-internal blob', () => {
    expect(extractTurnPreview("[RESULT_ERROR] success: You've hit a rate limit")).toBeNull();
  });

  it('truncates to 140 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const result = extractTurnPreview(long);
    expect(result).toHaveLength(140);
    expect(result?.endsWith('…')).toBe(true);
  });
});
