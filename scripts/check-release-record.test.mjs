import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/**
 * The checker finds the record from its own location, so each planted repository carries a copy of
 * it and of the libraries it imports. A library it gains and this list lacks fails every case here
 * with a module-not-found, which is loud.
 */
const CARRIED = [
  'check-release-record.mjs',
  'lib/baseline-ratchet.mjs',
  'lib/base-branch.mjs',
  'lib/release-record.mjs',
  'lib/markdown.mjs',
];

const SEALED_ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

const made = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: SEALED_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

const PUBLISHED =
  '**A published entry nobody may silently lose.** It was released, a reader saw it, and ' +
  'deleting it without a declared reason is the failure the record exists to stop.';
const ADDED =
  '**A widget now reports its own size.** The report names the widget, the size it measured ' +
  'and when it measured it, so a reader can compare two reports without opening either widget.';
const REWORDED =
  '**Gadgets print what they weigh.** Each gadget writes its weight with the scale that took it ' +
  'and the hour of the reading, so two readings are compared side by side without a trip.';

function record(...entries) {
  return `# Changelog\n\n## [Unreleased]\n\n### Changed\n\n${entries.map((e) => `- ${e}\n\n`).join('')}`;
}

/** A `dev` branch with the checker on it, whose tip carries `PUBLISHED`; returns that tip. */
function planted() {
  const box = mkdtempSync(join(tmpdir(), 'release-record-'));
  made.push(box);
  const root = join(box, 'work');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const file of CARRIED) copyFileSync(join(SCRIPTS, file), join(root, 'scripts', file));
  git(box, 'init', '-q', '-b', 'dev', root);
  git(root, 'config', 'user.email', 'check@example.invalid');
  git(root, 'config', 'user.name', 'check');
  const commit = (msg, text) => {
    if (text !== undefined) writeFileSync(join(root, 'CHANGELOG.md'), text);
    else writeFileSync(join(root, 'other.txt'), msg);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', msg);
    return git(root, 'rev-parse', 'HEAD');
  };
  const before = commit('published', record(PUBLISHED));
  return { box, root, before, commit };
}

/** The checker run as CI runs it on a push to `dev`, `origin/dev` standing at the pushed head. */
function onPush(w, payload) {
  git(w.root, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  const event = join(w.box, 'event.json');
  if (payload !== null) writeFileSync(event, JSON.stringify(payload));
  return spawnSync('node', [join(w.root, 'scripts', 'check-release-record.mjs')], {
    cwd: w.root,
    encoding: 'utf8',
    env: {
      ...SEALED_ENV,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/dev',
      GITHUB_EVENT_PATH: event,
    },
  });
}

describe('check-release-record on a push of several commits', () => {
  it('passes an entry added and then reworded inside the push', () => {
    const w = planted();
    w.commit('push 1 of 2: add', record(ADDED, PUBLISHED));
    w.commit('push 2 of 2: reword', record(REWORDED, PUBLISHED));
    const r = onPush(w, { before: w.before });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('refuses a published entry deleted before the last commit of the push', () => {
    const w = planted();
    w.commit('push 1 of 2: delete', record());
    w.commit('push 2 of 2: unrelated');
    const r = onPush(w, { before: w.before });
    expect(r.stderr).toContain('no-silent-loss');
    expect(r.stderr).toContain('A published entry nobody may silently lose.');
    expect(r.status).toBe(1);
  });

  it('exits 2 naming the refusal when the push moved from a tip that is not an ancestor', () => {
    const w = planted();
    const stranger = git(w.root, 'commit-tree', `${w.before}^{tree}`, '-m', 'another history');
    w.commit('next');
    const r = onPush(w, { before: stranger });
    expect(r.stderr).toContain('no base revision can be taken');
    expect(r.stderr).toContain('not an ancestor of HEAD');
    expect(r.status).toBe(2);
  });

  it('exits 2 naming the refusal when the push payload cannot be read', () => {
    const w = planted();
    w.commit('next');
    const r = onPush(w, null);
    expect(r.stderr).toContain('could not be read');
    expect(r.status).toBe(2);
  });
});

describe('check-release-record with no base to compare against', () => {
  it('names the fetch of the merge target, not of main', () => {
    const w = planted();
    const r = spawnSync('node', [join(w.root, 'scripts', 'check-release-record.mjs')], {
      cwd: w.root,
      encoding: 'utf8',
      env: { ...SEALED_ENV, GITHUB_BASE_REF: 'dev' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('git fetch origin dev');
    expect(r.stderr).not.toContain('git fetch origin main');
  });
});
