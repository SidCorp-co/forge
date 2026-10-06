/** Replace an open builder run that cannot finish truly with a fresh one, as a join would open it. */

import type { ActorAgency } from '@forge/contracts/permissions';
import { db } from '../db/client.js';
import { loadOrgRole } from '../lib/authz.js';
import { emitEvent } from '../outbox/index.js';
import { permissionFactsOf } from '../permissions/index.js';
import { notFound } from './access.js';
import { owedTrigger } from './builder-head.js';
import { openedRun } from './builder-run-rules.js';
import {
  notOpenRefusal,
  supersededRun,
  supersedeReason,
  supersederRefusal,
} from './builder-supersede-rules.js';
import { loadEcosystem } from './ecosystem-service.js';
import type { BuilderRunWrite } from './link-schema.js';
import { type Held, sourceOf, storedBuilderRun } from './link-service.js';
import { insertBuilderRun, readBuilderRun, replaceBuilderRun } from './link-store.js';
import { activeEcosystemIdsOf } from './membership-store.js';
import type { EcosystemRefusal } from './refusals.js';
import { lockKeys } from './store.js';

type SupersedeOutcome =
  | { ok: true; superseded: Held<BuilderRunWrite>; opened: Held<BuilderRunWrite> }
  | { ok: false; refusals: EcosystemRefusal[] };

const refusedWith = (refusal: EcosystemRefusal): SupersedeOutcome => ({
  ok: false,
  refusals: [refusal],
});

export async function supersedeBuilderRun(input: {
  runId: string;
  /** The ecosystem the REST path names; the run must be in it. */
  ecosystemId?: string;
  /** The project the MCP side names; the run must be its. */
  projectId?: string;
  actor: { userId: string; agency: ActorAgency };
  reason: unknown;
}): Promise<SupersedeOutcome> {
  const { runId, actor } = input;
  const reason = supersedeReason(input.reason);
  if (!reason.ok) return reason;
  const row = await readBuilderRun(db, runId);
  if (
    !row ||
    (input.ecosystemId !== undefined && row.ecosystemId !== input.ecosystemId) ||
    (input.projectId !== undefined && row.projectId !== input.projectId)
  ) {
    throw notFound(
      `no builder run ${runId}${input.ecosystemId ? ` in ecosystem ${input.ecosystemId}` : ''}${input.projectId ? ` of project ${input.projectId}` : ''}`,
    );
  }
  const projectId = row.projectId;
  const eco = await loadEcosystem(row.ecosystemId);
  const denied = supersederRefusal(
    await permissionFactsOf(actor.userId, projectId),
    await loadOrgRole(eco.stewardOrgId, actor.userId),
  );
  if (denied) return refusedWith(denied);
  const closed = notOpenRefusal(runId, storedBuilderRun(row));
  if (closed) return refusedWith(closed);

  const source = await sourceOf(projectId);
  const trigger = await owedTrigger({ projectId, kind: 'manual', source });
  if (!trigger.ok) return trigger;

  return db.transaction(async (tx): Promise<SupersedeOutcome> => {
    await lockKeys(tx, [`builder run:${projectId}`]);
    const now = await readBuilderRun(tx, runId);
    if (!now) throw notFound(`builder run ${runId} is gone`);
    const doc = storedBuilderRun(now);
    const moved = notOpenRefusal(runId, doc);
    if (moved) return refusedWith(moved);
    const active = await activeEcosystemIdsOf(tx, [projectId]);
    if (!active.some((a) => a.ecosystemId === now.ecosystemId)) {
      return refusedWith({
        code: 'BUILDER_RUN_NOT_MEMBER',
        path: '/ecosystem',
        detail: `project ${projectId} is no longer an active member of ecosystem ${now.ecosystemId}, so no fresh run opens there; a run is superseded while its project is a member.`,
      });
    }
    const fresh = openedRun({
      ecosystem: now.ecosystemId,
      project: projectId,
      trigger: trigger.value,
      source,
    });
    const opened = await insertBuilderRun(tx, fresh, actor.userId);
    const closedDoc = supersededRun(doc, { run: opened.id, reason: reason.value });
    const replaced = await replaceBuilderRun(tx, {
      id: now.id,
      revision: now.revision,
      doc: closedDoc,
      userId: actor.userId,
    });
    await emitEvent(tx, 'ecosystem.buildOwed', { projectId });
    return {
      ok: true,
      superseded: { row: replaced, document: closedDoc },
      opened: { row: opened, document: fresh },
    };
  });
}
