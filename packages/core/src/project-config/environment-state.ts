import {
  type DeploymentRecord,
  type DeploymentStatus,
  describeProbeReading,
  readRuntimeProbe,
  type TargetedDeployAdapter,
} from '../integrations/deploy/index.js';
import { isRefusal } from '../lib/refusal.js';
import {
  type EnvironmentDeclaration,
  type EnvironmentState,
  environmentStateSchema,
  type ProbeOutcomeState,
  type ProjectDocument,
  type RecordedEnvironmentState,
} from './schema.js';

type RuntimeProbe = NonNullable<EnvironmentDeclaration['verification']>['runtime'][number];
type UnknownCause = Extract<EnvironmentState, { state: 'unknown' }>['reason']['cause'];

export interface EnvironmentStateDeps {
  readonly deployAdapterFor: (bindingId: string) => Promise<TargetedDeployAdapter | null>;
  /** Absent in production, where the runtime probe makes its own request; a test hands in a fake. */
  readonly fetch?: typeof fetch;
  readonly probeTimeoutMs: number;
}

interface EnvironmentStateContext {
  readonly sourceType: ProjectDocument['source']['type'];
}

const STATE_OF: Readonly<Record<DeploymentStatus, RecordedEnvironmentState['state']>> = {
  queued: 'deploying',
  running: 'deploying',
  succeeded: 'deployed',
  failed: 'failed',
  cancelled: 'cancelled',
};

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function sameIdentity(identifies: RuntimeProbe['identifies'], recorded: string, read: string) {
  if (identifies === 'artifact') return recorded === read;
  const a = recorded.toLowerCase();
  const b = read.toLowerCase();
  return a.length >= b.length ? a.startsWith(b) && b.length >= 7 : b.startsWith(a);
}

async function runProbe(
  probe: RuntimeProbe,
  record: DeploymentRecord,
  deps: EnvironmentStateDeps,
): Promise<ProbeOutcomeState> {
  const where = { url: probe.url, identifies: probe.identifies };
  const seen = await readRuntimeProbe(probe, { timeoutMs: deps.probeTimeoutMs, fetch: deps.fetch });
  if (seen.kind !== 'value') {
    return { ...where, status: 'unreachable', error: clip(describeProbeReading(probe, seen), 500) };
  }
  const recorded = probe.identifies === 'source' ? record.sourceRevision : record.artifact?.id;
  if (!recorded) {
    const what = probe.identifies === 'source' ? 'source revision' : 'artifact';
    return {
      ...where,
      status: 'uncompared',
      observed: seen.value,
      error: clip(`deployment ${record.id} records no ${what} to compare with`, 500),
    };
  }
  return sameIdentity(probe.identifies, recorded, seen.value)
    ? { ...where, status: 'confirmed', observed: seen.value }
    : { ...where, status: 'mismatch', observed: seen.value, expected: recorded };
}

function evidenceOf(probes: readonly ProbeOutcomeState[]): RecordedEnvironmentState['evidence'] {
  const has = (status: ProbeOutcomeState['status']) => probes.some((p) => p.status === status);
  if (has('mismatch')) return 'runtime-mismatch';
  if (has('unreachable')) return 'runtime-unreachable';
  if (has('confirmed')) return 'runtime-confirmed';
  return 'deployment-record';
}

function sourceOf(
  record: DeploymentRecord,
  ctx: EnvironmentStateContext,
): RecordedEnvironmentState['source'] {
  if (record.sourceRevision !== null) return { kind: 'revision', revision: record.sourceRevision };
  return ctx.sourceType === 'git' ? { kind: 'unrecorded' } : { kind: 'non-git' };
}

const unknown = (environment: string, cause: UnknownCause, message: string) =>
  environmentStateSchema.parse({
    environment,
    state: 'unknown',
    evidence: 'none',
    reason: { cause, message: clip(message, 1000) },
  });

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function latestRecord(
  environment: string,
  bindingId: string,
  deps: EnvironmentStateDeps,
): Promise<
  | { ok: true; record: DeploymentRecord; bound: TargetedDeployAdapter }
  | { ok: false; state: EnvironmentState }
> {
  let bound: TargetedDeployAdapter | null;
  try {
    bound = await deps.deployAdapterFor(bindingId);
  } catch (err) {
    if (!isRefusal(err)) {
      return { ok: false, state: unknown(environment, 'adapter-error', why(err)) };
    }
    return {
      ok: false,
      state: unknown(
        environment,
        'binding-refused',
        err.refusals.map((r) => `${r.code}: ${r.detail}`).join('; '),
      ),
    };
  }
  if (!bound) {
    const message = `BINDING_NOT_FOUND: environment \`${environment}\` deploys through binding ${bindingId}, which this project does not hold`;
    return { ok: false, state: unknown(environment, 'binding-refused', message) };
  }
  try {
    const record = await bound.adapter.latestDeployment(bound.target);
    if (record) return { ok: true, record, bound };
    const message = `binding ${bindingId} reports no deployment of this environment's target`;
    return { ok: false, state: unknown(environment, 'no-record', message) };
  } catch (err) {
    return { ok: false, state: unknown(environment, 'adapter-error', why(err)) };
  }
}

export async function resolveEnvironmentState(
  environment: string,
  decl: EnvironmentDeclaration,
  ctx: EnvironmentStateContext,
  deps: EnvironmentStateDeps,
): Promise<EnvironmentState> {
  if ('mode' in decl.deployment) {
    return unknown(
      environment,
      'external',
      `environment \`${environment}\` is deployed outside Forge, with no binding to read`,
    );
  }
  const latest = await latestRecord(environment, decl.deployment.binding, deps);
  if (!latest.ok) return latest.state;
  const { record, bound } = latest;
  const probes = await Promise.all(
    (decl.verification?.runtime ?? []).map((p) => runProbe(p, record, deps)),
  );
  return environmentStateSchema.parse({
    environment,
    state: STATE_OF[record.status],
    evidence: evidenceOf(probes),
    deployment: {
      id: record.id,
      provider: bound.adapter.provider,
      status: record.status,
      at: record.at,
    },
    artifact: record.artifact,
    source: sourceOf(record, ctx),
    ...(probes.length > 0 ? { probes } : {}),
  });
}
