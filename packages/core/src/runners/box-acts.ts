// Two things core asks one box to do for a room's session, outside the session's sandbox (REQ-75 r5
// BC-27): run a command on a host over the box's own SSH (`host.command`), and commit, push and name
// the room's working copy (`build.push`). Core decided the act may run before it asks; the box runs
// it with its own credentials and answers on the device route under the request's id. Asked of the
// box the session runs on, never fanned out: a command runs once.

import type { SupportCommandResult } from '@forge/contracts/support';
import { boxAsks } from './box-ask.js';
import { runnersPorts } from './ports.js';

/** How long a command may run on its host; the box kills it there. */
export const HOST_COMMAND_TIMEOUT_MS = 60_000;
/** The box's own wait plus the frame's way there and back. */
const COMMAND_ANSWER_WAIT_MS = HOST_COMMAND_TIMEOUT_MS + 15_000;
/** A fetch, a commit and a push. */
const BUILD_ANSWER_WAIT_MS = 120_000;

export type BoxActOutcome<T> = { ok: true; value: T } | { ok: false; why: string };

export interface BuildPushed {
  branch: string;
  base: string;
  sha: string;
  files: string[];
}

interface Waiting {
  settle(answer: unknown): void;
}

const asks = boxAsks<Waiting>();

interface BoxActDeps {
  send(deviceId: string, envelope: { event: string; data: unknown }): number;
}

const defaultDeps = (): BoxActDeps => ({
  send: (deviceId, envelope) => runnersPorts().sendToBoxNow(deviceId, envelope),
});

function askBox<T>(input: {
  deviceId: string;
  projectId: string;
  event: string;
  data: Record<string, unknown>;
  timeoutMs: number;
  read(answer: unknown): BoxActOutcome<T>;
  deps: BoxActDeps;
}): Promise<BoxActOutcome<T>> {
  return new Promise((resolve) => {
    asks.ask(
      { settle: (answer) => resolve(input.read(answer)) },
      {
        deviceId: input.deviceId,
        projectId: input.projectId,
        event: input.event,
        data: { projectId: input.projectId, ...input.data },
        timeoutMs: input.timeoutMs,
        send: input.deps.send,
        settle: resolve,
        unanswered: (): BoxActOutcome<T> => ({
          ok: false,
          why: `the box was asked (${input.event}) and did not answer within ${input.timeoutMs / 1000}s; a forge-runner older than this core does not take ${input.event} (\`forge-runner update\`)`,
        }),
        disconnected: (): BoxActOutcome<T> => ({
          ok: false,
          why: `the box disconnected before it could be asked (${input.event})`,
        }),
      },
    );
  });
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Run `command` on `host` through the box `deviceId`, which binds `projectId`. */
export function runHostCommand(
  input: { deviceId: string; projectId: string; host: string; command: string },
  deps: BoxActDeps = defaultDeps(),
): Promise<BoxActOutcome<SupportCommandResult>> {
  return askBox({
    deviceId: input.deviceId,
    projectId: input.projectId,
    event: 'host.command',
    data: { host: input.host, command: input.command, timeoutMs: HOST_COMMAND_TIMEOUT_MS },
    timeoutMs: COMMAND_ANSWER_WAIT_MS,
    deps,
    read: (raw) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      if (typeof a.error === 'string') return { ok: false, why: a.error.slice(0, 2000) };
      return {
        ok: true,
        value: {
          host: input.host,
          exitCode: typeof a.exitCode === 'number' ? a.exitCode : null,
          stdout: text(a.stdout, 64_000),
          stderr: text(a.stderr, 64_000),
          truncated: a.truncated === true,
          timedOut: a.timedOut === true,
          durationMs: typeof a.durationMs === 'number' ? a.durationMs : 0,
        },
      };
    },
  });
}

const SHA = /^[0-9a-f]{40}$/;

/** Commit the room's working copy on `branch`, push it without force, and say what was pushed. */
export function pushSupportBuild(
  input: {
    deviceId: string;
    projectId: string;
    buildKey: string;
    base: string;
    branch: string;
    title: string;
    body: string;
  },
  deps: BoxActDeps = defaultDeps(),
): Promise<BoxActOutcome<BuildPushed>> {
  const { deviceId, projectId, ...data } = input;
  return askBox({
    deviceId,
    projectId,
    event: 'build.push',
    data,
    timeoutMs: BUILD_ANSWER_WAIT_MS,
    deps,
    read: (raw) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      if (typeof a.error === 'string') return { ok: false, why: a.error.slice(0, 2000) };
      if (typeof a.sha !== 'string' || !SHA.test(a.sha) || a.branch !== input.branch) {
        return {
          ok: false,
          why: `the box answered build.push without the commit it pushed on ${input.branch}`,
        };
      }
      const files = Array.isArray(a.files)
        ? a.files.filter((f): f is string => typeof f === 'string').slice(0, 500)
        : [];
      return {
        ok: true,
        value: { branch: input.branch, base: input.base, sha: a.sha, files },
      };
    },
  });
}

/**
 * Settle the ask `requestId` with a box's answer; false when nobody asked that box for that
 * project, or the wait already ended.
 */
export function answerBoxAct(
  deviceId: string,
  requestId: string,
  answer: { projectId: string } & Record<string, unknown>,
): boolean {
  const entry = asks.take(requestId, deviceId, answer.projectId);
  if (!entry) return false;
  entry.settle(answer);
  return true;
}
