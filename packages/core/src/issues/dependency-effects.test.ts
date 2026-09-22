import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { issueDependencyKinds } from '../db/schema.js';
import { FORGE_GUIDES } from '../guides/registry.js';
import { FORGE_FACTS } from '../prompt/facts/registry.js';
import {
  describeDependencyKind,
  GATES_DISPATCH_NOTE,
  WORK_EVIDENCE_WAIVER_KIND,
  WORK_EVIDENCE_WAIVER_NOTE,
} from './dependency-effects.js';

vi.mock('../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/stub',
  },
}));
vi.mock('../db/client.js', () => ({ db: {} }));

const { forgeProjectPmTool } = await import('../mcp/tools/forge-project-pm.js');
const { forgePmSetDependencyTool } = await import('../mcp/tools/forge-pm-set-dependency.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

function read(relative: string): string {
  return readFileSync(resolve(REPO, relative), 'utf8');
}

const fakeCtx = { principal: {}, deprecations: new Set<string>() } as never;

describe('describeDependencyKind', () => {
  it('names the waiver on exactly one kind', () => {
    const waiving = issueDependencyKinds.filter(
      (k) => describeDependencyKind(k).waivesWorkEvidence,
    );
    expect(waiving).toEqual([WORK_EVIDENCE_WAIVER_KIND]);
  });

  it('names dispatch gating on exactly `blocks`', () => {
    const gating = issueDependencyKinds.filter((k) => describeDependencyKind(k).gatesDispatch);
    expect(gating).toEqual(['blocks']);
  });

  it('gives the waiver kind the note every agent-facing surface renders', () => {
    expect(describeDependencyKind(WORK_EVIDENCE_WAIVER_KIND).note).toBe(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('never calls the waiver kind inert', () => {
    const note = describeDependencyKind(WORK_EVIDENCE_WAIVER_KIND).note;
    expect(note).toContain('work-evidence gate');
    expect(note).not.toMatch(/gates nothing|holds nothing back|no lifecycle of its own/);
  });
});

describe('the three surfaces that render the note', () => {
  it('the `issue-dependencies` guide', () => {
    const guide = FORGE_GUIDES.find((g) => g.slug === 'issue-dependencies');
    expect(guide?.body).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('no prompt fact claims to render it, because none reaches an agent', () => {
    for (const fact of FORGE_FACTS) {
      expect(fact.render({ projectId: 'p', stage: null }), fact.id).not.toContain(
        WORK_EVIDENCE_WAIVER_NOTE,
      );
    }
  });

  it('the `forge_pm.set_dependency` tool description', () => {
    expect(forgePmSetDependencyTool(fakeCtx).description).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('the `forge_project_pm` action description', () => {
    expect(forgeProjectPmTool(fakeCtx).description).toContain(WORK_EVIDENCE_WAIVER_NOTE);
  });

  it('spells the gating rule once, so `merged_at` cannot creep back in as what holds B', () => {
    const description = forgePmSetDependencyTool(fakeCtx).description;
    expect(description).toContain(GATES_DISPATCH_NOTE);
    expect(description).not.toMatch(/waits for A's `merged_at`/);
  });
});

describe('the query the surfaces describe', () => {
  const source = read('packages/core/src/pipeline/work-evidence.ts');

  it('filters on the constant, not a literal kind', () => {
    expect(source).toContain('eq(issueDependencies.kind, WORK_EVIDENCE_WAIVER_KIND)');
  });

  it('holds no bare dependency-kind literal', () => {
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    for (const kind of issueDependencyKinds) {
      expect(code).not.toContain(`'${kind}'`);
    }
  });
});
