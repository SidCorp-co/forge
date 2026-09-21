import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, runners, workspaceSshKeys } from '../db/schema.js';
import { isHttpsGitUrl, projectsWithGitHubAppCredential } from '../git/github-app-credential.js';
import { deviceGitCredentialRoutes } from '../git/github-credential-routes.js';
import { decryptSecret } from '../integrations/vault.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { deviceHolderUserId, issueWorkspaceCredential } from './workspace-credential.js';

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
  // The identity the box acts as, resolved once: every credential minted below
  // belongs to it, so a box paired as an agent hands its checkouts that agent's
  // reach and not the approving person's.
  const holderUserId = rows.length > 0 ? await deviceHolderUserId(device.id) : null;

  const provisions = await Promise.all(
    rows.map(async (r) => {
      let sshPrivateKey: string | null = null;
      if (r.sshPrivateKeyEnc) {
        try {
          sshPrivateKey = decryptSecret(r.sshPrivateKeyEnc);
        } catch {
          sshPrivateKey = null;
        }
      }
      // The token the checkout's `.mcp.json` carries. Delivered with the
      // provision, over the same TLS channel as the deploy key above, because the
      // alternative is a human pasting a wider one into the box by hand.
      const mcpCredential = holderUserId
        ? await issueWorkspaceCredential({
            deviceId: device.id,
            projectId: r.projectId,
            holderUserId,
          })
        : null;

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
        mcpCredential,
      };
    }),
  );

  return c.json(provisions);
});
