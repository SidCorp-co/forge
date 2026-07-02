/**
 * Per-project git SSH deploy keys (optional, opt-in).
 *
 * Forge can mint an ed25519 keypair for a project: the private key is encrypted
 * at rest (vault, INTEGRATION_MASTER_KEY) and the public key is surfaced for the
 * user to add to their repo as a deploy key. Any device bound to the project
 * then clones/pushes with the same key — add once, scale to N runners. Users who
 * prefer their own key paste a private key instead (`user_provided`); we derive
 * its public half + fingerprint and encrypt the private the same way.
 *
 * Keys are generated with the system `ssh-keygen` so the on-disk format the
 * runner writes is exactly what OpenSSH/git expects — no hand-rolled OpenSSH
 * private-key encoding. The private key is decrypted only at provision dispatch
 * and delivered to the runner once over the wire (mirrors ISS-305).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GeneratedSshKey {
  /** OpenSSH public key line, e.g. "ssh-ed25519 AAAA… forge-<slug>". */
  publicKey: string;
  /** OpenSSH private key (PEM-ish OpenSSH format) — caller MUST encrypt before persisting. */
  privateKey: string;
  /** Non-secret SHA256 fingerprint, e.g. "SHA256:abc…". */
  fingerprint: string;
}

/** Run a command in a throwaway 0700 temp dir, always cleaned up. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-sshkey-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Parse the SHA256 fingerprint out of `ssh-keygen -l -f <pub>` output. */
function parseFingerprint(out: string): string {
  // Format: "256 SHA256:xxxxx comment (ED25519)"
  const m = out.match(/(SHA256:[A-Za-z0-9+/=]+)/);
  return m?.[1] ?? '';
}

/**
 * Generate a fresh ed25519 keypair. `comment` labels the public key (use the
 * project slug so deploy keys are recognisable). The returned `privateKey` is
 * plaintext — encrypt it via vault.encryptSecret before storing.
 */
export async function generateSshKeypair(comment: string): Promise<GeneratedSshKey> {
  return withTempDir(async (dir) => {
    const keyPath = join(dir, 'id_ed25519');
    // -N '' => no passphrase (the key is protected by vault encryption at rest);
    // -C => comment; -q => quiet. ssh-keygen writes <keyPath> + <keyPath>.pub.
    await execFileAsync('ssh-keygen', [
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      comment,
      '-f',
      keyPath,
      '-q',
    ]);
    const [privateKey, publicKey, fp] = await Promise.all([
      readFile(keyPath, 'utf8'),
      readFile(`${keyPath}.pub`, 'utf8'),
      execFileAsync('ssh-keygen', ['-l', '-f', `${keyPath}.pub`]).then((r) => r.stdout),
    ]);
    return {
      publicKey: publicKey.trim(),
      privateKey,
      fingerprint: parseFingerprint(fp),
    };
  });
}

/** Result of probing a repo's reachability with a stored deploy key. */
export interface SshConnTest {
  ok: boolean;
  /** Machine-readable outcome for the UI to phrase / colour. */
  code: 'authenticated' | 'auth_denied' | 'host_unreachable' | 'not_found' | 'timeout' | 'error';
  /** Human-readable one-liner (safe to show — no secrets). */
  message: string;
  /** Remote HEAD sha on success, for a "reachable @ abc123" confirmation. */
  headSha?: string;
}

/** First non-empty line of a (possibly multi-line) stderr blob, truncated. */
function firstLine(s: string): string {
  const line = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').slice(0, 300);
}

/**
 * Probe whether `repoUrl` (an SSH clone URL) is reachable + authorised using
 * `privateKey`, by running `git ls-remote` with a scoped GIT_SSH_COMMAND. This
 * exercises the real deploy-key → repo path host-agnostically (GitHub, GitLab,
 * Bitbucket, self-hosted) and never mutates anything. The key is written to a
 * throwaway 0600 file; known_hosts is scoped to the temp dir so we neither
 * prompt nor pollute the host. Requires `git` + `ssh` on PATH.
 */
export async function testSshConnection(repoUrl: string, privateKey: string): Promise<SshConnTest> {
  return withTempDir(async (dir) => {
    const keyPath = join(dir, 'id_deploy');
    await writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    const knownHosts = join(dir, 'known_hosts');
    // IdentitiesOnly => use only this key (ignore agent/defaults); accept-new +
    // a temp known_hosts => auto-trust the host key without a prompt or global
    // pollution; BatchMode => never prompt for a passphrase (fail instead);
    // ConnectTimeout bounds the TCP dial.
    const sshCmd = [
      'ssh',
      '-i',
      keyPath,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'LogLevel=ERROR',
    ].join(' ');
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', repoUrl, 'HEAD'], {
        env: { ...process.env, GIT_SSH_COMMAND: sshCmd, GIT_TERMINAL_PROMPT: '0' },
        timeout: 20_000,
        maxBuffer: 1_000_000,
      });
      const headSha = stdout.trim().split(/\s+/)[0];
      return {
        ok: true,
        code: 'authenticated',
        message: 'Deploy key authenticated — the repository is reachable.',
        ...(headSha ? { headSha } : {}),
      };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; killed?: boolean; signal?: string };
      const stderr = (e.stderr ?? '').toString();
      const low = stderr.toLowerCase();
      if (e.killed || e.signal === 'SIGTERM') {
        return { ok: false, code: 'timeout', message: 'Connection timed out after 20s.' };
      }
      if (low.includes('permission denied')) {
        return {
          ok: false,
          code: 'auth_denied',
          message:
            'Permission denied — this deploy key is not authorised on the repository. Add the public key (with write access) to the repo.',
        };
      }
      if (
        low.includes('could not resolve hostname') ||
        low.includes('connection timed out') ||
        low.includes('network is unreachable') ||
        low.includes('connection refused')
      ) {
        return { ok: false, code: 'host_unreachable', message: 'Could not reach the git host.' };
      }
      if (low.includes('repository not found') || low.includes('does not exist')) {
        return {
          ok: false,
          code: 'not_found',
          message: 'Repository not found — check the repo URL (or the key may lack access to it).',
        };
      }
      return { ok: false, code: 'error', message: firstLine(stderr) || 'git ls-remote failed.' };
    }
  });
}

/**
 * Derive the public key + fingerprint from a user-supplied OpenSSH private key.
 * Throws if the key is malformed or passphrase-protected (we can't store a key
 * we can't use unattended). `comment` re-labels the derived public key.
 */
export async function derivePublicFromPrivate(
  privateKey: string,
  comment: string,
): Promise<GeneratedSshKey> {
  return withTempDir(async (dir) => {
    const keyPath = join(dir, 'id_ed25519');
    await writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    // `ssh-keygen -y` prints the public key for a private key; it errors on a
    // passphrase-protected or malformed key (no TTY to prompt), which we surface.
    let publicRaw: string;
    try {
      const { stdout } = await execFileAsync('ssh-keygen', ['-y', '-f', keyPath]);
      publicRaw = stdout.trim();
    } catch {
      throw new Error(
        'invalid_private_key: could not read the SSH private key (malformed or passphrase-protected)',
      );
    }
    const publicKey = comment ? `${publicRaw} ${comment}` : publicRaw;
    // Fingerprint the derived public key.
    const pubPath = `${keyPath}.pub`;
    await writeFile(pubPath, `${publicKey}\n`);
    const { stdout: fp } = await execFileAsync('ssh-keygen', ['-l', '-f', pubPath]);
    return { publicKey, privateKey, fingerprint: parseFingerprint(fp) };
  });
}
