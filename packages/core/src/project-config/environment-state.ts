import type {
  DeploymentRecord,
  DeploymentStatus,
  TargetedDeployAdapter,
} from './deploy-adapters/types.js';
import {
  type EnvironmentDeclaration,
  type EnvironmentState,
  environmentStateSchema,
} from './schema.js';

type RuntimeProbe = NonNullable<EnvironmentDeclaration['verification']>['runtime'][number];

export type ProbeOutcome =
  | { readonly ok: true; readonly probe: RuntimeProbe; readonly read: string }
  | { readonly ok: false; readonly probe: RuntimeProbe; readonly reason: string };

export interface EnvironmentStateDeps {
  readonly deployAdapterFor: (bindingId: string) => Promise<TargetedDeployAdapter | null>;
  readonly fetch: typeof fetch;
  readonly probeTimeoutMs: number;
  readonly onProbe?: (environment: string, outcome: ProbeOutcome) => void;
}

export type EnvironmentStateRefusal =
  | 'BINDING_NOT_FOUND'
  | 'BINDING_ROLE_MISMATCH'
  | 'DEPLOY_HISTORY_UNSUPPORTED';

export class EnvironmentStateError extends Error {
  readonly code: EnvironmentStateRefusal;
  constructor(code: EnvironmentStateRefusal, message: string) {
    super(message);
    this.name = 'EnvironmentStateError';
    this.code = code;
  }
}

const STATE_OF: Readonly<Record<DeploymentStatus, EnvironmentState['state']>> = {
  queued: 'deploying',
  running: 'deploying',
  succeeded: 'deployed',
  failed: 'failed',
  cancelled: 'failed',
};

function readPath(body: unknown, path: string): unknown {
  let at: unknown = body;
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

async function runProbe(probe: RuntimeProbe, deps: EnvironmentStateDeps): Promise<ProbeOutcome> {
  let res: Response;
  try {
    res = await deps.fetch(probe.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(deps.probeTimeoutMs),
    });
  } catch (err) {
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, probe, reason: `GET ${probe.url} did not answer (${why})` };
  }
  if (res.status !== 200) {
    return { ok: false, probe, reason: `GET ${probe.url} answered HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, probe, reason: `GET ${probe.url} answered a body that is not JSON` };
  }
  const value = readPath(body, probe.path);
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, probe, reason: `GET ${probe.url} carries no string at \`${probe.path}\`` };
  }
  return { ok: true, probe, read: value.trim() };
}

function recordIdentity(record: DeploymentRecord, identifies: RuntimeProbe['identifies']) {
  return identifies === 'source' ? record.sourceRevision : (record.artifact?.id ?? null);
}

function sameIdentity(
  identifies: RuntimeProbe['identifies'],
  recorded: string,
  read: string,
): boolean {
  if (identifies === 'artifact') return recorded === read;
  const a = recorded.toLowerCase();
  const b = read.toLowerCase();
  return a.length >= b.length ? a.startsWith(b) && b.length >= 7 : b.startsWith(a);
}

async function runtimeEvidence(
  environment: string,
  decl: EnvironmentDeclaration,
  record: DeploymentRecord,
  deps: EnvironmentStateDeps,
): Promise<EnvironmentState['evidence']> {
  const probes = decl.verification?.runtime ?? [];
  if (record.status !== 'succeeded' || probes.length === 0) return 'deployment-record';
  const outcomes = await Promise.all(probes.map((p) => runProbe(p, deps)));
  let confirmed = false;
  for (const outcome of outcomes) {
    deps.onProbe?.(environment, outcome);
    if (!outcome.ok) continue;
    const recorded = recordIdentity(record, outcome.probe.identifies);
    if (recorded === null) continue;
    if (!sameIdentity(outcome.probe.identifies, recorded, outcome.read)) return 'runtime-mismatch';
    confirmed = true;
  }
  return confirmed ? 'runtime-confirmed' : 'deployment-record';
}

export async function resolveEnvironmentState(
  environment: string,
  decl: EnvironmentDeclaration,
  deps: EnvironmentStateDeps,
): Promise<EnvironmentState> {
  if ('mode' in decl.deployment) {
    return environmentStateSchema.parse({ environment, state: 'unknown', evidence: 'none' });
  }
  const bindingId = decl.deployment.binding;
  const bound = await deps.deployAdapterFor(bindingId);
  if (!bound) {
    throw new EnvironmentStateError(
      'BINDING_NOT_FOUND',
      `environment \`${environment}\` deploys through binding ${bindingId}, which this project does not hold`,
    );
  }
  const record = await bound.adapter.latestDeployment(bound.target);
  if (!record) {
    return environmentStateSchema.parse({ environment, state: 'unknown', evidence: 'none' });
  }
  return environmentStateSchema.parse({
    environment,
    state: STATE_OF[record.status],
    evidence: await runtimeEvidence(environment, decl, record, deps),
    deployment: {
      id: record.id,
      provider: bound.adapter.provider,
      status: record.status,
      at: record.at,
    },
    artifact: record.artifact,
    source: record.sourceRevision === null ? null : { revision: record.sourceRevision },
  });
}
