import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projectGitCredentials, projects, runners, workspaceSshKeys } from '../db/schema.js';
import { isHttpsGitUrl, projectsWithHostCredential } from '../git/host-credential.js';
import { deviceGitCredentialRoutes } from '../git/host-credential-routes.js';
import { logger } from '../logger.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { readDeclaredSource, remoteOf } from '../project-config/source.js';
import { recordProvisionReports } from './provision-reports.js';
import {
  buildProvisionRow,
  PROVISION_FAILURES_HEADER,
  type Provision,
  type ProvisionReport,
  provisionFailuresHeader,
} from './provision-row.js';
import { deviceHolderUserId, issueCheckoutCredential } from './workspace-credential.js';

export const deviceProvisionRoutes = new Hono<{ Variables: DeviceVars }>();

deviceProvisionRoutes.route('/', deviceGitCredentialRoutes);

const unauth = () =>
  new HTTPException(401, { message: 'device revoked', cause: { code: 'UNAUTHENTICATED' } });

function queuedRows(deviceId: string) {
  return db
    .select({
      runnerId: runners.id,
      projectId: runners.projectId,
      slug: projects.slug,
      repoPath: runners.repoPath,
      branch: runners.branch,
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

deviceProvisionRoutes.get('/me/provisions', requireDevice(), async (c) => {
  const device = c.get('device');
  if (device.status === 'revoked') throw unauth();

  const rows = await queuedRows(device.id);
  const credentialed = await projectsWithHostCredential(rows.map((r) => r.projectId));
  // The identity the box acts as, resolved once: a box paired as an agent hands
  // its checkouts that agent's reach and not the approving person's.
  const holderUserId = rows.length > 0 ? await deviceHolderUserId(device.id) : null;

  const settled = await Promise.allSettled(
    rows.map(async (r) => {
      const { repository, defaultBranch } = await readDeclaredSource(r.projectId);
      // cm:why the document names a repository, not a transport: an attached deploy key can only
      // reach it over SSH, and every other credential (a host's minted one, public) reaches it over HTTPS.
      const repoUrl = repository
        ? remoteOf(repository, r.sshPrivateKeyEnc ? 'ssh' : 'https')
        : null;
      return buildProvisionRow(
        { ...r, repoUrl, baseBranch: defaultBranch },
        {
          deviceId: device.id,
          holderUserId,
          hostCredential: isHttpsGitUrl(repoUrl) && credentialed.has(r.projectId),
        },
        { issueCredential: issueCheckoutCredential },
      );
    }),
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

  // Guarded although `recordProvisionReports` contracts not to throw: the one
  // thing this endpoint may never do again is lose every project's provision to
  // one row's fault. The guard says what it caught rather than swallowing it.
  const recorded = await recordProvisionReports(reports).catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err);
    return reports.map((r) => ({
      ...r,
      terminal: false,
      reason: `${r.reason} \u2014 and nothing here reached a runner row: ${why}`,
    }));
  });
  // Every report, whatever else carries it: the header has a budget and a row's
  // detail can be overwritten by the runner's next step, so the server log is
  // the one place a diagnostic cannot be dropped.
  for (const report of recorded) {
    logger.warn({ deviceId: device.id, ...report }, 'provision.report');
  }

  const header = provisionFailuresHeader(recorded);
  if (header) c.header(PROVISION_FAILURES_HEADER, header);

  // A bare array: a deployed runner decodes `Vec<Provision>` and nothing else,
  // and this endpoint has no way to negotiate a shape, so the reports ride the
  // header instead of an envelope.
  return c.json(provisions);
});
