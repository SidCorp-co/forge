import {
  FILTERED,
  SCRUB_MIN_SECRET_LENGTH,
  scrubLogText,
  scrubSecretValues,
  scrubSecretValuesDeep,
} from '@forge/observability';
import { describe, expect, it } from 'vitest';

const SECRET = 'pa"ss\\word-9';

describe('the scrubber takes a known value back out of job output', () => {
  it('replaces the value raw and in its JSON-escaped form', () => {
    expect(scrubSecretValues(`pw ${SECRET}`, [SECRET])).toBe(`pw ${FILTERED}`);
    const escaped = JSON.stringify({ pw: SECRET });
    expect(scrubSecretValues(escaped, [SECRET])).not.toContain('ss');
  });

  it('reaches a value nested past any depth bound, keys included', () => {
    let nested: unknown = { [SECRET]: SECRET };
    for (let i = 0; i < 20; i++) nested = [nested];
    expect(JSON.stringify(scrubSecretValuesDeep(nested, [SECRET]))).not.toContain('word-9');
  });

  it('leaves a value shorter than the floor alone, which is why the route refuses one', () => {
    const short = 'x'.repeat(SCRUB_MIN_SECRET_LENGTH - 1);
    expect(scrubSecretValues(`a ${short} b`, [short])).toBe(`a ${short} b`);
  });

  it('is the same replacement scrubLogText makes for an extra secret', () => {
    expect(scrubLogText(`login ${SECRET}`, [SECRET])).toBe(`login ${FILTERED}`);
  });
});
