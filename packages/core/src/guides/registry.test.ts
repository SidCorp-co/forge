/**
 * ISS-1178 — every guide core serves declares who it is written for, and core's homes admit agents
 * alone. The type says so at compile time; this says so of the objects actually served, including
 * one built through a cast.
 */

import { describe, expect, it } from 'vitest';
import { FORGE_GUIDES, getGuide, listGuides } from './registry.js';
import { CORE_GUIDE_AUDIENCES } from './types.js';

/** `<slug>: <what is wrong>` for each guide whose audience is missing or not one core admits. */
function audienceFaults(guides: ReadonlyArray<{ slug: string; audience?: unknown }>): string[] {
  return guides.flatMap((g) => {
    if (g.audience === undefined) return [`${g.slug}: declares no audience`];
    return (CORE_GUIDE_AUDIENCES as readonly unknown[]).includes(g.audience)
      ? []
      : [
          `${g.slug}: audience ${JSON.stringify(g.audience)} is not one core serves (${CORE_GUIDE_AUDIENCES.join(', ')})`,
        ];
  });
}

describe('the audience of every guide core serves', () => {
  it('is declared on every registry entry, as agent', () => {
    expect(FORGE_GUIDES.length).toBeGreaterThan(10);
    expect(audienceFaults(FORGE_GUIDES)).toEqual([]);
  });

  it('survives into the body-free index and the full guide', () => {
    expect(audienceFaults(listGuides())).toEqual([]);
    for (const { slug } of listGuides()) expect(getGuide(slug)?.audience, slug).toBe('agent');
  });
});

describe('that guard, against planted guides', () => {
  it('names a guide that declares no audience', () => {
    expect(audienceFaults([{ slug: 'planted-none' }])).toEqual([
      'planted-none: declares no audience',
    ]);
  });

  it('names a guide whose audience core does not serve', () => {
    expect(audienceFaults([{ slug: 'planted-user', audience: 'user' }])).toEqual([
      'planted-user: audience "user" is not one core serves (agent)',
    ]);
  });
});
