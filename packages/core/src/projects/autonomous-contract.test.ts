import { describe, expect, it } from 'vitest';
import {
  declaresRepository,
  missingProjectKnowledge,
  requiredProjectKnowledge,
} from './autonomous-contract.js';
import { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';

const REPO = { repository: 'github.com/x/y', production: null };
const NOTHING = { repository: null, production: null };

describe('declaresRepository', () => {
  it('is the document declaring a repository', () => {
    expect(declaresRepository(REPO)).toBe(true);
  });

  it('is false when it is null', () => {
    expect(declaresRepository(NOTHING)).toBe(false);
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

  it('owes a release procedure wherever the project document declares a production environment', () => {
    expect(requiredProjectKnowledge({ ...NOTHING, production: 'beta' }).map((o) => o.slug)) //
      .toEqual(['release-procedure']);
    expect(requiredProjectKnowledge({ ...REPO, production: 'beta' }).map((o) => o.slug)) //
      .toEqual(['build-commands', 'test-commands', 'release-procedure']);
  });

  it('names the declaration that made each entry owed, since a gap has to say why', () => {
    const owed = requiredProjectKnowledge({ ...REPO, production: 'beta' });
    expect(owed.every((o) => o.role.trim().length > 0)).toBe(true);
    expect(owed[0]?.because).toContain('repository');
    expect(owed[2]?.because).toContain('production environment `beta`');
  });

  it('owes no slug that the reserved project keys already resolve', () => {
    const reserved = new Set<string>(RESERVED_PROJECT_FACT_KEYS);
    const everyOwed = requiredProjectKnowledge({ ...REPO, production: 'beta' });
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
