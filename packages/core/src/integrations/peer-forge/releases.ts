// The releases pressed on a peer Forge project (ISS-988): read so the beta port can run them on dev,
// and ended there once dev's release settles. The peer may run an older release, so each answer is
// read for the few fields the port needs and a shape it cannot read is refused by name.

import {
  call,
  dateOf,
  isRecord,
  type PeerAnswer,
  type PeerForge,
  refuse,
  rowsOf,
  shape,
  str,
} from './client.js';

/** One beta issue a peer release carries, as its release read names it. */
export interface PeerReleaseIssue {
  id: string;
  key: string;
  status: string;
}

/** A release pressed on a peer project: a release run still running there, and what it carries. */
export interface PeerRelease {
  runId: string;
  /** The version the peer cut for it; null where its read names none. */
  version: string | null;
  startedAt: Date;
  issues: PeerReleaseIssue[];
}

const RUN_PAGE = 50;
const MAX_RUN_PAGES = 4;

/** The release a peer's release read answers for one run; null where the run is no release. */
async function readPeerRelease(
  peer: PeerForge,
  projectId: string,
  runId: string,
  startedAt: Date,
): Promise<PeerAnswer<PeerRelease | null>> {
  const route = `/projects/${encodeURIComponent(projectId)}/release-batches/${encodeURIComponent(runId)}`;
  const got = await call(peer, 'GET', route);
  // the peer's read answers 404 NOT_FOUND for a run that is no release batch (`loadRunForProject`);
  // any other refusal, a route the peer does not serve among them, is named, never read as "none"
  if (!got.ok && got.refusal.status === 404 && got.refusal.code === 'NOT_FOUND') {
    return { ok: true, value: null };
  }
  if (!got.ok) return got;
  if (got.value === null) return { ok: true, value: null };
  if (!isRecord(got.value) || !Array.isArray(got.value.issues)) {
    return shape(`/api${route}`, 'release (runId, version, issues)');
  }
  const issues: PeerReleaseIssue[] = [];
  for (const row of got.value.issues) {
    const id = isRecord(row) ? str(row.id) : null;
    const key = isRecord(row) ? (str(row.displayId) ?? str(row.key)) : null;
    const status = isRecord(row) ? str(row.status) : null;
    if (!id || !key || !status) {
      return shape(`/api${route}`, 'release issue (id, displayId, status)');
    }
    issues.push({ id, key, status });
  }
  return { ok: true, value: { runId, version: str(got.value.version), startedAt, issues } };
}

/**
 * The releases pressed on one peer project after `since`, oldest first: its runs still `running`
 * (`GET /api/projects/:id/pipeline-runs?status=running`, newest first), less every run opened over
 * an issue, each read through the peer's release read, which answers no release for a run that is
 * none. A peer at forge-beta 51939268 asks no approval of a release, so a press is the run it opens.
 */
export async function listPeerPressedReleases(
  peer: PeerForge,
  projectId: string,
  since: Date,
): Promise<PeerAnswer<PeerRelease[]>> {
  const route = `/projects/${encodeURIComponent(projectId)}/pipeline-runs`;
  const runs: { id: string; startedAt: Date }[] = [];
  let done = false;
  for (let page = 0; page < MAX_RUN_PAGES && !done; page += 1) {
    const got = await call(
      peer,
      'GET',
      `${route}?status=running&limit=${RUN_PAGE}&offset=${page * RUN_PAGE}`,
    );
    if (!got.ok) return got;
    const rows = rowsOf(got.value);
    if (!rows) return shape(`/api${route}`, 'run list');
    for (const row of rows) {
      const id = isRecord(row) ? str(row.id) : null;
      const startedAt = isRecord(row) ? dateOf(row.startedAt) : null;
      if (!id || !startedAt) return shape(`/api${route}`, 'run row (id, startedAt)');
      if (startedAt <= since) {
        done = true;
        break;
      }
      if (isRecord(row) && str(row.issueId) === null) runs.push({ id, startedAt });
    }
    const more = isRecord(got.value) && got.value.hasMore === true;
    if (!more || rows.length === 0) done = true;
    else if (page === MAX_RUN_PAGES - 1) {
      return refuse(
        'PEER_FORGE_TOO_MANY',
        200,
        `GET /api${route} holds more than ${MAX_RUN_PAGES * RUN_PAGE} running runs since ${since.toISOString()}; this client reads no further`,
      );
    }
  }
  const releases: PeerRelease[] = [];
  for (const run of runs.reverse()) {
    const read = await readPeerRelease(peer, projectId, run.id, run.startedAt);
    if (!read.ok) return read;
    if (read.value) releases.push(read.value);
  }
  return { ok: true, value: releases };
}

/**
 * End a release pressed on a peer project that the peer will not perform itself: its abort door
 * (`POST /api/projects/:id/release-batches/:runId/abort`), whose reason is the log line the peer
 * keeps on the release. The issues it claimed are handed back to the peer's release gate.
 */
export async function endPeerRelease(
  peer: PeerForge,
  projectId: string,
  runId: string,
  reason: string,
): Promise<PeerAnswer<null>> {
  const route = `/projects/${encodeURIComponent(projectId)}/release-batches/${encodeURIComponent(runId)}/abort`;
  const got = await call(peer, 'POST', route, { reason });
  return got.ok ? { ok: true, value: null } : got;
}
