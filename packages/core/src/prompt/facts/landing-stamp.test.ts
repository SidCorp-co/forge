// ISS-1327 — a `website` project refuses a mark naming no landing, so the prompt must teach one.

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

describe('the stamp the prompt teaches names a landing on a website project', () => {
  it.each([
    ['drive rules', mandatoryPreambleBlocks('drive').pipelineRules],
    ['drive tool reference', mandatoryPreambleBlocks('drive').toolReference],
    ['pipeline rules', mandatoryPreambleBlocks('code').pipelineRules],
  ])('%s', (_surface, text) => {
    const stamps = stampSentences(text);
    expect(stamps).toContain('kind `website`');
    expect(stamps).toMatch(/landing/);
  });
});
