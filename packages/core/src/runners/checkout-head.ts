// A project's default-branch head as a box reads it from its own bound checkout, with its own git
// access: the answer for a repository Forge holds no host binding for (ADR 0009: the box reads,
// core decides). Asked over the box's socket and answered on the device route; never stored here.

import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { runnersPorts } from './ports.js';

const COMMIT = /^[0-9a-f]{40}$/;
const ANSWER_WAIT_MS = 20_000;

type CheckoutHeadReason = 'no_checkout' | 'no_runner_online' | 'unanswered' | 'runner_refused';

export class CheckoutHeadUnreadable extends Error {
  readonly reason: CheckoutHeadReason;
  constructor(reason: CheckoutHeadReason, message: string) {
    super(message);
    this.name = 'CheckoutHeadUnreadable';
    this.reason = reason;
  }
}

/** The evidence a box's read is: which commit, on which ref, when, and that a checkout read it. */
export interface CheckoutHead {
  sha: string;
  ref: string;
  readAt: string;
  via: 'runner-checkout';
  deviceId: string;
}

interface BoundCheckout {
  deviceId: string;
  runnerId: string;
  repoPath: string;
}

export interface CheckoutHeadDeps {
  boundCheckouts(projectId: string): Promise<BoundCheckout[]>;
  listening(deviceId: string): boolean;
  send(deviceId: string, envelope: { event: string; data: unknown }): number;
  timeoutMs: number;
}

/** What the box posts back: the head it read, or why it could not. Checked here, not trusted. */
export interface CheckoutHeadAnswer {
  projectId: string;
  sha?: string | undefined;
  ref?: string | undefined;
  readAt?: string | undefined;
  via?: string | undefined;
  origin?: string | undefined;
  error?: string | undefined;
}

type AnswerOutcome =
  | { ok: true }
  | { ok: false; code: 'CHECKOUT_HEAD_NOT_ASKED' | 'CHECKOUT_HEAD_MALFORMED'; detail?: string };

const WAYS_OUT =
  "bind the repository's host on the project's Integrations page, or bring online a box holding a checkout of it bound to this project (`forge-runner bind <slug> --path <checkout>`, or assign the box a runner with a repo path on the project's Runners page)";

interface Asked {
  deviceId: string;
  projectId: string;
  ref: string;
  resolve(head: CheckoutHead): void;
  reject(err: CheckoutHeadUnreadable): void;
  timer: ReturnType<typeof setTimeout>;
}

const asked = new Map<string, Asked>();

async function boundCheckouts(projectId: string): Promise<BoundCheckout[]> {
  const rows = await db
    .select({ deviceId: runners.deviceId, runnerId: runners.id, repoPath: runners.repoPath })
    .from(runners)
    .innerJoin(devices, eq(devices.id, runners.deviceId))
    .where(
      and(
        eq(runners.projectId, projectId),
        isNotNull(runners.repoPath),
        or(isNull(runners.provisionStatus), eq(runners.provisionStatus, 'ready')),
        isNull(devices.disabledAt),
      ),
    )
    .orderBy(asc(runners.createdAt));
  return rows.flatMap((r) => (r.repoPath ? [{ ...r, repoPath: r.repoPath }] : []));
}

function defaultDeps(): CheckoutHeadDeps {
  return {
    boundCheckouts,
    listening: (deviceId) => runnersPorts().boxIsListening(deviceId),
    send: (deviceId, envelope) => runnersPorts().sendToBoxNow(deviceId, envelope),
    timeoutMs: ANSWER_WAIT_MS,
  };
}

/**
 * Ask the first connected box holding a bound checkout of the project for `branch`'s head at its
 * origin. No checkout, no box online, no answer in time, or a refusal from the box: each refuses
 * by name, naming the two ways out. Nothing is guessed and nothing is cached.
 */
export async function readCheckoutHead(
  projectId: string,
  branch: string,
  deps: CheckoutHeadDeps = defaultDeps(),
): Promise<CheckoutHead> {
  const bound = await deps.boundCheckouts(projectId);
  if (bound.length === 0) {
    throw new CheckoutHeadUnreadable(
      'no_checkout',
      `no runner holds a checkout bound to this project, so no box can read ${branch}'s head with its own git access — ${WAYS_OUT}`,
    );
  }
  const box = bound.find((b) => deps.listening(b.deviceId));
  if (!box) {
    throw new CheckoutHeadUnreadable(
      'no_runner_online',
      `no box holding a checkout bound to this project is connected now (${bound.map((b) => b.repoPath).join(', ')}), so none can read ${branch}'s head — ${WAYS_OUT}`,
    );
  }
  const requestId = randomUUID();
  const ref = `refs/heads/${branch}`;
  return new Promise<CheckoutHead>((resolve, reject) => {
    const timer = setTimeout(() => {
      asked.delete(requestId);
      reject(
        new CheckoutHeadUnreadable(
          'unanswered',
          `the box holding ${box.repoPath} was asked for ${ref} and did not answer within ${deps.timeoutMs / 1000}s (a forge-runner older than this core does not read heads: \`forge-runner update\`) — ${WAYS_OUT}`,
        ),
      );
    }, deps.timeoutMs);
    asked.set(requestId, { deviceId: box.deviceId, projectId, ref, resolve, reject, timer });
    const took = deps.send(box.deviceId, {
      event: 'checkout.head.read',
      data: { requestId, projectId, branch },
    });
    if (took === 0) {
      clearTimeout(timer);
      asked.delete(requestId);
      reject(
        new CheckoutHeadUnreadable(
          'no_runner_online',
          `the box holding ${box.repoPath} disconnected before it could be asked for ${ref} — ${WAYS_OUT}`,
        ),
      );
    }
  });
}

/** Settle the read `requestId` asked of `deviceId`. An answer nobody asked that box for is refused. */
export function answerCheckoutHead(
  deviceId: string,
  requestId: string,
  answer: CheckoutHeadAnswer,
): AnswerOutcome {
  const entry = asked.get(requestId);
  if (!entry || entry.deviceId !== deviceId || entry.projectId !== answer.projectId) {
    return { ok: false, code: 'CHECKOUT_HEAD_NOT_ASKED' };
  }
  asked.delete(requestId);
  clearTimeout(entry.timer);
  const refuse = (why: string): AnswerOutcome => {
    entry.reject(
      new CheckoutHeadUnreadable(
        'runner_refused',
        `the box holding a bound checkout could not read ${entry.ref}: ${why} — ${WAYS_OUT}`,
      ),
    );
    return { ok: false, code: 'CHECKOUT_HEAD_MALFORMED', detail: why };
  };
  if (answer.error !== undefined) {
    entry.reject(
      new CheckoutHeadUnreadable(
        'runner_refused',
        `the box holding a bound checkout could not read ${entry.ref}: ${answer.error} — ${WAYS_OUT}`,
      ),
    );
    return { ok: true };
  }
  if (!answer.sha || !COMMIT.test(answer.sha)) {
    return refuse(`it answered ${JSON.stringify(answer.sha ?? null)}, not a 40-hex commit`);
  }
  if (answer.ref !== entry.ref) {
    return refuse(`it answered for ${JSON.stringify(answer.ref ?? null)}, not ${entry.ref}`);
  }
  if (answer.via !== undefined && answer.via !== 'runner-checkout') {
    return refuse(`it said it read via ${JSON.stringify(answer.via)}, not runner-checkout`);
  }
  const readAt = answer.readAt ? new Date(answer.readAt) : null;
  if (!readAt || Number.isNaN(readAt.getTime())) {
    return refuse(`it named no readable readAt (${JSON.stringify(answer.readAt ?? null)})`);
  }
  entry.resolve({
    sha: answer.sha,
    ref: entry.ref,
    readAt: readAt.toISOString(),
    via: 'runner-checkout',
    deviceId,
  });
  return { ok: true };
}
