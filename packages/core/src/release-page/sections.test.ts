import type { ReleaseShipped } from '@forge/contracts/release-page';
import type { ReleaseApprovalView, ReleaseDetail } from '@forge/contracts/releases';
import { describe, expect, it } from 'vitest';
import { actionsOf, approvalOf, buildOf, changesOf, technicalOf } from './sections.js';

const HEAD = 'c'.repeat(40);
const UNREAD: ReleaseShipped = { state: 'unread', why: 'planted' };
const OWNER = { id: 'u-1', name: 'Linh', kind: 'human' as const };

function detail(over: Partial<ReleaseDetail> = {}): ReleaseDetail {
  return {
    version: '0.2.0',
    state: 'shipped',
    head: HEAD,
    approval: null,
    approvalRequired: false,
    notes: { sections: [], designs: [], withoutNotes: [], language: 'en', attention: [] },
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
          language: 'en',
          attention: [],
        },
      }),
      UNREAD,
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
    const t = technicalOf(detail({ changes: none }), shipped);
    expect(t.migrations).toHaveLength(2);
    expect(t.contracts).toEqual(['added GET /api/previews']);
    expect(t.dependencies).toEqual(['packages/core: added zod 4.6.5']);
    expect(t.settings).toEqual(['FORGE_VAULT_KEY (required)', 'PREVIEW_DOMAIN (optional)']);
  });

  it('claims nothing from a range it did not read', () => {
    expect(actionsOf(none, UNREAD)).toEqual([]);
    expect(technicalOf(detail({ changes: none }), UNREAD).migrations).toEqual([]);
  });
});
