/**
 * The ancestry half of `shipped-earlier.ts`: where each commit lands among the releases that
 * shipped, read from one of two readers. The source host compares; where the project has none, the
 * box holding its bound checkout answers `git merge-base --is-ancestor` (`runners/checkout-ancestry.ts`)
 * and its answer is evidence with its provenance (box, checkout, origin, shas), never a guess. Either
 * reader is asked the same pairs in the same order, so the placement is the same rule whichever read.
 */

import type { SourceHost } from '../integrations/source-host/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import {
  ANCESTRY_PAIRS_MAX,
  type AncestryPair,
  BOX_SILENT_REASONS,
  type BoxAncestry,
  type CheckoutAncestryDeps,
  pairKey,
  readCheckoutAncestry,
} from '../runners/index.js';
import type { ShippedRelease } from './shipped-earlier-keyed.js';

/** A pair's answer: whether the commit is in the release, or why it was not read. */
type Answer = boolean | { unread: string };

/** Who read the pair that placed a commit: the host, or a box, named with what it read. */
export type Witness =
  | { via: 'source-host' }
  | {
      via: 'box-read';
      deviceId: string;
      runnerId: string;
      repoPath: string;
      origin: string;
      readAt: string;
      fetched: boolean;
      commit: string;
      release: string;
    };

/** How a box is asked; the live socket where a field is absent. */
export type BoxDeps = Partial<CheckoutAncestryDeps>;

/** Nobody answered at all (no checkout bound, no box connected, none answering in time), and why. */
type Silent = { silent: string };

export interface AncestryReader {
  /** Every pair answered, or `silent` where nobody read any of them. */
  ask(pairs: readonly AncestryPair[]): Promise<Map<string, Answer> | Silent>;
  witness(pair: AncestryPair): Witness;
}

export function hostReader(host: SourceHost): AncestryReader {
  return {
    async ask(pairs) {
      const out = new Map<string, Answer>();
      for (const p of pairs) {
        try {
          const status = await host.compare(p.commit, p.release);
          out.set(pairKey(p), status === 'ahead' || status === 'identical');
        } catch (err) {
          out.set(pairKey(p), { unread: err instanceof Error ? err.message : String(err) });
        }
      }
      return out;
    },
    witness: () => ({ via: 'source-host' }),
  };
}

/** The box reader for `projectId`, checking each answer's origin against its declared repository. */
export async function boxReaderFor(projectId: string, deps: BoxDeps = {}): Promise<AncestryReader> {
  const { repository } = await readDeclaredSource(projectId);
  return boxReader(projectId, repository, deps);
}

function boxReader(projectId: string, repository: string | null, deps: BoxDeps): AncestryReader {
  const readings = new Map<string, BoxAncestry>();
  return {
    async ask(pairs) {
      const out = new Map<string, Answer>();
      for (let at = 0; at < pairs.length; at += ANCESTRY_PAIRS_MAX) {
        const chunk = pairs.slice(at, at + ANCESTRY_PAIRS_MAX);
        const read = await readCheckoutAncestry(projectId, repository, chunk, deps);
        if (!read.ok) {
          if ((BOX_SILENT_REASONS as readonly string[]).includes(read.reason)) {
            return { silent: read.detail };
          }
          for (const p of chunk) out.set(pairKey(p), { unread: read.detail });
          continue;
        }
        const { reading } = read;
        for (const p of chunk) {
          const answer = reading.answers.get(pairKey(p));
          readings.set(pairKey(p), reading);
          out.set(
            pairKey(p),
            answer && 'ancestor' in answer
              ? answer.ancestor
              : {
                  unread: `the box ${reading.deviceId} could not read it in its checkout ${reading.repoPath}: ${answer?.unreadable ?? 'no answer'}`,
                },
          );
        }
      }
      return out;
    },
    witness(pair) {
      const r = readings.get(pairKey(pair));
      if (!r) throw new Error(`no box reading is held for ${pairKey(pair)}`);
      return {
        via: 'box-read',
        deviceId: r.deviceId,
        runnerId: r.runnerId,
        repoPath: r.repoPath,
        origin: r.origin,
        readAt: r.readAt,
        fetched: r.fetched,
        commit: pair.commit,
        release: pair.release,
      };
    },
  };
}

// An ancestry answer that was "no" for the newest shipped release stays no until a newer one ships,
// so a held row is not asked about again every tick. Keyed by the pair it answered for.
const NOT_SHIPPED = new Set<string>();
const NOT_SHIPPED_LIMIT = 5_000;

export interface Placement {
  release: ShippedRelease;
  witness: Witness;
}

interface Search {
  sha: string;
  lo: number;
  hi: number;
}

/**
 * The earliest of `releases` (oldest first) holding each of `shas`, or none where the newest does
 * not. Releases on one branch only ever gain commits, so a release holding a commit is followed by
 * releases holding it and the earliest is found by halving; every sha's halving steps are asked in
 * one read per step. A commit the reader could not answer is in `unread` with why. Nobody answering
 * the first step is `silent`: nothing was read, and the caller names it as such.
 */
export async function placeCommits(
  reader: AncestryReader,
  shas: readonly string[],
  releases: readonly ShippedRelease[],
): Promise<{ placed: Map<string, Placement>; unread: Map<string, string> } | Silent> {
  const placed = new Map<string, Placement>();
  const unread = new Map<string, string>();
  const newest = releases[releases.length - 1];
  if (!newest) return { placed, unread };
  const asked = [...new Set(shas)].filter((sha) => !NOT_SHIPPED.has(`${sha}@${newest.commit}`));
  if (asked.length === 0) return { placed, unread };

  const first = asked.map((sha) => ({ commit: sha, release: newest.commit }));
  const answers = await reader.ask(first);
  if (!(answers instanceof Map)) return answers;
  let open: Search[] = [];
  const witnessed = new Map<string, AncestryPair>();
  for (const pair of first) {
    const answer = answers.get(pairKey(pair));
    if (answer === true) {
      witnessed.set(pair.commit, pair);
      open.push({ sha: pair.commit, lo: 0, hi: releases.length - 1 });
    } else if (answer === false) {
      if (NOT_SHIPPED.size >= NOT_SHIPPED_LIMIT) NOT_SHIPPED.clear();
      NOT_SHIPPED.add(pairKey(pair));
    } else {
      unread.set(pair.commit, answer?.unread ?? 'the reader gave no answer');
    }
  }

  while (open.some((s) => s.lo < s.hi)) {
    const stepping = open.filter((s) => s.lo < s.hi);
    const pairs = stepping.map((s) => ({
      commit: s.sha,
      release: (releases[Math.floor((s.lo + s.hi) / 2)] as ShippedRelease).commit,
    }));
    const reply = await reader.ask(pairs);
    const step =
      reply instanceof Map
        ? reply
        : new Map<string, Answer>(pairs.map((p) => [pairKey(p), { unread: reply.silent }]));
    const next: Search[] = open.filter((s) => s.lo >= s.hi);
    stepping.forEach((s, i) => {
      const pair = pairs[i] as AncestryPair;
      const answer = step.get(pairKey(pair));
      const mid = Math.floor((s.lo + s.hi) / 2);
      if (answer === true) {
        witnessed.set(s.sha, pair);
        next.push({ ...s, hi: mid });
      } else if (answer === false) {
        next.push({ ...s, lo: mid + 1 });
      } else {
        unread.set(s.sha, answer?.unread ?? 'the reader gave no answer');
      }
    });
    open = next;
  }

  for (const s of open) {
    const release = releases[s.lo] as ShippedRelease;
    const pair = witnessed.get(s.sha) as AncestryPair;
    placed.set(s.sha, { release, witness: reader.witness(pair) });
  }
  return { placed, unread };
}
