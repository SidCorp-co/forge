import { isPreviousCredentialValid } from '../rotation.js';
import { CoolifyClient } from './client.js';
import type { CoolifyApplicationResponse, CoolifyConfig, CoolifySecrets } from './types.js';

/** One application as the target picker shows it. */
export interface CoolifyApplicationSummary {
  uuid: string;
  name: string | null;
  fqdn: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
  status: string | null;
}

export function summarizeApplication(app: CoolifyApplicationResponse): CoolifyApplicationSummary {
  return {
    uuid: app.uuid,
    name: app.name ?? null,
    fqdn: app.fqdn ?? null,
    gitRepository: app.git_repository ?? null,
    gitBranch: app.git_branch ?? null,
    gitCommitSha: app.git_commit_sha ?? null,
    status: app.status ?? null,
  };
}

/**
 * The applications a Coolify credential can see. Takes the credential rather
 * than a binding so the settings picker works on the create form, before any
 * connection is persisted — the same two-mode shape `rocketchat/rooms` uses.
 */
export async function fetchCoolifyApplications(auth: {
  baseUrl: string;
  apiToken: string;
  previousApiToken?: string;
}): Promise<CoolifyApplicationSummary[]> {
  const client = new CoolifyClient(auth);
  return (await client.listApplications()).map(summarizeApplication);
}

/** The credential a picker client is built from, out of stored secrets. */
export function credentialFromSecrets(
  config: CoolifyConfig,
  secrets: CoolifySecrets,
): { baseUrl: string; apiToken: string; previousApiToken?: string } {
  const auth: { baseUrl: string; apiToken: string; previousApiToken?: string } = {
    baseUrl: config.baseUrl,
    apiToken: secrets.apiToken,
  };
  if (secrets.previousApiToken && isPreviousCredentialValid(secrets)) {
    auth.previousApiToken = secrets.previousApiToken;
  }
  return auth;
}
