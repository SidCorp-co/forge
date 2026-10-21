// The steward's write doors (REQ-48 BC-2..BC-7): ask, comment, reject a breakdown, move an issue,
// wake the master and write the note, each one existing door and each logged with how it is undone.

import {
  type ItemStanding,
  STEWARD_NOTE_CITES_MAX,
  type StewardCite,
  stewardCiteSchema,
  stewardNoteWriteSchema,
} from '@forge/contracts/steward';
import { z } from 'zod';
import type { StewardUndo } from '../db/schema-steward-runs.js';
import { type DoorAnswer, type DoorRequest, doorName, refusalCodeOfAnswer } from './door-call.js';
import {
  cite,
  type DoorContext,
  type DoorSpec,
  issueIdOf,
  issueKey,
  key,
  reason,
  requirementCommentUndo,
  send,
} from './door-kit.js';
import { OWNER } from './door-owner.js';
import { noteWriteOf } from './note.js';
import { openStandings, stewardPorts } from './ports.js';

const optionsParam = z
  .array(
    z.strictObject({
      id: z.string().trim().min(1).max(40),
      label: z.string().trim().min(1).max(200),
    }),
  )
  .min(2)
  .max(4);

/** What a question may be about: an issue, or a requirement, never a feedback item's key. */
const askAbout = key
  .superRefine((value, ctx) => {
    if (!/^FB-\d+$/i.test(value)) return;
    ctx.addIssue({
      code: 'custom',
      message: `${value} is a feedback item, which takes no question here: ask on the issue that carries it or the requirement it is about (read its route with steward_read_feedback or steward_read_item).`,
    });
  })
  .describe('ISS-n or REQ-n: the issue or requirement the question is about');

const askParams = z.strictObject({
  about: askAbout,
  prompt: z.string().trim().min(10).max(2000),
  options: optionsParam,
  recommended: z.string().trim().min(1).max(40).describe('the id of the option you recommend'),
});

const ASK: DoorSpec<z.infer<typeof askParams>> = {
  name: 'steward_ask',
  describe:
    'Ask whoever owes the next act one question, with 2-4 options and the one you recommend. About an issue it is a choice question on that issue; about a requirement it is a question comment on it.',
  params: askParams,
  write: true,
  async call(args, ctx) {
    const choices = args.options.map((o) => `${o.id}: ${o.label}`).join('; ');
    if (/^REQ-\d+$/i.test(args.about)) {
      const sent = await send(
        {
          method: 'POST',
          path: `/api/projects/${ctx.projectId}/requirements/${args.about}/comments`,
          body: {
            intent: 'question',
            body: `${args.prompt}\n\nOptions: ${choices}. Recommended: ${args.recommended}.`,
          },
        },
        ctx,
      );
      const comment = sent.answer.json?.comment as { id?: unknown } | undefined;
      return {
        ...sent,
        act: {
          door: doorName(sent.request),
          did: `Asked on ${args.about}: ${args.prompt}`,
          wrote: cite('comment', comment?.id),
          undo: requirementCommentUndo(ctx, args.about, comment?.id),
        },
      };
    }
    const issueId = await issueIdOf(args.about, ctx);
    if (typeof issueId !== 'string')
      return { request: { method: 'GET', path: `/api/issues/${args.about}` }, answer: issueId };
    const sent = await send(
      {
        method: 'POST',
        path: '/api/questions',
        body: {
          issueId,
          prompt: args.prompt,
          options: args.options.map((o) => ({
            id: o.id,
            label: o.label,
            authority: 'writer',
            bindsTo: 'this_call',
            executedBy: 'human',
            // the one decision this run asks for: an answer binds to it and to nothing after it
            fingerprint: `steward:${ctx.runId}:${o.id}`,
          })),
          recommendedOptionId: args.recommended,
          blockerKind: 'human',
        },
      },
      ctx,
    );
    const id = sent.answer.json?.id;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Asked on ${args.about}: ${args.prompt}`,
        wrote: cite('question', id),
        undo:
          typeof id === 'string'
            ? {
                door: `POST /api/questions/${id}/void`,
                body: { reason: "A person undid the steward's question, so it needs no answer." },
              }
            : null,
      },
    };
  },
};

const commentRequirementParams = z.strictObject({
  requirement: key,
  body: z.string().trim().min(3).max(8000),
});
const COMMENT_REQUIREMENT: DoorSpec<z.infer<typeof commentRequirementParams>> = {
  name: 'steward_comment_requirement',
  describe: 'Post a note on a requirement: the breakdown brief once its intake check is complete.',
  params: commentRequirementParams,
  write: true,
  async call(args, ctx) {
    const sent = await send(
      {
        method: 'POST',
        path: `/api/projects/${ctx.projectId}/requirements/${args.requirement}/comments`,
        body: { intent: 'note', body: args.body },
      },
      ctx,
    );
    const comment = sent.answer.json?.comment as { id?: unknown } | undefined;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Wrote a note on ${args.requirement}`,
        wrote: cite('comment', comment?.id),
        undo: requirementCommentUndo(ctx, args.requirement, comment?.id),
      },
    };
  },
};

const commentIssueParams = z.strictObject({
  issue: issueKey,
  body: z.string().trim().min(3).max(8000),
});
const COMMENT_ISSUE: DoorSpec<z.infer<typeof commentIssueParams>> = {
  name: 'steward_comment_issue',
  describe: 'Post a comment on an issue saying why the steward acted on it.',
  params: commentIssueParams,
  write: true,
  async call(args, ctx) {
    const issueId = await issueIdOf(args.issue, ctx);
    if (typeof issueId !== 'string')
      return { request: { method: 'GET', path: `/api/issues/${args.issue}` }, answer: issueId };
    const sent = await send(
      {
        method: 'POST',
        path: `/api/issues/${issueId}/comments`,
        body: { intent: 'note', body: args.body },
      },
      ctx,
    );
    const id = sent.answer.json?.id;
    const undo: StewardUndo | null =
      typeof id === 'string' ? { door: `DELETE /api/comments/${id}`, body: null } : null;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Commented on ${args.issue}`,
        wrote: cite('comment', id),
        undo,
      },
    };
  },
};

const rejectParams = z.strictObject({ suggestionId: z.uuid(), reason });
const REJECT: DoorSpec<z.infer<typeof rejectParams>> = {
  name: 'steward_reject_breakdown',
  describe:
    'Reject a proposed breakdown, naming each gap ("BC-4 untraced; \'Export CSV\' unsized"). Its master is owed a new one with your reason.',
  params: rejectParams,
  write: true,
  async call(args, ctx) {
    const sent = await send(
      {
        method: 'POST',
        path: `/api/projects/${ctx.projectId}/suggestions/${args.suggestionId}/reject`,
        body: { reason: args.reason },
      },
      ctx,
    );
    const s = sent.answer.json?.suggestion as
      | {
          id: string;
          kind: string;
          target: { type: string; id: string };
          baseRevision: number | null;
          payload: unknown;
        }
      | undefined;
    const undo: StewardUndo | null =
      s && s.payload !== null
        ? {
            door: `POST /api/projects/${ctx.projectId}/suggestions`,
            body: {
              kind: s.kind,
              [s.target.type]: s.target.id,
              baseRevision: s.baseRevision,
              payload: s.payload,
            },
          }
        : null;
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Rejected the breakdown of ${ctx.subject.key}: ${args.reason}`,
        wrote: cite('suggestion', args.suggestionId),
        undo,
      },
    };
  },
};

const moveParams = z.strictObject({
  issue: issueKey,
  to: z
    .enum(['open', 'reopen'])
    .describe('open: take a ready draft on; reopen: send it back naming the missing evidence'),
  reason,
});
const MOVE: DoorSpec<z.infer<typeof moveParams>> = {
  name: 'steward_move_issue',
  describe:
    'Move an issue: `open` a draft carrier whose ready checklist is complete, or send an issue at awaiting_release back to `reopen`, naming each criterion and the evidence missing.',
  params: moveParams,
  write: true,
  async call(args, ctx) {
    const issueId = await issueIdOf(args.issue, ctx);
    if (typeof issueId !== 'string')
      return { request: { method: 'GET', path: `/api/issues/${args.issue}` }, answer: issueId };
    const sent = await send(
      {
        method: 'POST',
        path: `/api/issues/${issueId}/transition`,
        body: { toStatus: args.to, reason: args.reason },
      },
      ctx,
    );
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Moved ${args.issue} to ${args.to}: ${args.reason}`,
        wrote: cite('issue', args.issue),
        undo: null,
      },
    };
  },
};

const wakeParams = z.strictObject({ about: key, ask: z.string().trim().min(10).max(500) });
const WAKE: DoorSpec<z.infer<typeof wakeParams>> = {
  name: 'steward_wake_master',
  describe:
    "Wake the project's master and ask it to act on an item: it stands among what the master is owed until the item's standing moves.",
  params: wakeParams,
  write: true,
  async call(args, ctx) {
    const request: DoorRequest = { method: 'POST', path: `/ws/master.wake/steward` };
    const woke = await stewardPorts().wakeMasters({
      projectId: ctx.projectId,
      subjectKey: args.about,
      ask: args.ask,
    });
    const answer: DoorAnswer = { status: 200, ok: true, json: woke, text: JSON.stringify(woke) };
    return {
      request,
      answer,
      act: {
        door: 'WAKE master.wake steward',
        did: `Asked the master about ${args.about}: ${args.ask}`,
        wrote: null,
        undo: null,
        masterAsk: `${args.about}: ${args.ask}`,
      },
    };
  },
};

const noteParams = z.strictObject({
  lines: stewardNoteWriteSchema.shape.lines.describe(
    'line 1: what happened and what blocks; line 2: what is next and by when',
  ),
  cites: z
    .array(stewardCiteSchema)
    .max(STEWARD_NOTE_CITES_MAX - 2)
    .optional()
    .describe(
      'records the lines name beyond the item and what it waits on, which are cited for you',
    ),
});

/** A refusal a re-read standing answers: it moved since the run read it. */
const MOVED: ReadonlySet<string> = new Set([
  'STEWARD_NOTE_STALE',
  'STEWARD_NOTE_CONTRADICTS',
  'STEWARD_NOTE_CITE_MISSING',
]);

/** The item's standing now, from the one standing read; null where it holds no open row. */
async function standingNow(ctx: DoorContext): Promise<ItemStanding | null> {
  return (await openStandings(ctx.projectId)).find((r) => r.subject.id === ctx.subject.id) ?? null;
}

/**
 * The model writes the two lines; code copies the claims, the basis and the item's own cites from the
 * standing the run read (`note.ts:noteWriteOf`), so a note never guesses a field. A refusal that says
 * the standing moved is answered by reading it again and writing the same lines once more against it.
 */
const NOTE: DoorSpec<z.infer<typeof noteParams>> = {
  name: 'steward_write_note',
  describe:
    "Write the item's two-line note: line 1 what happened and what blocks, line 2 what is next and by when. Give the lines, and any record they name beyond the item and what it waits on; the claims, basis and those two cites are copied from the standing for you.",
  params: noteParams,
  write: true,
  async call(args, ctx) {
    const path = `/api/projects/${ctx.projectId}/steward-notes/${ctx.subject.kind}/${ctx.subject.key}`;
    const put = (standing: ItemStanding) =>
      send(
        {
          method: 'PUT',
          path,
          body: noteWriteOf(standing, args.lines, args.cites ?? [], ctx.runId),
        },
        ctx,
      );
    const read = ctx.standing ?? (await standingNow(ctx));
    if (!read) {
      const text = `the standing read holds no open row for ${ctx.subject.key}, so no note can be checked against it`;
      return {
        request: { method: 'PUT', path },
        answer: { status: 404, ok: false, json: { code: 'STEWARD_NOTE_SUBJECT_UNKNOWN' }, text },
      };
    }
    let sent = await put(read);
    const code = refusalCodeOfAnswer(sent.answer);
    if (!sent.answer.ok && code && MOVED.has(code)) {
      // only a standing that did move is written against again; one that holds keeps its refusal
      const now = await standingNow(ctx);
      if (now && now.basis !== read.basis) sent = await put(now);
    }
    return {
      ...sent,
      act: {
        door: doorName(sent.request),
        did: `Wrote the note on ${ctx.subject.key}: ${args.lines[0]}`,
        wrote: cite(ctx.subject.kind as StewardCite['kind'], ctx.subject.key),
        undo: null,
      },
    };
  },
};

/** Every write door, in the catalogue's order. */
export const WRITE_DOORS = [
  ASK,
  COMMENT_REQUIREMENT,
  COMMENT_ISSUE,
  REJECT,
  MOVE,
  OWNER,
  WAKE,
  NOTE,
] as unknown as DoorSpec<never>[];
