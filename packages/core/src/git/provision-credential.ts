/**
 * ISS-305 — auto git push-credential provisioning at runner-login time.
 *
 * Goal: kill the read-only-HTTPS blocker where a freshly-paired runner cannot
 * push (so merge/release loops stall on_hold). When a device logs in via the
 * browser-approve flow, core can hand it a push credential the runner writes
 * into a git credential helper, so `git push` works with no manual SSH setup.
 *
 * SAFETY / honesty: this ships DARK behind `runnerGitCredProvision` (default
 * OFF). Minting a *real* push credential requires a server-side token source —
 * we do NOT fabricate one. The credential returned is the operator-configured
 * push token (env `GIT_PROVISION_TOKEN` for `GIT_PROVISION_HOST`). When the
 * flag is off, or no token source is configured, provisioning is skipped and
 * runner login still succeeds (device token only) — the runner just keeps
 * whatever git credentials it already had.
 *
 * The login flow is project-agnostic (a device binds to projects later via
 * `forge-runner bind`), so the credential is host-scoped (works for every repo
 * the token can reach) rather than repo-scoped. A future per-repo deploy-key
 * path (SSH) can slot in behind the same flag.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices } from '../db/schema.js';
import { isEnabled } from '../lib/feature-flags.js';
import { logger } from '../logger.js';

export type GitTransport = 'https' | 'ssh' | 'unknown';

/**
 * Credential material returned ONCE to the runner at poll time. Never persisted
 * server-side beyond the non-secret `devices.git_credential_ref` label.
 */
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

/**
 * Best-effort classification of a git remote URL into a transport, for the
 * Integrations hub GitHub card. Pure string inspection — no network.
 */
export function classifyGitRemote(url: string | null | undefined): GitTransport {
  if (!url) return 'unknown';
  const u = url.trim();
  if (u.startsWith('http://') || u.startsWith('https://')) return 'https';
  if (u.startsWith('git@') || u.startsWith('ssh://')) return 'ssh';
  return 'unknown';
}

/**
 * Provision a git push credential for a freshly-logged-in device.
 *
 * Returns the credential to surface to the runner, or `null` when provisioning
 * is disabled / not configured (the common case). Stamps the non-secret
 * `devices.git_credential_ref` label on success so the UI can show per-device
 * push-cred status without ever exposing the secret.
 */
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
    // The label is a convenience for the UI; a write failure must not block the
    // credential handoff that actually unblocks the runner's pushes.
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
