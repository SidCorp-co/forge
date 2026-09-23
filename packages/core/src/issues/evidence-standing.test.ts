/**
 * Whether what a verdict cites is still there, against what the tracker holds.
 */

import { describe, expect, it } from 'vitest';
import { citationSentence, citationStanding, unresolvedCitations } from './evidence-standing.js';

const HELD = new Set(['qa-iss497-judging-log.md', 'c17-cleared.png']);
const WHOLE = '33637c612ef15be6f924520c0d201a0889d8ed7e';

describe('what a citation resolves to', () => {
  it('reads a file name the issue holds an attachment under as held', () => {
    expect(citationStanding('c17-cleared.png', HELD)).toBe('held');
    expect(citationStanding('  c17-cleared.png  ', HELD)).toBe('held');
  });

  it('reads a file name the issue holds nothing under as dangling', () => {
    expect(citationStanding('c4-readonly-archive.png', HELD)).toBe('dangling');
  });

  it('reads a path on the machine that wrote it as unreachable', () => {
    expect(citationStanding('/tmp/claude-1000/scratchpad/c17-cleared.png', HELD)).toBe(
      'unreachable',
    );
    expect(citationStanding('~/forge-local-docs/qa-iss497/log.md', HELD)).toBe('unreachable');
    expect(citationStanding('file:///tmp/c17-cleared.png', HELD)).toBe('unreachable');
  });

  it('reads a URL as elsewhere, held or not', () => {
    expect(citationStanding('https://example.test/c17-cleared.png', HELD)).toBe('elsewhere');
  });

  it('reads an object id as elsewhere', () => {
    expect(citationStanding(WHOLE, HELD)).toBe('elsewhere');
    expect(citationStanding('afd83c9', HELD)).toBe('elsewhere');
  });

  it('reads a path inside the repository as elsewhere', () => {
    expect(citationStanding('packages/core/src/ws/server.test.ts', HELD)).toBe('elsewhere');
  });

  it('reads a value no path segment admits as a file name, so it dangles', () => {
    expect(citationStanding('captures/my shot.png', HELD)).toBe('dangling');
    expect(citationStanding('network capture in-page', HELD)).toBe('dangling');
  });

  it('does not read a held name as elsewhere because it happens to look like a path', () => {
    expect(citationStanding('docs/flows/index.html', new Set(['docs/flows/index.html']))).toBe(
      'elsewhere',
    );
  });
});

describe('what a reader is told', () => {
  it('keeps only the citations that do not resolve, in the order written', () => {
    const reports = unresolvedCitations(
      ['c17-cleared.png', 'gone.png', WHOLE, '/tmp/also-gone.png'],
      HELD,
    );
    expect(reports).toEqual([
      { cited: 'gone.png', standing: 'dangling' },
      { cited: '/tmp/also-gone.png', standing: 'unreachable' },
    ]);
  });

  it('finds nothing to report where every citation resolves or points elsewhere', () => {
    expect(unresolvedCitations(['c17-cleared.png', WHOLE], HELD)).toEqual([]);
  });

  it('names each citation and why it does not resolve', () => {
    const sentence = citationSentence(
      unresolvedCitations(['gone.png', '/tmp/also-gone.png'], HELD),
    );
    expect(sentence).toContain('gone.png');
    expect(sentence).toContain('names no attachment this issue holds');
    expect(sentence).toContain('/tmp/also-gone.png');
    expect(sentence).toContain('the tracker never held');
  });
});
