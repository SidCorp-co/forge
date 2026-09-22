import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, runners, workspaceSshKeys } from '../db/schema.js';
import { isHttpsGitUrl, projectsWithGitHubAppCredential } from '../git/github-app-credential.js';
import { deviceGitCredentialRoutes } from '../git/github-credential-routes.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import {
  buildProvisionRow,
  PROVISION_FAILURES_HEADER,
  type Provision,
  type ProvisionReport,
  provisionFailuresHeader,
} from './provision-row.js';
import { deviceHolderUserId, issueWorkspaceCredential } from './workspace-credential.js';

export const deviceProvisionRoutes = new Hono<{ Variables: DeviceVars }>();

deviceProvisionRoutes.route('/', deviceGitCredentialRoutes);

const unauth = () =>
  new HTTPException(401, { message: 'device revoked', cause: { code: 'UNAUTHENTICATED' } });

/** What `runners.provision_detail` holds, which the web stepper renders. */
const DETAIL_MAX = 2000;

function queuedRows(deviceId: string) {
  return db
    .select({
      runnerId: runners.id,
      projectId: runners.projectId,
      slug: projects.slug,
      repoPath: runners.repoPath,
      branch: runners.branch,
      repoUrl: projects.repoUrl,
      baseBranch: projects.baseBranch,
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
        eq(runners.deviceId, deviceId),
        eq(runners.type, 'claude-code'),
        eq(runners.provisionStatus, 'queued'),
      ),
    );
}

/**
 * Leave each report where the operator will find it without this response in
 * hand: on the row itself, which is what the project's runner page renders. A
 * report whose cause was demonstrated to reproduce also takes its row out of
 * the queue, so it stops being re-read every ninety seconds forever; re-binding
 * the runner puts it back at `queued` with a clean detail.
 */
async function recordReports(reports: readonly ProvisionReport[]): Promise<void> {
  for (const report of reports) {
    await db
      .update(runners)
      .set({
        provisionDetail: report.reason.slice(0, DETAIL_MAX),
        updatedAt: new Date(),
        ...(report.terminal ? { provisionStatus: 'failed' as const } : {}),
      })
      .where(eq(runners.id, report.runnerId));
  }
}

deviceProvisionRoutes.get('/me/provisions', requireDevice(), async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();

  const rows = await queuedRows(device.id);
  const appProjects = await projectsWithGitHubAppCredential(rows.map((r) => r.projectId));
  // The identity the box acts as, resolved once: a box paired as an agent hands
  // its checkouts that agent's reach and not the approving person's.
  const holderUserId = rows.length > 0 ? await deviceHolderUserId(device.id) : null;

  const settled = await Promise.allSettled(
    rows.map((r) =>
      buildProvisionRow(
        r,
        {
          deviceId: device.id,
          holderUserId,
          githubAppCredential: isHttpsGitUrl(r.repoUrl) && appProjects.has(r.projectId),
        },
        { issueCredential: issueWorkspaceCredential },
      ),
    ),
  );

  const provisions: Provision[] = [];
  const reports: ProvisionReport[] = [];
  for (const [i, outcome] of settled.entries()) {
    const row = rows[i];
    if (!row) continue;
    if (outcome.status === 'rejected') {
      // The builder's contract breaking, not a provision failing. Named against
      // the row rather than taking the response down with it (ISS-1184).
      reports.push({
        runnerId: row.runnerId,
        projectId: row.projectId,
        slug: row.slug,
        kind: 'omitted',
        reason: `building this provision threw: ${String(outcome.reason)}`,
        terminal: false,
      });
      continue;
    }
    if (outcome.value.provision) provisions.push(outcome.value.provision);
    reports.push(...outcome.value.reports);
  }

  await recordReports(reports);

  const header = provisionFailuresHeader(reports);
  if (header) c.header(PROVISION_FAILURES_HEADER, header);

  // A bare array: a deployed runner decodes `Vec<Provision>` and nothing else,
  // and this endpoint has no way to negotiate a shape, so the reports ride the
  // header instead of an envelope.
  return c.json(provisions);
});
