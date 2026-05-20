import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => {
  const select = vi.fn();
  return { db: { select } };
});

const { db } = await import('../db/client.js');
const { buildPipelinePreamble, PIPELINE_RULES, TOOL_REFERENCE } = await import(
  './chat-preamble.js'
);

type Row = Record<string, unknown>;

function mockSelectOnce(rows: Row[]): void {
  // biome-ignore lint/suspicious/noExplicitAny: test-only mock chain
  (db as any).select.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({ limit: async () => rows }),
    }),
  }));
}

describe('buildPipelinePreamble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders >= 3000 chars for a project with both branches configured', async () => {
    mockSelectOnce([{ baseBranch: 'main', productionBranch: 'main' }]);
    const out = await buildPipelinePreamble('project-uuid');
    expect(out.length).toBeGreaterThanOrEqual(3000);
    expect(out).toContain('## Pipeline Rules');
    expect(out).toContain('## Tool Reference');
    expect(out).toContain('## Project Config');
    expect(out).toContain('- stagingBranch: main');
    expect(out).toContain('- productionBranch: main');
    // The configured-branch path must NOT append the detection helper.
    expect(out).not.toContain('<detect-from-git>');
  });

  it('emits the <detect-from-git> sentinel + detection helper when branches are null', async () => {
    mockSelectOnce([{ baseBranch: null, productionBranch: null }]);
    const out = await buildPipelinePreamble('project-uuid');
    expect(out).toContain('<detect-from-git>');
    expect(out).toContain('git symbolic-ref refs/remotes/origin/HEAD');
    // Even with no project config, the rules + tool block alone must still
    // be substantial enough that the cache key remains stable.
    expect(out.length).toBeGreaterThanOrEqual(3000);
  });

  it('still returns the static rules + tools when the project row is missing', async () => {
    mockSelectOnce([]);
    const out = await buildPipelinePreamble('missing-project');
    expect(out).toContain('## Pipeline Rules');
    expect(out).toContain('## Tool Reference');
    expect(out).toContain('<detect-from-git>');
  });

  it('PIPELINE_RULES covers status / branch / learnings / sessionContext / output', () => {
    expect(PIPELINE_RULES).toContain('Status LAST');
    expect(PIPELINE_RULES).toContain('Branch discipline');
    expect(PIPELINE_RULES).toContain('ISS-* branch is the source of truth');
    expect(PIPELINE_RULES).toContain('Fetch issue first');
    expect(PIPELINE_RULES).toContain('English only');
    expect(PIPELINE_RULES).toContain('Capture Learnings');
    expect(PIPELINE_RULES).toContain('Session Context');
    expect(PIPELINE_RULES).toContain('Output Rules');
  });

  it('TOOL_REFERENCE lists the MCP tools available to pipeline jobs', () => {
    expect(TOOL_REFERENCE).toContain('forge_issues');
    expect(TOOL_REFERENCE).toContain('forge_comments');
    expect(TOOL_REFERENCE).toContain('forge_memory');
    expect(TOOL_REFERENCE).toContain('forge_config');
    expect(TOOL_REFERENCE).toContain('forge_skills');
    expect(TOOL_REFERENCE).toContain('forge_projects');
  });
});
