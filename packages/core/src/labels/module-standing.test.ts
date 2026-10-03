import type { IssueAttentionGroup } from '@forge/contracts/issue-standing';
import { describe, expect, it } from 'vitest';
import {
  activityDays,
  attentionOf,
  couplingsOf,
  deriveStandings,
  keyPathsOf,
  type LandingRow,
  type ModuleNode,
  modulePaths,
  moduleRefs,
  type OpenIssue,
  railOrder,
  subtreesOf,
  summaryOf,
  type TraceRow,
  tracesOf,
} from './module-standing.js';

const node = (id: string, parentId: string | null = null): ModuleNode => ({
  id,
  name: id.toUpperCase(),
  slug: id,
  parentId,
  description: null,
  knowledgeEntryId: null,
});

const issue = (
  key: string,
  moduleId: string | null,
  attentionGroup: IssueAttentionGroup,
  touchedAt = '2026-10-03T10:00:00.000Z',
): OpenIssue => ({
  key,
  title: `title of ${key}`,
  status: 'open',
  standing: {
    attentionGroup,
    touchedAt,
    tone: 'neutral',
    step: null,
    waitingOn: {
      kind: attentionGroup === 'needs_you' ? 'you' : 'issue',
      who: attentionGroup === 'needs_you' ? 'You' : 'ISS-9',
      act: `act of ${key}`,
      rule: 'rule',
      ref: null,
    },
    module: moduleId ? { id: moduleId, path: moduleId, name: moduleId } : null,
  },
});

const landing = (moduleId: string, issueKey: string, landedAt: string): LandingRow => ({
  moduleId,
  issueKey,
  title: `landed ${issueKey}`,
  landedAt,
  commitSha: 'abc1234',
  target: 'dev',
  landing: null,
  release: null,
});

describe('module paths and subtrees', () => {
  const nodes = [node('a'), node('b', 'a'), node('c', 'b'), node('orphan', 'ghost')];

  it('builds the slug path from the root and treats a parent outside the project as a root', () => {
    const paths = modulePaths(nodes);
    expect(paths.get('c')).toBe('a/b/c');
    expect(paths.get('orphan')).toBe('orphan');
  });

  it('collects every descendant, self first', () => {
    const subtrees = subtreesOf(nodes);
    expect(new Set(subtrees.get('a'))).toEqual(new Set(['a', 'b', 'c']));
    expect(subtrees.get('c')).toEqual(['c']);
    expect(subtrees.get('orphan')).toEqual(['orphan']);
  });

  it('answers on a parent cycle instead of spinning', () => {
    const cyclic = [node('x', 'y'), node('y', 'x')];
    expect(new Set(subtreesOf(cyclic).get('x'))).toEqual(new Set(['x', 'y']));
    expect(modulePaths(cyclic).get('x')).toBe('y/x');
  });
});

describe('attention group of a module', () => {
  const none = { needs_you: 0, moving: 0, stuck: 0, queued: 0, paused: 0 };

  it('reads needs-you over stuck over moving over quiet', () => {
    expect(attentionOf({ ...none, moving: 3, stuck: 1, needs_you: 1 })).toBe('needs_you');
    expect(attentionOf({ ...none, moving: 3, stuck: 1 })).toBe('stuck');
    expect(attentionOf({ ...none, moving: 1 })).toBe('moving');
    expect(attentionOf({ ...none, queued: 4, paused: 2 })).toBe('quiet');
    expect(attentionOf(none)).toBe('quiet');
  });
});

describe('deriveStandings', () => {
  const nodes = [node('parent'), node('child', 'parent'), node('lone')];

  it('rolls a child into its parent but never a parent into its child', () => {
    const s = deriveStandings({
      nodes,
      openIssues: [
        issue('ISS-1', 'child', 'needs_you'),
        issue('ISS-2', 'child', 'queued'),
        issue('ISS-3', 'parent', 'moving'),
      ],
      latestLandings: [],
      traces: [],
    });
    expect(s.get('parent')?.openByKind).toEqual({
      needs_you: 1,
      moving: 1,
      stuck: 0,
      queued: 1,
      paused: 0,
    });
    expect(s.get('parent')?.attentionGroup).toBe('needs_you');
    expect(s.get('child')?.openByKind).toEqual({
      needs_you: 1,
      moving: 0,
      stuck: 0,
      queued: 1,
      paused: 0,
    });
    expect(s.get('child')?.running).toBe(0);
    expect(s.get('parent')?.running).toBe(1);
    expect(s.get('lone')?.open).toBe(0);
    expect(s.get('parent')?.childCount).toBe(1);
  });

  it('names the newest issue of the highest group as the one it waits on', () => {
    const s = deriveStandings({
      nodes,
      openIssues: [
        issue('ISS-1', 'lone', 'stuck', '2026-10-01T00:00:00.000Z'),
        issue('ISS-2', 'lone', 'stuck', '2026-10-02T00:00:00.000Z'),
        issue('ISS-3', 'lone', 'moving', '2026-10-03T00:00:00.000Z'),
      ],
      latestLandings: [],
      traces: [],
    });
    expect(s.get('lone')?.attentionGroup).toBe('stuck');
    expect(s.get('lone')?.waitingOn.issueKey).toBe('ISS-2');
    expect(s.get('lone')?.waitingOn.act).toBe('act of ISS-2');
  });

  it('says what a quiet module holds, and that nothing is open when nothing is', () => {
    const quiet = deriveStandings({
      nodes,
      openIssues: [
        issue('ISS-1', 'lone', 'queued'),
        issue('ISS-2', 'lone', 'queued'),
        issue('ISS-3', 'lone', 'paused'),
      ],
      latestLandings: [],
      traces: [],
    });
    expect(quiet.get('lone')?.waitingOn).toMatchObject({
      kind: 'none',
      who: 'Nobody',
      act: '2 queued · 1 paused',
      issueKey: null,
    });
    const empty = deriveStandings({ nodes, openIssues: [], latestLandings: [], traces: [] });
    expect(empty.get('lone')?.waitingOn.act).toBe('nothing open');
  });

  it('leaves an issue with no module out of every module', () => {
    const s = deriveStandings({
      nodes,
      openIssues: [issue('ISS-1', null, 'needs_you')],
      latestLandings: [],
      traces: [],
    });
    expect([...s.values()].every((v) => v.open === 0)).toBe(true);
  });

  it('takes the newest landing across the subtree and names the module it landed in', () => {
    const s = deriveStandings({
      nodes,
      openIssues: [],
      latestLandings: [
        landing('parent', 'ISS-10', '2026-09-01T00:00:00.000Z'),
        landing('child', 'ISS-11', '2026-10-01T00:00:00.000Z'),
        landing('lone', 'ISS-12', '2026-10-02T00:00:00.000Z'),
      ],
      traces: [],
    });
    expect(s.get('parent')?.lastLanding).toMatchObject({
      issueKey: 'ISS-11',
      modulePath: 'parent/child',
    });
    expect(s.get('child')?.lastLanding?.issueKey).toBe('ISS-11');
    expect(s.get('lone')?.lastLanding?.issueKey).toBe('ISS-12');
  });

  it('has no last landing where nothing landed', () => {
    const s = deriveStandings({ nodes, openIssues: [], latestLandings: [], traces: [] });
    expect(s.get('lone')?.lastLanding).toBeNull();
  });
});

describe('requirement traces', () => {
  it('lists each requirement once, in number order, with its criteria in number order', () => {
    const rows: TraceRow[] = [
      { moduleId: 'm', reqSeq: 12, reqTitle: 'Twelve', criterion: 'BC-10' },
      { moduleId: 'm', reqSeq: 12, reqTitle: 'Twelve', criterion: 'BC-2' },
      { moduleId: 'm', reqSeq: 12, reqTitle: 'Twelve', criterion: 'BC-2' },
      { moduleId: 'm', reqSeq: 3, reqTitle: 'Three', criterion: null },
    ];
    expect(tracesOf(rows)).toEqual([
      { key: 'REQ-3', title: 'Three', criteria: [] },
      { key: 'REQ-12', title: 'Twelve', criteria: ['BC-2', 'BC-10'] },
    ]);
  });

  it('rolls a child trace into its parent', () => {
    const s = deriveStandings({
      nodes: [node('parent'), node('child', 'parent')],
      openIssues: [],
      latestLandings: [],
      traces: [{ moduleId: 'child', reqSeq: 5, reqTitle: 'Five', criterion: 'BC-1' }],
    });
    expect(s.get('parent')?.requirements).toEqual([
      { key: 'REQ-5', title: 'Five', criteria: ['BC-1'] },
    ]);
  });
});

describe('key paths', () => {
  it('takes file and directory paths cited in code spans, without a symbol or line suffix', () => {
    const body =
      'See `src/reminders/schedule.ts:nextDue` and `src/reminders/state-machine.ts:12:4`, also `apps/api/src/quiet/`.';
    expect(keyPathsOf(body)).toEqual([
      'src/reminders/schedule.ts',
      'src/reminders/state-machine.ts',
      'apps/api/src/quiet/',
    ]);
  });

  it('refuses what is not a path: module slugs, urls, bare names, prose with spaces', () => {
    const body =
      'Uses `messaging/sms`, `https://example.com/a/b.html`, `schedule.ts`, `a b/c.ts`, `git push origin/main`.';
    expect(keyPathsOf(body)).toEqual([]);
  });

  it('keeps first sight order, drops repeats and stops at the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => `\`src/f${i}.ts\``).join(' ');
    expect(keyPathsOf(`\`src/f0.ts\` ${many}`)).toHaveLength(12);
    expect(keyPathsOf('`src/a.ts` `src/a.ts:fn`')).toEqual(['src/a.ts']);
  });
});

describe('summary', () => {
  it('is the first prose paragraph, past headings and fences', () => {
    const body =
      '# Reminders\n\n```mermaid\nflowchart TD\n```\n\nLich nhac tai kham sau xuat vien.\nTinh moc D+1.\n\nSecond paragraph.';
    expect(summaryOf(body)).toBe('Lich nhac tai kham sau xuat vien. Tinh moc D+1.');
  });

  it('is empty when the entry holds only structure, and clipped when long', () => {
    expect(summaryOf('# Title\n\n```mermaid\nA-->B\n```\n')).toBe('');
    const long = summaryOf('x'.repeat(600));
    expect(long.length).toBe(420);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('activity days', () => {
  it('answers fourteen UTC days, oldest first, zero where nothing happened', () => {
    const days = activityDays(
      [
        { day: '2026-10-04', events: 5 },
        { day: '2026-09-21', events: 2 },
        { day: '2026-09-20', events: 9 },
      ],
      new Date('2026-10-04T23:59:00.000Z'),
    );
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ date: '2026-09-21', events: 2 });
    expect(days[13]).toEqual({ date: '2026-10-04', events: 5 });
    expect(days.some((d) => d.date === '2026-09-20')).toBe(false);
    expect(days.filter((d) => d.events === 0)).toHaveLength(12);
  });
});

describe('couplings', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const refs = moduleRefs(nodes);

  it('reads a declared edge from either end with its direction, and an observed pair by weight', () => {
    const out = couplingsOf(
      'a',
      refs,
      [
        { fromId: 'a', toId: 'b', predicate: 'calls' },
        { fromId: 'c', toId: 'a', predicate: 'reads' },
        { fromId: 'b', toId: 'c', predicate: 'unrelated' },
      ],
      [
        { aId: 'a', bId: 'c', issueCount: 2, recentIssueKeys: ['ISS-1'] },
        { aId: 'b', bId: 'a', issueCount: 7, recentIssueKeys: [] },
        { aId: 'b', bId: 'c', issueCount: 9, recentIssueKeys: [] },
      ],
    );
    expect(out.declared.map((d) => [d.module.slug, d.direction, d.predicate])).toEqual([
      ['b', 'out', 'calls'],
      ['c', 'in', 'reads'],
    ]);
    expect(out.observed.map((o) => [o.module.slug, o.issueCount])).toEqual([
      ['b', 7],
      ['c', 2],
    ]);
  });

  it('drops an edge whose other end is not a module of the project', () => {
    const out = couplingsOf(
      'a',
      refs,
      [{ fromId: 'a', toId: 'ghost', predicate: 'calls' }],
      [{ aId: 'a', bId: 'ghost', issueCount: 3, recentIssueKeys: [] }],
    );
    expect(out).toEqual({ declared: [], observed: [] });
  });
});

describe('rail order', () => {
  it('puts what waits on you first, then stuck, moving, queued, paused, newest first within a group', () => {
    const ordered = railOrder([
      issue('ISS-1', 'm', 'paused'),
      issue('ISS-2', 'm', 'queued'),
      issue('ISS-3', 'm', 'moving'),
      issue('ISS-4', 'm', 'stuck'),
      issue('ISS-5', 'm', 'needs_you', '2026-10-01T00:00:00.000Z'),
      issue('ISS-6', 'm', 'needs_you', '2026-10-02T00:00:00.000Z'),
    ]).map((i) => i.key);
    expect(ordered).toEqual(['ISS-6', 'ISS-5', 'ISS-4', 'ISS-3', 'ISS-2', 'ISS-1']);
  });
});
