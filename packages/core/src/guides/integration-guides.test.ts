/**
 * ISS-1178 — an organisation's integration guide is a row, not a registry entry, and the table
 * holds no audience column: the home admits agents alone. What `forge_guide` hands back for one
 * says so all the same, on the full guide and in the index.
 */

import { describe, expect, it, vi } from 'vitest';

const ROW = {
  provider: 'epodsystem',
  title: 'ePodSystem',
  summary: 'How the ePodSystem API behaves.',
  body: '## ePodSystem\nNever send a batch over 50.',
  version: 3,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

vi.mock('../db/client.js', () => {
  const rows = () => [ROW];
  const where = () => Object.assign(Promise.resolve(rows()), { limit: async () => rows() });
  return { db: { select: () => ({ from: () => ({ where }) }) } };
});

const { resolveGuide, resolveGuideIndex } = await import('./integration-guides.js');

describe("an organisation's integration guide", () => {
  it('carries the agent audience when read in full', async () => {
    const guide = await resolveGuide('integration-epodsystem', 'org-1');
    expect(guide?.body).toBe(ROW.body);
    expect(guide?.audience).toBe('agent');
  });

  it('carries the agent audience in the index, beside the registry guides', async () => {
    const index = await resolveGuideIndex('org-1');
    const row = index.find((g) => g.slug === 'integration-epodsystem');
    expect(row?.title).toBe(ROW.title);
    for (const g of index) expect(g.audience, g.slug).toBe('agent');
  });
});
