// A memory that copies code rots on the next commit (ISS-1251): the writer is told so on its answer,
// and the entry is stored as written. Whether a block earns its place is the writer's call, taught in
// the memory tool's `write` line; the warning is what a reader of the answer sees it was told.

import type { CurationWarning } from '@forge/contracts/knowledge';
import { MEMORY_AUTHORED_SOURCES } from '@forge/contracts/memory';

/** The longest fenced block a memory carries before its writer is warned. */
export const MAX_CODE_BLOCK_LINES = 5;

/** The line count of the longest fenced (```/~~~) block, 0 if none. */
export function longestFencedBlockLines(text: string): number {
  let longest = 0;
  let openFence: string | null = null;
  let blockLines = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimStart();
    const fence = line.match(/^(`{3,}|~{3,})/)?.[1] ?? null;
    if (openFence === null) {
      if (fence) {
        openFence = fence[0] === '`' ? '```' : '~~~';
        blockLines = 0;
      }
    } else if (fence?.startsWith(openFence)) {
      openFence = null;
      longest = Math.max(longest, blockLines);
    } else {
      blockLines += 1;
    }
  }
  // Unterminated fence: everything after the opener is the block.
  if (openFence !== null) longest = Math.max(longest, blockLines);
  return longest;
}

/** The write's warning for a fenced block longer than `MAX_CODE_BLOCK_LINES`, on a source an agent authors. */
export function codeBlockWarning(source: string, text: string): CurationWarning[] {
  if (!(MEMORY_AUTHORED_SOURCES as readonly string[]).includes(source)) return [];
  const lines = longestFencedBlockLines(text);
  if (lines <= MAX_CODE_BLOCK_LINES) return [];
  return [
    {
      code: 'CODE_BLOCK_LONG',
      path: '/textContent',
      detail: `stored with a ${lines}-line fenced code block (over ${MAX_CODE_BLOCK_LINES}): copied code rots on the next commit, so a rewrite that keeps the invariant in one sentence and points at the code by path and symbol or a commit reads true for longer; a one-line runnable command is fine`,
    },
  ];
}
