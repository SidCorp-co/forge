/**
 * The contract versions a job is given (workflow requirement-to-delivery, edge delivery -> build):
 * every version its requirement's latest baseline pins, whole, never a newer one and never one
 * nobody approved, refused by name when a pinned version cannot be given.
 */

import type { ArtifactContextRefusalCode } from '@forge/contracts/workflows';
import { and, desc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { contractArtifacts, contractVersions } from '../db/schema-ecosystem.js';
import { RefusalError } from '../lib/refusal.js';
import type { RequirementPinRow } from './requirement-context.js';

/** How much of one artifact a prompt carries; the rest is fetched from the artifact route. */
const PINNED_ARTIFACT_CHARS = 40_000;

interface PinnedVersionRow {
  providerProjectId: string;
  contractSlug: string;
  version: string;
  approval: string;
  contractType: string;
  elements: string[] | null;
  artifactSha256: string | null;
}

export interface LoadedPinnedContract {
  /** `<project>/<contract>`. */
  ref: string;
  providerProjectId: string;
  contractSlug: string;
  version: string;
  type: string;
  elements: readonly string[] | null;
  artifact: string | null;
  sha256: string | null;
}

const pinnedRefusal = (code: ArtifactContextRefusalCode, detail: string) =>
  new RefusalError([{ code, path: '', detail }], 'ARTIFACT_CONTEXT_UNLOADABLE');

/**
 * Why one pinned version cannot be given, or null. `versions` are the contract's recorded versions,
 * newest first; the current one is the newest approved.
 */
function pinnedContractProblem(
  key: string,
  at: string,
  version: string,
  versions: readonly Pick<PinnedVersionRow, 'version' | 'approval'>[],
): RefusalError | null {
  const hit = versions.find((v) => v.version === version);
  if (!hit) {
    return pinnedRefusal(
      'ARTIFACT_CONTEXT_UNLOADABLE',
      `contract-version ${at}@${version}: ${key}'s latest baseline pins it, and its provider holds no such version`,
    );
  }
  if (hit.approval !== 'approved') {
    return pinnedRefusal(
      'ARTIFACT_CONTEXT_UNLOADABLE',
      `contract-version ${at}@${version}: ${key}'s latest baseline pins it, and it is ${hit.approval}; a job is given approved versions only`,
    );
  }
  const current = versions.find((v) => v.approval === 'approved')?.version ?? null;
  if (current !== version) {
    return pinnedRefusal(
      'REQUIREMENT_REVISION_NOT_CURRENT',
      `contract-version ${at}@${version}: ${key}'s latest baseline pins it, and ${current} is the current version now; a superseded version is never given, so a person re-pins ${key} first`,
    );
  }
  return null;
}

/** Every contract version `key`'s latest baseline pins, in pin order; throws the refusal. */
export async function loadPinnedContracts(
  key: string,
  pins: readonly RequirementPinRow[],
): Promise<LoadedPinnedContract[]> {
  const wanted = pins.flatMap((p) =>
    p.providerProjectId && p.contractSlug && p.contractVersion
      ? [
          {
            providerProjectId: p.providerProjectId,
            contractSlug: p.contractSlug,
            version: p.contractVersion,
          },
        ]
      : [],
  );
  if (wanted.length === 0) return [];
  const providers = [...new Set(wanted.map((w) => w.providerProjectId))];
  const [rows, slugs] = await Promise.all([
    db
      .select({
        providerProjectId: contractVersions.providerProjectId,
        contractSlug: contractVersions.contractSlug,
        version: contractVersions.version,
        approval: contractVersions.approval,
        contractType: contractVersions.contractType,
        elements: contractVersions.elements,
        artifactSha256: contractVersions.artifactSha256,
      })
      .from(contractVersions)
      .where(
        and(
          inArray(contractVersions.providerProjectId, providers),
          inArray(contractVersions.contractSlug, [...new Set(wanted.map((w) => w.contractSlug))]),
        ),
      )
      .orderBy(desc(contractVersions.recordedAt)),
    db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(inArray(projects.id, providers)),
  ]);
  const out: LoadedPinnedContract[] = [];
  for (const w of wanted) {
    const ref = `${slugs.find((s) => s.id === w.providerProjectId)?.slug ?? w.providerProjectId}/${w.contractSlug}`;
    const versions = rows.filter(
      (r) => r.providerProjectId === w.providerProjectId && r.contractSlug === w.contractSlug,
    );
    const problem = pinnedContractProblem(key, ref, w.version, versions);
    if (problem) throw problem;
    const hit = versions.find((v) => v.version === w.version) as PinnedVersionRow;
    out.push({
      ref,
      providerProjectId: w.providerProjectId,
      contractSlug: w.contractSlug,
      version: w.version,
      type: hit.contractType,
      elements: hit.elements,
      artifact: null,
      sha256: hit.artifactSha256,
    });
  }
  const artifacts = await artifactsOf(out.flatMap((c) => (c.sha256 ? [c.sha256] : [])));
  return out.map((c) => (c.sha256 ? { ...c, artifact: artifacts.get(c.sha256) ?? null } : c));
}

async function artifactsOf(shas: readonly string[]): Promise<Map<string, string>> {
  if (shas.length === 0) return new Map();
  const rows = await db
    .select({ sha256: contractArtifacts.sha256, content: contractArtifacts.content })
    .from(contractArtifacts)
    .where(inArray(contractArtifacts.sha256, [...new Set(shas)]));
  return new Map(rows.map((r) => [r.sha256, r.content]));
}

/** The prompt block: each pinned version, its elements and its text. */
export function renderPinnedContracts(
  key: string,
  loaded: readonly LoadedPinnedContract[],
): string | null {
  if (loaded.length === 0) return null;
  const parts = loaded.map((c) => {
    const route = `/api/projects/${c.providerProjectId}/contracts/${c.contractSlug}/versions/${c.version}/artifact`;
    const elements = c.elements?.length
      ? `Elements: ${c.elements.join(', ')}`
      : 'Elements: not indexed for this kind.';
    const text =
      c.artifact === null
        ? 'Artifact: none stored (an opaque contract).'
        : c.artifact.length > PINNED_ARTIFACT_CHARS
          ? `Artifact (the first ${PINNED_ARTIFACT_CHARS} of ${c.artifact.length} characters; the whole is at GET ${route}):\n\`\`\`\n${c.artifact.slice(0, PINNED_ARTIFACT_CHARS)}\n\`\`\``
          : `Artifact (also at GET ${route}, which a mock server reads):\n\`\`\`\n${c.artifact}\n\`\`\``;
    return [`### ${c.ref}@${c.version} (${c.type})`, elements, text].join('\n');
  });
  return [
    `## The contract versions ${key}'s latest baseline pins`,
    'Build against exactly these versions, the provider and the consumer alike. When the work lands, name each one it implemented: `contracts: ["<project>/<contract>@<version>"]` on the merge mark.',
    ...parts,
  ].join('\n\n');
}

/** What the job's record keeps of each version it was given. */
export function pinnedContractsRecord(loaded: readonly LoadedPinnedContract[]) {
  return loaded.map((c) => ({
    kind: 'contract-version' as const,
    ref: c.ref,
    version: c.version,
    sha256: c.sha256,
    chars: c.artifact?.length ?? 0,
  }));
}
