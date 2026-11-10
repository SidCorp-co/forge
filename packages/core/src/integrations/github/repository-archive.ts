/**
 * A repository's tree at one commit, read through the GitHub App bound to it: what the forge plugin
 * install serves is the designated commit of a private repository, which only an App installed on
 * its owner can read (ISS-1199).
 *
 * The App is found the way git finds one (`source-host/host-credential.ts`): an active GitHub binding
 * naming that owner and repository, on any project, its connection holding the App's key. Every
 * way this cannot answer throws `RepositoryUnreachable` naming what is missing; nothing is guessed.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationBindings, integrationConnections } from '../../db/schema.js';
import { decryptConnectionSecrets, effectiveConfig } from '../index.js';
import { installationOctokit, isTimeout, responseOf } from './octokit.js';
import type { GitHubConfig, GitHubSecrets } from './types.js';

/** A tarball is several megabytes; the App client's own eight seconds is for a JSON read. */
const ARCHIVE_TIMEOUT_MS = 60_000;

export class RepositoryUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryUnreachable';
  }
}

interface Repository {
  owner: string;
  repo: string;
}

async function clientFor({ owner, repo }: Repository) {
  const pairs = await db
    .select({ binding: integrationBindings, connection: integrationConnections })
    .from(integrationBindings)
    .innerJoin(
      integrationConnections,
      eq(integrationConnections.id, integrationBindings.connectionId),
    )
    .where(and(eq(integrationBindings.provider, 'github'), eq(integrationBindings.active, true)))
    .orderBy(asc(integrationBindings.createdAt));
  const named = `${owner}/${repo}`.toLowerCase();
  const pair = pairs.find((p) => {
    const c = effectiveConfig<GitHubConfig>(p);
    return `${c.owner ?? ''}/${c.repo ?? ''}`.toLowerCase() === named;
  });
  if (!pair) {
    throw new RepositoryUnreachable(
      `no active GitHub binding names ${owner}/${repo}, so no App here can read it; bind that repository on a project's Integrations page with the App installed on ${owner}`,
    );
  }
  const config = effectiveConfig<GitHubConfig>(pair);
  const secrets = decryptConnectionSecrets<GitHubSecrets>(pair.connection);
  if (!pair.connection.active) {
    throw new RepositoryUnreachable(
      `the GitHub connection behind ${owner}/${repo} is deactivated; reconnect it on the Integrations page`,
    );
  }
  if (!config.installationId || !secrets.appId || !secrets.privateKey) {
    throw new RepositoryUnreachable(
      `the GitHub binding of ${owner}/${repo} holds no installed App to read it with; install the App on ${owner} and bind the repository again`,
    );
  }
  return installationOctokit({
    appId: secrets.appId,
    privateKey: secrets.privateKey,
    installationId: config.installationId,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
}

function said(err: unknown, what: string): RepositoryUnreachable {
  if (err instanceof RepositoryUnreachable) return err;
  if (isTimeout(err)) return new RepositoryUnreachable(`GitHub did not answer ${what} in time`);
  const answered = responseOf(err);
  if (answered)
    return new RepositoryUnreachable(`GitHub answered ${what} with HTTP ${answered.status}`);
  const why = err instanceof Error ? err.message : String(err);
  return new RepositoryUnreachable(`GitHub could not be asked ${what}: ${why}`);
}

/** The commit the repository's default branch stands at now. */
export async function repositoryHead(at: Repository): Promise<string> {
  const what = `for the head of ${at.owner}/${at.repo}`;
  try {
    const octokit = await clientFor(at);
    const res = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      ...at,
      ref: 'HEAD',
    });
    const sha = (res.data as { sha?: unknown }).sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new RepositoryUnreachable(`GitHub answered ${what} with no commit sha`);
    }
    return sha;
  } catch (err) {
    throw said(err, what);
  }
}

/** The gzipped tarball of the repository at `commit`, as GitHub makes it: one top directory. */
export async function repositoryTarball(at: Repository & { commit: string }): Promise<Buffer> {
  const what = `for the tarball of ${at.owner}/${at.repo} at ${at.commit}`;
  try {
    const octokit = await clientFor(at);
    const res = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
      owner: at.owner,
      repo: at.repo,
      ref: at.commit,
      request: { signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS) },
    });
    if (!(res.data instanceof ArrayBuffer)) {
      throw new RepositoryUnreachable(`GitHub answered ${what} with no archive`);
    }
    return Buffer.from(res.data);
  } catch (err) {
    throw said(err, what);
  }
}
