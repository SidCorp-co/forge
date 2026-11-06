import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The project's knowledge entries as the store holds them; the selectors below read from it. */
const knowledge = vi.hoisted(() => ({
  rows: [] as { slug: string; injection: 'always' | 'on_demand'; body: string; org?: boolean }[],
  fail: false,
}));
vi.mock('../knowledge/index.js', () => {
  const live = (projectId: string) => {
    if (knowledge.fail) throw new Error('knowledge store down');
    return projectId === 'p-1' ? knowledge.rows : [];
  };
  return {
    selectAlwaysInjectFromKnowledge: async (id: string) =>
      live(id)
        .filter((r) => r.injection === 'always' && !r.org)
        .map((r) => ({ key: r.slug, text: r.body })),
    selectLessonEntries: async () => [],
    selectOnDemandSlugsFromKnowledge: async (id: string) =>
      live(id)
        .filter((r) => r.injection === 'on_demand' && !r.org)
        .map((r) => r.slug),
    orgOnDemandSlugsOf: async (id: string) =>
      live(id)
        .filter((r) => r.injection === 'on_demand' && r.org)
        .map((r) => r.slug),
    selectOnDemandSourcesFromKnowledge: async () => ({}),
  };
});

/** The runner rows this device is assigned, as the heartbeat's query reads them. */
const assigned = vi.hoisted(() => ({
  rows: [] as { projectId: string; slug: string }[],
  fail: false,
}));
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => {
            if (assigned.fail) throw new Error('connection terminated');
            return assigned.rows;
          },
        }),
      }),
    }),
  },
}));

const compose = vi.hoisted(() => ({ throws: false }));
vi.mock('./ports.js', async () => {
  const { servedCheckoutOrientation } = await import('../prompt/checkout-orientation.js');
  return {
    devicesPorts: () => ({
      checkoutOrientation: async (projectId: string, slug: string) => {
        if (compose.throws) throw new Error('composer threw');
        return servedCheckoutOrientation(projectId, slug);
      },
    }),
  };
});

import { servedCheckoutOrientation } from '../prompt/checkout-orientation.js';
import { deviceOrientationRevisions, orientationRevision } from './orientation-revision.js';

beforeEach(() => {
  knowledge.rows = [
    { slug: 'ui-copy-rule', injection: 'always', body: 'A label is 1-3 words.' },
    { slug: 'dev-release', injection: 'on_demand', body: 'how forge-dev ships' },
    { slug: 'onboarding-code-map-jobs', injection: 'on_demand', body: 'the job map' },
    { slug: 'org-voice-guide', injection: 'on_demand', body: 'voice', org: true },
  ];
  knowledge.fail = false;
  assigned.rows = [
    { projectId: 'p-1', slug: 'forge' },
    { projectId: 'p-2', slug: 'epod' },
  ];
  assigned.fail = false;
  compose.throws = false;
});

describe('an orientation carries a revision that moves whenever what it is composed from moves (ISS-1066)', () => {
  it('moves when a knowledge entry the orientation lists is deleted, and the deleted slug leaves the body', async () => {
    const before = await servedCheckoutOrientation('p-1', 'forge');
    expect(before).toContain('- onboarding-code-map-jobs');
    knowledge.rows = knowledge.rows.filter((r) => r.slug !== 'onboarding-code-map-jobs');
    const after = await servedCheckoutOrientation('p-1', 'forge');
    expect(after).not.toContain('onboarding-code-map-jobs');
    expect(orientationRevision(after)).not.toBe(orientationRevision(before));
  });

  it('moves when an always-applied rule changes, and when an org guide is deleted', async () => {
    const first = orientationRevision(await servedCheckoutOrientation('p-1', 'forge'));
    knowledge.rows[0] = { ...knowledge.rows[0], body: 'A label is 1-2 words.' };
    const ruleChanged = orientationRevision(await servedCheckoutOrientation('p-1', 'forge'));
    expect(ruleChanged).not.toBe(first);
    knowledge.rows = knowledge.rows.filter((r) => r.slug !== 'org-voice-guide');
    const orgDeleted = orientationRevision(await servedCheckoutOrientation('p-1', 'forge'));
    expect(orgDeleted).not.toBe(ruleChanged);
  });

  it('stands still while nothing the orientation is composed from changes', async () => {
    const a = orientationRevision(await servedCheckoutOrientation('p-1', 'forge'));
    const b = orientationRevision(await servedCheckoutOrientation('p-1', 'forge'));
    expect(b).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the sha256 of the body, so any byte of it (the affordances table included) moves it', () => {
    expect(orientationRevision('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(orientationRevision('# Forge orientation — forge\n')).not.toBe(
      orientationRevision('# Forge orientation — forge\n\n'),
    );
  });
});

describe('the heartbeat names every assigned project’s revision', () => {
  it('answers each assigned project by id with the revision of the body me/runners serves it', async () => {
    const said = await deviceOrientationRevisions('d-1');
    expect(said).toEqual({
      'p-1': orientationRevision(await servedCheckoutOrientation('p-1', 'forge')),
      'p-2': orientationRevision(await servedCheckoutOrientation('p-2', 'epod')),
    });
    knowledge.rows = knowledge.rows.filter((r) => r.slug !== 'dev-release');
    const moved = await deviceOrientationRevisions('d-1');
    expect(moved?.['p-1']).not.toBe(said?.['p-1']);
    expect(moved?.['p-2']).toBe(said?.['p-2']);
  });

  it('serves the named-absence orientation’s revision when the knowledge store cannot be read', async () => {
    const held = await deviceOrientationRevisions('d-1');
    knowledge.fail = true;
    const said = await deviceOrientationRevisions('d-1');
    expect(said?.['p-1']).toMatch(/^[0-9a-f]{64}$/);
    expect(said?.['p-1']).not.toBe(held?.['p-1']);
  });

  it('answers null rather than failing the beat when the assignments or a composition cannot be read', async () => {
    assigned.fail = true;
    expect(await deviceOrientationRevisions('d-1')).toBeNull();
    assigned.fail = false;
    compose.throws = true;
    expect(await deviceOrientationRevisions('d-1')).toBeNull();
  });

  it('answers an empty map for a device with no assignment', async () => {
    assigned.rows = [];
    expect(await deviceOrientationRevisions('d-1')).toEqual({});
  });
});
