import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../knowledge/service.js', () => ({
  selectAlwaysInjectFromKnowledge: vi.fn(),
  selectOnDemandSlugsFromKnowledge: vi.fn(),
  selectAllSlugsFromKnowledge: vi.fn(),
}));
vi.mock('../../logger.js', () => ({ logger: { warn: vi.fn() } }));

const { renderStageFactsText } = await import('./resolve.js');
type Inputs = Parameters<typeof renderStageFactsText>[0];

function makeInputs(overrides?: Partial<Inputs>): Inputs {
  return {
    ladder: ['open', 'confirmed', 'approved', 'developed', 'testing', 'awaiting_release', 'closed'],
    branches: { baseBranch: null, liveBranch: null, releaseModel: 'none' as const },
    noProgressRounds: 5,
    project: () => undefined,
    projectFactKeys: ['build-commands'],
    alwaysInjectFacts: [],
    factsUnavailable: false,
    missingObligations: [],
    modules: [],
    ...overrides,
  };
}

describe('renderStageFactsText — an unreadable knowledge store says so (ISS-1048)', () => {
  it('renders a could-not-be-read block instead of an empty index', () => {
    const text = renderStageFactsText(
      makeInputs({ factsUnavailable: true, projectFactKeys: [], alwaysInjectFacts: [] }),
      'p-1',
      'drive',
    );
    expect(text).toContain('could not be read');
    expect(text).toContain('`forge_knowledge`');
    expect(text).toContain('Do not conclude');
    // The header stays and the body changes: an agent that skims headers still sees the section,
    // and what it finds under it is the reason it is empty rather than a list of nothing.
    expect(text).toContain('### Project guides (fetch on demand)');
    expect(text).not.toContain('Author-maintained guides exist');
  });

  it('says nothing about an unreadable store when the read succeeded', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'drive');
    expect(text).not.toContain('could not be read');
  });
});

describe('renderStageFactsText — undeclared project knowledge (ISS-1048)', () => {
  const OWED = [
    {
      slug: 'test-commands',
      role: 'how to run the tests a verdict rests on',
      because: 'this project declares a repository',
    },
  ];

  it('names each owed slug, what it is for, and the declaration that owes it', () => {
    const text = renderStageFactsText(makeInputs({ missingObligations: OWED }), 'p-1', 'drive');
    expect(text).toContain('### Undeclared project knowledge');
    expect(text).toContain('`test-commands`');
    expect(text).toContain('how to run the tests a verdict rests on');
    expect(text).toContain('owed because this project declares a repository');
  });

  it('renders no block at all when nothing is owed', () => {
    const text = renderStageFactsText(makeInputs(), 'p-1', 'drive');
    expect(text).not.toContain('Undeclared project knowledge');
  });

  it('tells the agent the gap blocks nothing but must not be invented around', () => {
    const text = renderStageFactsText(makeInputs({ missingObligations: OWED }), 'p-1', 'drive');
    expect(text).toContain('Nothing here blocks you');
    expect(text).toContain('rather than inventing the answer');
  });
});

/**
 * `{{project:<key>}}` — what a skill body gets when it asks for a branch.
 *
 * ISS-1046 retired `{{project:production-branch}}` and introduced `{{project:live-branch}}`,
 * which resolves only where the project declares it promotes. Both halves matter and neither
 * was asserted anywhere: the resolver was built privately inside the DB-backed loader, so the
 * only way to reach it was through a database.
 */
