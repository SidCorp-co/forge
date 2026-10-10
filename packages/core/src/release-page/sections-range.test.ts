// The developer view's What it changes and Action required, read from the release's own commit
// range (REQ-40 BC-7, BC-9): J9 on 0.4.0-dev.225.

import { readFileSync } from 'node:fs';
import type { ReleaseShipped } from '@forge/contracts/release-page';
import type { ReleaseDetail } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { surfacesSchema } from '../project-config/surfaces-schema.js';
import type { RangeChange } from '../release-batch/index.js';
import { actionsOf, technicalOf } from './sections.js';

const UNREAD: ReleaseShipped = { state: 'unread', why: 'planted' };
const kept = (shipped: ReleaseShipped, changed: RangeChange[] | null = null) => ({
  shipped,
  changed,
});

function detail(changes: ReleaseDetail['changes']): ReleaseDetail {
  return {
    version: '0.4.0-dev.224',
    state: 'shipped',
    head: '852dcfb'.padEnd(40, '0'),
    notes: {
      sections: [],
      designs: [],
      withoutNotes: [],
      reworked: [],
      language: 'en',
      attention: [],
    },
    changes,
  } as unknown as ReleaseDetail;
}

describe("the developer view's What it changes is the range's own (BC-9, J9 on 0.4.0-dev.225)", () => {
  // dev.224 (3b5e47c..852dcfb) claimed ISS-455; ISS-455's next round, d729b27be, landed after it and
  // shipped in dev.225. The page read ISS-455's latest landing whole: migration 0495 under Data, the
  // intake files, and the journal as a data-shape risk, two lines below a Migrations list naming 0494.
  const MAP = surfacesSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../tests/fixtures/forge-core-surfaces.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const J = 'packages/core/drizzle/migrations/meta/_journal.json';
  const M494 = 'packages/core/drizzle/migrations/0494_feedback_says_why.sql';
  const M495 = 'packages/core/drizzle/migrations/0495_intake_retry.sql';
  const INTAKE = 'packages/web-v2/src/features/intake/components/intake-draft.tsx';
  const art = (ref: string, issue: string, change: 'added' | 'changed' = 'added') => ({
    ref,
    change,
    issues: [issue],
    carriedBy: null,
  });
  const landings: ReleaseDetail['changes'] = {
    surfaces: [
      {
        surface: 'data',
        count: 3,
        shipsNothing: false,
        issues: ['ISS-452', 'ISS-455'],
        artifacts: [art(M494, 'ISS-452'), art(M495, 'ISS-455'), art(J, 'ISS-455', 'changed')],
      },
      {
        surface: 'ui',
        count: 1,
        shipsNothing: false,
        issues: ['ISS-455'],
        artifacts: [art(INTAKE, 'ISS-455', 'changed')],
      },
    ],
    risks: [
      {
        risk: 'data_changed',
        surface: 'data',
        ref: J,
        issues: ['ISS-455'],
        sentence: `${J} changes shape`,
        says: { sentence: { key: 'standing.risk.dataChanged', vars: { ref: J } } as never },
      },
    ],
    unclassified: [],
    boxRead: ['ISS-455'],
    shipsNothing: false,
  };
  const dev224: ReleaseShipped = {
    state: 'read',
    base: '3b5e47c'.padEnd(40, '0'),
    head: '852dcfb'.padEnd(40, '0'),
    migrations: [M494],
    contracts: [],
    dependencies: [],
    settings: [],
  };
  const files: RangeChange[] = [
    { path: M494, change: 'added' },
    { path: J, change: 'changed' },
    { path: 'packages/core/src/feedback/verify.ts', change: 'changed' },
  ];

  it('lists only what the range ships: no later round of a claimed issue', () => {
    const t = technicalOf(detail(landings), kept(dev224, files), MAP);
    const refs = t.changes.surfaces.flatMap((s) => s.artifacts.map((a) => a.ref));
    expect(refs.sort()).toEqual([M494, J, 'packages/core/src/feedback/verify.ts'].sort());
    expect(t.migrations).toEqual([M494]);
    expect(t.changes.risks).toEqual([]);
    const data = t.changes.surfaces.find((s) => s.surface === 'data');
    expect(data?.artifacts.map((a) => [a.ref, a.issues])).toEqual([
      [M494, ['ISS-452']],
      [J, ['ISS-455']],
    ]);
  });

  it('says a range kept without its files was not listed, and guesses nothing from the landings', () => {
    const t = technicalOf(detail(landings), kept(dev224), MAP);
    expect(t.changes.surfaces).toEqual([]);
    expect(t.changes.risks).toEqual([]);
    expect(t.changes.unclassified).toEqual([
      { key: null, why: expect.stringMatching(/report it again/), paths: [] },
    ]);
  });

  it('reads the landings as they say only where the range is unread', () => {
    expect(technicalOf(detail(landings), kept(UNREAD), MAP).changes).toBe(landings);
  });

  it('asks an admin only for the migration the range adds, on dev.224, dev.225 and dev.226 (BC-7)', () => {
    expect(actionsOf(landings, dev224).map((a) => `${a.kind}:${a.ref}:${a.issues}`)).toEqual([
      `migration:${M494}:ISS-452`,
    ]);
    const dev225 = { ...dev224, migrations: [M495] };
    expect(actionsOf(landings, dev225).map((a) => `${a.kind}:${a.ref}:${a.issues}`)).toEqual([
      `migration:${M495}:ISS-455`,
    ]);
    const dev226 = { ...dev224, migrations: [] };
    expect(actionsOf(landings, dev226)).toEqual([]);
  });
});
