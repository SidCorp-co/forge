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
      githubAppCredential: isHttpsGitUrl(r.repoUrl) && appProjects.has(r.projectId),
    };
  });

  return c.json(provisions);
});
