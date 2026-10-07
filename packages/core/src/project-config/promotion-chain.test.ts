import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { releasePathOf } from './release-path.js';
import { checkProjectConfig } from './rules.js';
import { type ProjectDocument, projectDocumentSchema } from './schema.js';

const ID = '11111111-1111-4111-8111-111111111111';

function document(
  promotions: ProjectDocument['promotions'],
  deploysFrom: string,
  branches = ['main', 'staging', 'release', 'live'],
): ProjectDocument {
  return projectDocumentSchema.parse({
    $schema: `${SCHEMA_BASE}/project-v1.json`,
    version: 1,
    project: { id: ID, slug: 'demo', name: 'Demo' },
    source: { type: 'git', git: { repository: 'github.com/o/r', defaultBranch: 'main', branches } },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments: { prod: { tier: 'production', deploysFrom, deployment: { mode: 'external' } } },
    promotions,
    rollback: { strategy: 'none' },
    execution: { plugin: { source: 'o/p', ref: 'a'.repeat(40) } },
  });
}

const ctx = { bindings: new Map(), testingProfileIds: new Set<string>() };
const codes = (doc: ProjectDocument) => checkProjectConfig(doc, ctx).map((r) => r.code);

describe('a release path the release cannot perform is refused at write', () => {
  it('accepts no promotion and one promotion into the production branch', () => {
    expect(codes(document([], 'main'))).not.toContain('PROMOTION_CHAIN_UNSUPPORTED');
    expect(codes(document([{ from: 'main', to: 'live', via: 'merge' }], 'live'))).not.toContain(
      'PROMOTION_CHAIN_UNSUPPORTED',
    );
  });

  it('refuses two crossings to reach the production branch, naming each', () => {
    const doc = document(
      [
        { from: 'main', to: 'staging', via: 'merge' },
        { from: 'staging', to: 'live', via: 'cherry-pick' },
      ],
      'live',
    );
    const refusal = checkProjectConfig(doc, ctx).find(
      (r) => r.code === 'PROMOTION_CHAIN_UNSUPPORTED',
    );
    expect(refusal?.path).toBe('/promotions');
    expect(refusal?.detail).toContain('main -> staging, staging -> live');
  });

  it('refuses the longest legal chain too', () => {
    const doc = document(
      [
        { from: 'main', to: 'staging', via: 'merge' },
        { from: 'staging', to: 'release', via: 'merge' },
        { from: 'release', to: 'live', via: 'merge' },
      ],
      'live',
    );
    expect(codes(doc)).toContain('PROMOTION_CHAIN_UNSUPPORTED');
  });

  it('does not count a promotion production does not deploy through', () => {
    const doc = document(
      [
        { from: 'main', to: 'live', via: 'merge' },
        { from: 'main', to: 'staging', via: 'merge' },
        { from: 'staging', to: 'release', via: 'merge' },
      ],
      'live',
    );
    expect(codes(doc)).not.toContain('PROMOTION_CHAIN_UNSUPPORTED');
  });
});

describe('the release path names the one promotion a landed change crosses', () => {
  it('reads no crossing where production deploys from the landing branch', () => {
    const read = releasePathOf(1, document([], 'main'));
    expect(read.ok && read.path.crossing).toBeNull();
  });

  it('reads the one promotion into the production branch', () => {
    const read = releasePathOf(
      1,
      document([{ from: 'main', to: 'live', via: 'cherry-pick' }], 'live'),
    );
    expect(read.ok && read.path.crossing).toEqual({ from: 'main', to: 'live', via: 'cherry-pick' });
  });

  it('refuses a chain of two by name instead of reading its last crossing', () => {
    const read = releasePathOf(
      3,
      document(
        [
          { from: 'main', to: 'staging', via: 'merge' },
          { from: 'staging', to: 'live', via: 'merge' },
        ],
        'live',
      ),
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toContain('crosses 2 promotions to reach `live`');
  });

  it('refuses a production branch no promotion reaches', () => {
    const read = releasePathOf(3, document([], 'live'));
    expect(!read.ok && read.reason).toContain('no promotion reaches `live` from `main`');
  });
});
