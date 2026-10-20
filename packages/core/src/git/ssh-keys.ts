import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HTTPException } from 'hono/http-exception';
import { decryptSecret } from '../integrations/vault.js';
import { logger } from '../logger.js';
import { KEY_ACCESS, namingTheHost, readHostRefusal, WHY_KEY_ACCESS } from './bounded-fetch.js';
import { isHostUnresolved, type PinnedSshHost, pinSafeSshHost } from './ssh-host-guard.js';

const execFileAsync = promisify(execFile);

export interface GeneratedSshKey {
  /** OpenSSH public key line, e.g. "ssh-ed25519 AAAA… forge-<slug>". */
  publicKey: string;
  /** OpenSSH private key (PEM-ish OpenSSH format) — caller MUST encrypt before persisting. */
  privateKey: string;
  /** Non-secret SHA256 fingerprint, e.g. "SHA256:abc…", or null if unparseable. */
  fingerprint: string | null;
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

function parseFingerprint(out: string): string | null {
  // Format: "256 SHA256:xxxxx comment (ED25519)"
  const m = out.match(/(SHA256:[A-Za-z0-9+/=]+)/);
  return m?.[1] ?? null;
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
  code:
    | 'authenticated'
    | 'auth_denied'
    | 'key_unreadable'
    | 'host_unreachable'
    | 'not_found'
    | 'timeout'
    | 'error';
  /** Human-readable one-liner (safe to show — no secrets). */
  message: string;
  /** Remote HEAD sha on success, for a "reachable @ abc123" confirmation. */
  headSha?: string;
}

/**
 * Run `fn` with the environment git needs to reach `repoUrl` as `privateKey` and nothing else: the
 * key in a 0700 temp dir, a known_hosts of its own, no prompt, the ssh transport only, and ssh
 * pinned to the one public address the host guard resolved, which `fn` is handed with the host it
 * stands for. Throws the guard's HTTPException for a remote it refuses, before any key is written.
 */
export async function withDeployKey<T>(
  privateKey: string,
  repoUrl: string,
  fn: (env: NodeJS.ProcessEnv, dir: string, pin: PinnedSshHost) => Promise<T>,
): Promise<T> {
  const pin = await pinSafeSshHost(repoUrl);
  return withTempDir(async (dir) => {
    const keyPath = join(dir, 'id_deploy');
    await writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, {
      mode: 0o600,
    });
    const knownHosts = join(dir, 'known_hosts');
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
      '-o',
      `HostName=${pin.address}`,
      '-o',
      `HostKeyAlias=${pin.host}`,
    ].join(' ');
    return fn(
      {
        ...process.env,
        GIT_SSH_COMMAND: sshCmd,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ALLOW_PROTOCOL: 'ssh',
      },
      dir,
      pin,
    );
  });
}

/** The guard words its refusals for a clause; Test connection shows one alone, as a sentence. */
export function asSentence(clause: string): string {
  const said = clause.trim();
  const opened = said.charAt(0).toUpperCase() + said.slice(1);
  return /[.!?)]$/.test(opened) ? opened : `${opened}.`;
}

/** A stored key Forge cannot read: one it cannot decrypt, or one ssh cannot load. Never the host's. */
export const STORED_KEY_UNREADABLE: SshConnTest = {
  ok: false,
  code: 'key_unreadable',
  message:
    'Forge could not read the stored deploy key, so it was never offered to the git host. Detach it and generate a new one.',
};

/**
 * Test connection on a stored key. A ciphertext the vault cannot open (its master key changed, or the
 * row was damaged) is a key Forge cannot read, answered as one rather than as a server fault: it is
 * the one way a stored key becomes unreadable once the upload check has passed (ISS-1421 r13).
 */
export async function testStoredSshKey(
  repoUrl: string,
  privateKeyEnc: Buffer,
  context: Record<string, unknown>,
): Promise<SshConnTest> {
  let privateKey: string;
  try {
    privateKey = decryptSecret(privateKeyEnc);
  } catch (err) {
    logger.warn({ err, ...context }, 'ssh-keys: the stored key could not be decrypted for a test');
    return STORED_KEY_UNREADABLE;
  }
  return testSshConnection(repoUrl, privateKey);
}

export async function testSshConnection(repoUrl: string, privateKey: string): Promise<SshConnTest> {
  return withDeployKey(privateKey, repoUrl, (env, _dir, pin) => lsRemote(repoUrl, env, pin)).catch(
    (err: unknown): SshConnTest => {
      if (!(err instanceof HTTPException)) throw err;
      const code = isHostUnresolved(err) ? 'host_unreachable' : 'error';
      return { ok: false, code, message: asSentence(err.message) };
    },
  );
}

async function lsRemote(
  repoUrl: string,
  env: NodeJS.ProcessEnv,
  pin: PinnedSshHost,
): Promise<SshConnTest> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', repoUrl, 'HEAD'], {
      env,
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
    if (e.killed || e.signal === 'SIGTERM') {
      return { ok: false, code: 'timeout', message: 'Connection timed out after 20s.' };
    }
    const answer = readHostRefusal((e.stderr ?? '').toString());
    const said = namingTheHost(answer.said, pin);
    switch (answer.kind) {
      case 'key_unreadable':
        return STORED_KEY_UNREADABLE;
      case 'key_refused':
        return {
          ok: false,
          code: 'auth_denied',
          message: `The git host refused this deploy key. Give it ${KEY_ACCESS} to the repository, ${WHY_KEY_ACCESS}.\n${said}`,
        };
      case 'no_access':
        return {
          ok: false,
          code: 'not_found',
          message: `The git host took this deploy key but will not let it read the repository. Give it ${KEY_ACCESS} to the repository, ${WHY_KEY_ACCESS}. If none lives there, fix the SSH clone URL.\n${said}`,
        };
      case 'unreachable':
        return {
          ok: false,
          code: 'host_unreachable',
          message: `Forge could not reach the git host.\n${said}`,
        };
      default:
        return { ok: false, code: 'error', message: said || 'git ls-remote failed.' };
    }
  }
}

/** A pasted private key ssh cannot load. Its message is the sentence a person reads; the code is the caller's. */
export class UnreadablePrivateKeyError extends Error {
  constructor() {
    super(
      'Forge could not read this SSH private key. It may be malformed or protected by a passphrase, and Forge needs one it can use unattended.',
    );
    this.name = 'UnreadablePrivateKeyError';
  }
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
      throw new UnreadablePrivateKeyError();
    }
    const publicKey = comment ? `${publicRaw} ${comment}` : publicRaw;
    // Fingerprint the derived public key.
    const pubPath = `${keyPath}.pub`;
    await writeFile(pubPath, `${publicKey}\n`);
    const { stdout: fp } = await execFileAsync('ssh-keygen', ['-l', '-f', pubPath]);
    return { publicKey, privateKey, fingerprint: parseFingerprint(fp) };
  });
}
