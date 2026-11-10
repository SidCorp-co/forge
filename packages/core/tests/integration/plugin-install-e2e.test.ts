/**
 * REQ-25 BC-4: a person installs the forge plugin with one command Forge serves, holding only their
 * Forge token. The script is public with this core's origin written in; the archive it downloads is
 * the instance's designated plugin commit, fetched through the GitHub App that reaches the private
 * plugin repository, cut down to the marketplace (`.claude-plugin/`) and the plugin (`plugin/`), and
 * served only to a token holder (ISS-1199).
 *
 * GitHub is stubbed at the global fetch the App client calls, as the other GitHub App files stub it;
 * the archives it answers are made by the system `tar`, and the served one is read back by it.
 *
 * @direct-test-of packages/core/src/devices/install-routes.ts
 * @direct-test-of packages/core/src/devices/plugin-archive-routes.ts
 * @direct-test-of packages/core/src/devices/plugin-archive.ts
 * @direct-test-of packages/core/src/integrations/github/repository-archive.ts
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/index.js';
import { api, patToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { orgOwnedApp, seedGithubWorld, stubGitHub } from '../helpers/github-instance-world.js';

const INSTALLATION = 171606736;
const MARKETPLACE = 'SidCorp-co/forge-plugin';
const PINNED = 'a1'.repeat(20);
const MOVED = 'b2'.repeat(20);
const HEAD = 'c3'.repeat(20);

let scratch = '';
/** The tarball GitHub answers per commit, or the HTTP status it fails with. */
const github = new Map<string, Buffer | number>();
/** Every GitHub URL the App client asked, in order. */
let asked: string[] = [];

/** A repository tree as GitHub's tarball holds it: one top directory named for the commit. */
async function tarball(commit: string, files: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(scratch, 'repo-'));
  const top = `SidCorp-co-forge-plugin-${commit.slice(0, 7)}`;
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, top, path)), { recursive: true });
    await writeFile(join(root, top, path), text);
  }
  const out = join(root, 'repo.tar.gz');
  const made = spawnSync('tar', ['-czf', out, '-C', root, top]);
  expect(made.status, made.stderr.toString()).toBe(0);
  return readFile(out);
}

/** The paths and file texts a served archive holds, read by the system tar. */
async function served(bytes: ArrayBuffer): Promise<{ paths: string[]; text(p: string): string }> {
  const dir = await mkdtemp(join(scratch, 'served-'));
  await writeFile(join(dir, 'a.tar.gz'), Buffer.from(bytes));
  const list = spawnSync('tar', ['-tzf', join(dir, 'a.tar.gz')], { encoding: 'utf8' });
  expect(list.status, list.stderr).toBe(0);
  const out = join(dir, 'out');
  await mkdir(out);
  expect(spawnSync('tar', ['-xzf', join(dir, 'a.tar.gz'), '-C', out]).status).toBe(0);
  const paths = list.stdout
    .split('\n')
    .filter((p) => p !== '' && !p.endsWith('/'))
    .sort();
  const texts = new Map<string, string>();
  for (const p of paths) texts.set(p, await readFile(join(out, p), 'utf8'));
  return { paths, text: (p) => texts.get(p) ?? '' };
}

const REPO = {
  '.claude-plugin/marketplace.json': JSON.stringify({
    name: 'forge-local',
    plugins: [{ name: 'forge', source: './plugin' }],
  }),
  'plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'forge', version: '9.9.9' }),
  'plugin/hooks/link-cli.mjs': 'export {};\n',
  'plugin/bin/forge': '#!/bin/sh\n',
  'docs/internal.md': 'not for the archive\n',
  'packages/code-quality/index.mjs': 'not for the archive\n',
  'CLAUDE.md': 'not for the archive\n',
};

beforeAll(async () => {
  testEnv();
  scratch = await mkdtemp(join(tmpdir(), 'plugin-install-e2e-'));
  // the App client keeps the fetch it was built with, so GitHub is stubbed once for the file and
  // each case changes what it answers
  stubGitHub();
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const path = new URL(url).pathname;
    const archive = path.match(/^\/repos\/SidCorp-co\/forge-plugin\/tarball\/([0-9a-f]{40})$/);
    if (archive) {
      asked.push(`tarball ${archive[1]}`);
      const held = github.get(archive[1] as string);
      if (held === undefined || typeof held === 'number') {
        return Response.json({ message: 'Server Error' }, { status: held ?? 404 });
      }
      return new Response(held, { status: 200, headers: { 'content-type': 'application/x-gzip' } });
    }
    if (path === '/repos/SidCorp-co/forge-plugin/commits/HEAD') {
      asked.push('head');
      return Response.json({ sha: HEAD });
    }
    return inner(input, init);
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(scratch, { recursive: true, force: true });
});

let home = { id: '', slug: '', orgId: '' };
let token = '';

/** forge-dev's shape: an org-owned App bound to the plugin's own repository on the plugin's project. */
async function bindThePluginRepository(): Promise<void> {
  const { admin, session, project } = await seedGithubWorld();
  home = project;
  const plugin = await createTestProject(admin, { orgId: project.orgId });
  await addProjectMember(plugin.id, admin, 'owner');
  const connection = await orgOwnedApp(project.orgId);
  const res = await api(session, 'POST', `/api/integration-connections/${connection}/bindings`, {
    bindings: [
      {
        projectId: plugin.id,
        role: 'source',
        target: {
          provider: 'github',
          installationId: INSTALLATION,
          owner: 'SidCorp-co',
          repo: 'forge-plugin',
        },
      },
    ],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function designate(designations: unknown[] | null, homeProject: string | null = home.id) {
  await rows(sql`
    INSERT INTO instance_settings (id, forge_home_project_id, revision)
    VALUES (1, ${homeProject}, 1)
    ON CONFLICT (id) DO UPDATE SET forge_home_project_id = EXCLUDED.forge_home_project_id
    RETURNING id`);
  await rows(sql`
    UPDATE projects SET agent_config = ${JSON.stringify(designations === null ? {} : { plugins: designations })}::jsonb
     WHERE id = ${home.id} RETURNING id`);
}

const archive = (bearer: string | null) =>
  app.fetch(
    new Request('http://forge.test/api/install/plugin.tar.gz', {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );

beforeEach(async () => {
  await truncateAll();
  github.clear();
  asked = [];
  await bindThePluginRepository();
  // a person who reaches neither the home project nor the plugin's: their token alone opens it
  const person = (await createTestUser({ verified: true })).id;
  const own = await createTestProject(person);
  await addProjectMember(own.id, person, 'owner');
  token = await patToken(person, [own.id]);
});

describe('REQ-25 BC-4: the plugin install command Forge serves (ISS-1199)', () => {
  it('PLANT: GET /install-plugin.sh answers a shell script with this core written in, at both mounts', async () => {
    for (const path of ['/install-plugin.sh', '/api/install-plugin.sh']) {
      const res = await app.fetch(new Request(`http://forge.test${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/x-shellscript/);
      const script = await res.text();
      expect(script.startsWith('#!/bin/sh\n')).toBe(true);
      expect(script).toContain('BASE="https://forge.test"');
      expect(script).not.toContain('__BASE__');
    }
  });

  it('PLANT: the archive refuses a request with no token, by name, and asks GitHub nothing', async () => {
    await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: PINNED }]);
    github.set(PINNED, await tarball(PINNED, REPO));

    const res = await archive(null);

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    expect(asked).toEqual([]);
  });

  it('PLANT: with a token, the archive is the designated commit cut to .claude-plugin/ and plugin/', async () => {
    await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: PINNED }]);
    github.set(PINNED, await tarball(PINNED, REPO));

    const res = await archive(token);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('x-forge-plugin-commit')).toBe(PINNED);
    const got = await served(await res.arrayBuffer());
    expect(got.paths).toEqual([
      '.claude-plugin/marketplace.json',
      'plugin/.claude-plugin/plugin.json',
      'plugin/bin/forge',
      'plugin/hooks/link-cli.mjs',
    ]);
    expect(got.text('.claude-plugin/marketplace.json')).toBe(REPO['.claude-plugin/marketplace.json']);
    expect(got.text('plugin/bin/forge')).toBe('#!/bin/sh\n');
  });

  it('a commit already fetched is served from the cache, without asking GitHub again', async () => {
    await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: PINNED }]);
    github.set(PINNED, await tarball(PINNED, REPO));

    expect((await archive(token)).status).toBe(200);
    github.set(PINNED, 500);
    const again = await archive(token);

    expect(again.status).toBe(200);
    expect(again.headers.get('x-forge-plugin-commit')).toBe(PINNED);
    expect(asked).toEqual([`tarball ${PINNED}`]);
  });

  it('an unpinned designation serves the commit the default branch stands at now', async () => {
    await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: null }]);
    github.set(HEAD, await tarball(HEAD, REPO));

    const res = await archive(token);

    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('x-forge-plugin-commit')).toBe(HEAD);
    expect(asked).toEqual(['head', `tarball ${HEAD}`]);
  });

  describe('refused by name, never a stale fallback', () => {
    for (const [why, setup] of [
      ['the instance names no home project', () => designate(null, null)],
      ['the home project designates no plugin', () => designate(null)],
      [
        'the home project designates other plugins, not forge',
        () => designate([{ marketplace: MARKETPLACE, name: 'code-quality', pinnedRef: PINNED }]),
      ],
    ] as const) {
      it(`PLUGIN_ARCHIVE_UNDESIGNATED when ${why}`, async () => {
        await setup();

        const res = await archive(token);

        expect(res.status).toBe(503);
        const body = (await res.json()) as { code: string; detail: string };
        expect(body.code).toBe('PLUGIN_ARCHIVE_UNDESIGNATED');
        expect(body.detail).toContain('PATCH /api/projects/');
        expect(asked).toEqual([]);
      });
    }

    it('PLUGIN_ARCHIVE_UNREACHABLE when the App fetch fails, even with another commit cached', async () => {
      await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: PINNED }]);
      github.set(PINNED, await tarball(PINNED, REPO));
      expect((await archive(token)).status).toBe(200);

      await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: MOVED }]);
      github.set(MOVED, 500);
      const res = await archive(token);

      expect(res.status).toBe(424);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe('PLUGIN_ARCHIVE_UNREACHABLE');
      expect(body.detail).toContain(`${MARKETPLACE} at ${MOVED}`);
    });

    it('PLUGIN_ARCHIVE_UNREACHABLE when no GitHub binding reaches the marketplace repository', async () => {
      await designate([{ marketplace: 'SidCorp-co/elsewhere', name: 'forge', pinnedRef: PINNED }]);

      const res = await archive(token);

      expect(res.status).toBe(424);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe('PLUGIN_ARCHIVE_UNREACHABLE');
      expect(body.detail).toContain('SidCorp-co/elsewhere');
      expect(asked).toEqual([]);
    });

    it('PLUGIN_ARCHIVE_UNREACHABLE when the commit holds no marketplace to install from', async () => {
      await designate([{ marketplace: MARKETPLACE, name: 'forge', pinnedRef: PINNED }]);
      github.set(PINNED, await tarball(PINNED, { 'plugin/hooks/link-cli.mjs': 'export {};\n' }));

      const res = await archive(token);

      expect(res.status).toBe(424);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body.code).toBe('PLUGIN_ARCHIVE_UNREACHABLE');
      expect(body.detail).toContain('.claude-plugin/marketplace.json');
    });
  });
});
