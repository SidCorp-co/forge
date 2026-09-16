// ISS-1047 — what a CLAIMABLE job receives, pinned to bytes.
//
// The staged lane left eight state prompts and nine contextual facts behind,
// all keyed on job types `RUNNER_CAPABILITIES` refuses. Removing them must not
// move a byte of what the job types a runner CAN claim receive, and a count of
// surviving entries cannot prove that: a deletion and a rewrite both leave one
// entry standing.
//
// The digests below were taken at `34d43e83`, before the removal, by running
// this file against that tree, and RE-TAKEN by ISS-1046 in the commit that moved
// the text — which is what the guard below asks for, not an exemption from it.
// What ISS-1046 changed, and why each digest moved:
//   · `pipelineRules` / `toolReference` for the four non-drive steps — three
//     sentences in `facts/registry.ts` named `productionBranch`, a column that no
//     longer exists. They now name `liveBranch` and say it is read only under
//     `releaseModel: 'promote'`. `drive`'s two blocks are UNCHANGED, and that is
//     the evidence the edit was to the shared text rather than to the driver's.
//   · every `facts` digest — `formatProjectConfig` renders the live-branch line
//     only under `promote`, and the fixture below declares `none`. At 34d43e83
//     every project was told a `productionBranch` whatever its release was, which
//     is the defect ISS-1046 exists to remove. The fixture's integrations string
//     also reads `[Live]` rather than `[production]`, a scope the renderer can no
//     longer produce.
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
    modules: [{ name: 'prompt', parentName: null }],
  };
}

// cm:guard one entry per CLAIMABLE job type, and the keys are checked against
// `RUNNER_CAPABILITIES` below rather than trusted: pinning only `drive` and `release_batch` would
// leave a fact scoped to `smoke`, `reconcile` or `verify_skill` changing a working job's prompt
// with every digest here still green, which is the hole this table had when it was first written.
const AT_ISS_1046: Record<string, { pipelineRules: string; toolReference: string; facts: string }> =
  {
    drive: {
      pipelineRules: 'fbe5bb53fb025294b46388b8cad8cb86',
      toolReference: 'db1d4c01c8e941a9bd62c6c8f853ee85',
      facts: '8085844cb9be59f5c3efbb0af095b632',
    },
    release_batch: {
      pipelineRules: '19eab60ca9881ff42c9a5f5a56cf9955',
      toolReference: '59d2871434d24008337ead630cbfa380',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
    smoke: {
      pipelineRules: '19eab60ca9881ff42c9a5f5a56cf9955',
      toolReference: '59d2871434d24008337ead630cbfa380',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
    reconcile: {
      pipelineRules: '19eab60ca9881ff42c9a5f5a56cf9955',
      toolReference: '59d2871434d24008337ead630cbfa380',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
    verify_skill: {
      pipelineRules: '19eab60ca9881ff42c9a5f5a56cf9955',
      toolReference: '59d2871434d24008337ead630cbfa380',
      facts: '7fdb7e7706a48d360dc31e7c345b6824',
    },
  };

const RELEASE_BATCH_STATE_PROMPT_AT_34D43E83 = '8ea75419bba908b9a137c43c012ec3f9';

describe('the prompt a claimable job receives is pinned to bytes', () => {
  const claimable = [...new Set(Object.values(RUNNER_CAPABILITIES).flat())].sort();

  // cm:guard without this, a job type ADDED to RUNNER_CAPABILITIES gets no digest and the suite
  // stays green while saying it covers every claimable job — the table would silently stop being
  // the thing its own name claims.
  it('pins exactly the job types a runner can claim', () => {
    expect(Object.keys(AT_ISS_1046).sort()).toEqual(claimable);
  });

  for (const step of ['drive', 'release_batch', 'smoke', 'reconcile', 'verify_skill'] as const) {
    it(`${step} gets exactly the two mandatory blocks pinned for it`, () => {
      const { pipelineRules, toolReference } = mandatoryPreambleBlocks(step);
      expect(sha(pipelineRules)).toBe(AT_ISS_1046[step]?.pipelineRules);
      expect(sha(toolReference)).toBe(AT_ISS_1046[step]?.toolReference);
    });

    it(`the ${step} facts block is byte-identical`, () => {
      expect(sha(renderStageFactsText(fixedInputs(), 'p-1', step))).toBe(AT_ISS_1046[step]?.facts);
    });
  }

  it('the release_batch state block is byte-identical', () => {
    expect(sha(getStatePrompt('release_batch') ?? '')).toBe(RELEASE_BATCH_STATE_PROMPT_AT_34D43E83);
  });
});
