import type { ActorAgency } from '@forge/contracts/permissions';
import { db } from '../../db/client.js';
import { embedFeedbackLater } from '../../feedback/index.js';
import { settleContractWaitsIn } from '../../issues/index.js';
import { contractLockKey } from '../../lib/contract-versions.js';
import { permissionFactsOf } from '../../permissions/index.js';
import { notFound } from '../access.js';
import { loadInterface } from '../interface-service.js';
import type { EcosystemRefusal } from '../refusals.js';
import { lockKeys, projectsWhere } from '../store.js';
import { type Approved, announceApprovedIn, fileBreakingIn } from './announce.js';
import { approverRefusal, type ContractDecision, decisionRefusals } from './approval.js';
import { compareVersions } from './naming.js';
import { approvalView, decideVersion, type StoredVersion, versionsOf } from './store.js';

interface DecideInput {
  projectId: string;
  contract: string;
  version: string;
  decision: ContractDecision;
  reason: string | null;
  actor: { userId: string; agency: ActorAgency };
}

type DecideOutcome =
  | { ok: true; version: StoredVersion; filed: string[] }
  | { ok: false; refusals: EcosystemRefusal[] };

// the REST decision and forge_ecosystem contract_version_decide are one service, so who may decide and what may be decided are the same at both doors
export async function decideContractVersion(input: DecideInput): Promise<DecideOutcome> {
  const { projectId, contract, version, decision, actor } = input;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const [project] = await projectsWhere(db, { ids: [projectId] });
  if (!project) throw notFound(`project ${projectId} does not exist`);
  const ref = `${project.slug}/${contract}@${version}`;
  const target = (await versionsOf(db, [projectId], contract)).find((v) => v.version === version);
  if (!target) throw notFound(`${project.slug}/${contract} has no recorded version "${version}"`);
  const [facts, iface] = await Promise.all([
    permissionFactsOf(actor.userId, projectId),
    loadInterface(projectId),
  ]);
  const denied = approverRefusal(facts, { ref });
  if (denied) return { ok: false, refusals: [denied] };
  const outcome = await db.transaction(async (tx): Promise<DecideOutcome> => {
    await lockKeys(tx, [contractLockKey(projectId, contract)]);
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
    if (decision !== 'approve' || !iface) return { ok: true, version: decided, filed: [] };
    // the approval releases every wait it reaches in its own transaction; the event it emits wakes them
    const versioning = iface.document.commitments.versioning;
    await settleContractWaitsIn(tx, {
      providerProjectId: projectId,
      contractSlug: contract,
      version,
      reaches: (min) => compareVersions(versioning, version, min) >= 0,
    });
    const approved: Approved = {
      provider: { id: project.id, slug: project.slug },
      version: decided,
      noticeDays: iface.document.commitments.deprecationNoticeDays,
      filer: actor,
    };
    const filed = await fileBreakingIn(tx, approved);
    await announceApprovedIn(tx, approved);
    return { ok: true, version: decided, filed };
  });
  if (outcome.ok) for (const id of outcome.filed) embedFeedbackLater(id);
  return outcome;
}

/** The answer both doors give a decided version. */
export const decidedView = (out: Extract<DecideOutcome, { ok: true }>) => ({
  version: out.version.document,
  approval: approvalView(out.version),
  filedFeedback: out.filed.length,
});
