import { describe, expect, it } from 'vitest';
import { RETIRED_JOB_TYPES } from '../../db/job-vocabulary.js';
import { FORGE_FACTS } from './registry.js';

describe('FORGE_FACTS', () => {
  it('no fact applies to a retired staged-pipeline stage (ISS-1229)', () => {
    const retired: ReadonlySet<string> = new Set(RETIRED_JOB_TYPES);
    const offenders = FORGE_FACTS.flatMap((f) =>
      (f.appliesTo ?? []).filter((s) => retired.has(s)).map((s) => `${f.id}:${s}`),
    );
    expect(offenders).toEqual([]);
  });
});
