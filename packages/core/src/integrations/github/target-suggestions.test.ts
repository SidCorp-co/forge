import { describe, expect, it } from 'vitest';
import { type RepositoryTarget, suggestTargets } from './target-suggestions.js';

const repo = (owner: string, name: string, installationId = 7): RepositoryTarget => ({
  provider: 'github',
  installationId,
  owner,
  repo: name,
});
const project = (over: Partial<{ slug: string; name: string; repository: string | null }>) => ({
  id: 'p1',
  slug: 'forge',
  name: 'Forge',
  repository: null,
  ...over,
});

describe('suggestTargets pre-ticks a repository only where one answer exists', () => {
  it('takes the repository the project declared, over a namesake', () => {
    const targets = [repo('someone', 'forge'), repo('SidCorp-co', 'engine')];
    const [s] = suggestTargets([project({ repository: 'github.com/sidcorp-co/Engine' })], targets);
    expect(s).toEqual({ projectId: 'p1', by: 'repository', target: targets[1] });
  });

  it('reads an SSH remote as the same declared repository', () => {
    const targets = [repo('SidCorp-co', 'forge')];
    const [s] = suggestTargets(
      [project({ repository: 'git@github.com:SidCorp-co/forge.git' })],
      targets,
    );
    expect(s?.by).toBe('repository');
  });

  it('offers nothing when the declared GitHub repository is not seen, never a namesake', () => {
    const targets = [repo('SidCorp-co', 'forge')];
    expect(suggestTargets([project({ repository: 'github.com/other/forge' })], targets)).toEqual(
      [],
    );
  });

  it('matches the slug exactly, ignoring case, when nothing is declared on GitHub', () => {
    const targets = [repo('SidCorp-co', 'Forge-Core'), repo('SidCorp-co', 'forge-core-ui')];
    const [s] = suggestTargets(
      [project({ slug: 'forge-core', name: 'Core', repository: 'gitlab.com/x/forge-core' })],
      targets,
    );
    expect(s).toEqual({ projectId: 'p1', by: 'slug', target: targets[0] });
  });

  it('matches the name when the slug matches nothing', () => {
    const targets = [repo('SidCorp-co', 'storefront')];
    const [s] = suggestTargets([project({ slug: 'shop', name: 'Storefront' })], targets);
    expect(s).toEqual({ projectId: 'p1', by: 'name', target: targets[0] });
  });

  it('PLANT ambiguity: two repositories of one name are named, never guessed between', () => {
    const targets = [repo('SidCorp-co', 'forge', 1), repo('chuongld', 'forge', 2)];
    const [s] = suggestTargets([project({})], targets);
    expect(s).toEqual({ projectId: 'p1', by: 'ambiguous', candidates: targets });
  });

  it('PLANT ambiguity: a slug and a name pointing at different repositories is ambiguous', () => {
    const targets = [repo('SidCorp-co', 'shop'), repo('SidCorp-co', 'storefront')];
    const [s] = suggestTargets([project({ slug: 'shop', name: 'Storefront' })], targets);
    expect(s?.by).toBe('ambiguous');
  });

  it('PLANT no match: a project nothing matches is left out, unticked', () => {
    const targets = [repo('SidCorp-co', 'forge-plugin'), repo('SidCorp-co', 'forgery')];
    expect(suggestTargets([project({})], targets)).toEqual([]);
  });

  it('a slug and a name naming the same repository is one candidate, not two', () => {
    const targets = [repo('SidCorp-co', 'forge')];
    const [s] = suggestTargets([project({ slug: 'forge', name: 'forge' })], targets);
    expect(s?.by).toBe('slug');
  });
});
