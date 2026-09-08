/**
 * Git over HTTPS authenticated by a GitHub App installation token.
 *
 * The deploy-key path hands a runner one long-lived secret it keeps. This one
 * hands it nothing: an installation token lives an hour, so the runner asks for
 * one per git invocation through a credential helper and stores none. What the
 * device is allowed to reach is therefore decided here, on every ask, from the
 * bindings of the projects it actually runs — not from what it was given once.
 *
 * Resolution is by repository, not by project: git knows the URL it is fetching
 * and nothing else, so `owner/repo` is the only key the helper can present.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationBindings, projects, runners } from '../db/schema.js';
import { installationTokenWithExpiry } from '../integrations/github/app-auth.js';
import type { GitHubConfig, GitHubSecrets } from '../integrations/github/types.js';
import { decryptConnectionSecrets, findConnectionById } from '../integrations/store.js';

export const GIT_CREDENTIAL_USERNAME = 'x-access-token';

export interface GitCredentialGrant {
  username: typeof GIT_CREDENTIAL_USERNAME;
  password: string;
  expiresAt: string;
  repository: string;
  projectId: string;
}

export class GitCredentialError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitCredentialError';
    this.status = status;
  }
}

/**
 * `owner/repo` out of whatever git put in the helper's `path` field —
 * `SidCorp-co/epodsystem_cli.git`, with or without the extension or a leading
 * slash. Returns null for anything that is not exactly two segments.
 */
export function parseRepoPath(raw: string): { owner: string; repo: string } | null {
  const parts = raw
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

// cm:guard the device is authorised by its RUNNERS, never by the binding alone — a binding says a project may reach a repository and says nothing about which box may. Drop the `runners.device_id` join and any paired device can mint a token for every repository bound anywhere in the fleet, which is broader than the deploy keys this path replaces.
// cm:guard compare owner/repo case-INSENSITIVELY and write the identifiers literally — GitHub treats `SidCorp-co` and `sidcorp-co` as one repository, and Drizzle renders a column reference inside a raw `sql` template unqualified, which is ambiguous under these joins.
async function findBindingForRepo(deviceId: string, owner: string, repo: string) {
  const rows = await db
    .select({
      bindingId: integrationBindings.id,
      connectionId: integrationBindings.connectionId,
      projectId: integrationBindings.projectId,
      environment: integrationBindings.environment,
      config: integrationBindings.config,
      slug: projects.slug,
    })
    .from(integrationBindings)
    .innerJoin(projects, eq(projects.id, integrationBindings.projectId))
    .innerJoin(runners, eq(runners.projectId, integrationBindings.projectId))
    .where(
      and(
        eq(integrationBindings.provider, 'github'),
        eq(integrationBindings.active, true),
        eq(runners.deviceId, deviceId),
        sql`lower(integration_bindings.config->>'owner') = lower(${owner})`,
        sql`lower(integration_bindings.config->>'repo') = lower(${repo})`,
      ),
    );

  // cm:guard prefer `prod` — a project may hold a staging binding on the same repository, and the two carry different installations. Picking whichever row the planner returned first makes the credential non-deterministic across identical asks.
  return rows.find((r) => r.environment === 'prod') ?? rows[0] ?? null;
}

/**
 * Mint a git credential for one device and one repository, or refuse saying
 * which of the four things is missing.
 */
export async function mintGitCredentialForDevice(args: {
  deviceId: string;
  host: string;
  path: string;
}): Promise<GitCredentialGrant> {
  const parsed = parseRepoPath(args.path);
  if (!parsed) {
    throw new GitCredentialError(
      400,
      `"${args.path}" is not an owner/repo path — git must be configured with credential.useHttpPath=true for this helper to resolve a repository`,
    );
  }
  const { owner, repo } = parsed;
  const full = `${owner}/${repo}`;

  const row = await findBindingForRepo(args.deviceId, owner, repo);
  if (!row) {
    throw new GitCredentialError(
      404,
      `no active GitHub App binding for ${full} on any project this device runs — bind the repository on the project's Integrations page, and assign this device a runner there`,
    );
  }

  const config = row.config as GitHubConfig;
  // cm:guard report the BINDING's spelling of the repository, never the one git asked with — this string is what the log line and the operator see, and echoing `sidcorp-co/EPODSYSTEM_CLI` back names a repository nobody can find in GitHub.
  const canonical = config.owner && config.repo ? `${config.owner}/${config.repo}` : full;
  if (!config.installationId) {
    throw new GitCredentialError(
      409,
      `${canonical} is bound on project ${row.slug} but the App is not installed for that binding — install it on the account that owns ${owner}`,
    );
  }

  const connection = await findConnectionById(row.connectionId);
  if (!connection?.active) {
    throw new GitCredentialError(
      409,
      `the GitHub connection behind ${canonical} is gone or deactivated`,
    );
  }
  const secrets = decryptConnectionSecrets<GitHubSecrets>(connection);
  if (!secrets.appId || !secrets.privateKey) {
    throw new GitCredentialError(
      409,
      `the connection behind ${canonical} holds no GitHub App credential`,
    );
  }

  const { token, expiresAt } = await installationTokenWithExpiry({
    appId: secrets.appId,
    privateKey: secrets.privateKey,
    installationId: config.installationId,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });

  return {
    username: GIT_CREDENTIAL_USERNAME,
    password: token,
    expiresAt: new Date(expiresAt).toISOString(),
    repository: canonical,
    projectId: row.projectId,
  };
}

/**
 * Which of these projects can authenticate git through their GitHub App, so the
 * provision payload can say so instead of the runner guessing from a URL.
 */
// cm:guard an App binding is a CAPABILITY, never a requirement — a project with no integration, or one on SSH, must provision exactly as it did before this path existed. Return false here rather than refusing, and the deploy-key and repo-less paths stay the default they are.
export async function projectsWithGitHubAppCredential(projectIds: string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const rows = await db
    .select({ projectId: integrationBindings.projectId })
    .from(integrationBindings)
    .where(
      and(
        eq(integrationBindings.provider, 'github'),
        eq(integrationBindings.active, true),
        inArray(integrationBindings.projectId, projectIds),
        sql`integration_bindings.config->>'installationId' IS NOT NULL`,
      ),
    );
  return new Set(rows.map((r) => r.projectId));
}

/** Whether a repo URL is one this credential path can authenticate at all. */
export function isHttpsGitUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https:\/\//i.test(url.trim());
}
