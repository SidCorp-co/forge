// A project's default-branch head as a box reads it from its own bound checkout, with its own git
// access: the answer for a repository Forge holds no host binding for (ADR 0009: the box reads,
// core decides). Asked over the box's socket and answered on the device route; never stored here.

import { parseRepository } from '@forge/contracts/git-repository';
import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { boxAsks } from './box-ask.js';
import { runnersPorts } from './ports.js';

const COMMIT = /^[0-9a-f]{40}$/;
const ANSWER_WAIT_MS = 20_000;

type BoxReason = 'no_runner_online' | 'unanswered' | 'runner_refused' | 'other_repository';
type CheckoutHeadReason = BoxReason | 'no_checkout' | 'every_box_failed';

/** A box's read of the head, or why none could be made, with the two ways out in `detail`. */
export type CheckoutHeadRead =
  | { ok: true; head: CheckoutHead }
  | { ok: false; reason: CheckoutHeadReason; detail: string };

const unread = (reason: CheckoutHeadReason, detail: string): CheckoutHeadRead => ({
  ok: false,
  reason,
  detail,
});

/** The evidence a box's read is: which commit, on which ref, when, and that a checkout read it. */
export interface CheckoutHead {
  sha: string;
  ref: string;
  readAt: string;
  via: 'runner-checkout';
  deviceId: string;
}

export interface BoundCheckout {
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
  | {
      ok: false;
      code:
        | 'CHECKOUT_HEAD_NOT_ASKED'
        | 'CHECKOUT_HEAD_MALFORMED'
        | 'CHECKOUT_HEAD_OTHER_REPOSITORY';
      detail?: string;
    };

const WAYS_OUT =
  "bind the repository's host on the project's Integrations page, or bring online a box holding a checkout of it bound to this project (`forge-runner bind <slug> --path <checkout>`, or assign the box a runner with a repo path on the project's Runners page)";

type BoxRead = { ok: true; head: CheckoutHead } | { ok: false; reason: BoxReason; why: string };

interface Asked {
  deviceId: string;
  projectId: string;
  repoPath: string;
  repository: string;
  ref: string;
  settle(read: BoxRead): void;
}

const asks = boxAsks<Asked>();

const SCHEME = /^(?:[a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?\/(.+)$/i;

/** `scheme://user[:password]@`: the userinfo a checkout cloned with a token carries in its origin. */
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`()]+@/gi;

/** `text` with every URL's userinfo removed: a box older than this core sends its origin as git stores it, token included. */
export function withoutUserinfo(text: string): string {
  return text.replace(USERINFO, '$1');
}

/** How a remote URL git prints names the repository, in the declared spellings' terms: a host and path, or a local path. */
function identityOf(remote: string): { local: boolean; id: string } {
  const trimmed = remote.trim();
  const file = /^file:\/\//i.test(trimmed) ? trimmed.replace(/^file:\/\//i, '') : null;
  const url = file === null ? SCHEME.exec(trimmed) : null;
  const ref = parseRepository(file ?? (url ? `${url[1]}/${url[2]}` : trimmed));
  if (ref.kind === 'local') return { local: true, id: ref.path.replace(/\/+$/, '') };
  return {
    local: false,
    id: `${ref.host}/${ref.path}`
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase(),
  };
}

/** One repository, however the two spell it: a local path by its path, a hosted or SSH one by host and path. */
export function sameRepository(origin: string, declared: string): boolean {
  const a = identityOf(origin);
  const b = identityOf(declared);
  return a.local === b.local && a.id === b.id;
}

export async function boundCheckouts(projectId: string): Promise<BoundCheckout[]> {
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
 * Ask every connected box holding a bound checkout of the project for `branch`'s head at its
 * origin, naming the checkout each is asked to read; the first read of `repository` itself wins.
 * No checkout, no box online, or no box answering well: each refuses by name, every box's reason
 * named, with the two ways out. Nothing is guessed and nothing is cached.
 */
export async function readCheckoutHead(
  projectId: string,
  branch: string,
  repository: string,
  deps: CheckoutHeadDeps = defaultDeps(),
): Promise<CheckoutHeadRead> {
  const bound = await deps.boundCheckouts(projectId);
  if (bound.length === 0) {
    return unread(
      'no_checkout',
      `no runner holds a checkout bound to this project, so no box can read ${branch}'s head with its own git access — ${WAYS_OUT}`,
    );
  }
  const online = bound.filter((b) => deps.listening(b.deviceId));
  if (online.length === 0) {
    return unread(
      'no_runner_online',
      `no box holding a checkout bound to this project is connected now (${bound.map((b) => b.repoPath).join(', ')}), so none can read ${branch}'s head — ${WAYS_OUT}`,
    );
  }
  const ref = `refs/heads/${branch}`;
  return new Promise<CheckoutHeadRead>((settle) => {
    const failed: { box: BoundCheckout; reason: BoxReason; why: string }[] = [];
    let done = false;
    const onRead = (box: BoundCheckout) => (read: BoxRead) => {
      if (done) return;
      if (read.ok) {
        done = true;
        settle(read);
        return;
      }
      failed.push({ box, reason: read.reason, why: read.why });
      if (failed.length < online.length) return;
      done = true;
      const only = failed.length === 1 ? failed[0] : undefined;
      settle(
        only
          ? unread(only.reason, `${only.why} — ${WAYS_OUT}`)
          : unread(
              'every_box_failed',
              `no box read ${ref} of ${repository}: ${online
                .map((b) => failed.find((f) => f.box === b))
                .map((f) => (f ? `${f.reason}: ${f.why}` : ''))
                .join('; ')} — ${WAYS_OUT}`,
            ),
      );
    };
    for (const box of online) ask(box, projectId, repository, ref, branch, deps, onRead(box));
  });
}

function ask(
  box: BoundCheckout,
  projectId: string,
  repository: string,
  ref: string,
  branch: string,
  deps: CheckoutHeadDeps,
  settle: (read: BoxRead) => void,
): void {
  asks.ask(
    { deviceId: box.deviceId, projectId, repoPath: box.repoPath, repository, ref, settle },
    {
      deviceId: box.deviceId,
      projectId,
      event: 'checkout.head.read',
      data: { projectId, branch, runnerId: box.runnerId, repoPath: box.repoPath },
      timeoutMs: deps.timeoutMs,
      send: deps.send,
      settle,
      unanswered: (): BoxRead => ({
        ok: false,
        reason: 'unanswered',
        why: `the box holding ${box.repoPath} was asked for ${ref} and did not answer within ${deps.timeoutMs / 1000}s (a forge-runner older than this core does not read heads: \`forge-runner update\`)`,
      }),
      disconnected: (): BoxRead => ({
        ok: false,
        reason: 'no_runner_online',
        why: `the box holding ${box.repoPath} disconnected before it could be asked for ${ref}`,
      }),
    },
  );
}

/** Settle the read `requestId` asked of `deviceId`. An answer nobody asked that box for is refused. */
export function answerCheckoutHead(
  deviceId: string,
  requestId: string,
  answer: CheckoutHeadAnswer,
): AnswerOutcome {
  const entry = asks.take(requestId, deviceId, answer.projectId);
  if (!entry) return { ok: false, code: 'CHECKOUT_HEAD_NOT_ASKED' };
  const refused = (why: string) =>
    entry.settle({
      ok: false,
      reason: 'runner_refused',
      why: `the box holding ${entry.repoPath} could not read ${entry.ref}: ${why}`,
    });
  const refuse = (why: string): AnswerOutcome => {
    refused(why);
    return { ok: false, code: 'CHECKOUT_HEAD_MALFORMED', detail: why };
  };
  if (answer.error !== undefined) {
    refused(withoutUserinfo(answer.error));
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
  if (!answer.origin?.trim()) {
    return refuse(
      `it named no origin, so nothing shows its head is of the declared repository ${entry.repository}`,
    );
  }
  if (!sameRepository(answer.origin, entry.repository)) {
    const why = `the checkout ${entry.repoPath} reads origin ${withoutUserinfo(answer.origin)}, which is not the project's declared repository ${entry.repository}; its ${entry.ref} is no head of this project`;
    entry.settle({ ok: false, reason: 'other_repository', why });
    return { ok: false, code: 'CHECKOUT_HEAD_OTHER_REPOSITORY', detail: why };
  }
  entry.settle({
    ok: true,
    head: {
      sha: answer.sha,
      ref: entry.ref,
      readAt: readAt.toISOString(),
      via: 'runner-checkout',
      deviceId,
    },
  });
  return { ok: true };
}
