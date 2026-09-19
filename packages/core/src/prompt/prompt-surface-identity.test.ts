import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }));

const { RUNNER_CAPABILITIES } = await import('../pipeline/registry.js');
const { mandatoryPreambleBlocks } = await import('./facts/mandatory-blocks.js');
const { renderStageFactsText } = await import('./facts/resolve.js');
const { getStatePrompt } = await import('./state-prompts/index.js');

type Inputs = Parameters<typeof renderStageFactsText>[0];

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);

/** One fixed set, so a digest names the prompt text and never the fixture. */
function fixedInputs(): Inputs {
  return {
    ladder: [
      'open',
      'confirmed',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'awaiting_release',
      'closed',
    ],
    branches: { baseBranch: 'main', liveBranch: 'main', releaseModel: 'none' as const },
    noProgressRounds: 5,
    project: (key: string) =>
      key === 'integrations'
        ? '## Project integrations\nConnected integrations and how to use them:\n- **coolify** [Live] - Deploy via forge_coolify_deploy.'
        : undefined,
    projectFactKeys: ['build-commands'],
    alwaysInjectFacts: [],
    factsUnavailable: false,
    missingObligations: [],
    modules: [{ name: 'prompt', parentName: null }],
  };
}

const AT_ISS_1048: Record<string, { pipelineRules: string; toolReference: string; facts: string }> =
  {
    drive: {
      pipelineRules: 'dd3ea099c1b57c64c7c570241241227a',
      toolReference: 'efbbc2e0fdd496ca0ed2befd268054c8',
      facts: '8085844cb9be59f5c3efbb0af095b632',
    },
    release_batch: {
      pipelineRules: '9b0bbc296a7e1705a58e8cbf32ffd04f',
      toolReference: '5027a7b2dfbde84010bd5429c010d63a',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
    smoke: {
      pipelineRules: '9b0bbc296a7e1705a58e8cbf32ffd04f',
      toolReference: '5027a7b2dfbde84010bd5429c010d63a',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
    reconcile: {
      pipelineRules: '9b0bbc296a7e1705a58e8cbf32ffd04f',
      toolReference: '5027a7b2dfbde84010bd5429c010d63a',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
    verify_skill: {
      pipelineRules: '9b0bbc296a7e1705a58e8cbf32ffd04f',
      toolReference: '5027a7b2dfbde84010bd5429c010d63a',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
  };

const RELEASE_BATCH_STATE_PROMPT_AT_34D43E83 = '8ea75419bba908b9a137c43c012ec3f9';

describe('the prompt a claimable job receives is pinned to bytes', () => {
  const claimable = [...new Set(Object.values(RUNNER_CAPABILITIES).flat())].sort();

  it('pins exactly the job types a runner can claim', () => {
    expect(Object.keys(AT_ISS_1048).sort()).toEqual(claimable);
  });

  for (const step of ['drive', 'release_batch', 'smoke', 'reconcile', 'verify_skill'] as const) {
    it(`${step} gets exactly the two mandatory blocks pinned for it`, () => {
      const { pipelineRules, toolReference } = mandatoryPreambleBlocks(step);
      expect(sha(pipelineRules)).toBe(AT_ISS_1048[step]?.pipelineRules);
      expect(sha(toolReference)).toBe(AT_ISS_1048[step]?.toolReference);
    });

    it(`the ${step} facts block is byte-identical`, () => {
      expect(sha(renderStageFactsText(fixedInputs(), 'p-1', step))).toBe(AT_ISS_1048[step]?.facts);
    });
  }

  it('the release_batch state block is byte-identical', () => {
    expect(sha(getStatePrompt('release_batch') ?? '')).toBe(RELEASE_BATCH_STATE_PROMPT_AT_34D43E83);
  });
});
