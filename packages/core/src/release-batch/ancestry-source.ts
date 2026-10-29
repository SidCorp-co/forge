/**
 * The project's ancestry reader, for the writes that check a commit against another before they
 * record it (`recorded-landing.ts`, `landing-coverage.ts`, `landed-build.ts`): the source host
 * compares; where the project has none, the box holding its bound checkout answers `git merge-base
 * --is-ancestor` (`runners/checkout-ancestry.ts`), and its answer is evidence with its provenance
 * (box, checkout, origin, shas), never a guess.
 *
 * No read path asks it (ISS-774, owner 2026-10-29: a read never calls the source host): what an
 * agent owes about where its work shipped is said to the agent, who checks with its own git.
 */

import {
  resolveSourceHost,
  type SourceHost,
  SourceHostUnavailable,
} from '../integrations/source-host/index.js';
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

export type AncestrySource =
  | { kind: 'host'; host: SourceHost; reader: AncestryReader }
  | { kind: 'box'; why: string; reader: AncestryReader }
  | { kind: 'none'; why: string };

export interface AncestrySourceDeps {
  host?: (projectId: string) => Promise<SourceHost>;
  /** How a box is asked where the project has no source host; the live socket where absent. */
  box?: BoxDeps;
}

/**
 * The source host, or why there is none and, where none is bound at all, the box reader that stands
 * in for it. A binding that exists and cannot serve stays its own refusal: a box never papers over it.
 */
export async function ancestrySourceFor(
  projectId: string,
  deps: AncestrySourceDeps = {},
): Promise<AncestrySource> {
  try {
    const host = await (deps.host ?? ((id) => resolveSourceHost(id, 'kernel')))(projectId);
    return { kind: 'host', host, reader: hostReader(host) };
  } catch (err) {
    if (!(err instanceof SourceHostUnavailable)) throw err;
    if (err.reason !== 'no_binding' && err.reason !== 'local_repository') {
      return { kind: 'none', why: err.message };
    }
    return { kind: 'box', why: err.message, reader: await boxReaderFor(projectId, deps.box) };
  }
}
