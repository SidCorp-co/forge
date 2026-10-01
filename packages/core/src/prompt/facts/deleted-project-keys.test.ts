import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { APP_BASE_URL: 'https://forge.example.com', NODE_ENV: 'test' },
}));

const { mandatoryPreambleBlocks } = await import('./mandatory-blocks.js');
const { jobTypes } = await import('../../db/schema.js');

/**
 * Every line the deleted project keys produced in a job prompt, as `origin/dev` 0bbb1a55f rendered
 * it, beside the line that replaces it. Rendering every step before and after the deletion and
 * diffing the two gives exactly these six lines and nothing else.
 */
const CHANGED: ReadonlyArray<{ before: string; after: string }> = [
  {
    before: '/config`), categories, plugins, and reads back',
    after: '/config`), plugins, and reads back',
  },
  {
    before: 'On a project of kind `website` the stamp carries `landing`',
    after: 'On a project whose `source.type` is not `git` the stamp carries `landing`',
  },
  {
    before: 'On a project of kind `website` the work lands outside git, so the stamp names',
    after:
      'On a project whose `source.type` is not `git` the work lands outside git, so the stamp names',
  },
  {
    before: 'or, on a project of kind `website`, at the landing its mark names.',
    after: 'or, on a project whose `source.type` is not `git`, at the landing its mark names.',
  },
  {
    before: 'or, on a project of kind `website`, whose work lands outside git,',
    after: 'or, on a project whose `source.type` is not `git`, whose work lands outside git,',
  },
  {
    before: 'On a project of kind `website` there is no commit to check',
    after: 'On a project whose `source.type` is not `git` there is no commit to check',
  },
];

const DELETED = [
  /\bcategories\b/,
  /kind `website`/,
  /personaStyle/,
  /rocketChatAnswerMode/,
  /autoUpdate/,
];

const rendered = (step: (typeof jobTypes)[number] | null) => {
  const blocks = mandatoryPreambleBlocks(step);
  return `${blocks.pipelineRules}\n\n${blocks.toolReference}`;
};

describe('a job prompt after the project-identity keys are deleted', () => {
  const all = [null, ...jobTypes].map((step) => rendered(step)).join('\n');

  it.each(CHANGED)('renders "$after" where it rendered "$before"', ({ before, after }) => {
    expect(all).not.toContain(before);
    expect(all).toContain(after);
  });

  it.each([null, ...jobTypes])('names no deleted key on step %s', (step) => {
    const text = rendered(step);
    for (const key of DELETED) expect(text).not.toMatch(key);
  });
});
