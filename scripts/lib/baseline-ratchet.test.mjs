import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseRev, compareBaseline, pushedFrom } from './baseline-ratchet.mjs';

describe('improves: down', () => {
  const at = (files) => ({ generatedAt: '2026-01-01', files });

  it('accepts a fix', () => {
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'a.ts': { r: 4 } }));
    expect(faults).toEqual([]);
  });

  it('refuses an existing offender getting worse', () => {
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'a.ts': { r: 11 } }));
    expect(faults).toContain('a.ts::r: 10 -> 11');
  });

  it('refuses a brand-new offender, because the total rises', () => {
    const faults = compareBaseline(
      'down',
      at({ 'a.ts': { r: 10 } }),
      at({ 'a.ts': { r: 10 }, 'b.ts': { r: 3 } }),
    );
    expect(faults).toEqual(['frozen total for . rose 10 -> 13']);
  });

  it('lets a rename through: same debt, new path, flat total', () => {
    const faults = compareBaseline(
      'down',
      at({ 'old.ts': { r: 10 } }),
      at({ 'new.ts': { r: 10 } }),
    );
    expect(faults).toEqual([]);
  });

  it('allows a swap that leaves the total flat', () => {
    const faults = compareBaseline('down', at({ 'a.ts': { r: 10 } }), at({ 'b.ts': { r: 10 } }));
    expect(faults).toEqual([]);
  });

  it('reads a flat {path: n} baseline the same way as a nested one', () => {
    expect(compareBaseline('down', at({ 'a.ts': 5 }), at({ 'a.ts': 6 }))).toContain('a.ts: 5 -> 6');
  });

  it('accepts a first-time-covered area arriving with its debt frozen', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 216 } }),
      at({ 'packages/web-v2/src/a.tsx': { r: 216 }, 'packages/core/src/b.ts': { r: 280 } }),
    );
    expect(faults).toEqual([]);
  });

  it('still refuses debt on a new file inside an area it already covered', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/core/src/a.ts': { r: 10 } }),
      at({ 'packages/core/src/a.ts': { r: 10 }, 'packages/core/src/b.ts': { r: 1 } }),
    );
    expect(faults).toEqual(['frozen total for packages/core rose 10 -> 11']);
  });

  it('still refuses an existing offender getting worse in a widening re-freeze', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 5 } }),
      at({ 'packages/web-v2/src/a.tsx': { r: 6 }, 'packages/core/src/b.ts': { r: 280 } }),
    );
    expect(faults).toContain('packages/web-v2/src/a.tsx::r: 5 -> 6');
  });

  it('refuses debt laundered from one covered area into another', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 60 }, 'packages/core/src/x.ts': { r: 10 } }),
      at({
        'packages/web-v2/src/a.tsx': { r: 10 },
        'packages/core/src/x.ts': { r: 10 },
        'packages/core/src/new.ts': { r: 50 },
      }),
    );
    expect(faults).toEqual(['frozen total for packages/core rose 10 -> 60']);
  });

  it('refuses a debt-carrying file moved from one covered area into another', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/web-v2/src/a.tsx': { r: 10 }, 'packages/core/src/x.ts': { r: 5 } }),
      at({ 'packages/core/src/a.ts': { r: 10 }, 'packages/core/src/x.ts': { r: 5 } }),
    );
    expect(faults).toEqual(['frozen total for packages/core rose 5 -> 15']);
  });

  it('lets a move into a first-time-seen area escape its old total — declared, not closed', () => {
    const faults = compareBaseline(
      'down',
      at({ 'packages/core/src/a.ts': { r: 10 } }),
      at({ 'packages/newpkg/src/a.ts': { r: 40 } }),
    );
    expect(faults).toEqual([]);
  });

  it('treats an empty previous baseline as covering everything, not nothing', () => {
    const faults = compareBaseline('down', at({}), at({ 'packages/core/src/a.ts': { r: 1 } }));
    expect(faults).toEqual(['frozen total for packages/core rose 0 -> 1']);
  });
});

describe('improves: shrink', () => {
  it('accepts cleaning frozen entries away', () => {
    expect(compareBaseline('shrink', { 'a.ts': ['h1', 'h2'] }, { 'a.ts': ['h1'] })).toEqual([]);
  });

  it('refuses a bigger frozen set', () => {
    const faults = compareBaseline(
      'shrink',
      { 'a.ts': ['h1'] },
      { 'a.ts': ['h1'], 'b.ts': ['h2'] },
    );
    expect(faults).toEqual(['frozen entries grew 1 -> 2']);
  });

  it('reads the flow-coverage shape, which is one array under a key', () => {
    const faults = compareBaseline(
      'shrink',
      { uncovered: ['release/deploy'] },
      { uncovered: ['release/deploy', 'dispatch/tick'] },
    );
    expect(faults).toEqual(['frozen entries grew 1 -> 2']);
  });
});

describe('improves: tighten', () => {
  const at = (contracts) => ({ contracts });

  it('accepts draft becoming locked', () => {
    expect(
      compareBaseline(
        'tighten',
        at([{ id: 'c', status: 'draft' }]),
        at([{ id: 'c', status: 'locked' }]),
      ),
    ).toEqual([]);
  });

  it('refuses locked becoming draft', () => {
    const faults = compareBaseline(
      'tighten',
      at([{ id: 'c', status: 'locked' }]),
      at([{ id: 'c', status: 'draft' }]),
    );
    expect(faults).toEqual(['c: locked -> draft']);
  });

  it('treats a deleted contract as loosening', () => {
    const faults = compareBaseline('tighten', at([{ id: 'c', status: 'locked' }]), at([]));
    expect(faults).toEqual(['c: locked -> removed']);
  });

  it('welcomes a contract that did not exist before', () => {
    const before = at([{ id: 'c', status: 'locked' }]);
    const now = at([
      { id: 'c', status: 'locked' },
      { id: 'd', status: 'draft' },
    ]);
    expect(compareBaseline('tighten', before, now)).toEqual([]);
  });
});

it('refuses a direction it does not implement', () => {
  expect(compareBaseline('sideways', {}, {})).toEqual(['unknown direction sideways']);
});

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A `dev` branch whose published tip is `before`, then a push of two commits on top, and a commit
 * with no parent, on a history of its own. `origin/dev` stands at the pushed head, as CI's checkout leaves it.
 */
function pushed() {
  const box = mkdtempSync(join(tmpdir(), 'base-rev-'));
  made.push(box);
  const root = join(box, 'work');
  git(box, 'init', '-q', '-b', 'dev', root);
  git(root, 'config', 'user.email', 'check@example.invalid');
  git(root, 'config', 'user.name', 'check');
  const commit = (msg) => {
    writeFileSync(join(root, 'f.txt'), msg);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', msg);
    return git(root, 'rev-parse', 'HEAD');
  };
  const before = commit('published');
  const first = commit('first of the push');
  const head = commit('last of the push');
  const stranger = git(root, 'commit-tree', `${head}^{tree}`, '-m', 'another history');
  git(root, 'update-ref', 'refs/remotes/origin/dev', head);
  const event = (payload) => {
    const path = join(box, `event-${made.length}-${Math.random()}.json`);
    writeFileSync(path, JSON.stringify(payload));
    return { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev', GITHUB_EVENT_PATH: path };
  };
  return { box, root, before, first, head, stranger, event };
}

describe('pushedFrom: a push is one change, judged from the tip it moved its branch from', () => {
  it('returns the pre-push tip, not HEAD~1, for a push of several commits', () => {
    const w = pushed();
    expect(pushedFrom(w.root, w.event({ before: w.before }), w.head)).toBe(w.before);
    expect(w.first).toBe(git(w.root, 'rev-parse', 'HEAD~1'));
  });

  it('is null for an event that is not a push', () => {
    const w = pushed();
    expect(pushedFrom(w.root, { GITHUB_EVENT_NAME: 'pull_request' }, w.head)).toBeNull();
  });

  it('is null for a push that created its branch', () => {
    const w = pushed();
    expect(pushedFrom(w.root, w.event({ before: '0'.repeat(40) }), w.head)).toBeNull();
  });

  it('refuses by name a push whose before is not an ancestor of HEAD', () => {
    const w = pushed();
    expect(() => pushedFrom(w.root, w.event({ before: w.stranger }), w.head)).toThrow(
      /not an ancestor of HEAD/,
    );
  });

  it('refuses by name a push whose before this clone does not hold', () => {
    const w = pushed();
    expect(() => pushedFrom(w.root, w.event({ before: 'a'.repeat(40) }), w.head)).toThrow(
      /absent from this clone/,
    );
  });

  it('refuses by name a readable push payload that names no before', () => {
    const w = pushed();
    for (const payload of [{}, { before: null }, { before: 'HEAD~3' }])
      expect(() => pushedFrom(w.root, w.event(payload), w.head)).toThrow(
        /names no commit as `before`/,
      );
  });

  it('refuses by name a push event whose payload cannot be read', () => {
    const w = pushed();
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(w.box, 'absent.json') };
    expect(() => pushedFrom(w.root, env, w.head)).toThrow(/absent\.json could not be read/);
  });

  it('refuses by name a push event with no payload path', () => {
    const w = pushed();
    expect(() => pushedFrom(w.root, { GITHUB_EVENT_NAME: 'push' }, w.head)).toThrow(
      /\$GITHUB_EVENT_PATH could not be read \(\$GITHUB_EVENT_PATH is unset\)/,
    );
  });
});

describe('baseRev', () => {
  it('judges a push to its merge target from the tip the push moved it from', () => {
    const w = pushed();
    expect(baseRev(w.root, w.event({ before: w.before }))).toBe(w.before);
  });

  it('takes the merge-base where the change is a branch off its target', () => {
    const w = pushed();
    git(w.root, 'checkout', '-q', '-b', 'ISS-1-a-branch', w.first);
    writeFileSync(join(w.root, 'g.txt'), 'branch work');
    git(w.root, 'add', '-A');
    git(w.root, 'commit', '-q', '-m', 'branch work');
    expect(baseRev(w.root, { GITHUB_BASE_REF: 'dev' })).toBe(w.first);
  });

  it('refuses, rather than judging HEAD~1, where no merge target can be derived', () => {
    const w = pushed();
    expect(() => baseRev(w.root, {})).toThrow(/no merge target could be derived/);
  });

  it('refuses, rather than judging HEAD~1, where the merge target names no ref here', () => {
    const w = pushed();
    expect(() => baseRev(w.root, { GITHUB_BASE_REF: 'release/9' })).toThrow(
      /`release\/9` .* resolves to no ref here/,
    );
  });

  it('refuses a merge target sharing no history with HEAD', () => {
    const w = pushed();
    git(w.root, 'update-ref', 'refs/remotes/origin/elsewhere', w.stranger);
    expect(() => baseRev(w.root, { GITHUB_BASE_REF: 'elsewhere' })).toThrow(/no common ancestor/);
  });
});
