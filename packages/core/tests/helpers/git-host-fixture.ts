/**
 * A git host that is not GitHub, stood up on this machine (ISS-1398): a real bare repository served
 * to `git@gitlab.com:sid/desk.git` through a fake `ssh` on PATH, which runs the `git-upload-pack`
 * the client asks for against the repository its HostKeyAlias names. Everything Forge does on the
 * way — the host guard's pin, the deploy key written to a 0700 temp dir, the ssh command line, the
 * fetches and their filters — is the real code; only the network hop is not.
 *
 * A suite mocks `node:dns` with `publicDns` so the guard pins gitlab.com to a public address, calls
 * `startGitHost()` in `beforeAll`, and `attachDeployKey` on the project it reads.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { TestDb } from './db.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

export const GITLAB_URL = 'git@gitlab.com:sid/desk.git';

/** What `node:dns` answers in a suite reading the host: gitlab.com at one public address. */
export async function publicDns(real: typeof import('node:dns')) {
  return {
    ...real,
    promises: {
      ...real.promises,
      lookup: async () => [{ address: '172.65.251.78', family: 4 }],
    },
  };
}

const author = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_COMMITTER_DATE: '2026-09-30T09:00:00Z',
};

export interface GitHost {
  url: string;
  /** Commit `message` on `branch` of the working repository, touching `path`; the new sha. */
  commit(branch: string, message: string, path?: string): string;
  /** Start `branch` at `from`. */
  branch(branch: string, from: string): void;
  /** Merge `from` into `into` with a merge commit; the merge's sha. */
  merge(into: string, from: string, message: string): string;
  /** Make the served repository match the working one, every branch. */
  publish(): void;
  /** Whether the host refuses every key, as a host that was never given the public key does. */
  refusing(on: boolean): void;
  close(): void;
}

export function startGitHost(): GitHost {
  const root = mkdtempSync(join(tmpdir(), 'forge-git-host-'));
  const work = join(root, 'work');
  const served = join(root, 'hosts', 'gitlab.com', 'sid', 'desk.git');
  const bin = join(root, 'bin');
  const refuse = join(root, 'refuse');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...process.env, ...author } })
      .toString()
      .trim();

  git(root, 'init', '--quiet', '--initial-branch=main', work);
  mkdirSync(served, { recursive: true });
  git(served, 'init', '--quiet', '--bare');
  git(served, 'config', 'uploadpack.allowFilter', 'true');

  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'ssh'),
    [
      '#!/bin/sh',
      'alias=""',
      'for a in "$@"; do case "$a" in HostKeyAlias=*) alias=$(printf %s "$a" | cut -d= -f2);; esac; done',
      `if [ -e "${refuse}" ]; then echo "git@$alias: Permission denied (publickey)." >&2; exit 255; fi`,
      'for last in "$@"; do :; done',
      `cd "${join(root, 'hosts')}/$alias" || exit 128`,
      'exec sh -c "$last"',
    ].join('\n'),
  );
  chmodSync(join(bin, 'ssh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;

  let n = 0;
  return {
    url: GITLAB_URL,
    commit(branch, message, file) {
      n += 1;
      if (git(work, 'symbolic-ref', '--short', 'HEAD') !== branch) {
        git(work, 'checkout', '--quiet', branch);
      }
      const at = file ?? `f${n}.txt`;
      mkdirSync(join(work, at, '..'), { recursive: true });
      writeFileSync(join(work, at), `${n}\n`);
      git(work, 'add', at);
      git(work, 'commit', '--quiet', '-m', message);
      return git(work, 'rev-parse', 'HEAD');
    },
    branch(branch, from) {
      git(work, 'branch', branch, from);
    },
    merge(into, from, message) {
      git(work, 'checkout', '--quiet', into);
      git(work, 'merge', '--quiet', '--no-ff', '-m', message, from);
      return git(work, 'rev-parse', 'HEAD');
    },
    publish() {
      git(work, 'push', '--quiet', '--force', '--all', served);
    },
    refusing(on) {
      if (on) writeFileSync(refuse, '');
      else rmSync(refuse, { force: true });
    },
    close() {
      process.env.PATH = path;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Attach a deploy key to the project and point it at `repoUrl`, as Settings → Git access does. */
export async function attachDeployKey(db: TestDb, projectId: string, repoUrl: string) {
  const { encryptSecret } = await import('../../src/integrations/vault.js');
  const keyId = randomUUID();
  await db.execute(sql`UPDATE projects SET repo_url = ${repoUrl} WHERE id = ${projectId}`);
  await db.execute(sql`
    INSERT INTO workspace_ssh_keys (id, org_id, name, source, public_key, private_key_enc)
    SELECT ${keyId}, org_id, 'Forge x GitLab', 'user_provided', 'ssh-ed25519 AAAA test',
           ${encryptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n')}
      FROM projects WHERE id = ${projectId}
  `);
  await db.execute(sql`
    INSERT INTO project_git_credentials (project_id, ssh_key_id) VALUES (${projectId}, ${keyId})
  `);
}
