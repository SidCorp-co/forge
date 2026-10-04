import { parseSecretRef } from '@forge/contracts/project-config';
import { scrubSecretValuesDeep } from '@forge/observability';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobEvents, jobs } from '../db/schema.js';
import { projectSecrets } from '../db/schema-project-config.js';
import { appendJobEvent } from './intervention-event.js';
import { jobsPorts } from './ports.js';

const SECRET_RESOLVE_KIND = 'secret_resolve' as const;

export interface SecretResolveAudit {
  environment: string;
  profile: string;
  refs: string[];
  tokenId: string;
  deviceId: string | null;
}

/** A testing-secrets resolve, on the job's event log: the row commits before any value leaves, and
 *  it is the row the scrubber reads to know what this job holds. */
export async function recordSecretResolve(jobId: string, audit: SecretResolveAudit): Promise<void> {
  await db.transaction((tx) => appendJobEvent(tx, jobId, SECRET_RESOLVE_KIND, { ...audit }));
}

// cm:why the audit row names refs, never values, so a value rotated after it was handed out is
// known only here; the row is what survives a restart, at the value the vault holds now.
const handedOut = new Map<string, Set<string>>();
const HANDED_OUT_JOBS_KEPT = 2000;

export function rememberHandedOut(jobId: string, values: readonly string[]): void {
  const held = handedOut.get(jobId) ?? new Set<string>();
  for (const v of values) held.add(v);
  handedOut.delete(jobId);
  handedOut.set(jobId, held);
  for (const oldest of handedOut.keys()) {
    if (handedOut.size <= HANDED_OUT_JOBS_KEPT) break;
    handedOut.delete(oldest);
  }
}

async function resolvedRefsByJob(jobIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (jobIds.length === 0) return out;
  const rows = await db
    .select({ jobId: jobEvents.jobId, projectId: jobs.projectId, data: jobEvents.data })
    .from(jobEvents)
    .innerJoin(jobs, eq(jobs.id, jobEvents.jobId))
    .where(and(inArray(jobEvents.jobId, [...jobIds]), eq(jobEvents.kind, SECRET_RESOLVE_KIND)));
  for (const row of rows) {
    const refs = (row.data as Partial<SecretResolveAudit>).refs ?? [];
    const key = `${row.jobId}|${row.projectId}`;
    const held = out.get(key) ?? new Set<string>();
    for (const r of refs) held.add(r);
    out.set(key, held);
  }
  return out;
}

async function currentValues(projectId: string, refs: ReadonlySet<string>): Promise<string[]> {
  const wanted = [...refs].map(parseSecretRef).filter((r) => r !== null);
  if (wanted.length === 0) return [];
  // cm:guard a core that cannot decrypt cannot know the values; it refuses the output rather than
  // storing it unscrubbed.
  if (!jobsPorts().vault.isVaultConfigured()) {
    throw new Error(
      'job output unscrubbable: this job resolved testing secrets and INTEGRATION_MASTER_KEY is not set, so their values cannot be read to scrub its output',
    );
  }
  const rows = await db
    .select({
      scope: projectSecrets.scope,
      name: projectSecrets.name,
      enc: projectSecrets.valueEnc,
    })
    .from(projectSecrets)
    .where(
      and(
        eq(projectSecrets.projectId, projectId),
        inArray(
          projectSecrets.scope,
          wanted.map((w) => w.scope),
        ),
      ),
    );
  const names = new Set(wanted.map((w) => `${w.scope}/${w.name}`));
  return rows
    .filter((r) => names.has(`${r.scope}/${r.name}`))
    .map((r) => jobsPorts().vault.decryptSecret(r.enc));
}

// cm:flow testing-secrets/scrub after:audit — the values a job was handed are taken back out of
// everything its box posts, before the row is stored or broadcast
async function secretsHeldByJobs(jobIds: readonly string[]): Promise<string[]> {
  const values = new Set<string>();
  for (const id of jobIds) for (const v of handedOut.get(id) ?? []) values.add(v);
  for (const [key, refs] of await resolvedRefsByJob(jobIds)) {
    const projectId = key.split('|')[1] ?? '';
    for (const v of await currentValues(projectId, refs)) values.add(v);
  }
  return [...values];
}

export async function scrubJobOutput<T>(jobIds: readonly string[], data: T): Promise<T> {
  const secrets = await secretsHeldByJobs(jobIds);
  return secrets.length === 0 ? data : scrubSecretValuesDeep(data, secrets);
}

export async function jobsOfSession(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.agentSessionId, sessionId));
  return rows.map((r) => r.id);
}
