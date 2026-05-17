import { afterEach, describe, expect, it } from 'vitest';
import { clearPlaintext, getPlaintext, stashPlaintext } from '@/features/token/lib/plaintext-store';

const TOKEN_ID = '11111111-1111-1111-1111-111111111111';

describe('plaintext-store', () => {
  afterEach(() => {
    clearPlaintext(TOKEN_ID);
  });

  it('returns null for unknown tokens', () => {
    expect(getPlaintext(TOKEN_ID)).toBeNull();
  });

  it('returns the stashed plaintext', () => {
    stashPlaintext(TOKEN_ID, 'forge_pat_live_abc');
    expect(getPlaintext(TOKEN_ID)).toBe('forge_pat_live_abc');
  });

  it('clears on demand', () => {
    stashPlaintext(TOKEN_ID, 'forge_pat_live_abc');
    clearPlaintext(TOKEN_ID);
    expect(getPlaintext(TOKEN_ID)).toBeNull();
  });
});
