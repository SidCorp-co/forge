import { describe, expect, it } from 'vitest';
import { flattenLogs, tailLog } from './logs.js';

describe('flattenLogs', () => {
  it('parses a JSON-encoded array of { output } lines', () => {
    const logs = JSON.stringify([
      { output: 'step 1', type: 'stdout' },
      { output: "Cannot find module '@codemirror/state'", type: 'stderr' },
    ]);
    expect(flattenLogs(logs)).toBe("step 1\nCannot find module '@codemirror/state'");
  });

  it('handles an already-decoded array', () => {
    expect(flattenLogs([{ output: 'a' }, { output: 'b' }])).toBe('a\nb');
  });

  it('falls back to the raw string when not JSON', () => {
    expect(flattenLogs('plain build log\nline 2')).toBe('plain build log\nline 2');
  });

  it('does not throw on an unexpected JSON shape — returns raw', () => {
    expect(flattenLogs('{"unexpected":true}')).toBe('{"unexpected":true}');
  });

  it('returns empty string for undefined logs', () => {
    expect(flattenLogs(undefined)).toBe('');
  });
});

describe('tailLog', () => {
  it('keeps the last maxLines lines and flags truncated', () => {
    const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
    const { text: out, truncated } = tailLog(text, 100, 1024 * 1024);
    const lines = out.split('\n');
    expect(lines).toHaveLength(100);
    expect(lines.at(-1)).toBe('line 249');
    expect(truncated).toBe(true);
  });

  it('does not flag truncated when under both bounds', () => {
    const { text, truncated } = tailLog('short\nlog', 100, 1024);
    expect(text).toBe('short\nlog');
    expect(truncated).toBe(false);
  });

  it('trims from the front to maxBytes, keeping the tail', () => {
    const text = 'x'.repeat(100);
    const { text: out, truncated } = tailLog(text, 1000, 16);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(16);
    expect(truncated).toBe(true);
    // the tail (last bytes) is preserved
    expect(text.endsWith(out)).toBe(true);
  });
});
