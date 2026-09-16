import { describe, expect, it } from 'vitest';
import { RUNNER_CAPABILITIES } from '../../pipeline/registry.js';
import { DEFAULT_STATE_SYSTEM_PROMPTS, getStatePrompt } from './index.js';

/**
 * ISS-1047 — this map may only hold blocks a job that can exist will receive.
 *
 * `RUNNER_CAPABILITIES` is the whole gate on which job types a runner may
 * claim; anything else is refused `runner_unsupported_type` before a prompt is
 * built. Eight entries keyed on the retired staged types outlived the ISS-895
 * lane removal here and rendered for nobody for nine days.
 */
describe('state-prompts — every entry is a block a claimable job can receive', () => {
  const claimable = new Set(Object.values(RUNNER_CAPABILITIES).flat());

  it('every key of DEFAULT_STATE_SYSTEM_PROMPTS is a claimable job type', () => {
    for (const step of Object.keys(DEFAULT_STATE_SYSTEM_PROMPTS)) {
      expect(claimable.has(step as never), `${step} is not in RUNNER_CAPABILITIES`).toBe(true);
    }
  });

  it('release_batch is the only claimable job type with a block', () => {
    const withBlock = [...claimable].filter((step) => getStatePrompt(step) !== null);
    expect(withBlock).toEqual(['release_batch']);
  });

  it('drive has no block, because the driver depth is the issue-flow skill', () => {
    expect(getStatePrompt('drive')).toBeNull();
  });
});

/**
 * ISS-1042 criterion 39 — the English-only rule covers the CHANGELOG only.
 *
 * It read "English-only: all output, comments, changelog", which swept in every
 * comment a release agent writes. On a project whose issues, thread and
 * operators work in another language, that is a release run answering in a
 * language nobody there reads — for a rule that only ever existed because a
 * changelog is a published artefact.
 */
describe('state-prompts — the batch release language rule', () => {
  const releaseBatch = getStatePrompt('release_batch') ?? '';

  it('binds the English requirement to the changelog and to nothing else', () => {
    expect(releaseBatch).toContain('The CHANGELOG entry is written in English');
    expect(releaseBatch).not.toContain('English-only');
    expect(releaseBatch).not.toMatch(/English[^.\n]*comments/);
  });

  it('says the rest goes in the language the project works in', () => {
    expect(releaseBatch).toMatch(/the language the project works in/);
  });

  it('tells the release agent to repair forward rather than roll back', () => {
    expect(releaseBatch).toContain('REPAIR FORWARD');
    expect(releaseBatch).toContain('Never roll back');
  });
});
