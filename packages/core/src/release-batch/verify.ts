// "Deployed" must not be a sentence an agent writes.
//
// The batch already had a report step and it was the agent's own account of
// what it had just done. The failure that account cannot see is the common one:
// the deploy command succeeded, the site is healthy, and it is still serving
// the previous build. A health check that only reads the status code says green
// through the whole of it.
//
// So the project declares probes, and the kernel reads them. Green needs BOTH
// halves: the live commit changed from what was serving before the release, and
// it matches the commit the release says it pushed. The first half is why the
// pre-release read is taken at claim time, before anything moves — without it,
// an agent reporting the commit that was already live verifies perfectly.
//
// Design: docs/modules/issues-pipeline/release-gate.md (L2.2)

import { logger } from '../logger.js';

export interface VerifyProbe {
  url: string;
  /** Dot path into the JSON body. Omitted → the whole body, trimmed. */
  commitPath?: string | undefined;
}

export interface VerifyConfig {
  probes: VerifyProbe[];
  /** Give up after this long. Default 300s. */
  timeoutSeconds?: number;
  /** Consecutive identical reads required before believing it. Default 2. */
  stableReads?: number;
}

export function parseVerifyConfig(raw: unknown): VerifyConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.probes)) return null;
  const probes = obj.probes
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      url: typeof p.url === 'string' ? p.url : '',
      commitPath: typeof p.commitPath === 'string' ? p.commitPath : undefined,
    }))
    .filter((p) => p.url.length > 0);
  if (probes.length === 0) return null;
  return {
    probes,
    timeoutSeconds: typeof obj.timeoutSeconds === 'number' ? obj.timeoutSeconds : 300,
    stableReads: typeof obj.stableReads === 'number' ? obj.stableReads : 2,
  };
}

function pluck(body: unknown, path: string | undefined): string | null {
  if (path === undefined) return typeof body === 'string' ? body.trim() : null;
  let cur: unknown = body;
  for (const key of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

// cm:guard the cache-buster and the no-cache header are BOTH required and neither is decoration — the probe reads through whatever CDN or reverse proxy fronts the site (varnish, in the case this was written for), and a cached 200 from the previous build is exactly the state verification exists to catch
async function readProbe(probe: VerifyProbe): Promise<string | null> {
  const url = new URL(probe.url);
  url.searchParams.set('_forge_cb', String(Math.random()).slice(2));
  try {
    const res = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (probe.commitPath === undefined) return text.trim() || null;
    try {
      return pluck(JSON.parse(text), probe.commitPath);
    } catch {
      return null;
    }
  } catch (err) {
    logger.debug({ err, url: probe.url }, 'release-verify: probe unreachable');
    return null;
  }
}

/**
 * One read of every probe. `null` when any probe fails or the probes disagree
 * — a fleet half on the new build is not deployed.
 */
export async function readLiveCommit(cfg: VerifyConfig): Promise<string | null> {
  const reads = await Promise.all(cfg.probes.map(readProbe));
  const first = reads[0];
  if (first == null) return null;
  return reads.every((r) => r === first) ? first : null;
}

export type VerifyOutcome =
  | { ok: true; commit: string }
  | { ok: false; reason: string; live: string | null };

export interface VerifyArgs {
  cfg: VerifyConfig;
  /** What was serving before the release started. */
  commitBefore: string | null;
  /** What the release says it pushed. */
  expected: string | null;
  /** Injected so the poll loop is testable without real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function verifyDeployed(args: VerifyArgs): Promise<VerifyOutcome> {
  const { cfg, commitBefore, expected } = args;
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (cfg.timeoutSeconds ?? 300) * 1000;
  const needed = cfg.stableReads ?? 2;

  let stable = 0;
  let last: string | null = null;
  let live: string | null = null;

  while (now() < deadline) {
    live = await readLiveCommit(cfg);
    const acceptable =
      live != null && live !== commitBefore && (expected == null || live === expected);
    stable = acceptable && live === last ? stable + 1 : acceptable ? 1 : 0;
    last = live;
    if (stable >= needed) return { ok: true, commit: live as string };
    if (now() >= deadline) break;
    await sleep(5000);
  }

  if (live == null) return { ok: false, reason: 'no probe answered with a commit', live };
  if (live === commitBefore) {
    return {
      ok: false,
      // cm:why this is the whole point of the pre-release read: the site is up, the deploy reported success, and it is still serving what it served before
      reason: `the live build is unchanged (${live}) — the site is healthy and still serving the pre-release commit`,
      live,
    };
  }
  if (expected != null && live !== expected) {
    return { ok: false, reason: `live is ${live}, the release pushed ${expected}`, live };
  }
  return { ok: false, reason: 'the live commit never held still', live };
}
