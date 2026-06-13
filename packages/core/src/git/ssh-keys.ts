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
