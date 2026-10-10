import { readFileSync } from 'node:fs';
import type { ReleaseShipped } from '@forge/contracts/release-page';
import type { ReleaseApprovalView, ReleaseDetail } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { surfacesSchema } from '../project-config/surfaces-schema.js';
import type { RangeChange } from '../release-batch/index.js';
import { actionsOf, approvalOf, buildOf, changesOf, technicalOf } from './sections.js';

const HEAD = 'c'.repeat(40);
const UNREAD: ReleaseShipped = { state: 'unread', why: 'planted' };
/** A range reading kept without its changed files, unless they are given. */
const kept = (shipped: ReleaseShipped, changed: RangeChange[] | null = null) => ({
  shipped,
  changed,
});
const OWNER = { id: 'u-1', name: 'Linh', kind: 'human' as const };

function detail(over: Partial<ReleaseDetail> = {}): ReleaseDetail {
  return {
    version: '0.2.0',
    state: 'shipped',
    head: HEAD,
    approval: null,
    approvalRequired: false,
    notes: {
      sections: [],
      designs: [],
      withoutNotes: [],
      reworked: [],
      language: 'en',
      attention: [],
    },
    changes: {
      surfaces: [],
      risks: [],
      unclassified: [],
      boxRead: [],
      shipsNothing: false,
    },
    ...over,
  } as ReleaseDetail;
}

function approval(over: Partial<ReleaseApprovalView>): ReleaseApprovalView {
  return {
    id: 'a-1',
    requestedBy: OWNER,
    requestedAt: '2026-10-09T08:00:00.000Z',
    evidence: { environment: 'beta', commit: HEAD, reading: 'GET /health 200' },
    note: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    ...over,
  };
}

describe('who approved the release (BC-1, BC-12)', () => {
  it('reads "not asked" where the setting asks nobody and nobody approved', () => {
    expect(approvalOf(detail())).toEqual({
      required: false,
      state: 'not_asked',
      by: null,
      at: null,
    });
  });

  it('reads pending where the setting asks and nobody has decided', () => {
    expect(approvalOf(detail({ approvalRequired: true, state: 'awaiting_approval' })).state).toBe(
      'pending',
    );
    expect(approvalOf(detail({ approval: approval({}) })).state).toBe('pending');
  });

  it('names who approved and when, even where the setting asked nobody', () => {
    const at = '2026-10-09T09:00:00.000Z';
    expect(
      approvalOf(
        detail({ approval: approval({ decision: 'approved', decidedBy: OWNER, decidedAt: at }) }),
      ),
    ).toEqual({ required: false, state: 'approved', by: OWNER, at });
  });
});

describe('the build a page describes', () => {
  it('is the release head, and none on a draft or a head that is not a full commit', () => {
    expect(buildOf(detail())).toBe(HEAD);
    expect(buildOf(detail({ state: 'draft' }))).toBeNull();
    expect(buildOf(detail({ head: 'abc1234' }))).toBeNull();
  });
});

describe('improvements and fixes in user terms (BC-6)', () => {
  const entry = (key: string, userFacing: string, title = `title ${key}`) => ({
    key,
    title,
    userFacing,
    technical: null,
  });
  const notes = {
    sections: [
      { section: 'Added', entries: [entry('ISS-1', 'Nurses see reminders.')] },
      {
        section: 'Changed',
        entries: [
          entry('ISS-2', 'Reports load faster.'),
          entry('ISS-3', 'Reports load faster.'),
          entry('ISS-4', 'See ISS-9 for the reminder fix.'),
        ],
      },
      { section: 'Fixed', entries: [entry('ISS-5', 'A saved filter no longer resets.')] },
    ],
    designs: [],
    withoutNotes: [{ key: 'ISS-6', title: 'Untold change' }],
    reworked: [],
    language: 'en',
    attention: [],
  };

  it('keeps each line with its issue and the kind its section reads as', () => {
    const out = changesOf(notes);
    expect(out.improvements).toEqual([
      { issueKey: 'ISS-1', kind: 'new', line: 'Nurses see reminders.' },
      { issueKey: 'ISS-2', kind: 'improved', line: 'Reports load faster.' },
    ]);
    expect(out.fixes).toEqual([
      { issueKey: 'ISS-5', kind: 'fixed', line: 'A saved filter no longer resets.' },
    ]);
  });

  it('names an issue with no line, and one whose line a reader cannot follow, rather than inventing one', () => {
    expect(changesOf(notes).withoutNotes).toEqual([
      { issueKey: 'ISS-6', title: 'Untold change', why: 'no_note' },
      { issueKey: 'ISS-4', title: 'title ISS-4', why: 'held' },
    ]);
  });
});

describe('what an admin must do (BC-7) and the technical notes (BC-9)', () => {
  const artifact = (
    ref: string,
    change: 'added' | 'changed' | 'removed',
    carriedBy: string | null = null,
  ) => ({
    ref,
    change,
    issues: ['ISS-1'],
    carriedBy,
  });
  const changes: ReleaseDetail['changes'] = {
    surfaces: [
      {
        surface: 'data',
        count: 2,
        shipsNothing: false,
        issues: ['ISS-1'],
        artifacts: [
          artifact('packages/core/drizzle/migrations/0478_highlights.sql', 'added'),
          artifact('release_highlights', 'added'),
        ],
      },
      {
        surface: 'config',
        count: 2,
        shipsNothing: false,
        issues: ['ISS-1'],
        artifacts: [
          artifact('release.approval.required', 'changed'),
          artifact('shares.write', 'added'),
        ],
      },
      {
        surface: 'api',
        count: 2,
        shipsNothing: false,
        issues: ['ISS-1'],
        artifacts: [
          artifact('GET /api/projects/:id/releases/:version/page', 'added'),
          artifact('package.json', 'changed'),
        ],
      },
      {
        surface: 'ui',
        count: 1,
        shipsNothing: false,
        issues: ['ISS-2'],
        artifacts: [artifact('settings.retention', 'added', 'ISS-7')],
      },
    ],
    risks: [],
    unclassified: [],
    boxRead: [],
    shipsNothing: false,
  };

  it('derives settings, migrations and permissions from what the release ships, naming each artifact', () => {
    expect(actionsOf(changes, UNREAD)).toEqual([
      {
        kind: 'migration',
        ref: 'packages/core/drizzle/migrations/0478_highlights.sql',
        sentence: expect.stringMatching(/^Back up the database/),
        issues: ['ISS-1'],
      },
      {
        kind: 'setting',
        ref: 'release.approval.required',
        sentence: expect.stringMatching(/^Check release\.approval\.required/),
        issues: ['ISS-1'],
      },
      {
        kind: 'permission',
        ref: 'shares.write',
        sentence: expect.stringMatching(/^Grant shares\.write/),
        issues: ['ISS-1'],
      },
    ]);
  });

  it('adds the technical notes, migrations, contracts and dependencies', () => {
    const t = technicalOf(
      detail({
        changes,
        notes: {
          sections: [
            {
              section: 'Added',
              entries: [
                { key: 'ISS-1', title: 'Page', userFacing: 'A page.', technical: 'New table.' },
              ],
            },
          ],
          designs: [],
          withoutNotes: [],
          reworked: [],
          language: 'en',
          attention: [],
        },
      }),
      kept(UNREAD),
      null,
    );
    expect(t.notes).toEqual([{ issueKey: 'ISS-1', title: 'Page', technical: 'New table.' }]);
    expect(t.migrations).toEqual(['packages/core/drizzle/migrations/0478_highlights.sql']);
    expect(t.contracts).toEqual(['GET /api/projects/:id/releases/:version/page', 'package.json']);
    expect(t.dependencies).toEqual(['package.json']);
  });
});

describe('what the commit range ships adds to what the issues named (BC-7, BC-9)', () => {
  const none = {
    surfaces: [],
    risks: [],
    unclassified: [],
    boxRead: [],
    shipsNothing: false,
  };
  const shipped: ReleaseShipped = {
    state: 'read',
    base: 'a'.repeat(40),
    head: HEAD,
    migrations: [
      'packages/core/drizzle/migrations/0477_preview.sql',
      'packages/core/drizzle/migrations/0478_page.sql',
    ],
    contracts: ['added GET /api/previews'],
    dependencies: ['packages/core: added zod 4.6.5'],
    settings: [
      { name: 'PREVIEW_DOMAIN', required: false },
      { name: 'FORGE_VAULT_KEY', required: true },
    ],
  };

  it('asks an admin for each migration and each new required setting though no issue filled a field', () => {
    const items = actionsOf(none, shipped);
    expect(items.map((i) => `${i.kind}:${i.ref}`)).toEqual([
      'migration:packages/core/drizzle/migrations/0477_preview.sql',
      'migration:packages/core/drizzle/migrations/0478_page.sql',
      'setting:FORGE_VAULT_KEY',
    ]);
    expect(items[0]?.sentence).toMatch(/^Back up the database/);
    expect(items[2]?.sentence).toMatch(/^Set FORGE_VAULT_KEY/);
  });

  it('says an item once where an issue also named it, keeping that issue', () => {
    const named = {
      ...none,
      surfaces: [
        {
          surface: 'data' as const,
          count: 1,
          shipsNothing: false,
          issues: ['ISS-491'],
          artifacts: [
            {
              ref: 'packages/core/drizzle/migrations/0477_preview.sql',
              change: 'added' as const,
              issues: ['ISS-491'],
              carriedBy: null,
            },
          ],
        },
      ],
    };
    const items = actionsOf(named, shipped);
    const mig = items.filter((i) => i.ref.endsWith('0477_preview.sql'));
    expect(mig).toHaveLength(1);
    expect(mig[0]?.issues).toEqual(['ISS-491']);
  });

  it('lists the derived migrations, contracts, dependencies and every new setting in the developer notes', () => {
    const t = technicalOf(detail({ changes: none }), kept(shipped), null);
    expect(t.migrations).toHaveLength(2);
    expect(t.contracts).toEqual(['added GET /api/previews']);
    expect(t.dependencies).toEqual(['packages/core: added zod 4.6.5']);
    expect(t.settings).toEqual(['FORGE_VAULT_KEY (required)', 'PREVIEW_DOMAIN (optional)']);
  });

  it('claims nothing from a range it did not read', () => {
    expect(actionsOf(none, UNREAD)).toEqual([]);
    expect(technicalOf(detail({ changes: none }), kept(UNREAD), null).migrations).toEqual([]);
  });
});

describe('a read range is what the release ships, whatever its issues landed before (BC-7, BC-9)', () => {
  // J7 on 0.4.0-dev.223: the developer view said "Read from the range 4c9ea53..3b5e47c" and listed
  // migration 0493, the journal and 7 contract files that range does not change: 0493 shipped in
  // dev.222, and an issue carried again brought its whole landing. Action required asked for a backup
  // for both, the journal read as a schema change.
  const MIG = 'packages/core/drizzle/migrations/0493_requirement_reviews.sql';
  const JOURNAL = 'packages/core/drizzle/migrations/meta/_journal.json';
  const SNAPSHOT = 'packages/core/drizzle/migrations/meta/0493_snapshot.json';
  const landed = (surface: 'data' | 'api' | 'config', refs: string[]) => ({
    surface,
    count: refs.length,
    shipsNothing: false,
    issues: ['ISS-488'],
    artifacts: refs.map((ref) => ({
      ref,
      change: 'added' as const,
      issues: ['ISS-488'],
      carriedBy: null,
    })),
  });
  const earlier: ReleaseDetail['changes'] = {
    surfaces: [
      landed('data', [MIG, JOURNAL, SNAPSHOT]),
      landed('api', ['packages/contracts/src/requirements.ts', 'packages/core/src/x/routes.ts']),
      landed('config', ['scripts/check-x.mjs', 'packages/core/package.json']),
    ],
    risks: [],
    unclassified: [],
    boxRead: [],
    shipsNothing: false,
  };
  const quiet: ReleaseShipped = {
    state: 'read',
    base: '4c9ea53'.padEnd(40, '0'),
    head: HEAD,
    migrations: [],
    contracts: [],
    dependencies: [],
    settings: [],
  };

  it('lists no migration, contract or dependency the range does not change', () => {
    const t = technicalOf(detail({ changes: earlier }), kept(quiet), null);
    expect(t.migrations).toEqual([]);
    expect(t.contracts).toEqual([]);
    expect(t.dependencies).toEqual([]);
  });

  it('asks an admin for nothing the range does not ship', () => {
    expect(actionsOf(earlier, quiet)).toEqual([]);
  });

  it('keeps an issue on an item the range ships and its landing names', () => {
    const ships = { ...quiet, migrations: [MIG] };
    expect(technicalOf(detail({ changes: earlier }), kept(ships), null).migrations).toEqual([MIG]);
    expect(actionsOf(earlier, ships)).toEqual([
      expect.objectContaining({ kind: 'migration', ref: MIG, issues: ['ISS-488'] }),
    ]);
  });

  it('never reads the journal or a snapshot as a migration, where the range is unread too', () => {
    expect(technicalOf(detail({ changes: earlier }), kept(UNREAD), null).migrations).toEqual([MIG]);
    expect(actionsOf(earlier, UNREAD).filter((a) => a.kind === 'migration')).toEqual([
      expect.objectContaining({ ref: MIG }),
    ]);
  });
});

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
    const t = technicalOf(detail({ changes: landings }), kept(dev224, files), MAP);
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
    const t = technicalOf(detail({ changes: landings }), kept(dev224), MAP);
    expect(t.changes.surfaces).toEqual([]);
    expect(t.changes.risks).toEqual([]);
    expect(t.changes.unclassified).toEqual([
      { key: null, why: expect.stringMatching(/report it again/), paths: [] },
    ]);
  });

  it('reads the landings as they say only where the range is unread', () => {
    expect(technicalOf(detail({ changes: landings }), kept(UNREAD), MAP).changes).toBe(landings);
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

describe('an issue reworked after the release claimed it (BC-6, J9 on 0.4.0-dev.224)', () => {
  it('is named as reworked, never shown with the line its later round wrote', () => {
    const out = changesOf({
      sections: [],
      designs: [],
      withoutNotes: [],
      reworked: [{ key: 'ISS-455', title: 'Intake drafts' }],
      language: 'en',
      attention: [],
    });
    expect(out.fixes).toEqual([]);
    expect(out.withoutNotes).toEqual([
      { issueKey: 'ISS-455', title: 'Intake drafts', why: 'reworked' },
    ]);
  });
});
