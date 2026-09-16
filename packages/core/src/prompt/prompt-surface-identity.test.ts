// ISS-1047 — what a CLAIMABLE job receives, pinned to bytes.
//
// The staged lane left eight state prompts and nine contextual facts behind,
// all keyed on job types `RUNNER_CAPABILITIES` refuses. Removing them must not
// move a byte of what the job types a runner CAN claim receive, and a count of
// surviving entries cannot prove that: a deletion and a rewrite both leave one
// entry standing.
//
// The digests below were taken at `34d43e83`, before the removal, by running
// this file against that tree.
// cm:guard the digests are EVIDENCE, not a target — re-recording one to make this
// green is the whole of what this test exists to stop. A deliberate change to what
// a drive or release_batch job is told re-takes them in the same commit that
// changes the text, and says so in that commit.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ env: { KNOWLEDGE_INJECTION_ENABLED: false } }));
vi.mock('../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn() } }));

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
    branches: { baseBranch: 'main', productionBranch: 'main' },
    noProgressRounds: 5,
    project: (key: string) =>
      key === 'integrations'
        ? '## Project integrations\nConnected integrations and how to use them:\n- **coolify** [production] - Deploy via forge_coolify_deploy.'
        : undefined,
    projectFactKeys: ['build-commands'],
    alwaysInjectFacts: [],
    modules: [{ name: 'prompt', parentName: null }],
  };
}

const AT_34D43E83 = {
  drivePipelineRules: 'fbe5bb53fb025294b46388b8cad8cb86',
  driveToolReference: 'db1d4c01c8e941a9bd62c6c8f853ee85',
  releaseBatchPipelineRules: '7773c03e395152f7a6b1bad83edb76be',
  releaseBatchToolReference: '9ca9c2695fa4ca38b656106199a8491c',
  driveFacts: 'b013bb553f87f18690759b99d5e1fbcf',
  releaseBatchFacts: 'a995f32f7ab94a52aaaa04ddee8bed7c',
  releaseBatchStatePrompt: '8ea75419bba908b9a137c43c012ec3f9',
};

describe('the prompt a claimable job receives is unchanged by ISS-1047', () => {
  it('drive gets the same two mandatory blocks it got at 34d43e83', () => {
    const { pipelineRules, toolReference } = mandatoryPreambleBlocks('drive');
    expect(sha(pipelineRules)).toBe(AT_34D43E83.drivePipelineRules);
    expect(sha(toolReference)).toBe(AT_34D43E83.driveToolReference);
  });

  it('release_batch gets the same two mandatory blocks it got at 34d43e83', () => {
    const { pipelineRules, toolReference } = mandatoryPreambleBlocks('release_batch');
    expect(sha(pipelineRules)).toBe(AT_34D43E83.releaseBatchPipelineRules);
    expect(sha(toolReference)).toBe(AT_34D43E83.releaseBatchToolReference);
  });

  it('the drive facts block is byte-identical', () => {
    expect(sha(renderStageFactsText(fixedInputs(), 'p-1', 'drive'))).toBe(AT_34D43E83.driveFacts);
  });

  it('the release_batch facts block is byte-identical', () => {
    expect(sha(renderStageFactsText(fixedInputs(), 'p-1', 'release_batch'))).toBe(
      AT_34D43E83.releaseBatchFacts,
    );
  });

  it('the release_batch state block is byte-identical', () => {
    expect(sha(getStatePrompt('release_batch') ?? '')).toBe(AT_34D43E83.releaseBatchStatePrompt);
  });
});
