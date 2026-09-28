import { describe, expect, it } from 'vitest';
import {
  declaresRepository,
  missingProjectKnowledge,
  requiredProjectKnowledge,
} from './autonomous-contract.js';
import { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';

const SHIPS_NOTHING: { branch: string; from?: 'merge-branch' | 'cherry-pick' }[] = [];
const CROSSES = [{ branch: 'main' }, { branch: 'live', from: 'merge-branch' as const }];
const PUBLISHES = [{ branch: 'main' }];

const REPO = { repoPath: '/srv/app', repoUrl: null, releaseChain: SHIPS_NOTHING } as const;
const NOTHING = { repoPath: null, repoUrl: null, releaseChain: SHIPS_NOTHING } as const;

describe('declaresRepository', () => {
  it('accepts either column on its own', () => {
    expect(declaresRepository(REPO)).toBe(true);
    expect(declaresRepository({ ...NOTHING, repoUrl: 'git@github.com:x/y.git' })).toBe(true);
  });

  it('is false when both are null', () => {
    expect(declaresRepository(NOTHING)).toBe(false);
  });

  it('counts a whitespace-only column as no repository', () => {
    expect(declaresRepository({ ...NOTHING, repoPath: '   ' })).toBe(false);
    expect(declaresRepository({ ...NOTHING, repoUrl: '\n\t' })).toBe(false);
  });
});

describe('requiredProjectKnowledge', () => {
  it('owes nothing when the project declares neither a repository nor a release', () => {
    expect(requiredProjectKnowledge(NOTHING)).toEqual([]);
  });

  it('owes build and test commands once a repository is declared', () => {
    expect(requiredProjectKnowledge(REPO).map((o) => o.slug)).toEqual([
      'build-commands',
      'test-commands',
    ]);
  });

  it('owes a release procedure for every release model except none', () => {
    expect(requiredProjectKnowledge({ ...NOTHING, releaseChain: CROSSES }).map((o) => o.slug)) //
      .toEqual(['release-procedure']);
    expect(
      requiredProjectKnowledge({ ...NOTHING, releaseChain: PUBLISHES }).map((o) => o.slug),
    ).toEqual(['release-procedure']);
    expect(requiredProjectKnowledge({ ...REPO, releaseChain: CROSSES }).map((o) => o.slug)) //
      .toEqual(['build-commands', 'test-commands', 'release-procedure']);
  });

  it('names the declaration that made each entry owed, since a gap has to say why', () => {
    const owed = requiredProjectKnowledge({ ...REPO, releaseChain: CROSSES });
    expect(owed.every((o) => o.role.trim().length > 0)).toBe(true);
    expect(owed[0]?.because).toContain('repository');
    expect(owed[2]?.because).toContain('release chain');
    expect(owed[2]?.because).toContain('live');
  });

  it('owes no slug that the reserved project keys already resolve', () => {
    const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
    const everyOwed = requiredProjectKnowledge({ ...REPO, releaseChain: CROSSES });
    expect(everyOwed.filter((o) => reserved.has(o.slug))).toEqual([]);
  });
});

describe('missingProjectKnowledge', () => {
  it('is empty when the store holds every owed slug', () => {
    expect(missingProjectKnowledge(REPO, ['build-commands', 'test-commands'])).toEqual([]);
  });

  it('reports only the owed slugs the store is missing', () => {
    expect(missingProjectKnowledge(REPO, ['build-commands']).map((o) => o.slug)) //
      .toEqual(['test-commands']);
  });

  it('ignores slugs the project holds that nothing owes', () => {
    expect(
      missingProjectKnowledge(REPO, ['build-commands', 'test-commands', 'house-style']),
    ).toEqual([]);
  });

  it('accepts an owed slug whatever its injection setting, because presence is the question', () => {
    expect(missingProjectKnowledge(REPO, new Set(['build-commands', 'test-commands']))).toEqual([]);
  });
});
