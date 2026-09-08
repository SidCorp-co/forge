/**
 * The device's workspace-provisioning pull, and the git credential route that
 * belongs beside it.
 *
 * The device polls `/me/provisions` (and is woken by the `provision.request` WS
 * event) for its `queued` rows: where to clone, from what URL, and how to
 * authenticate. It then clones-if-missing, writes `.mcp.json`, syncs skills and
 * reports each stage back. A pull model, so binding a project never blocks on
 * the box being online.
 *
 * Its own module because `devices/routes.ts` may not reach `core-git`: that file
 * already coordinates ten modules and `.arch.json`'s `no-coordinator-blob` caps
 * a file at six, so an eleventh edge is a blocking violation rather than a style
 * note. The route surface is unchanged — both mount under `/api/devices`.
 */

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, runners, workspaceSshKeys } from '../db/schema.js';
import { isHttpsGitUrl, projectsWithGitHubAppCredential } from '../git/github-app-credential.js';
import { deviceGitCredentialRoutes } from '../git/github-credential-routes.js';
import { decryptSecret } from '../integrations/vault.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';

export const deviceProvisionRoutes = new Hono<{ Variables: DeviceVars }>();

deviceProvisionRoutes.route('/', deviceGitCredentialRoutes);

const unauth = () =>
  new HTTPException(401, { message: 'device revoked', cause: { code: 'UNAUTHENTICATED' } });

// cm:guard the SSH private key is delivered ONCE over TLS and never re-read in plaintext server-side (ISS-305) — a caller that logs this response, or a second route that returns the same field, turns a side-channel into a stored secret.
deviceProvisionRoutes.get('/me/provisions', requireDevice(), async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();

  const rows = await db
    .select({
      runnerId: runners.id,
      projectId: runners.projectId,
      slug: projects.slug,
      repoPath: runners.repoPath,
      branch: runners.branch,
      repoUrl: projects.repoUrl,
      baseBranch: projects.baseBranch,
      provisionStatus: runners.provisionStatus,
      sshSource: workspaceSshKeys.source,
      sshPublicKey: workspaceSshKeys.publicKey,
      sshPrivateKeyEnc: workspaceSshKeys.privateKeyEnc,
    })
    .from(runners)
    .innerJoin(projects, eq(projects.id, runners.projectId))
    .leftJoin(projectGitCredentials, eq(projectGitCredentials.projectId, runners.projectId))
    .leftJoin(workspaceSshKeys, eq(workspaceSshKeys.id, projectGitCredentials.sshKeyId))
    .where(
      and(
        eq(runners.deviceId, device.id),
        eq(runners.type, 'claude-code'),
        eq(runners.provisionStatus, 'queued'),
      ),
    );

  const appProjects = await projectsWithGitHubAppCredential(rows.map((r) => r.projectId));

  // cm:guard a decrypt failure (bad key, rotated master) degrades this ROW to "no key" and must never fail the pull — the device then falls back to whatever git auth it already had, and one unreadable project cannot stop every other project on the box from provisioning.
  const provisions = rows.map((r) => {
    let sshPrivateKey: string | null = null;
    if (r.sshPrivateKeyEnc) {
      try {
        sshPrivateKey = decryptSecret(r.sshPrivateKeyEnc);
      } catch {
        sshPrivateKey = null;
      }
    }
    return {
      runnerId: r.runnerId,
      projectId: r.projectId,
      slug: r.slug,
      repoPath: r.repoPath,
      branch: r.branch ?? r.baseBranch,
      repoUrl: r.repoUrl,
      sshKeySource: sshPrivateKey ? r.sshSource : null,
      sshPublicKey: sshPrivateKey ? r.sshPublicKey : null,
      sshPrivateKey,
      // cm:edge protocol -> packages/runner/crates/forge-runner-core/src/workspace/provision.rs — true means "ask core per git invocation", so this is the ONLY signal that turns the helper on; a project without it provisions exactly as it did before the App path existed.
      githubAppCredential: isHttpsGitUrl(r.repoUrl) && appProjects.has(r.projectId),
    };
  });

  return c.json(provisions);
});
