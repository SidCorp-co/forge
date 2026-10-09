import { describe, expect, it } from 'vitest';
import { approvedNew, type EntryReading, entryRefusal } from './pattern-entry.js';
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
const none: EntryReading = {
  running: new Set(),
  paths: { commit: HEAD, changes: [{ path: 'packages/core/src/x.ts', change: 'changed' }] },
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

describe('the merge check asks for the page in the change it reads', () => {
  it('refuses where nothing read shows the page, naming the page and what was read', () => {
    const out = entryRefusal('ISS-9', ['queue-door'], none);
    expect(out?.code).toBe('PATTERN_ENTRY_MISSING');
    expect(out?.path).toBe('/touched');
    expect(out?.detail).toContain(PAGE);
    expect(out?.detail).toContain('no source host is bound');
    expect(out?.detail).toContain(`the files the change touches at ${HEAD} list none`);
    expect(out?.detail).toContain('run the merge check again');
  });

  it("passes on the change's touched files, added or changed, never removed", () => {
    for (const change of ['added', 'changed'] as const) {
      const paths = { commit: HEAD, changes: [{ path: PAGE, change }] };
      expect(entryRefusal('ISS-9', ['queue-door'], { ...none, paths })).toBeNull();
    }
    const removed = { commit: HEAD, changes: [{ path: PAGE, change: 'removed' as const }] };
    const out = entryRefusal('ISS-9', ['queue-door'], { ...none, paths: removed });
    expect(out?.code).toBe('PATTERN_ENTRY_MISSING');
  });

  it("passes on the repository's tree at the commit, and names the sha where it lacks the page", () => {
    const held = { kind: 'read' as const, sha: 'f'.repeat(40), held: new Set([PAGE]) };
    expect(entryRefusal('ISS-9', ['queue-door'], { ...none, tree: held })).toBeNull();
    const lacking = { ...held, held: new Set<string>() };
    expect(entryRefusal('ISS-9', ['queue-door'], { ...none, tree: lacking })?.detail).toContain(
      `the repository holds none at ${'f'.repeat(40)}`,
    );
  });

  it('passes a page the running build already catalogues', () => {
    expect(
      entryRefusal('ISS-9', ['queue-door'], { ...none, running: new Set(['queue-door']) }),
    ).toBeNull();
  });

  it('names only the patterns still missing, and asks nothing of an issue with none approved', () => {
    const paths = { commit: HEAD, changes: [{ path: PAGE, change: 'added' as const }] };
    const out = entryRefusal('ISS-9', ['queue-door', 'cron-door'], { ...none, paths });
    expect(out?.detail).toContain('`cron-door`');
    expect(out?.detail).not.toContain('`queue-door`');
    expect(entryRefusal('ISS-9', [], none)).toBeNull();
  });
});
