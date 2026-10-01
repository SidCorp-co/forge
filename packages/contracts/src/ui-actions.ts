// cm:why the chat assistant drives the page beside it through a CLOSED registry: the model names an
// action and core forwards it, the browser executes it as the signed-in person, and an action outside
// this file, or one whose params do not parse, is refused by name — never guessed, never half applied.
// Every action changes view state only (route, list filter, selection, the board in the dock); none
// writes data — a board reaches an issue only when the person presses Attach.

import { z } from 'zod';
import { REGISTRY_ISSUE_PRIORITIES, REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';
import {
  parseWireframe,
  type WireframeRefusalCode,
  wireframeDocSchema,
  wireframePatchSchema,
} from './wireframe.js';

export const UI_ACTION_VERSION = 1 as const;

/** The project routes an action may name, each to its path under `/projects/<slug>`. */
export const UI_ROUTES = {
  overview: '',
  issues: '/issues',
  pipeline: '/pipeline',
  releases: '/releases',
  agents: '/agents',
  workflows: '/workflows',
  ecosystem: '/ecosystem',
  schedules: '/automation/schedules',
  improvements: '/automation/improvements',
  settings: '/settings',
} as const;
export type UiRoute = keyof typeof UI_ROUTES;
const ROUTE_NAMES = Object.keys(UI_ROUTES) as [UiRoute, ...UiRoute[]];

export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const issueKey = z.string().regex(ISSUE_KEY_PATTERN, 'an issue key such as ISS-47');

export const UI_ISSUE_FILTER_FIELDS = ['status', 'priority', 'createdBy', 'assignee', 'text'] as const;
export type UiIssueFilterField = (typeof UI_ISSUE_FILTER_FIELDS)[number];

export const uiIssueFilterSchema = z.strictObject({
  status: z.array(z.enum(REGISTRY_ISSUE_STATUSES)).min(1).optional(),
  priority: z.enum(REGISTRY_ISSUE_PRIORITIES).optional(),
  createdBy: z.literal('me').optional(),
  assignee: z.literal('me').optional(),
  text: z.string().trim().min(1).max(200).optional(),
});
export type UiIssueFilter = z.infer<typeof uiIssueFilterSchema>;

const navigateParams = z.strictObject({
  route: z.enum(ROUTE_NAMES),
});
const filterParams = z
  .strictObject({
    mode: z.enum(['merge', 'replace']),
    set: uiIssueFilterSchema.default({}),
    clear: z.array(z.enum(UI_ISSUE_FILTER_FIELDS)).max(UI_ISSUE_FILTER_FIELDS.length).default([]),
  })
  .refine((v) => Object.keys(v.set).length > 0 || v.clear.length > 0 || v.mode === 'replace', {
    message: 'a merge must set or clear at least one field',
  })
  .refine((v) => !v.clear.some((f) => f in v.set), {
    message: 'a field cannot be both set and cleared',
  });
const selectParams = z.strictObject({
  keys: z.array(issueKey).max(100),
});
const openParams = z.strictObject({
  key: issueKey,
});
const boardDrawParams = z.strictObject({
  doc: wireframeDocSchema,
});
const boardReviseParams = z.strictObject({
  ops: wireframePatchSchema,
});

/** The registry: one entry per action, its wire name (OpenAI allows no dots), its version and its params. */
export const UI_ACTIONS = {
  'ui.navigate': {
    wire: 'ui_navigate',
    version: UI_ACTION_VERSION,
    params: navigateParams,
    describe: 'Navigate the page beside the chat to one of this project\'s routes.',
  },
  'ui.issues.filter': {
    wire: 'ui_issues_filter',
    version: UI_ACTION_VERSION,
    params: filterParams,
    describe:
      'Open the Issues list and set its filter. mode "merge" keeps the filter the person sees and changes only the named fields; mode "replace" drops every field it does not set. createdBy and assignee take only "me" (the signed-in person).',
  },
  'ui.select': {
    wire: 'ui_select',
    version: UI_ACTION_VERSION,
    params: selectParams,
    describe: 'Select rows of the Issues list by issue key (an empty list clears the selection). Only rows on the page the person sees can be selected.',
  },
  'ui.open': {
    wire: 'ui_open',
    version: UI_ACTION_VERSION,
    params: openParams,
    describe: 'Open one issue, by its key, in the page beside the chat.',
  },
  'ui.board.draw': {
    wire: 'ui_board_draw',
    version: UI_ACTION_VERSION,
    params: boardDrawParams,
    describe:
      'Draw a UI wireframe on the board inside the chat panel (it widens to make room), replacing the board shown. doc is a strict wireframe-v1 document: shapes from the closed set frame, text, button, input, list, image (placeholder), arrow, pen; every shape has a stable id; x, y, w, h lie inside a 0..4000 canvas; an arrow joins two shape ids ({id}) or bounded points ({x,y}). Use it when the conversation is about a screen or layout.',
  },
  'ui.board.revise': {
    wire: 'ui_board_revise',
    version: UI_ACTION_VERSION,
    params: boardReviseParams,
    describe:
      'Revise the open board by shape id: ops add a shape, update fields of one ({op:"update", id, set:{x:...}}), or remove one. Read the board the person sees — including what they changed by hand — from the page snapshot\'s board before revising. The revised board must still be a valid wireframe-v1 document or nothing changes.',
  },
} as const;

export type UiActionName = keyof typeof UI_ACTIONS;
export const UI_ACTION_NAMES = Object.keys(UI_ACTIONS) as UiActionName[];

export type UiAction =
  | { name: 'ui.navigate'; v: 1; params: z.infer<typeof navigateParams> }
  | { name: 'ui.issues.filter'; v: 1; params: z.infer<typeof filterParams> }
  | { name: 'ui.select'; v: 1; params: z.infer<typeof selectParams> }
  | { name: 'ui.open'; v: 1; params: z.infer<typeof openParams> }
  | { name: 'ui.board.draw'; v: 1; params: z.infer<typeof boardDrawParams> }
  | { name: 'ui.board.revise'; v: 1; params: z.infer<typeof boardReviseParams> };

export type UiActionRefusalCode = 'UI_ACTION_UNKNOWN' | 'UI_ACTION_INVALID' | WireframeRefusalCode;
export type UiActionParse =
  | { ok: true; action: UiAction }
  | { ok: false; code: UiActionRefusalCode; name: string; message: string };

/** The registry entry a name (dotted, or its exact wire form) names, or null. */
export function uiActionNamed(name: string): UiActionName | null {
  if (name in UI_ACTIONS) return name as UiActionName;
  for (const key of UI_ACTION_NAMES) if (UI_ACTIONS[key].wire === name) return key;
  return null;
}

/** Parse one call against the registry: the action, or a refusal naming what was wrong. */
export function parseUiAction(name: string, params: unknown): UiActionParse {
  const key = uiActionNamed(name);
  if (!key) {
    return {
      ok: false,
      code: 'UI_ACTION_UNKNOWN',
      name,
      message: `UI_ACTION_UNKNOWN: "${name}" is not a UI action. Nothing was changed. The registry holds: ${UI_ACTION_NAMES.join(', ')}.`,
    };
  }
  const board = boardRefusal(key, params);
  if (board) return board;
  const parsed = UI_ACTIONS[key].params.safeParse(params ?? {});
  if (!parsed.success) {
    const where = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(params)'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      code: 'UI_ACTION_INVALID',
      name: key,
      message: `UI_ACTION_INVALID: ${key} params refused — ${where}. Nothing was changed.`,
    };
  }
  return { ok: true, action: { name: key, v: UI_ACTION_VERSION, params: parsed.data } as UiAction };
}

/** A board action's document judged by wireframe-v1 first, so its refusal carries the WIREFRAME_* code. */
function boardRefusal(key: UiActionName, params: unknown): (UiActionParse & { ok: false }) | null {
  if (key !== 'ui.board.draw' && key !== 'ui.board.revise') return null;
  const p = typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const no = (code: WireframeRefusalCode, message: string) => ({ ok: false as const, code, name: key, message });
  if (key === 'ui.board.draw' && 'doc' in p) {
    const r = parseWireframe(p.doc);
    return r.ok ? null : no(r.code, r.message);
  }
  if (key === 'ui.board.revise' && Array.isArray(p.ops)) {
    for (let i = 0; i < p.ops.length; i++) {
      const op = p.ops[i] as Record<string, unknown> | null;
      if (op?.op !== 'add') continue;
      const r = parseWireframe({ v: 'wireframe-v1', shapes: [op.shape] });
      if (!r.ok && r.code !== 'WIREFRAME_ARROW_DANGLING') return no(r.code, r.message.replace('shapes.0', `ops.${i}.shape`));
    }
  }
  return null;
}

/** The JSON Schema each action's params are offered to the model as. */
export function uiActionJsonSchema(name: UiActionName): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(UI_ACTIONS[name].params, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return schema;
}

/** The marker a deferred call's result carries, which the browser reads to know it owes the execution. */
export const UI_ACTION_DEFERRED = 'browser' as const;

/** What the page beside the chat looks like, sent with each message — typed, never scraped. */
export const uiSnapshotSchema = z.strictObject({
  v: z.literal(UI_ACTION_VERSION),
  route: z.enum([...ROUTE_NAMES, 'issue', 'other']),
  path: z.string().max(500),
  issueKey: issueKey.optional(),
  filter: uiIssueFilterSchema.optional(),
  selection: z.array(issueKey).max(100).optional(),
  /** The board open in the dock, as the person last left it (ISS-48). */
  board: wireframeDocSchema.optional(),
  /** Why the board the person drew is not sendable as wireframe-v1, when it is not. */
  boardRefused: z.string().max(500).optional(),
});
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;

/** The snapshot as the one line a person reads under the composer and the model reads above the message. */
export function describeUiSnapshot(s: UiSnapshot): string {
  const parts: string[] = [s.route === 'issue' && s.issueKey ? s.issueKey : s.route === 'other' ? s.path : s.route];
  const f = s.filter;
  if (f) {
    if (f.createdBy) parts.push('created by me');
    if (f.assignee) parts.push('assigned to me');
    if (f.priority) parts.push(`priority ${f.priority}`);
    if (f.status) parts.push(`status ${f.status.join('/')}`);
    if (f.text) parts.push(`"${f.text}"`);
  }
  if (s.selection && s.selection.length > 0) parts.push(`${s.selection.length} selected`);
  if (s.board) parts.push(`board of ${s.board.shapes.length} shape${s.board.shapes.length === 1 ? '' : 's'}`);
  if (s.boardRefused) parts.push('board not readable');
  return parts.join(' · ');
}
