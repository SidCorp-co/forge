// ISS-1251: a long fenced block in a memory is warned on the write's answer, never refused.
// @direct-test-of packages/core/src/memory/code-block.ts

import { describe, expect, it } from 'vitest';
import { codeBlockWarning, longestFencedBlockLines, MAX_CODE_BLOCK_LINES } from './code-block.js';

const fenced = (lines: number, fence = '```') =>
  [fence, ...Array.from({ length: lines }, (_, i) => `line ${i}`), fence].join('\n');

describe('a fenced block in a memory', () => {
  it('is counted by its inner lines, either fence, and to the end where it is never closed', () => {
    expect(longestFencedBlockLines('no code here')).toBe(0);
    expect(longestFencedBlockLines(fenced(3))).toBe(3);
    expect(longestFencedBlockLines(fenced(4, '~~~'))).toBe(4);
    expect(longestFencedBlockLines(`intro\n${fenced(2)}\n${fenced(7)}`)).toBe(7);
    expect(longestFencedBlockLines('```\na\nb\nc')).toBe(3);
  });

  it('warns past the limit by code and path, and says nothing at it', () => {
    expect(codeBlockWarning('note', fenced(MAX_CODE_BLOCK_LINES))).toEqual([]);
    expect(codeBlockWarning('note', fenced(MAX_CODE_BLOCK_LINES + 1))).toEqual([
      expect.objectContaining({ code: 'CODE_BLOCK_LONG', path: '/textContent' }),
    ]);
  });

  it('weighs only what agents and people author, never a mirror of another record', () => {
    expect(codeBlockWarning('knowledge', fenced(9))).toHaveLength(1);
    expect(codeBlockWarning('comment', fenced(9))).toEqual([]);
    expect(codeBlockWarning('issue', fenced(9))).toEqual([]);
  });
});
