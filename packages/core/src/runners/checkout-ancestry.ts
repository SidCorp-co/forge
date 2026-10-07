// Whether one commit is an ancestor of another, as a box reads it in its own bound checkout of the
// project with its own git access: the evidence for a repository Forge holds no host binding for
// (ADR 0009: the box reads, core decides). Asked over the box's socket and answered on the device
// route; never stored here. Ancestry between two commits a checkout holds never changes, so the box
// fetches only where a commit asked about is missing, and says whether it did.

import { randomUUID } from 'node:crypto';
import {
  type BoundCheckout,
  boundCheckouts,
  sameRepository,
  withoutUserinfo,
} from './checkout-head.js';
import { runnersPorts } from './ports.js';

const COMMIT = /^[0-9a-f]{40}$/;
const ANSWER_WAIT_MS = 30_000;
/** A box that let a read lapse is not asked again for this long, so an old runner costs one wait, not one per sweep. */
const SILENT_FOR_MS = 10 * 60_000;
/** The most pairs one read carries, which the device route's schema holds the answer to. */
export const ANCESTRY_PAIRS_MAX = 500;

/** One question: is `commit` an ancestor of (or the same commit as) `release`. */
export interface AncestryPair {
  commit: string;
  release: string;
}

/** A pair's answer: yes or no, or why the checkout could not answer it. */
export type PairAnswer = { ancestor: boolean } | { unreadable: string };

/** The evidence a box's read is: which box, which checkout, which origin, when, and whether it fetched. */
export interface BoxAncestry {
  via: 'box-read';
  deviceId: string;
  runnerId: string;
  repoPath: string;
  origin: string;
  readAt: string;
  fetched: boolean;
  /** Keyed by `pairKey`, one per pair asked. */
  answers: Map<string, PairAnswer>;
}

/** Why no box answered at all, which a reader tells apart from a box that answered it could not read. */
export const BOX_SILENT_REASONS = ['no_checkout', 'no_runner_online', 'unanswered'] as const;
type BoxSilentReason = (typeof BOX_SILENT_REASONS)[number];
type AncestryReason = BoxSilentReason | 'runner_refused' | 'other_repository';

export type AncestryRead =
  | { ok: true; reading: BoxAncestry }
  | { ok: false; reason: AncestryReason; detail: string };

export interface CheckoutAncestryDeps {
  boundCheckouts(projectId: string): Promise<BoundCheckout[]>;
  listening(deviceId: string): boolean;
  send(deviceId: string, envelope: { event: string; data: unknown }): number;
  timeoutMs: number;
  now(): number;
}

/** What the box posts back. Checked here, not trusted. */
export interface CheckoutAncestryAnswer {
  projectId: string;
  origin?: string | undefined;
  readAt?: string | undefined;
  via?: string | undefined;
  fetched?: boolean | undefined;
  answers?:
    | Array<{
        commit: string;
        release: string;
        ancestor?: boolean | undefined;
        error?: string | undefined;
      }>
    | undefined;
  error?: string | undefined;
}

type AnswerOutcome =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'CHECKOUT_ANCESTRY_NOT_ASKED'
        | 'CHECKOUT_ANCESTRY_MALFORMED'
        | 'CHECKOUT_ANCESTRY_OTHER_REPOSITORY';
      detail?: string;
    };

interface Asked {
  box: BoundCheckout;
  projectId: string;
  repository: string | null;
  pairs: AncestryPair[];
  settle(read: AncestryRead): void;
  timer: ReturnType<typeof setTimeout>;
}

const asked = new Map<string, Asked>();
const silentUntil = new Map<string, number>();

export const pairKey = (p: AncestryPair) => `${p.commit}@${p.release}`;

const WAYS_OUT =
  "bind the repository's host on the project's Integrations page, or bring online a box holding a checkout of it bound to this project, on a forge-runner that reads ancestry (`forge-runner update`)";

function defaultDeps(): CheckoutAncestryDeps {
  return {
    boundCheckouts,
    listening: (deviceId) => runnersPorts().boxIsListening(deviceId),
    send: (deviceId, envelope) => runnersPorts().sendToBoxNow(deviceId, envelope),
    timeoutMs: ANSWER_WAIT_MS,
    now: () => Date.now(),
  };
}

const refused = (reason: AncestryReason, detail: string): AncestryRead => ({
  ok: false,
  reason,
  detail,
});

/**
 * Ask ONE box for `pairs`: the first connected box (oldest binding first) whose runner binds a
 * checkout of the project, since only a binding reaches it. A box bound to no runner of this project
 * is never asked. No checkout, no box online or none answering: each refuses by name with the ways out.
 */
export async function readCheckoutAncestry(
  projectId: string,
  repository: string | null,
  pairs: readonly AncestryPair[],
  over: Partial<CheckoutAncestryDeps> = {},
): Promise<AncestryRead> {
  const deps = { ...defaultDeps(), ...over };
  if (pairs.length === 0 || pairs.length > ANCESTRY_PAIRS_MAX) {
    throw new RangeError(
      `an ancestry read carries 1..${ANCESTRY_PAIRS_MAX} pairs, not ${pairs.length}`,
    );
  }
  const bound = await deps.boundCheckouts(projectId);
  if (bound.length === 0) {
    return refused(
      'no_checkout',
      `no runner holds a checkout bound to this project, so no box can read whether a commit is in a release — ${WAYS_OUT}`,
    );
  }
  const now = deps.now();
  const online = bound.filter((b) => deps.listening(b.deviceId));
  const box = online.find((b) => (silentUntil.get(b.deviceId) ?? 0) <= now);
  if (!box) {
    const quiet = online.map(
      (b) =>
        `the box holding ${b.repoPath} let a read lapse and is asked again after ${new Date(silentUntil.get(b.deviceId) ?? now).toISOString()}`,
    );
    return refused(
      online.length === 0 ? 'no_runner_online' : 'unanswered',
      online.length === 0
        ? `no box holding a checkout bound to this project is connected now (${bound.map((b) => b.repoPath).join(', ')}) — ${WAYS_OUT}`
        : `${quiet.join('; ')} — ${WAYS_OUT}`,
    );
  }
  return new Promise<AncestryRead>((settle) =>
    ask(box, projectId, repository, [...pairs], deps, settle),
  );
}

function ask(
  box: BoundCheckout,
  projectId: string,
  repository: string | null,
  pairs: AncestryPair[],
  deps: CheckoutAncestryDeps,
  settle: (read: AncestryRead) => void,
): void {
  const requestId = randomUUID();
  const timer = setTimeout(() => {
    asked.delete(requestId);
    silentUntil.set(box.deviceId, deps.now() + SILENT_FOR_MS);
    settle(
      refused(
        'unanswered',
        `the box holding ${box.repoPath} was asked whether ${pairs.length} commit pair(s) are ancestors and did not answer within ${deps.timeoutMs / 1000}s (a forge-runner older than this core does not read ancestry) — ${WAYS_OUT}`,
      ),
    );
  }, deps.timeoutMs);
  asked.set(requestId, { box, projectId, repository, pairs, settle, timer });
  const took = deps.send(box.deviceId, {
    event: 'checkout.ancestry.read',
    data: { requestId, projectId, runnerId: box.runnerId, repoPath: box.repoPath, pairs },
  });
  if (took === 0) {
    clearTimeout(timer);
    asked.delete(requestId);
    settle(
      refused(
        'no_runner_online',
        `the box holding ${box.repoPath} disconnected before it could be asked — ${WAYS_OUT}`,
      ),
    );
  }
}

/** The answers keyed by pair, or why they do not answer exactly the pairs asked. */
function answersOf(
  pairs: readonly AncestryPair[],
  answers: NonNullable<CheckoutAncestryAnswer['answers']>,
): Map<string, PairAnswer> | string {
  const wanted = new Set(pairs.map(pairKey));
  const out = new Map<string, PairAnswer>();
  for (const a of answers) {
    const key = pairKey(a);
    if (!wanted.has(key)) return `it answered ${key}, which was not asked`;
    if (out.has(key)) return `it answered ${key} twice`;
    if (a.error !== undefined && a.ancestor === undefined) {
      out.set(key, { unreadable: withoutUserinfo(a.error) });
    } else if (typeof a.ancestor === 'boolean' && a.error === undefined) {
      out.set(key, { ancestor: a.ancestor });
    } else {
      return `its answer for ${key} names neither one of ancestor or error`;
    }
  }
  const missing = [...wanted].filter((k) => !out.has(k));
  if (missing.length > 0)
    return `it left ${missing.length} pair(s) unanswered, ${missing[0]} first`;
  return out;
}

/** Settle the read `requestId` asked of `deviceId`. An answer nobody asked that box for is refused. */
export function answerCheckoutAncestry(
  deviceId: string,
  requestId: string,
  answer: CheckoutAncestryAnswer,
): AnswerOutcome {
  const entry = asked.get(requestId);
  if (!entry || entry.box.deviceId !== deviceId || entry.projectId !== answer.projectId) {
    return { ok: false, code: 'CHECKOUT_ANCESTRY_NOT_ASKED' };
  }
  asked.delete(requestId);
  clearTimeout(entry.timer);
  silentUntil.delete(deviceId);
  const where = `the box holding ${entry.box.repoPath}`;
  const refuse = (why: string): AnswerOutcome => {
    entry.settle(
      refused('runner_refused', `${where} answered what is no ancestry reading: ${why}`),
    );
    return { ok: false, code: 'CHECKOUT_ANCESTRY_MALFORMED', detail: why };
  };
  if (answer.error !== undefined) {
    entry.settle(
      refused(
        'runner_refused',
        `${where} could not read ancestry: ${withoutUserinfo(answer.error)}`,
      ),
    );
    return { ok: true };
  }
  if (answer.via !== 'runner-checkout') {
    return refuse(`it said it read via ${JSON.stringify(answer.via ?? null)}, not runner-checkout`);
  }
  const readAt = answer.readAt ? new Date(answer.readAt) : null;
  if (!readAt || Number.isNaN(readAt.getTime())) {
    return refuse(`it named no readable readAt (${JSON.stringify(answer.readAt ?? null)})`);
  }
  if (typeof answer.fetched !== 'boolean') return refuse('it did not say whether it fetched');
  const origin = answer.origin?.trim();
  if (!origin) return refuse('it named no origin, so nothing shows which repository it read');
  for (const a of answer.answers ?? []) {
    if (!COMMIT.test(a.commit) || !COMMIT.test(a.release)) {
      return refuse(`it answered for ${JSON.stringify(pairKey(a))}, not two 40-hex commits`);
    }
  }
  const answers = answersOf(entry.pairs, answer.answers ?? []);
  if (typeof answers === 'string') return refuse(answers);
  if (entry.repository !== null && !sameRepository(origin, entry.repository)) {
    const why = `the checkout ${entry.box.repoPath} reads origin ${withoutUserinfo(origin)}, which is not the project's declared repository ${entry.repository}`;
    entry.settle(refused('other_repository', why));
    return { ok: false, code: 'CHECKOUT_ANCESTRY_OTHER_REPOSITORY', detail: why };
  }
  entry.settle({
    ok: true,
    reading: {
      via: 'box-read',
      deviceId,
      runnerId: entry.box.runnerId,
      repoPath: entry.box.repoPath,
      origin: withoutUserinfo(origin),
      readAt: readAt.toISOString(),
      fetched: answer.fetched,
      answers,
    },
  });
  return { ok: true };
}

/** Test seam: forget which boxes let a read lapse. */
export function forgetSilentBoxes(): void {
  silentUntil.clear();
}
