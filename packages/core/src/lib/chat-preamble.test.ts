import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The preamble import graph reaches env-validating modules (embeddings via
// prompt facts); stub env so collection doesn't require real secrets.
vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef' },
}));

vi.mock('../db/client.js', () => {
  const select = vi.fn();
  return { db: { select } };
});

const { db } = await import('../db/client.js');
const { buildPipelinePreamble, buildPipelinePreambleStructured } = await import(
  './chat-preamble.js'
);

type Row = Record<string, unknown>;

function mockBranchSelect(rows: Row[] | Error): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).select.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          if (rows instanceof Error) throw rows;
          return rows;
        },
      }),
    }),
  }));
}

describe('buildPipelinePreambleStructured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns rules + tools + project-context (3 blocks) when project has no branches', async () => {
    // loadProjectBranches catches a thrown select chain and returns null,
    // which is the same path as "project row not found". The
    // project-context block (ISS-225) is unconditional and uses only the
    // projectId arg, so it appears even when branches are unknown.
    mockBranchSelect(new Error('no row'));

    const built = await buildPipelinePreambleStructured('p1');
    expect(built.blocks).toHaveLength(3);
    expect(built.blocks.map((b) => b.id)).toEqual([
      'pipeline-rules',
      'tool-reference',
      'project-context',
    ]);
  });

  it('adds project-config + project-context (4 blocks) when branches resolve', async () => {
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);

    const built = await buildPipelinePreambleStructured('p1');
    expect(built.blocks).toHaveLength(4);
    expect(built.blocks.map((b) => b.id)).toEqual([
      'pipeline-rules',
      'tool-reference',
      'project-config',
      'project-context',
    ]);
  });

  it('each block has { id, kind: "system", chars, estTokens } with chars === body.length', async () => {
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);

    const built = await buildPipelinePreambleStructured('p1');
    for (const block of built.blocks) {
      expect(block.kind).toBe('system');
      expect(typeof block.chars).toBe('number');
      expect(typeof block.estTokens).toBe('number');
      expect(block.chars).toBeGreaterThan(0);
      expect(block.estTokens).toBeGreaterThan(0);
    }
    // Sum of block chars == total content length (separators are joined into
    // content but not double-counted because every section body is in some block).
    const totalChars = built.blocks.reduce((sum, b) => sum + b.chars, 0);
    // `content` = sections joined with '\n\n' so total chars = sum + 2*(n-1).
    expect(built.content.length).toBe(totalChars + 2 * (built.blocks.length - 1));
  });

  it('inserts a state-block (after project-context) when a step is supplied', async () => {
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);

    const built = await buildPipelinePreambleStructured('p1', { step: 'release_batch' });
    expect(built.blocks.map((b) => b.id)).toEqual([
      'pipeline-rules',
      'tool-reference',
      'project-config',
      'project-context',
      'forge-facts',
      'state-block',
    ]);
    expect(built.content).toContain('REPAIR FORWARD');
  });

  it('omits the state-block for a claimable step with no default, and when no step given', async () => {
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);

    const noStep = await buildPipelinePreambleStructured('p1');
    expect(noStep.blocks.some((b) => b.id === 'state-block')).toBe(false);

    const drive = await buildPipelinePreambleStructured('p1', { step: 'drive' });
    expect(drive.blocks.some((b) => b.id === 'state-block')).toBe(false);

    const custom = await buildPipelinePreambleStructured('p1', { step: 'custom' });
    expect(custom.blocks.some((b) => b.id === 'state-block')).toBe(false);
  });

  it('renders the policy state a job runs under after project-config', async () => {
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);

    const built = await buildPipelinePreambleStructured('p1', {
      step: 'release_batch',
      policy: {
        revision: 3,
        qa: 'independent',
        status: 'open',
        from: 'entry',
        model: 'opus',
        profile: 'driver',
        deniedTools: ['Bash(git push:*)', 'CronCreate'],
      },
    });
    const ids = built.blocks.map((b) => b.id);
    expect(ids.indexOf('policy')).toBe(ids.indexOf('project-config') + 1);
    expect(built.content).toContain('## Policy');
    expect(built.content).toContain('policy revision 3, profile `driver`');
    expect(built.content).toContain('the entry state `open`');
    expect(built.content).toContain('`Bash(git push:*)`, `CronCreate`');
    expect(built.content).toContain('another run judges it');
  });

  it('renders no policy block for a preamble no job runs', async () => {
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);
    const built = await buildPipelinePreambleStructured('p1', { step: 'release_batch' });
    expect(built.blocks.map((b) => b.id)).not.toContain('policy');
  });

  it('content matches the unstructured buildPipelinePreamble for the same project', async () => {
    // Both functions independently call loadProjectBranches; give both calls
    // the same row so they take the same code path.
    mockBranchSelect([{ baseBranch: 'main', releaseChain: [] }]);

    const structured = await buildPipelinePreambleStructured('p1');
    const plain = await buildPipelinePreamble('p1');
    expect(structured.content).toBe(plain);
  });
});
