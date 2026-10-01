// @gate-input whole-tree — it drives git in a scratch repository, which the root-walk guard reads as listing this one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pushedFrom } from './baseline-ratchet.mjs';

const root = mkdtempSync(join(tmpdir(), 'push-base-'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'dev');
git('config', 'user.email', 't@example.invalid');
git('config', 'user.name', 't');
const commit = (msg) => {
  writeFileSync(join(root, 'f'), msg);
  git('add', 'f');
  git('commit', '-q', '-m', msg);
  return git('rev-parse', 'HEAD');
};
const before = commit('published');
commit('first of the push');
const head = commit('last of the push');
git('checkout', '-q', '--orphan', 'other');
const stranger = commit('rewritten');
git('checkout', '-q', 'dev');

const event = (payload) => {
  const path = join(root, `event-${Math.random()}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: path };
};

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('pushedFrom: a push is judged from the tip it moved its branch from', () => {
  it('returns the pre-push tip, not HEAD~1, for a push of several commits', () => {
    expect(pushedFrom(root, event({ before }), head)).toBe(before);
    expect(pushedFrom(root, event({ before }), head)).not.toBe(git('rev-parse', 'HEAD~1'));
  });

  it('is null for an event that is not a push', () => {
    expect(pushedFrom(root, { GITHUB_EVENT_NAME: 'pull_request' }, head)).toBeNull();
  });

  it('is null for a push that created its branch', () => {
    expect(pushedFrom(root, event({ before: '0'.repeat(40) }), head)).toBeNull();
  });

  it('refuses by name a push whose before is not an ancestor of HEAD', () => {
    expect(() => pushedFrom(root, event({ before: stranger }), head)).toThrow(/not an ancestor/);
  });

  it('refuses by name a push event whose payload cannot be read', () => {
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: join(root, 'absent.json') };
    expect(() => pushedFrom(root, env, head)).toThrow(/payload .* could not be read/);
  });
});
