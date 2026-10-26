// @gate-input whole-tree — it runs git in a fixture repository, which the guard counts as the root
// @direct-test-of scripts/check-api-contracts.mjs
//
// Which committed contracts a generated contract is numbered after. A branch is numbered after its
// merge-base with where it lands, however often it regenerates; the target's own tip after the
// commit a push moved it from; and a tree edited on the tip after the tip itself, never after
// HEAD~1, which would hand a second change the number the tip already published.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTRACT_PATHS,
  contractBase,
  contractsAt,
  FLOOR_PATH,
  registryFloor,
} from './contract-base.mjs';

const AUTHOR = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const API = CONTRACT_PATHS['forge-api.openapi.json'];

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...AUTHOR } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function commit(root, version, message) {
  mkdirSync(dirname(join(root, API)), { recursive: true });
  writeFileSync(join(root, API), `${JSON.stringify({ info: { version } }, null, 2)}\n`);
  git(root, 'add', API);
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

let root;
let first;
let tip;
const shas = {};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'contract-base-'));
  git(root, 'init', '-q', '-b', 'dev');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'before any contract');
  shas.empty = git(root, 'rev-parse', 'HEAD');
  first = commit(root, '1.0.0', 'dev publishes 1.0.0');
  tip = commit(root, '1.1.0', 'dev publishes 1.1.0');
  git(root, 'checkout', '-q', '-b', 'lane', first);
  commit(root, '1.1.0', 'the lane numbers its own change');
  commit(root, '1.2.0', 'and regenerates again');
  git(root, 'checkout', '-q', 'dev');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = (extra = {}) => ({ GITHUB_BASE_REF: 'dev', ...extra });

describe('the base a contract is numbered after', () => {
  it('is the merge-base with the target on a branch, however many times it regenerated', () => {
    git(root, 'checkout', '-q', 'lane');
    try {
      expect(contractBase(root, env())).toEqual({
        rev: first,
        basis: 'the merge-base with dev',
      });
    } finally {
      git(root, 'checkout', '-q', 'dev');
    }
  });

  it("is HEAD on the target's own tip outside a push, never HEAD~1", () => {
    expect(contractBase(root, env())).toEqual({ rev: tip, basis: 'HEAD, the tip of dev' });
  });

  it('is the commit a push moved the target from, read from the push payload', () => {
    const payload = join(root, '..', `${root.split('/').pop()}-push.json`);
    writeFileSync(payload, JSON.stringify({ before: first }));
    try {
      const pushed = {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/dev',
        GITHUB_EVENT_PATH: payload,
      };
      expect(contractBase(root, pushed)).toEqual({
        rev: first,
        basis: 'the commit this push moved dev from',
      });
    } finally {
      rmSync(payload, { force: true });
    }
  });

  it('is refused by name where the target resolves to no ref here', () => {
    const out = contractBase(root, env({ GITHUB_BASE_REF: 'nowhere' }));
    expect(out.refusal).toMatch(/the merge target `nowhere`/);
  });
});

describe('the contracts a base holds', () => {
  it('reads each artifact at that revision, and null for one it does not hold', () => {
    const at = contractsAt(root, first);
    expect(JSON.parse(at['forge-api.openapi.json']).info.version).toBe('1.0.0');
    expect(at['forge-mcp.tools.json']).toBeNull();
    expect(contractsAt(root, shas.empty)['forge-api.openapi.json']).toBeNull();
  });
});

describe('the registry floor', () => {
  const reading = (doc) => (path) =>
    path === FLOOR_PATH ? (typeof doc === 'string' ? doc : JSON.stringify(doc)) : null;
  const entry = (over = {}) => ({
    contract: 'forge-api',
    version: '1.0.0',
    source: first,
    ...over,
  });

  it('is none for an artifact the file does not name, and none at all without the file', () => {
    expect(registryFloor(root, () => null).floors).toEqual({
      'forge-api.openapi.json': null,
      'forge-mcp.tools.json': null,
    });
    const { floors } = registryFloor(
      root,
      reading({ $comment: 'why', 'forge-api.openapi.json': entry() }),
    );
    expect(floors['forge-mcp.tools.json']).toBeNull();
    expect(floors['forge-api.openapi.json']).toMatchObject({ version: '1.0.0', source: first });
    expect(JSON.parse(floors['forge-api.openapi.json'].text).info.version).toBe('1.0.0');
  });

  it.each([
    [{ 'forge-api.json': entry() }, /"forge-api\.json" is not a published artifact/],
    [
      { 'forge-api.openapi.json': entry({ version: 'v2' }) },
      /\.version "v2" is not MAJOR\.MINOR\.PATCH/,
    ],
    [
      { 'forge-api.openapi.json': entry({ source: 'abc123' }) },
      /\.source "abc123" is not a 40-hex commit/,
    ],
    [{ 'forge-api.openapi.json': entry({ note: 'x' }) }, /unknown key\(s\) note/],
    ['{ not json', /is not JSON/],
  ])('refuses a malformed entry by name: %j', (doc, rule) => {
    expect(registryFloor(root, reading(doc)).refusal).toMatch(rule);
  });

  it('refuses a source commit that holds no such artifact, since the registry measures against its text', () => {
    const out = registryFloor(root, reading({ 'forge-mcp.tools.json': entry({ source: first }) }));
    expect(out.refusal).toMatch(/holds no packages\/core\/contracts\/forge-mcp\.tools\.json here/);
  });
});
