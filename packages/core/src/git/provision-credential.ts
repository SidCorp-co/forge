import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { isEnabled } from '../lib/feature-flags.js';
import { logger } from '../logger.js';

export type GitTransport = 'https' | 'ssh' | 'unknown';

export interface GitCredential {
  transport: 'https';
  /** Host the credential helper entry is scoped to, e.g. `github.com`. */
  host: string;
  /** Username for the helper entry (GitHub PATs use `x-access-token`). */
  username: string;
  /** The push token / password. Secret. */
  password: string;
  /** Human-readable note the CLI prints after writing the helper entry. */
  instructions: string;
}

export function classifyGitRemote(url: string | null | undefined): GitTransport {
  if (!url) return 'unknown';
  const u = url.trim();
  if (u.startsWith('http://') || u.startsWith('https://')) return 'https';
  if (u.startsWith('git@') || u.startsWith('ssh://')) return 'ssh';
  return 'unknown';
}

export async function provisionGitCredential(deviceId: string): Promise<GitCredential | null> {
  if (!isEnabled('runnerGitCredProvision')) return null;

  const token = process.env.GIT_PROVISION_TOKEN;
  const host = (process.env.GIT_PROVISION_HOST ?? 'github.com').trim();
  const username = (process.env.GIT_PROVISION_USERNAME ?? 'x-access-token').trim();

  if (!token) {
    // Flag on but no token source — log once and skip. Login still succeeds.
    logger.warn(
      'runnerGitCredProvision is enabled but GIT_PROVISION_TOKEN is unset — skipping git-cred provisioning',
    );
    return null;
  }

  const ref = `https:${host}`;
  try {
    await db.update(devices).set({ gitCredentialRef: ref }).where(eq(devices.id, deviceId));
  } catch (err) {
    logger.error({ err, deviceId }, 'failed to stamp devices.git_credential_ref');
  }

  return {
    transport: 'https',
    host,
    username,
    password: token,
    instructions: `Configured a git credential helper entry for https://${host} — push is now enabled for this device.`,
  };
}
