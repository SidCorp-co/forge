import { describe, expect, it } from 'vitest';
import {
  approvedNew,
  CATALOG_PAGE_FIELD,
  type ChangeList,
  catalogPageFields,
  catalogPagesIn,
  type EntryReading,
  entryRefusal,
} from './pattern-entry.js';
import type { PatternRowFacts } from './pattern-rules.js';

const row = (over: Partial<PatternRowFacts>): PatternRowFacts => ({
  id: 'p1',
  pattern: 'queue-door',
  kind: 'new',
  namedBy: 'author',
  namedSession: null,
  createdAt: new Date(0),
  decision: 'approved',
  decidedAt: new Date(1),
  retractedAt: null,
  ...over,
});

const PAGE = 'docs/patterns/queue-door.md';
const HEAD = 'a'.repeat(40);
const SHA = 'f'.repeat(40);

const touched = (changes: Parameters<typeof catalogPagesIn>[0]): ChangeList => ({
  pages: new Set(catalogPagesIn(changes)),
  none: `the files the change touches at ${HEAD} list none`,
});

const none: EntryReading = {
  lists: [touched([{ path: 'packages/core/src/x.ts', change: 'changed' }])],
  tree: { kind: 'unread', why: 'no source host is bound' },
};

describe('which patterns the change must carry a page for', () => {
  it('is each approved new pattern still named; not a reuse, a pending, returned or retracted one', () => {
    const rows = [
      row({}),
      row({ id: 'p2', pattern: 'api-route', kind: 'reuse', decision: null }),
      row({ id: 'p3', pattern: 'pending', decision: null }),
      row({ id: 'p4', pattern: 'returned', decision: 'returned' }),
      row({ id: 'p5', pattern: 'withdrawn', retractedAt: new Date(2) }),
    ];
    expect(approvedNew(rows)).toEqual(['queue-door']);
  });
});

describe('the catalog pages a list of changed files carries', () => {
  it('is each docs/patterns/<slug>.md added or changed, once; not a removed one, the index or another file', () => {
    const changes = [
      { path: PAGE, change: 'added' as const },
      { path: PAGE, change: 'changed' as const },
      { path: 'docs/patterns/cron-door.md', change: 'changed' as const },
      { path: 'docs/patterns/gone.md', change: 'removed' as const },
      { path: 'docs/patterns/README.md', change: 'changed' as const },
      { path: 'docs/patterns/nested/x.md', change: 'added' as const },
      { path: 'docs/patterns/queue-door.txt', change: 'added' as const },
      { path: 'packages/core/src/x.ts', change: 'added' as const },
    ];
    expect(catalogPagesIn(changes)).toEqual([PAGE, 'docs/patterns/cron-door.md']);
    expect(catalogPageFields(changes)).toEqual([
      { key: CATALOG_PAGE_FIELD, value: PAGE },
      { key: CATALOG_PAGE_FIELD, value: 'docs/patterns/cron-door.md' },
    ]);
  });
});

describe('the page is asked for in the change that was read', () => {
  it('refuses where nothing read shows the page, naming the page and what was read', () => {
    const out = entryRefusal('ISS-9', ['queue-door'], none, 'merge-check');
    expect(out?.code).toBe('PATTERN_ENTRY_MISSING');
    expect(out?.path).toBe('/touched');
    expect(out?.detail).toContain(PAGE);
    expect(out?.detail).toContain('no source host is bound');
    expect(out?.detail).toContain(`the files the change touches at ${HEAD} list none`);
    expect(out?.detail).toContain('run the merge check again');
  });

  it("passes on a list of the change's files, added or changed, never removed", () => {
    for (const change of ['added', 'changed'] as const) {
      const lists = [touched([{ path: PAGE, change }])];
      expect(entryRefusal('ISS-9', ['queue-door'], { ...none, lists }, 'move')).toBeNull();
    }
    const lists = [touched([{ path: PAGE, change: 'removed' }])];
    const out = entryRefusal('ISS-9', ['queue-door'], { ...none, lists }, 'move');
    expect(out?.code).toBe('PATTERN_ENTRY_MISSING');
  });

  it('passes on any one of several lists', () => {
    const lists: ChangeList[] = [
      { pages: new Set(), none: 'the box read none' },
      { pages: new Set([PAGE]), none: 'the merge check recorded none' },
    ];
    expect(entryRefusal('ISS-9', ['queue-door'], { ...none, lists }, 'move')).toBeNull();
  });

  it("passes on the page the repository hands back at the commit, and gives the host's own reason where it does not", () => {
    const held = { kind: 'read' as const, sha: SHA, held: new Set([PAGE]), missing: new Map() };
    expect(entryRefusal('ISS-9', ['queue-door'], { ...none, tree: held }, 'move')).toBeNull();
    const unknown = {
      ...held,
      held: new Set<string>(),
      missing: new Map([[PAGE, `No commit found for the ref ${SHA}`]]),
    };
    const out = entryRefusal('ISS-9', ['queue-door'], { ...none, tree: unknown }, 'move');
    expect(out?.detail).toContain(
      `the repository at ${SHA} holds none (No commit found for the ref ${SHA})`,
    );
  });

  it('never counts a page the host gave no answer for', () => {
    const silent = { kind: 'read' as const, sha: SHA, held: new Set<string>(), missing: new Map() };
    const out = entryRefusal('ISS-9', ['queue-door'], { ...none, tree: silent }, 'move');
    expect(out?.detail).toContain(`${PAGE}: the host answered neither its text nor why`);
  });

  it('says where it was asked and what to do there', () => {
    const approval = entryRefusal('ISS-9', ['queue-door'], none, 'approval');
    expect(approval?.path).toBe('/decision');
    expect(approval?.detail).toContain("the change this issue's merge mark already names");
    expect(approval?.detail).toContain('Nothing was decided');
    const move = entryRefusal('ISS-9', ['queue-door'], none, 'move');
    expect(move?.path).toBe('/status');
    expect(move?.detail).toContain("the change this issue's merge mark names");
    expect(move?.detail).toContain('The issue did not move');
  });

  it('names only the patterns still missing, and asks nothing of an issue with none approved', () => {
    const lists = [touched([{ path: PAGE, change: 'added' }])];
    const out = entryRefusal('ISS-9', ['queue-door', 'cron-door'], { ...none, lists }, 'move');
    expect(out?.detail).toContain('`cron-door`');
    expect(out?.detail).not.toContain('`queue-door`');
    expect(entryRefusal('ISS-9', [], none, 'move')).toBeNull();
  });
});
