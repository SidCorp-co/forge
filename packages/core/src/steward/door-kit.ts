// What every steward door is built from (REQ-48 BC-12): the context one act's turn calls doors in, a
// door's shape, and the call itself, made through core's own app with the steward account's token.

import { REASON_PARAGRAPH_MAX } from '@forge/contracts/comments';
import type { ItemStanding, StewardAct, StewardCite } from '@forge/contracts/steward';
import type { StewardDoorTool } from '@forge/contracts/steward-runtime';
import { z } from 'zod';
import type { StewardUndo } from '../db/schema-steward-runs.js';
import type { ActWrite } from './acts-store.js';
import { bearer, callDoor, type DoorAnswer, type DoorRequest } from './door-call.js';

export interface DoorContext {
  projectId: string;
  runId: string;
  act: StewardAct;
  subject: { kind: string; id: string; key: string };
  /** The item's standing the run read: what its note's claims, basis and cites are copied from. */
  standing: ItemStanding | null;
  token: string;
  /** Each write a door refused, as `door: CODE detail`. */
  refused: string[];
  /** Each write a door could not answer (5xx): no refusal, so the run is tried again. */
  broken: string[];
  /** The act rows this turn wrote. */
  acts: string[];
}

export type ActOf = Omit<ActWrite, 'runId' | 'projectId' | 'act'>;

export interface DoorSpec<A> {
  name: StewardDoorTool;
  describe: string;
  params: z.ZodType<A>;
  write: boolean;
  /**
   * The door's answer, or `correct`: a shape the turn owns, said to it and refused nowhere. `act` is
   * logged where the answer is ok; `acts`, the writes a door of several steps landed, whatever its
   * last step answered, so each is undone on its own.
   */
  call(
    args: A,
    ctx: DoorContext,
  ): Promise<
    { request: DoorRequest; answer: DoorAnswer; act?: ActOf; acts?: ActOf[] } | { correct: string }
  >;
}

export const key = z.string().trim().min(1).max(40);

/** The tool that reads a requirement's or a feedback item's key, which an issue door is not. */
const READ_OF: ReadonlyArray<{ pattern: RegExp; what: string; tool: StewardDoorTool }> = [
  { pattern: /^REQ-\d+$/i, what: 'a requirement', tool: 'steward_read_requirement' },
  { pattern: /^FB-\d+$/i, what: 'a feedback item', tool: 'steward_read_feedback' },
];

/**
 * An issue's key (ISS-n, or the project's own prefix): a requirement's or a feedback item's key is
 * refused here naming the tool that reads it, before any door is called, so a turn holding FB-110
 * never sends it to the issue door to be read as another project's issue.
 */
export const issueKey = key.superRefine((value, ctx) => {
  const hit = READ_OF.find((r) => r.pattern.test(value));
  if (!hit) return;
  ctx.addIssue({
    code: 'custom',
    message: `${value} is ${hit.what}, not an issue: read it with ${hit.tool}, or steward_read_item for this run's own item. An issue door takes an issue key like ISS-12; a feedback item's carrier issues are on its route.`,
  });
});
export const reason = z.string().trim().min(3).max(REASON_PARAGRAPH_MAX);

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

/** The undo of a comment the steward posted on a requirement: its delete door. */
export const requirementCommentUndo = (
  ctx: DoorContext,
  requirement: string,
  commentId: unknown,
): StewardUndo | null =>
  typeof commentId === 'string'
    ? {
        door: `DELETE /api/projects/${ctx.projectId}/requirements/${requirement}/comments/${commentId}`,
        body: null,
      }
    : null;

export const cite = (kind: StewardCite['kind'], ref: unknown): StewardCite | null =>
  typeof ref === 'string' && ref ? { kind, ref } : null;
