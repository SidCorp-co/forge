import { db } from '../../db/client.js';
import { loadInterface, type ProviderWriter, providerWriterMiss } from '../interface-service.js';
import type { EcosystemRefusal } from '../refusals.js';
import { projectsWhere } from '../store.js';
import { INDEXED_TYPES, isIndexed } from './elements.js';
import { recordVersion } from './record.js';
import { versionsOf } from './store.js';
import { type UploadBody, uploadRefusals } from './upload-rules.js';
import type { ContractVersionDocument } from './version-schema.js';

interface PublishInput extends UploadBody {
  projectId: string;
  writer: ProviderWriter;
  contract: string;
  /** The contract kind the caller says the artifact is; checked against what the interface publishes. */
  kind?: string | undefined;
  sourceRef?: string | undefined;
}

type PublishOutcome =
  | { ok: true; recorded: boolean; version: ContractVersionDocument }
  | { ok: false; refusals: EcosystemRefusal[] };

const refused = (refusals: EcosystemRefusal[]): PublishOutcome => ({ ok: false, refusals });

function kindRefusals(kind: string | undefined, published: string | undefined, ref: string) {
  if (kind === undefined) return [];
  if (!isIndexed(kind)) {
    return [
      {
        code: 'CONTRACT_KIND_UNKNOWN' as const,
        path: '/kind',
        detail: `"${kind}" is no contract kind core indexes; a version is published as one of ${INDEXED_TYPES.join(', ')}.`,
      },
    ];
  }
  if (published !== undefined && published !== kind) {
    return [
      {
        code: 'CONTRACT_KIND_MISMATCH' as const,
        path: '/kind',
        detail: `${ref} is published as ${published} in the interface, not ${kind}; change the publication's type first, or send the artifact it declares.`,
      },
    ];
  }
  return [];
}

// cm:why the REST upload and forge_ecosystem contract_version_publish are one service, so the writer rule, the kind check and the version rules are the same at both doors
export async function publishContractVersion(input: PublishInput): Promise<PublishOutcome> {
  const { projectId, writer, contract, kind, sourceRef, ...body } = input;
  const denied = await providerWriterMiss(writer, projectId, 'publishing a contract version');
  if (denied) return refused([denied]);
  const [project] = await projectsWhere(db, { ids: [projectId] });
  if (!project)
    throw new Error(`ecosystem: project ${projectId} passed the writer rule and has no row`);
  const iface = await loadInterface(projectId);
  const pub = iface?.document.publishes[contract];
  const ref = `${project.slug}/${contract}`;
  const early = kindRefusals(kind, pub?.type, ref);
  if (early.some((r) => r.code === 'CONTRACT_KIND_UNKNOWN')) return refused(early);
  const latest = (await versionsOf(db, [projectId], contract))[0] ?? null;
  const refusals = [
    ...early,
    ...uploadRefusals({ project, contract, iface: iface?.document ?? null, body, latest }),
  ];
  if (refusals.length > 0 || !pub || !iface) return refused(refusals);
  const origin = { uploadedBy: writer.userId, ...(sourceRef ? { sourceRef } : {}) };
  const out = await recordVersion({
    providerProjectId: projectId,
    contractRef: ref,
    publication: pub,
    versioning: iface.document.commitments.versioning,
    artifact: body.artifact ? { text: body.artifact, origin } : null,
    ...(body.semantic
      ? {
          semantic: {
            ...body.semantic,
            classification: body.semantic.classification as 'breaking' | 'unknown',
          },
        }
      : {}),
    ...(body.version ? { requestedVersion: body.version } : {}),
  });
  if (out.outcome === 'refused') {
    const path =
      out.problem.code === 'SEMANTIC_WITHOUT_VERSION'
        ? '/semantic'
        : out.problem.code === 'ARTIFACT_UNREADABLE'
          ? '/artifact'
          : '/version';
    return refused([{ code: out.problem.code, path, detail: out.problem.detail }]);
  }
  return { ok: true, recorded: out.outcome === 'recorded', version: out.version };
}
