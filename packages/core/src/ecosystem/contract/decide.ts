import { db } from '../../db/client.js';
import type { ActorAgency } from '../../issues/actor-agency.js';
import { effectiveProjectRole } from '../../lib/authz.js';
import { readProjectDocument } from '../../project-config/service.js';
import { notFound, refusedBy } from '../access.js';
import type { EcosystemRefusal } from '../refusals.js';
import { lockKeys, projectsWhere } from '../store.js';
import { approverRefusal, type ContractDecision, decisionRefusals } from './approval.js';
import { decideVersion, type StoredVersion, versionsOf } from './store.js';

export interface DecideInput {
  projectId: string;
  contract: string;
  version: string;
  decision: ContractDecision;
  reason: string | null;
  actor: { userId: string; agency: ActorAgency };
}

export type DecideOutcome =
  | { ok: true; version: StoredVersion }
  | { ok: false; refusals: EcosystemRefusal[] };

// cm:why the REST decision and forge_ecosystem contract_version_decide are one service, so who may decide and what may be decided are the same at both doors
export async function decideContractVersion(input: DecideInput): Promise<DecideOutcome> {
  const { projectId, contract, version, decision, actor } = input;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const [project] = await projectsWhere(db, { ids: [projectId] });
  if (!project) throw notFound(`project ${projectId} does not exist`);
  const ref = `${project.slug}/${contract}@${version}`;
  const read = async () =>
    (await versionsOf(db, [projectId], contract)).find((v) => v.version === version) ?? null;
  const target = await read();
  if (!target) throw notFound(`${project.slug}/${contract} has no recorded version "${version}"`);
  const [access, doc] = await Promise.all([
    effectiveProjectRole(actor.userId, projectId),
    readProjectDocument(projectId),
  ]);
  const denied = approverRefusal(
    {
      userId: actor.userId,
      agency: actor.agency,
      role: access?.role ?? null,
      orgRole: access?.orgRole ?? null,
    },
    { ref, classification: target.document.diff.classification },
    doc?.document.contracts?.approver ?? 'owner',
    projectId,
  );
  if (denied) throw refusedBy(denied);
  return db.transaction(async (tx) => {
    await lockKeys(tx, [`contract:${projectId}/${contract}`]);
    const now = (await versionsOf(tx, [projectId], contract)).find((v) => v.version === version);
    if (!now) throw notFound(`${project.slug}/${contract} has no recorded version "${version}"`);
    const refusals = decisionRefusals({ ref, approval: now.approval, decision, reason });
    if (refusals.length > 0) return { ok: false, refusals };
    const wrote = await decideVersion(tx, {
      providerProjectId: projectId,
      contractSlug: contract,
      version,
      approval: decision === 'approve' ? 'approved' : 'returned',
      decidedBy: actor.userId,
      decidedAs: actor.agency === 'agent' ? 'agent' : 'person',
      reason,
    });
    if (!wrote) throw new Error(`ecosystem: ${ref} moved under its own lock`);
    const decided = (await versionsOf(tx, [projectId], contract)).find(
      (v) => v.version === version,
    );
    if (!decided) throw new Error(`ecosystem: ${ref} vanished under its own lock`);
    return { ok: true, version: decided };
  });
}
