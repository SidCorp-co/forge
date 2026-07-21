import { describe, expect, it } from 'vitest';
import { isSystemNoise, stripSystemNoise } from './content-filter.js';

describe('isSystemNoise', () => {
  it('flags a RESULT_ERROR runner marker', () => {
    expect(isSystemNoise("[RESULT_ERROR] success: You've hit a rate limit")).toBe(true);
  });

  it('flags any [RESULT_*] marker', () => {
    expect(isSystemNoise('[RESULT_OK] done')).toBe(true);
  });

  it('flags a [Context: …] decoration', () => {
    expect(isSystemNoise('[Context: viewing /issues/ISS-1] hello')).toBe(true);
  });

  it('flags the rehydration transcript markers', () => {
    expect(isSystemNoise('[Your previous session was resumed on a different machine; ...]')).toBe(
      true,
    );
    expect(isSystemNoise('[End of prior transcript. Continue with the new message below.]')).toBe(
      true,
    );
  });

  it('flags empty / whitespace-only text', () => {
    expect(isSystemNoise('')).toBe(true);
    expect(isSystemNoise('   ')).toBe(true);
  });

  it('does not flag ordinary conversation text', () => {
    expect(isSystemNoise('Check giúp tôi lỗi này với')).toBe(false); // i18n-allow: non-English conversation fixture
    expect(isSystemNoise('What files are in this repo?')).toBe(false);
  });
});

describe('stripSystemNoise', () => {
  it('strips a leading [Context: …] line and keeps the rest', () => {
    expect(stripSystemNoise('[Context: viewing /issues/ISS-1] Can you check this?')).toBe(
      'Can you check this?',
    );
  });

  it('drops the whole string when it is a RESULT_ERROR blob', () => {
    expect(stripSystemNoise("[RESULT_ERROR] success: You've hit a rate limit")).toBe('');
  });

  it('drops the whole string when it is a rehydration marker', () => {
    expect(stripSystemNoise('[Your previous session was resumed...]')).toBe('');
  });

  it('passes through clean text unchanged', () => {
    expect(stripSystemNoise('Help me debug the runner dispatch loop')).toBe(
      'Help me debug the runner dispatch loop',
    );
  });

  it('returns empty for empty input', () => {
    expect(stripSystemNoise('')).toBe('');
    expect(stripSystemNoise('   ')).toBe('');
  });
});
