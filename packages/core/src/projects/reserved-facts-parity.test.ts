/**
 * The reserved project-fact keys are written twice, and this test is the only thing
 * that makes the second copy safe.
 *
 * Core owns the list: `mergeProjectFacts` DROPS a reserved key — it does not refuse it —
 * because those keys are derived from columns and a fact of the same name would shadow a
 * value the pipeline computes. web-v2 mirrors the list so the fact editor can say so before
 * the round trip, and web-v2 cannot import a runtime value from `@forge/core/public` (the
 * browser bundle would run core's env validation at import and throw). So the mirror is
 * hand-written, and when it falls behind, the operator types a key the browser accepts and
 * the server silently discards — which is the substitution this repo's rules exist to stop.
 *
 * ISS-1046 is exactly that: the rename to `live-branch` reached core's list and not web's.
 *
 * The web copy is read as SOURCE rather than imported, for the reason above.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_PROJECT_FACT_KEYS } from './project-facts.js';

const WEB_MIRROR = '../../../web-v2/src/features/project-settings/types.ts';

function webKeys(): string[] {
  const src = readFileSync(fileURLToPath(new URL(WEB_MIRROR, import.meta.url)), 'utf8');
  const block = /export const RESERVED_PROJECT_FACT_KEYS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block?.[1]) throw new Error(`no RESERVED_PROJECT_FACT_KEYS array found in ${WEB_MIRROR}`);
  return [...block[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
}

describe('the reserved project-fact keys, on both sides of the package boundary', () => {
  it('finds the array at all, so a rename cannot make this test vacuous', () => {
    expect(webKeys().length).toBeGreaterThan(0);
  });

  it('holds the same keys, in the same order', () => {
    expect(webKeys()).toEqual([...RESERVED_PROJECT_FACT_KEYS]);
  });

  it('reserves `live-branch` on both sides', () => {
    expect([...RESERVED_PROJECT_FACT_KEYS]).toContain('live-branch');
    expect(webKeys()).toContain('live-branch');
  });

  it('keeps the retired spelling reserved on both sides', () => {
    expect([...RESERVED_PROJECT_FACT_KEYS]).toContain('production-branch');
    expect(webKeys()).toContain('production-branch');
  });
});
