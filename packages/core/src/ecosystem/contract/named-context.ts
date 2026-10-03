/**
 * The contract versions an issue names, given whole to the job that builds it (ISS-60).
 *
 * Path-matched contract context (`run-context.ts`) reaches a contract through a link's call sites,
 * which is the consumer's view. Contract-first inside one project also needs the other view: the
 * issue that implements a contract, or builds a screen against one before it exists, names the
 * version as `contract:<project>/<contract>@<version>` and is given that version — never a newer
 * one, and never one nobody approved.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { projectsWhere } from '../store.js';
import { currentOf, readArtifact, versionsOf } from './store.js';

export interface NamedContract {
  /** `<project>/<contract>` as the issue wrote it. */
  readonly ref: string;
  readonly contract: string;
  readonly version: string;
}

export interface LoadedNamedContract extends NamedContract {
  readonly type: string;
  /** The current version of the contract, which may be newer than the one named. */
  readonly current: string | null;
  readonly elements: readonly string[] | null;
  readonly artifact: string | null;
  readonly sha256: string | null;
}

/** Why a named contract cannot be given; prepare refuses the job under this code. */
export class NamedContractError extends Error {
  constructor(
    readonly code: 'CONTRACT_CONTEXT_UNLOADABLE' | 'CONTRACT_VERSION_NOT_APPROVED',
    message: string,
  ) {
    super(message);
    this.name = 'NamedContractError';
  }
}

const NAMED =
  /contract:\s*`?([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})@([A-Za-z0-9][A-Za-z0-9._+-]{0,39})/g;

/** Every `contract:<project>/<contract>@<version>` an issue's text names, once each, in order. */
export function contractsNamedIn(text: string): NamedContract[] {
  const out = new Map<string, NamedContract>();
  for (const m of text.matchAll(NAMED)) {
    const version = (m[3] as string).replace(/[.]+$/, '');
    const ref = `${m[1]}/${m[2]}`;
    out.set(`${ref}@${version}`, { ref, contract: m[2] as string, version });
  }
  return [...out.values()];
}

/** How much of one artifact a prompt carries; the rest is fetched from the artifact route. */
export const NAMED_ARTIFACT_CHARS = 40_000;

/** What one named version must be to be given: this project's, recorded, and approved. */
export function namedVersionProblem(
  n: NamedContract,
  own: string,
  projectId: string,
  versions: readonly { version: string; approval: string }[],
): NamedContractError | null {
  const at = `contract:${n.ref}@${n.version}`;
  if (!n.ref.startsWith(`${own}/`)) {
    return new NamedContractError(
      'CONTRACT_CONTEXT_UNLOADABLE',
      `${at} names another project's contract, and this issue is project ${own}'s; a job is given its own project's contract versions by name, and reaches another project's through its link`,
    );
  }
  const hit = versions.find((v) => v.version === n.version);
  if (!hit) {
    const known = versions.map((v) => v.version).slice(0, 10);
    return new NamedContractError(
      'CONTRACT_CONTEXT_UNLOADABLE',
      `${at} names a version project ${own} never recorded (recorded, newest first: ${known.join(', ') || 'none'})`,
    );
  }
  if (hit.approval !== 'approved') {
    return new NamedContractError(
      'CONTRACT_VERSION_NOT_APPROVED',
      `${at} is ${hit.approval}; work built against a contract version starts only once that version is approved (POST /api/projects/${projectId}/contracts/${n.contract}/versions/${n.version}/decision)`,
    );
  }
  return null;
}

// cm:guard a named version that is not this project's, not recorded, or not approved refuses the job by name — an agent given a guess or an unapproved contract builds against something nobody agreed (ISS-60)
export async function loadNamedContracts(
  projectId: string,
  named: readonly NamedContract[],
): Promise<LoadedNamedContract[]> {
  if (named.length === 0) return [];
  const [project] = await projectsWhere(db, { ids: [projectId] });
  const own = project?.slug ?? '';
  const out: LoadedNamedContract[] = [];
  for (const n of named) {
    const versions = n.ref.startsWith(`${own}/`)
      ? await versionsOf(db, [projectId], n.contract)
      : [];
    const problem = namedVersionProblem(n, own, projectId, versions);
    if (problem) throw problem;
    const hit = versions.find((v) => v.version === n.version);
    if (!hit) throw new Error(`ecosystem: ${n.ref}@${n.version} passed the check with no row`);
    out.push({
      ...n,
      type: hit.contractType,
      current: currentOf(versions)?.version ?? null,
      elements: hit.elements,
      artifact: hit.artifactSha256 ? await readArtifact(db, hit.artifactSha256) : null,
      sha256: hit.artifactSha256,
    });
  }
  return out;
}

/** The prompt block: each named version, whether it is still current, its elements and its text. */
export function renderNamedContracts(
  projectId: string,
  loaded: readonly LoadedNamedContract[],
): string | null {
  if (loaded.length === 0) return null;
  const parts = loaded.map((c) => {
    const route = `/api/projects/${projectId}/contracts/${c.contract}/versions/${c.version}/artifact`;
    const now =
      c.current === c.version
        ? 'It is the current version.'
        : `It is approved, and the contract's current version is now ${c.current ?? 'none'}; build against the version named, and name it when you land.`;
    const elements = c.elements?.length
      ? `Elements: ${c.elements.join(', ')}`
      : 'Elements: not indexed for this kind.';
    const text =
      c.artifact === null
        ? 'Artifact: none stored (an opaque contract).'
        : c.artifact.length > NAMED_ARTIFACT_CHARS
          ? `Artifact (the first ${NAMED_ARTIFACT_CHARS} of ${c.artifact.length} characters; the whole is at GET ${route}):\n\`\`\`\n${c.artifact.slice(0, NAMED_ARTIFACT_CHARS)}\n\`\`\``
          : `Artifact (also at GET ${route}, which a mock server reads):\n\`\`\`\n${c.artifact}\n\`\`\``;
    return [`### ${c.ref}@${c.version} (${c.type})`, now, elements, text].join('\n');
  });
  return [
    '## Contract versions this issue names',
    'Build against exactly these versions. When the work lands, name each one it implemented: `contracts: ["<project>/<contract>@<version>"]` on the merge mark; a version that is no longer current is refused there as CONTRACT_DRIFT.',
    ...parts,
  ].join('\n\n');
}

export const NAMED_CONTRACT_KEY = 'namedContractContext';

/** Stamps what was given on the session's metadata, merged so no other key is touched. */
export async function recordNamedContracts(
  agentSessionId: string,
  loaded: readonly LoadedNamedContract[],
): Promise<void> {
  const patch = {
    [NAMED_CONTRACT_KEY]: {
      loadedAt: new Date().toISOString(),
      contracts: loaded.map((c) => ({
        ref: c.ref,
        version: c.version,
        current: c.current,
        sha256: c.sha256,
        chars: c.artifact?.length ?? 0,
      })),
    },
  };
  await db
    .update(agentSessions)
    .set({
      metadata: sql`coalesce(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(agentSessions.id, agentSessionId));
}
