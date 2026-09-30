import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { formatApiError, isRetryableApiError } from './error';

describe('isRetryableApiError', () => {
  it('refuses retry on a 400 — the malformed-identifier / missing-scope refusal', () => {
    expect(isRetryableApiError(new ApiError(400, 'Invalid input', 'BAD_REQUEST'))).toBe(false);
  });

  it('refuses retry on a 404 — the key-names-nothing refusal', () => {
    expect(isRetryableApiError(new ApiError(404, 'not found', 'NOT_FOUND'))).toBe(false);
  });

  it('refuses retry on a 403 — the project-the-caller-cannot-read refusal', () => {
    expect(isRetryableApiError(new ApiError(403, 'nope', 'FORBIDDEN'))).toBe(false);
  });

  it('allows retry on a 500 — a server fault the same request might not repeat', () => {
    expect(isRetryableApiError(new ApiError(500, 'boom', 'INTERNAL_ERROR'))).toBe(true);
  });

  it('allows retry on a non-ApiError — a transport failure, not a refusal', () => {
    expect(isRetryableApiError(new Error('fetch failed'))).toBe(true);
  });
});

// ISS-1327 — core's merge-mark refusals are written for agents and name every door; a person on the
// web has one, the issue's Mark merged control, and the toast that carries the sentence is short.
describe('formatApiError — the merge-mark refusals, in the web\'s words', () => {
  const words = (s: string) => s.trim().split(/\s+/).length;
  const AGENT_SENTENCE = 'x '.repeat(142);

  it('names Mark merged and "Where it landed" for a website close, in at most 60 words', () => {
    for (const held of ['unmarked', 'asserted']) {
      const msg = formatApiError(
        new ApiError(422, AGENT_SENTENCE, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedLanding', held }),
      );
      expect(msg).toContain('Mark merged');
      expect(msg).toContain('“Where it landed”');
      expect(words(msg)).toBeLessThanOrEqual(60);
    }
  });

  it('says Unmark first where the mark that stands names no landing', () => {
    const msg = formatApiError(
      new ApiError(422, AGENT_SENTENCE, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedLanding', held: 'asserted' }),
    );
    expect(msg).toContain('press Unmark first');
  });

  it('names Mark merged and no landing for a close on a project that lands in git', () => {
    const msg = formatApiError(new ApiError(422, AGENT_SENTENCE, 'CLOSE_REQUIRES_SHIPPED', { requires: 'mergedAt' }));
    expect(msg).toContain('Mark merged');
    expect(msg).not.toContain('landed');
  });

  it('names the landing that stands, and Unmark, for a refused correction', () => {
    const msg = formatApiError(
      new ApiError(422, 'core sentence', 'MARK_ALREADY_STANDS', { heldLanding: 'https://shop.example.com/a' }),
    );
    expect(msg).toContain('https://shop.example.com/a');
    expect(msg).toContain('press Unmark');
    expect(msg).toContain('nothing changed');
  });
});
