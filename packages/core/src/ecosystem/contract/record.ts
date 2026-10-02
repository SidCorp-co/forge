import { db } from '../../db/client.js';
import type { Publication } from '../schema.js';
import { lockKeys } from '../store.js';
import { type MeasuredChange, type MeasuredDiff, measured } from './diff.js';
import {
  ArtifactUnreadable,
  elementList,
  INITIAL,
  measureChange,
  parseArtifact,
  sha256,
} from './measure.js';
import { type NamingProblem, namingProblem, proposeVersion, type Versioning } from './naming.js';
import { insertVersion, latestVersion, readArtifact, type StoredVersion } from './store.js';
import {
  CONTRACT_VERSION_SCHEMA_ID,
  type ContractVersionDocument,
  contractVersionSchema,
} from './version-schema.js';

export type ArtifactOrigin = { sourceCommit: string } | { uploadedBy: string; sourceRef?: string };

export interface SemanticChange {
  classification: 'breaking' | 'unknown';
  reason: string;
  elements: string[];
}

export interface RecordInput {
  providerProjectId: string;
  contractRef: string;
  publication: Pick<Publication, 'type'>;
  versioning: Versioning;
  artifact: { text: string; origin: ArtifactOrigin } | null;
  semantic?: SemanticChange;
  requestedVersion?: string;
  now?: Date;
}

export type RecordOutcome =
  | { outcome: 'recorded'; version: ContractVersionDocument }
  | { outcome: 'unchanged'; version: ContractVersionDocument }
  | {
      outcome: 'refused';
      problem:
        | NamingProblem
        | { code: 'SEMANTIC_WITHOUT_VERSION' | 'ARTIFACT_UNREADABLE'; detail: string };
    };

const slugOf = (ref: string) => ref.slice(ref.indexOf('/') + 1);

const undecided = (check: string, text: string): MeasuredChange => ({
  element: 'document',
  kind: 'changed',
  level: 'warning',
  text,
  check,
});

async function diffFrom(
  input: RecordInput,
  latest: StoredVersion | null,
  previousText: string | null,
): Promise<MeasuredDiff> {
  const type = input.publication.type;
  if (input.semantic) {
    const { classification, reason, elements } = input.semantic;
    return {
      tool: 'none',
      classification,
      changes: elements.map((element) => ({
        element,
        kind: 'changed',
        level: classification === 'breaking' ? 'breaking' : 'warning',
        text: reason,
        check: 'semantic-change',
      })),
    };
  }
  if (!latest) return INITIAL;
  if (type === 'opaque') {
    return measured('none', '', [
      undecided(
        'opaque',
        'an opaque contract has no artifact to measure, so every change to it is unknown',
      ),
    ]);
  }
  if (latest.contractType !== type) {
    return measured('none', '', [
      undecided(
        'contract-type-changed',
        `the contract was ${latest.contractType} and is now ${type}; no differ compares across types`,
      ),
    ]);
  }
  if (previousText === null || !input.artifact) {
    return measured('none', '', [
      undecided(
        'no-previous-artifact',
        `version ${latest.version} holds no artifact to compare against`,
      ),
    ]);
  }
  return measureChange(type, previousText, input.artifact.text);
}

function documentOf(
  input: RecordInput,
  latest: StoredVersion | null,
  diff: MeasuredDiff,
  name: string,
  now: Date,
): ContractVersionDocument {
  const artifact = input.artifact
    ? { sha256: sha256(input.artifact.text), ...input.artifact.origin }
    : (latest?.document.artifact ?? null);
  const { toolVersion, ...rest } = diff;
  return contractVersionSchema.parse({
    $schema: CONTRACT_VERSION_SCHEMA_ID,
    version: 1,
    contract: input.contractRef,
    contractVersion: name,
    previous: latest?.version ?? null,
    artifact: input.publication.type === 'opaque' ? null : artifact,
    observedAt: now.toISOString(),
    diff: { ...rest, ...(toolVersion ? { toolVersion } : {}) },
  });
}

// cm:why one lock per contract serialises lands and uploads, so each version is measured against the version that is latest when it is written and never against one a concurrent writer is replacing
export async function recordVersion(input: RecordInput): Promise<RecordOutcome> {
  const now = input.now ?? new Date();
  const slug = slugOf(input.contractRef);
  let doc: unknown = null;
  try {
    doc = input.artifact ? parseArtifact(input.publication.type, input.artifact.text) : null;
  } catch (err) {
    if (!(err instanceof ArtifactUnreadable)) throw err;
    return { outcome: 'refused', problem: { code: 'ARTIFACT_UNREADABLE', detail: err.message } };
  }
  return db.transaction(async (tx) => {
    await lockKeys(tx, [`contract:${input.providerProjectId}/${slug}`]);
    const latest = await latestVersion(tx, input.providerProjectId, slug);
    if (input.semantic && !latest) {
      return {
        outcome: 'refused',
        problem: {
          code: 'SEMANTIC_WITHOUT_VERSION',
          detail: `${input.contractRef} has no recorded version yet; a semantic change is declared against a version core has recorded.`,
        },
      };
    }
    const hash = input.artifact ? sha256(input.artifact.text) : null;
    if (hash && !input.semantic && latest?.artifactSha256 === hash) {
      return { outcome: 'unchanged', version: latest.document };
    }
    const previousText = latest?.artifactSha256
      ? await readArtifact(tx, latest.artifactSha256)
      : null;
    const diff = await diffFrom(input, latest, previousText);
    const previous = latest?.version ?? null;
    const today = now.toISOString().slice(0, 10);
    if (input.requestedVersion !== undefined) {
      const problem = namingProblem({
        versioning: input.versioning,
        previous,
        requested: input.requestedVersion,
        diff,
      });
      if (problem) return { outcome: 'refused', problem };
    }
    const name = input.requestedVersion ?? proposeVersion(input.versioning, previous, diff, today);
    const document = documentOf(input, latest, diff, name, now);
    const indexed = input.artifact
      ? elementList(input.publication.type, doc)
      : (latest?.elements ?? null);
    await insertVersion(tx, {
      providerProjectId: input.providerProjectId,
      contractSlug: slug,
      contractType: input.publication.type,
      document,
      artifact: input.artifact && hash ? { sha256: hash, content: input.artifact.text } : null,
      elements: indexed,
    });
    return { outcome: 'recorded', version: document };
  });
}
