/**
 * What a landing owes the contract registry (ISS-1419): a published contract's uploaded artifact is
 * current only once a version holding it is recorded and decided, so a landing that changes the
 * file a contract is recorded from leaves the registry lagging what that commit serves until a
 * version holds the file as it stands there. forge-api stood at 2.0.0 while its
 * `forge-api.openapi.json` moved through a month of routes, and nothing said so.
 *
 * The merge mark asks it (`issues/mark-preconditions.ts`): the version is the agent's to record
 * (`POST …/contracts/:contract/versions` `{ artifact, sourceRef: "<path>@<commit>" }`) and decide
 * (`…/versions/:version/decision`), never core's on its behalf; the mark is refused by name until
 * one holds the landed file. A contract's file is the path its newest version naming a `sourceRef`
 * was read from: an interface declares no path, and a contract never recorded from one asks nothing.
 * Where the change or the file cannot be read from the source host, nothing is asked: the mark's
 * own reading of its commit already says the repository was not read.
 *
 * A commit inside a batch is never served on its own: the batch lands at the head its passing merge
 * check ran on, so the version recorded from that head holds the file for each issue the check
 * covers (ISS-1437). The bound is that check, not the pushed range: its range is recorded evidence
 * that the commit and the head landed together, where a range read off the host at mark time could
 * pair a commit with any later push. Recording the commit's own file instead would make a file
 * nothing served the registry's latest.
 */

import { db } from '../../db/client.js';
import { checkedLandingOf } from '../../issues/index.js';
import { type AncestrySource, ancestrySourceFor } from '../../release-batch/index.js';
import { loadInterface } from '../interface-service.js';
import { projectsWhere } from '../store.js';
import type { ContractApproval } from './approval.js';
import { MAX_ARTIFACT_BYTES, sha256 } from './measure.js';
import { type StoredVersion, versionsOf } from './store.js';

/** A contract's source file: the path its newest version naming a `sourceRef` was recorded from. */
export interface ContractSource {
  contract: string;
  path: string;
}

type Recorded = Pick<StoredVersion, 'contractSlug' | 'version' | 'approval' | 'document'> & {
  artifactSha256: string | null;
};

const sourceRefOf = (v: Pick<StoredVersion, 'document'>): string | null => {
  const artifact = v.document.artifact;
  return artifact && 'sourceRef' in artifact ? (artifact.sourceRef ?? null) : null;
};

const splitRef = (ref: string) => {
  const at = ref.lastIndexOf('@');
  return { path: ref.slice(0, at), commit: ref.slice(at + 1).toLowerCase() };
};

const sameCommit = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.startsWith(y) || y.startsWith(x);
};

/** Each uploaded contract's source file, read off its versions newest first; one never recorded from a file has none. */
export function contractSourcesOf(
  uploaded: readonly string[],
  versions: readonly Recorded[],
): ContractSource[] {
  return uploaded.flatMap((contract) => {
    const ref = versions
      .filter((v) => v.contractSlug === contract)
      .map(sourceRefOf)
      .find(Boolean);
    return ref ? [{ contract, path: splitRef(ref).path }] : [];
  });
}

/** A source file the landing changed, and the version holding it as the landed commit left it. */
export interface LandedSource extends ContractSource {
  held: { version: string; approval: ContractApproval } | null;
}

/** The version holding `path` at `commit`: one recorded from that very file, else one with its bytes. */
export function versionHolding(
  versions: readonly Recorded[],
  source: ContractSource,
  commit: string,
  digest: string | null,
): Recorded | null {
  const mine = versions.filter((v) => v.contractSlug === source.contract);
  const fromRef = mine.find((v) => {
    const ref = sourceRefOf(v);
    if (!ref) return false;
    const at = splitRef(ref);
    return at.path === source.path && sameCommit(at.commit, commit);
  });
  return fromRef ?? (digest ? (mine.find((v) => v.artifactSha256 === digest) ?? null) : null);
}

export interface RegistryLagRefusal {
  code: 'CONTRACT_VERSION_UNRECORDED' | 'CONTRACT_VERSION_UNDECIDED';
  /** The mark's field it is answered at: the commit whose landing the registry lags. */
  path: '/commit';
  detail: string;
}

// a landing that changed a contract's file is marked only once a version holds that file and is decided; otherwise the registry lags what the commit serves, so the mark names the door that catches it up
export function registryLagRefusal(
  project: { id: string; slug: string },
  commit: string,
  landed: readonly LandedSource[],
  /** The head of the batch the commit sits in, where a passing merge check places it in one. */
  batchHead: string | null = null,
): RegistryLagRefusal | null {
  const door = (contract: string) =>
    `POST /api/projects/${project.id}/contracts/${contract}/versions`;
  const unrecorded = landed.filter((l) => l.held === null);
  if (unrecorded.length > 0) {
    const from = batchHead ?? commit;
    const where = batchHead
      ? `at ${commit} or at the head of its batch; ${commit} sits in a batch landed at ${batchHead}, so record the file as the batch head left it, never this commit's own file, which nothing served`
      : `at ${commit}`;
    const each = unrecorded
      .map(
        (l) =>
          `${project.slug}/${l.contract} is recorded from ${l.path}, which this landing changes, and no version holds that file ${where}; record it: ${door(l.contract)} { artifact: <the file's text>, sourceRef: "${l.path}@${from}" }`,
      )
      .join('; ');
    return {
      code: 'CONTRACT_VERSION_UNRECORDED',
      path: '/commit',
      detail: `${each}. Then decide it at …/versions/<version>/decision and mark again, so the registry does not lag what this commit serves. Nothing was marked.`,
    };
  }
  const undecided = landed.filter((l) => l.held?.approval === 'proposed');
  if (undecided.length === 0) return null;
  const each = undecided
    .map(
      (l) =>
        `${project.slug}/${l.contract}@${l.held?.version} holds ${l.path} as this landing left it and is still proposed; decide it: ${door(l.contract)}/${l.held?.version}/decision { decision: approve | return, reason? }`,
    )
    .join('; ');
  return {
    code: 'CONTRACT_VERSION_UNDECIDED',
    path: '/commit',
    detail: `${each}. A proposed version is not current, so the registry would lag what this commit serves. Mark again once it is decided. Nothing was marked.`,
  };
}

type Host = Extract<AncestrySource, { kind: 'host' }>['host'];

/** The files the landing changed: since the merge check's base where one covers it, else the commit's own. */
async function changedFiles(
  host: Host,
  commit: string,
  base: string | null,
): Promise<Set<string> | null> {
  const listed = (r: { changes: readonly { path: string; change: string }[] }) =>
    new Set(r.changes.filter((c) => c.change !== 'removed').map((c) => c.path));
  if (base) {
    const since = await host.compareFiles(base, commit);
    if ('changes' in since) return listed(since);
  }
  const own = await host.commitFiles(commit);
  return 'changes' in own ? listed(own) : null;
}

/** The version holding `s` at `commit`, `unread` where the host holds no file there to compare. */
async function heldAt(
  host: Host,
  versions: readonly Recorded[],
  s: ContractSource,
  commit: string,
): Promise<Recorded | null | 'unread'> {
  const byRef = versionHolding(versions, s, commit, null);
  if (byRef) return byRef;
  const text = await host.readFile(s.path, commit, MAX_ARTIFACT_BYTES);
  return typeof text === 'string' ? versionHolding(versions, s, commit, sha256(text)) : 'unread';
}

const decided = (v: Recorded | null): v is Recorded => v !== null && v.approval !== 'proposed';

/**
 * The mark's refusal where the landing at `commit` changed a published contract's source file and
 * no decided version holds that file as the commit left it, or as the head of the batch it landed
 * in left it, else null. The landing is the issue's passing merge check covering the commit
 * (`issues/merge-check.ts:checkedLandingOf`): its base, so an issue's earlier commits count as its
 * landing, and its head, the batch's landed tip.
 */
export async function landingLagRefusal(
  projectId: string,
  commit: string,
  issueId: string,
): Promise<RegistryLagRefusal | null> {
  const iface = await loadInterface(projectId);
  const uploaded = Object.entries(iface?.document.publishes ?? {})
    .filter(([, pub]) => pub.artifact !== null)
    .map(([slug]) => slug);
  if (uploaded.length === 0) return null;
  const versions = await versionsOf(db, [projectId]);
  const sources = contractSourcesOf(uploaded, versions);
  if (sources.length === 0) return null;
  let source: AncestrySource;
  try {
    source = await ancestrySourceFor(projectId);
  } catch {
    return null;
  }
  if (source.kind !== 'host') return null;
  const host = source.host;
  const landing = await checkedLandingOf(issueId, commit);
  const batchHead = landing && !sameCommit(landing.head, commit) ? landing.head : null;
  const landed: LandedSource[] = [];
  try {
    const changed = await changedFiles(host, commit, landing?.base ?? null);
    for (const s of sources) {
      if (!changed?.has(s.path)) continue;
      const own = await heldAt(host, versions, s, commit);
      if (own === 'unread') continue;
      const atHead = batchHead && !decided(own) ? await heldAt(host, versions, s, batchHead) : null;
      const later = atHead === 'unread' ? null : atHead;
      const held = decided(own) ? own : decided(later) ? later : (own ?? later);
      landed.push({ ...s, held: held ? { version: held.version, approval: held.approval } : null });
    }
  } catch {
    return null;
  }
  if (landed.length === 0) return null;
  const [project] = await projectsWhere(db, { ids: [projectId] });
  return registryLagRefusal(
    { id: projectId, slug: project?.slug ?? projectId },
    commit,
    landed,
    batchHead,
  );
}
