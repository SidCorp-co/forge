// What every steward door is built from (REQ-48 BC-12): the context one act's turn calls doors in, a
// door's shape, and the call itself, made through core's own app with the steward account's token.

import type { StewardAct, StewardCite } from '@forge/contracts/steward';
import type { StewardDoorTool } from '@forge/contracts/steward-runtime';
import { z } from 'zod';
import type { ActWrite } from './acts-store.js';
import { bearer, callDoor, type DoorAnswer, type DoorRequest } from './door-call.js';

export interface DoorContext {
  projectId: string;
  runId: string;
  act: StewardAct;
  subject: { kind: string; id: string; key: string };
  token: string;
  /** Each write a door refused, as `door: CODE detail`. */
  refused: string[];
  /** The act rows this turn wrote. */
  acts: string[];
}

export type ActOf = Omit<ActWrite, 'runId' | 'projectId' | 'act'>;

export interface DoorSpec<A> {
  name: StewardDoorTool;
  describe: string;
  params: z.ZodType<A>;
  write: boolean;
  call(
    args: A,
    ctx: DoorContext,
  ): Promise<{ request: DoorRequest; answer: DoorAnswer; act?: ActOf }>;
}

export const key = z.string().trim().min(1).max(40);
export const reason = z.string().trim().min(3).max(2000);

export const send = async (request: DoorRequest, ctx: DoorContext) => ({
  request,
  answer: await callDoor(request, bearer(ctx.token)),
});

export const read = <A>(
  name: StewardDoorTool,
  describe: string,
  params: z.ZodType<A>,
  path: (args: A, ctx: DoorContext) => string,
): DoorSpec<A> => ({
  name,
  describe,
  params,
  write: false,
  call: (args, ctx) => send({ method: 'GET', path: path(args, ctx) }, ctx),
});

/** The issue's uuid from its key, read through the issue door, which alone resolves a key. */
export async function issueIdOf(issue: string, ctx: DoorContext): Promise<string | DoorAnswer> {
  if (issue === ctx.subject.key && ctx.subject.kind === 'issue') return ctx.subject.id;
  const answer = await callDoor(
    {
      method: 'GET',
      path: `/api/issues/${encodeURIComponent(issue)}?projectId=${ctx.projectId}`,
    },
    bearer(ctx.token),
  );
  const id = answer.json?.id;
  return answer.ok && typeof id === 'string' ? id : answer;
}

export const cite = (kind: StewardCite['kind'], ref: unknown): StewardCite | null =>
  typeof ref === 'string' && ref ? { kind, ref } : null;
