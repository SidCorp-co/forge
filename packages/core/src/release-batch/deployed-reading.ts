/** What Forge itself last deployed through a project's deploy bindings, read when asked and never
 *  stored (ISS-1346). A deployment's commit is read off the provider's own record of it, so the
 *  identity is one Forge observed; a deploy made outside Forge is not seen. */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { getAdapter } from '../integrations/registry.js';
import {
  type BindingWithConnection,
  buildContextFromBinding,
  listActiveDeployBindingsForStage,
} from '../integrations/store.js';
import type { AdapterContext } from '../integrations/types.js';
import { recognisableIdentity } from '../messaging/verdict-identity.js';
import { PROBE_REQUEST_CAP_MS } from './verify.js';

/** `answered` names at least one commit, `unanswered` is a route that answered nothing this time,
 *  and `unrouted` is a project with nothing Forge could ever read a commit from. */
export type DeployedReading =
  | {
      readonly kind: 'answered';
      readonly commits: readonly string[];
      readonly readFrom: readonly string[];
      readonly unread: readonly string[];
    }
  | {
      readonly kind: 'unanswered';
      readonly readFrom: readonly string[];
      readonly unread: readonly string[];
    }
  | { readonly kind: 'unrouted'; readonly missing: string };

interface TargetAnswer {
  readonly commit: string | null;
  readonly readFrom: string | null;
  readonly unread: string | null;
}

type ReadCommit = (deploymentId: string) => Promise<string | null>;

/** A bound deploy target: its id and the resource it points at are its identity, the label its
 *  name. A target repointed under the same label is a different target (ISS-1346 review, F2). */
interface DeployTarget {
  readonly id: string;
  readonly label: string;
  readonly resource: string;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function targetsOf(ctx: AdapterContext): DeployTarget[] {
  const listed: unknown = ctx.config.targets;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((t: Record<string, unknown> | null) => {
    const id = text(t?.id);
    const label = text(t?.label);
    const resource = text(t?.resourceUuid);
    return id && label && resource ? [{ id, label, resource }] : [];
  });
}

/** Whether this binding's provider can say which commit one of its deployments built. */
function reports(pair: BindingWithConnection): boolean {
  return typeof getAdapter(pair.binding.provider)?.deployedCommit === 'function';
}

function stagesOf(pair: BindingWithConnection): string {
  return (pair.binding.stages ?? []).join(', ');
}

function providerName(pair: BindingWithConnection): string {
  const provider = pair.binding.provider;
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

function targetName(pair: BindingWithConnection, target: DeployTarget): string {
  return `${providerName(pair)} target \`${target.label}\` (${stagesOf(pair)})`;
}

/**
 * The latest deployment Forge dispatched to this target — a deploy or a rollback — that it then saw
 * finish. The outbound row is what names the target and the resource it was sent to; the inbound
 * row, joined on the deployment the provider handed back, is what says it finished.
 */
async function latestFinished(
  bindingId: string,
  target: DeployTarget,
): Promise<{ uuid: string; at: string } | null> {
  const rows = (await db.execute(sql`
    SELECT i.payload ->> 'deployment_uuid' AS uuid, i.created_at AS at
      FROM integration_deliveries i
      JOIN integration_deliveries o
        ON o.binding_id = i.binding_id
       AND o.direction = 'outbound'
       AND o.response ->> 'deployment_uuid' = i.payload ->> 'deployment_uuid'
     WHERE i.binding_id = ${bindingId}
       AND i.direction = 'inbound'
       AND i.event_name = 'deploy.succeeded'
       AND o.payload ->> 'targetId' = ${target.id}
       AND o.payload ->> 'resourceUuid' = ${target.resource}
     ORDER BY i.created_at DESC
     LIMIT 1
  `)) as unknown as Array<{ uuid: string | null; at: string | Date }>;
  const row = rows[0];
  if (!row?.uuid) return null;
  return { uuid: row.uuid, at: new Date(row.at).toISOString() };
}

async function readTarget(
  pair: BindingWithConnection,
  target: DeployTarget,
  readCommit: ReadCommit,
): Promise<TargetAnswer> {
  const name = targetName(pair, target);
  const last = await latestFinished(pair.binding.id, target);
  if (!last) {
    return {
      commit: null,
      readFrom: null,
      unread: `${name} has no deployment Forge made and saw finish on record, so nothing names what it runs — deploy it through Forge`,
    };
  }
  const where = `Forge's deployment ${last.uuid} to ${name}, finished ${last.at}`;
  try {
    const commit = String((await readCommit(last.uuid)) ?? '').trim();
    if (!recognisableIdentity(commit)) {
      const said = commit === '' ? 'no commit' : `\`${commit}\`, which is not a commit`;
      return { commit: null, readFrom: where, unread: `${where} reports ${said}` };
    }
    return { commit: commit.toLowerCase(), readFrom: where, unread: null };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { commit: null, readFrom: where, unread: `${where} could not be read: ${why}` };
  }
}

async function readBinding(pair: BindingWithConnection): Promise<TargetAnswer[]> {
  const named = `the ${providerName(pair)} binding ${pair.binding.id} (${stagesOf(pair)})`;
  const read = getAdapter(pair.binding.provider)?.deployedCommit;
  let ctx: AdapterContext;
  try {
    ctx = buildContextFromBinding(pair);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return [{ commit: null, readFrom: null, unread: `${named} could not be opened: ${why}` }];
  }
  const targets = targetsOf(ctx);
  if (!read || targets.length === 0) {
    return [{ commit: null, readFrom: null, unread: `${named} names no target` }];
  }
  const readCommit: ReadCommit = (id) => read(ctx, id, PROBE_REQUEST_CAP_MS);
  return Promise.all(targets.map((target) => readTarget(pair, target, readCommit)));
}

async function activeDeployBindings(projectId: string): Promise<BindingWithConnection[]> {
  const [preview, live] = await Promise.all([
    listActiveDeployBindingsForStage(projectId, 'preview'),
    listActiveDeployBindingsForStage(projectId, 'live'),
  ]);
  const seen = new Map<string, BindingWithConnection>();
  for (const pair of [...preview, ...live]) seen.set(pair.binding.id, pair);
  return [...seen.values()];
}

function unroutedWhy(pairs: readonly BindingWithConnection[]): string {
  if (pairs.length === 0) {
    return 'this project has no active deploy binding, so Forge makes no deployment it could read a commit from';
  }
  const providers = [...new Set(pairs.map((p) => p.binding.provider))].join(', ');
  return `its deploy bindings go through ${providers}, and none of them reports the commit a deployment built`;
}

/** Every commit the latest finished Forge deployment of each target reports, now. */
export async function readForgeDeployments(projectId: string): Promise<DeployedReading> {
  const pairs = await activeDeployBindings(projectId);
  const reporting = pairs.filter(reports);
  if (reporting.length === 0) return { kind: 'unrouted', missing: unroutedWhy(pairs) };

  const answers = (await Promise.all(reporting.map(readBinding))).flat();
  const silent = pairs
    .filter((p) => !reports(p))
    .map(
      (p) => `the ${providerName(p)} binding ${p.binding.id} reports no commit a deployment built`,
    );
  const commits = [...new Set(answers.flatMap((a) => (a.commit ? [a.commit] : [])))];
  const readFrom = answers.flatMap((a) => (a.readFrom ? [a.readFrom] : []));
  const unread = [...answers.flatMap((a) => (a.unread ? [a.unread] : [])), ...silent];
  if (commits.length === 0) return { kind: 'unanswered', readFrom, unread };
  return { kind: 'answered', commits, readFrom, unread };
}
