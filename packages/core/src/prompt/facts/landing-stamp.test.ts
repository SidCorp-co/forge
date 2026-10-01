// ISS-1327 — a project whose source is not git refuses a mark naming no landing, so the prompt must teach one.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { APP_BASE_URL: 'https://forge.example.com', NODE_ENV: 'test' },
}));

const { mandatoryPreambleBlocks } = await import('./mandatory-blocks.js');

function stampSentences(text: string): string {
  return text
    .split(/(?<=[.;])\s+/)
    .filter((s) => /mark_merged|issues\/<id>\/merge|\bstamp\b/.test(s))
    .join('\n');
}

describe('the stamp the prompt teaches names a landing on a project whose source is not git', () => {
  it.each([
    ['drive rules', mandatoryPreambleBlocks('drive').pipelineRules],
    ['drive tool reference', mandatoryPreambleBlocks('drive').toolReference],
    ['pipeline rules', mandatoryPreambleBlocks('code').pipelineRules],
  ])('%s', (_surface, text) => {
    const stamps = stampSentences(text);
    expect(stamps).toContain('`source.type` is not `git`');
    expect(stamps).toMatch(/landing/);
  });

  // Owner ruling on ISS-1327: a project outside git has no commit to check, and none is a false mark.
  it.each([
    ['drive rules', mandatoryPreambleBlocks('drive').pipelineRules],
    ['pipeline rules', mandatoryPreambleBlocks('code').pipelineRules],
  ])('%s never asks an agent outside git to check a commit before it stamps', (_surface, text) => {
    const outside = text
      .split(/(?<=[.;])\s+/)
      .filter((s) => s.includes('`source.type` is not `git`'))
      .join('\n');
    expect(outside).toContain('no commit to check');
    expect(outside).not.toMatch(/reachable|merge-base|ON THE REMOTE/);
    // The git check still stands, and names its own shape.
    expect(text).toMatch(/On a project that lands in git, confirm the commits/);
  });
});
