import { z } from 'zod';
import { REGISTER_STATUSES } from '../../ecosystem/channel-register.js';
import { NUMBER_PATTERN, UUID_PATTERN } from '../../ecosystem/channel-schema.js';
import type { EcosystemRefusal } from '../../ecosystem/refusals.js';
import { DOCUMENT_TYPES } from '../../ecosystem/schema.js';

export const CHANNEL_READS = [
  'register',
  'inbox',
  'outbox',
  'unanswered',
  'read',
  'thread',
  'contracts',
] as const;
export const CHANNEL_WRITES = [
  'draft',
  'reply',
  'edit',
  'submit',
  'hold',
  'release',
  'withdraw',
  'supersede',
  'gate',
] as const;
export const CHANNEL_ACTIONS = [...CHANNEL_READS, ...CHANNEL_WRITES] as const;
export type ChannelAction = (typeof CHANNEL_ACTIONS)[number];

const number = z.string().regex(NUMBER_PATTERN);
const ref = z.string().refine((v) => UUID_PATTERN.test(v) || NUMBER_PATTERN.test(v));
const reason = z.string().trim().min(1).max(500);
const content = {
  type: z.enum(DOCUMENT_TYPES),
  subject: z.string(),
  body: z.record(z.string(), z.unknown()),
  dueBy: z.string().optional(),
};

/** What each action takes; a key another action takes is refused here, not dropped. */
const BY_ACTION = {
  register: z.strictObject({
    ecosystem: z.uuid().optional(),
    status: z.enum(REGISTER_STATUSES).optional(),
    type: z.enum(DOCUMENT_TYPES).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  inbox: z.strictObject({}),
  outbox: z.strictObject({}),
  unanswered: z.strictObject({}),
  read: z.strictObject({ ref }),
  thread: z.strictObject({ thread: number }),
  contracts: z.strictObject({ project: z.uuid().optional() }),
  draft: z.strictObject({
    ecosystem: z.uuid().optional(),
    to: z.array(z.uuid()).min(1),
    inReplyTo: number.optional(),
    ...content,
  }),
  reply: z.strictObject({ inReplyTo: number, to: z.array(z.uuid()).min(1).optional(), ...content }),
  edit: z.strictObject({
    ref,
    to: z.array(z.uuid()).min(1),
    inReplyTo: number.optional(),
    ...content,
  }),
  submit: z.strictObject({ ref }),
  hold: z.strictObject({ thread: number, reason }),
  release: z.strictObject({ thread: number, reason: reason.optional() }),
  withdraw: z.strictObject({ ref, reason }),
  supersede: z.strictObject({ ref, by: number, reason }),
  gate: z.strictObject({
    ref,
    decision: z.enum(['approve', 'return']),
    note: z.string().trim().min(1).max(1000).optional(),
  }),
} satisfies Record<ChannelAction, z.ZodType>;

export type ChannelArgs<A extends ChannelAction> = z.infer<(typeof BY_ACTION)[A]>;

export type ParsedCall =
  | { ok: true; action: ChannelAction; args: Record<string, unknown> }
  | { ok: false; refusals: EcosystemRefusal[] };

const invalid = (path: string, detail: string): EcosystemRefusal => ({
  code: 'CHANNEL_ARGUMENT_INVALID',
  path,
  detail,
});

const SHAPES: Record<ChannelAction, string> = {
  register: '{ ecosystem?, status?, type?, limit? }',
  inbox: '{}',
  outbox: '{}',
  unanswered: '{}',
  read: '{ ref: a document uuid or number }',
  thread: '{ thread: the number that opened it }',
  contracts: '{ project?: a project uuid, this one when omitted }',
  draft: '{ ecosystem?, type, to, subject, body, dueBy?, inReplyTo? }',
  reply: '{ inReplyTo, type, subject, body, to?, dueBy? }',
  edit: '{ ref, type, to, subject, body, dueBy?, inReplyTo? }',
  submit: '{ ref }',
  hold: '{ thread, reason }',
  release: '{ thread, reason? }',
  withdraw: '{ ref, reason }',
  supersede: '{ ref, by: the published replacement number, reason }',
  gate: '{ ref: a submitted document, decision: approve | return, note? (return needs one) }',
};

export function parseChannelCall(raw: Record<string, unknown>): ParsedCall {
  const { action, ...rest } = raw;
  if (typeof action !== 'string' || !(CHANNEL_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      refusals: [invalid('/action', `action is one of ${CHANNEL_ACTIONS.join(', ')}`)],
    };
  }
  const act = action as ChannelAction;
  const parsed = BY_ACTION[act].safeParse(rest);
  if (parsed.success) return { ok: true, action: act, args: parsed.data };
  return {
    ok: false,
    refusals: parsed.error.issues.map((issue) => {
      const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
      const path = `/${[...issue.path, ...keys.slice(0, 1)].map(String).join('/')}`;
      return invalid(path, `${act} takes ${SHAPES[act]}; ${issue.message}`);
    }),
  };
}

const prop = (description: string, schema: Record<string, unknown> = { type: 'string' }) => ({
  ...schema,
  description,
});

/** The flat schema the model is offered; each action's own shape is `BY_ACTION`, enforced by `parseChannelCall`. */
export const CHANNEL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...CHANNEL_ACTIONS] },
    projectId: prop(
      'The side to act for; a token bound to one project, or the X-Forge-Project-Slug header, names it when omitted.',
    ),
    ecosystem: prop('Ecosystem uuid; omit when this project is in one.'),
    ref: prop('A document uuid, or its number such as FP-CN-3.'),
    thread: prop('The number of the document that opened the conversation.'),
    project: prop('contracts: the project whose API page to read.'),
    type: prop('Document type.', { type: 'string', enum: [...DOCUMENT_TYPES] }),
    to: prop('Recipient project uuids.', { type: 'array', items: { type: 'string' } }),
    subject: prop('One-line subject, in English.'),
    body: prop('The type-specific body.', { type: 'object' }),
    dueBy: prop('YYYY-MM-DD; a default applies when omitted.'),
    inReplyTo: prop('The number this document answers.'),
    reason: prop('Why, shown to both sides.'),
    by: prop('supersede: the number of the published replacement.'),
    decision: prop('gate: approve, or return to the writer.', {
      type: 'string',
      enum: ['approve', 'return'],
    }),
    note: prop('gate: what to change; a return needs one.'),
    status: prop('register filter.', { type: 'string', enum: [...REGISTER_STATUSES] }),
    limit: prop('register: rows, 1 to 200.', { type: 'integer' }),
  },
  required: ['action'],
  additionalProperties: false,
};
