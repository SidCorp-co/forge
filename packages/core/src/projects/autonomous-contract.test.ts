import { describe, expect, it } from 'vitest';
import {
  declaresRepository,
  missingProjectKnowledge,
  requiredProjectKnowledge,
} from './autonomous-contract.js';
import { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';

const REPO = { repoPath: '/srv/app', repoUrl: null, releaseModel: 'none' } as const;
const NOTHING = { repoPath: null, repoUrl: null, releaseModel: 'none' } as const;

describe('declaresRepository', () => {
  it('accepts either column on its own', () => {
    expect(declaresRepository(REPO)).toBe(true);
    expect(declaresRepository({ ...NOTHING, repoUrl: 'git@github.com:x/y.git' })).toBe(true);
  });

  it('is false when both are null', () => {
    expect(declaresRepository(NOTHING)).toBe(false);
  });

  // cm:guard whitespace is the settings form's empty. Reading it as a declared repository owes the
  // project build and test commands for a checkout that does not exist, and the gap it then reports
  // is one nobody can close.
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
    expect(requiredProjectKnowledge({ ...NOTHING, releaseModel: 'promote' }).map((o) => o.slug)) //
      .toEqual(['release-procedure']);
    expect(
      requiredProjectKnowledge({ ...NOTHING, releaseModel: 'publish' }).map((o) => o.slug),
    ).toEqual(['release-procedure']);
    expect(requiredProjectKnowledge({ ...REPO, releaseModel: 'promote' }).map((o) => o.slug)) //
      .toEqual(['build-commands', 'test-commands', 'release-procedure']);
  });

  it('names the declaration that made each entry owed, since a gap has to say why', () => {
    const owed = requiredProjectKnowledge({ ...REPO, releaseModel: 'promote' });
    expect(owed.every((o) => o.role.trim().length > 0)).toBe(true);
    expect(owed[0]?.because).toContain('repository');
    expect(owed[2]?.because).toContain('promote');
  });

  // cm:guard a slug the reserved set already resolves is unwritable: `{{project:<key>}}` answers it
  // from a project column, so the obligation would demand an entry the author has no way to create.
  it('owes no slug that the reserved project keys already resolve', () => {
    const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
    const everyOwed = requiredProjectKnowledge({ ...REPO, releaseModel: 'promote' });
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

  // cm:guard the contract is about the text existing, not about how it is delivered. An entry set to
  // `on_demand` or `none` still answers it; treating only always-injected entries as present would
  // report a gap on a project that has written exactly what was asked for.
  it('accepts an owed slug whatever its injection setting, because presence is the question', () => {
    expect(missingProjectKnowledge(REPO, new Set(['build-commands', 'test-commands']))).toEqual([]);
  });
});
