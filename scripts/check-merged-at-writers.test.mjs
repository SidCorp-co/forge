import { describe, expect, it } from 'vitest';
import { faultsIn } from './check-merged-at-writers.mjs';

// The fixtures are FIXTURE TEXT — source this checker parses, not source this file runs.
const faults = (source) => faultsIn('packages/core/src/fixture.ts', source);

describe('check-merged-at-writers — the mark columns have one writer', () => {
  it.each([
    ['merged_at', "await db.update(issues).set({ mergedAt: new Date() }).where(eq(issues.id, id));\n"],
    ['merged_commit_sha', "await db.update(issues).set({ mergedCommitSha: sha }).where(eq(issues.id, id));\n"],
    // ISS-1327: the landing is the evidence a website project's close reads, so it has the same one writer.
    ['merged_landing', "await db.update(issues).set({ mergedLanding: url }).where(eq(issues.id, id));\n"],
  ])('refuses a drizzle write of %s outside merge-record.ts', (_column, source) => {
    const found = faults(source);
    expect(found).toHaveLength(1);
    expect(found[0].how).toMatch(/^\.update\(issues\) sets /);
  });

  it('refuses a raw SQL write of merged_landing', () => {
    const found = faults('await db.execute(sql`UPDATE issues SET merged_landing = ${url} WHERE id = ${id}`);\n');
    expect(found.map((f) => f.how)).toEqual(['raw SQL updates issues.merged_*']);
  });

  it('passes a write of a column the mark does not own', () => {
    expect(faults("await db.update(issues).set({ title: 't' }).where(eq(issues.id, id));\n")).toEqual([]);
  });
});
