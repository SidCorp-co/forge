import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { closeHierarchy, driftFromSets, nearestCommonAncestorId } = await import(
  './module-drift.js'
);

/**
 * ISS-951 — the set difference, the threshold and the hierarchy closure carry the whole meaning of
 * the drift signal, and none of them needs a database. The SQL half (the `kind='module'` filter,
 * pair canonicalisation, distinct-issue counting) is exercised against real Postgres in
 * `tests/integration/module-drift-e2e.test.ts`, because a mocked client cannot fail those.
 */

const node = (labelId: string, name: string, parentId: string | null = null) => ({
  labelId,
  name,
  slug: name.toLowerCase(),
  knowledgeEntryId: null,
  parentId,
});

const observedEdge = (aLabelId: string, bLabelId: string, issueCount: number) => ({
  aLabelId,
  bLabelId,
  issueCount,
  primaryAnchoredIssueCount: issueCount,
  recentIssueSeqs: [issueCount],
});

const drift = (
  nodes: ReturnType<typeof node>[],
  observed: ReturnType<typeof observedEdge>[],
  overrides: { minCoOccurrence?: number } = {},
) =>
  driftFromSets({
    nodes,
    observed,
    minCoOccurrence: overrides.minCoOccurrence ?? 2,
    generatedAt: '2026-09-07T00:00:00.000Z',
  });

describe('driftFromSets — the signal (ISS-951)', () => {
  it('reports an observed pair the hierarchy does not declare, with the weight it rests on', () => {
    const report = drift([node('a', 'Alpha'), node('b', 'Beta')], [observedEdge('a', 'b', 4)]);

    expect(report.layer).toBe('module-taxonomy');
    expect(report.undeclared).toHaveLength(1);
    expect(report.undeclared[0]?.a.name).toBe('Alpha');
    expect(report.undeclared[0]?.b.name).toBe('Beta');
    expect(report.undeclared[0]?.issueCount).toBe(4);
    expect(report.undeclared[0]?.nearestCommonAncestor).toBeNull();
    expect(report.agreedEdgeCount).toBe(0);
  });

  it('does not report a pair that co-occurred once, and counts it below the threshold', () => {
    const report = drift([node('a', 'Alpha'), node('b', 'Beta')], [observedEdge('a', 'b', 1)]);

    expect(report.undeclared).toHaveLength(0);
    expect(report.observed.belowThresholdEdgeCount).toBe(1);
    expect(report.observed.edgeCount).toBe(1);
  });

  it('reports that same pair once the caller lowers the threshold to one', () => {
    const report = drift([node('a', 'Alpha'), node('b', 'Beta')], [observedEdge('a', 'b', 1)], {
      minCoOccurrence: 1,
    });

    expect(report.undeclared).toHaveLength(1);
    expect(report.observed.belowThresholdEdgeCount).toBe(0);
  });

  it('does not report a parent and its child, nor a transitive ancestor', () => {
    const nodes = [node('a', 'Alpha'), node('b', 'Beta', 'a'), node('c', 'Gamma', 'b')];
    const report = drift(nodes, [observedEdge('a', 'b', 9), observedEdge('a', 'c', 7)]);

    expect(report.undeclared).toHaveLength(0);
    expect(report.agreedEdgeCount).toBe(2);
    expect(report.declaration).toEqual({
      state: 'present',
      source: 'label-hierarchy',
      edgeCount: 3,
    });
  });

  it('reports two children of one parent, and names the parent they hang under', () => {
    const nodes = [node('p', 'Parent'), node('a', 'Alpha', 'p'), node('b', 'Beta', 'p')];
    const report = drift(nodes, [observedEdge('a', 'b', 3)]);

    expect(report.undeclared).toHaveLength(1);
    expect(report.undeclared[0]?.nearestCommonAncestor?.name).toBe('Parent');
  });

  it('separates the primary-anchored issues from the secondary-only ones', () => {
    const report = drift(
      [node('a', 'Alpha'), node('b', 'Beta')],
      [{ ...observedEdge('a', 'b', 5), primaryAnchoredIssueCount: 2 }],
    );

    expect(report.undeclared[0]?.issueCount).toBe(5);
    expect(report.undeclared[0]?.primaryAnchoredIssueCount).toBe(2);
  });

  it('orders the findings by weight, heaviest first', () => {
    const nodes = [node('a', 'Alpha'), node('b', 'Beta'), node('c', 'Gamma')];
    const report = drift(nodes, [
      observedEdge('a', 'b', 2),
      observedEdge('b', 'c', 11),
      observedEdge('a', 'c', 5),
    ]);

    expect(report.undeclared.map((e) => e.issueCount)).toEqual([11, 5, 2]);
  });

  it('names each pair in a stable order rather than the order the join returned it', () => {
    const nodes = [node('z', 'Zulu'), node('a', 'Alpha')];
    const report = drift(nodes, [observedEdge('z', 'a', 2)]);

    expect(report.undeclared[0]?.a.name).toBe('Alpha');
    expect(report.undeclared[0]?.b.name).toBe('Zulu');
  });

  it('drops an observed edge naming a module this project does not have', () => {
    const report = drift([node('a', 'Alpha')], [observedEdge('a', 'ghost', 6)]);

    expect(report.undeclared).toHaveLength(0);
  });
});

describe('driftFromSets — the other half of the difference (ISS-951)', () => {
  it('reports a declared pair the issue stream has never linked', () => {
    const nodes = [node('a', 'Alpha'), node('b', 'Beta', 'a')];
    const report = drift(nodes, []);

    expect(report.unobserved).toEqual([
      {
        a: { labelId: 'a', name: 'Alpha', slug: 'alpha', knowledgeEntryId: null },
        b: { labelId: 'b', name: 'Beta', slug: 'beta', knowledgeEntryId: null },
        issueCount: 0,
      },
    ]);
  });

  it('reports a declared pair whose co-occurrence is below the threshold, with what it has', () => {
    const nodes = [node('a', 'Alpha'), node('b', 'Beta', 'a')];
    const report = drift(nodes, [observedEdge('a', 'b', 1)]);

    expect(report.unobserved).toHaveLength(1);
    expect(report.unobserved[0]?.issueCount).toBe(1);
  });

  it('leaves a declared pair out of both lists once it is observed enough', () => {
    const nodes = [node('a', 'Alpha'), node('b', 'Beta', 'a')];
    const report = drift(nodes, [observedEdge('a', 'b', 2)]);

    expect(report.unobserved).toHaveLength(0);
    expect(report.undeclared).toHaveLength(0);
    expect(report.agreedEdgeCount).toBe(1);
  });
});

describe('driftFromSets — a project that declares nothing (ISS-951)', () => {
  it('says the declaration is absent and still returns the observed graph', () => {
    const report = drift([node('a', 'Alpha'), node('b', 'Beta')], [observedEdge('a', 'b', 3)]);

    expect(report.declaration).toEqual({
      state: 'absent',
      source: 'label-hierarchy',
      edgeCount: 0,
    });
    expect(report.undeclared).toHaveLength(1);
    expect(report.observed.moduleCount).toBe(2);
  });

  it('answers a project with no modules at all without inventing an edge', () => {
    const report = drift([], []);

    expect(report.declaration.state).toBe('absent');
    expect(report.undeclared).toEqual([]);
    expect(report.unobserved).toEqual([]);
    expect(report.observed).toEqual({
      moduleCount: 0,
      edgeCount: 0,
      belowThresholdEdgeCount: 0,
    });
  });
});

describe('closeHierarchy (ISS-951)', () => {
  it('closes a chain transitively and keeps each node ancestors nearest-first', () => {
    const { declaredPairs, ancestorsOf } = closeHierarchy([
      node('a', 'Alpha'),
      node('b', 'Beta', 'a'),
      node('c', 'Gamma', 'b'),
    ]);

    expect(declaredPairs.size).toBe(3);
    expect(ancestorsOf.get('c')).toEqual(['b', 'a']);
    expect(ancestorsOf.get('a')).toEqual([]);
  });

  // cm:why the FK permits a cycle, so a corrupted chain reaches this walk; the assertion is that it ANSWERS rather than that the answer is pretty — a spin here hangs the endpoint, which is the failure `module-service.ts` bounds the same way.
  it('answers rather than spinning on a parent chain that loops', () => {
    const { ancestorsOf } = closeHierarchy([node('a', 'Alpha', 'b'), node('b', 'Beta', 'a')]);

    expect(ancestorsOf.get('a')).toEqual(['b']);
  });

  it('finds no common ancestor for two unrelated subtrees', () => {
    const { ancestorsOf } = closeHierarchy([
      node('p', 'P'),
      node('q', 'Q'),
      node('a', 'Alpha', 'p'),
      node('b', 'Beta', 'q'),
    ]);

    expect(nearestCommonAncestorId(ancestorsOf, 'a', 'b')).toBeNull();
  });

  it('picks the NEAREST common ancestor, not the root', () => {
    const { ancestorsOf } = closeHierarchy([
      node('root', 'Root'),
      node('mid', 'Mid', 'root'),
      node('a', 'Alpha', 'mid'),
      node('b', 'Beta', 'mid'),
    ]);

    expect(nearestCommonAncestorId(ancestorsOf, 'a', 'b')).toBe('mid');
  });
});
