import { describe, expect, it } from 'vitest';
import { resolveRailSlug } from './nav-model';

const projA = { id: 'p-a', slug: 'proj-a' };
const projB = { id: 'p-b', slug: 'proj-b' };
const projC = { id: 'p-c', slug: 'proj-c' };

describe('resolveRailSlug', () => {
  it('returns the URL slug regardless of last/sticky/pinned', () => {
    expect(
      resolveRailSlug({
        slug: 'proj-a',
        lastSlug: 'proj-b',
        stickySlug: 'proj-c',
        scopedProjects: [projA, projB, projC],
        pinnedIds: new Set(['p-b']),
      }),
    ).toBe('proj-a');
  });

  it('prefers the in-scope lastSlug (ISS-731 per-tab last-project)', () => {
    expect(
      resolveRailSlug({
        slug: null,
        lastSlug: 'proj-b',
        stickySlug: 'proj-c',
        scopedProjects: [projA, projB, projC],
        pinnedIds: new Set(),
      }),
    ).toBe('proj-b');
  });

  it('falls back to the in-scope stickySlug when lastSlug is absent', () => {
    expect(
      resolveRailSlug({
        slug: null,
        lastSlug: null,
        stickySlug: 'proj-c',
        scopedProjects: [projA, projB, projC],
        pinnedIds: new Set(),
      }),
    ).toBe('proj-c');
  });

  it('convergence guard: same stickySlug survives a reordered project list', () => {
    const first = resolveRailSlug({
      slug: null,
      lastSlug: null,
      stickySlug: 'proj-c',
      scopedProjects: [projA, projB, projC],
      pinnedIds: new Set(),
    });
    const reordered = resolveRailSlug({
      slug: null,
      lastSlug: null,
      stickySlug: 'proj-c',
      scopedProjects: [projC, projB, projA],
      pinnedIds: new Set(),
    });
    expect(first).toBe('proj-c');
    expect(reordered).toBe('proj-c');
    expect(first).toBe(reordered);
  });

  it('first run (no lastSlug, no stickySlug): returns the pinned-first project', () => {
    expect(
      resolveRailSlug({
        slug: null,
        lastSlug: null,
        stickySlug: null,
        scopedProjects: [projA, projB, projC],
        pinnedIds: new Set(['p-b']),
      }),
    ).toBe('proj-b');
  });

  it('first run with no pins: returns list[0]', () => {
    expect(
      resolveRailSlug({
        slug: null,
        lastSlug: null,
        stickySlug: null,
        scopedProjects: [projA, projB, projC],
        pinnedIds: new Set(),
      }),
    ).toBe('proj-a');
  });

  it('org-scope guard: an out-of-scope lastSlug/stickySlug (foreign org) never surfaces', () => {
    expect(
      resolveRailSlug({
        slug: null,
        lastSlug: 'proj-foreign',
        stickySlug: 'proj-also-foreign',
        scopedProjects: [projA, projB],
        pinnedIds: new Set(['p-b']),
      }),
    ).toBe('proj-b');
  });

  it('returns null when the scoped project list is empty', () => {
    expect(
      resolveRailSlug({
        slug: null,
        lastSlug: null,
        stickySlug: null,
        scopedProjects: [],
        pinnedIds: new Set(),
      }),
    ).toBeNull();
  });
});
