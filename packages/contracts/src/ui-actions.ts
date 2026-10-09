// the chat assistant drives the page beside it through a CLOSED registry: the model names an
// action and core forwards it, the browser executes it as the signed-in person, and an action outside
// this file, or one whose params do not parse, is refused by name — never guessed, never half applied.
// Every action changes view state only (route, list filter, selection, the board in the dock); none
// writes data — a board reaches an issue only when the person presses Attach.

import { z } from 'zod';
import {
  describeListFilter,
  listFilterParamsOf,
  UI_LIST_FILTERS,
  uiListFilterParams,
  uiListFilterSnapshotSchema,
} from './ui-list-filters.js';
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

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const issueKey = z.string().regex(ISSUE_KEY_PATTERN, 'an issue key such as ISS-47');

export const UI_ISSUE_FILTER_FIELDS = ['status', 'priority', 'createdBy', 'assignee', 'text'] as const;
export type UiIssueFilterField = (typeof UI_ISSUE_FILTER_FIELDS)[number];

/**
 * The Issues filter the registry offers today: the issues list's filter (`ui-list-filters.ts`) less
 * `waitingOn`, which the ui-actions lane (REQ-41) adds here in the change that teaches the Issues
 * list to read it, so the model is never offered a field no page applies.
 */
export const uiIssueFilterSchema = UI_LIST_FILTERS.issues.omit({ waitingOn: true });
export type UiIssueFilter = z.infer<typeof uiIssueFilterSchema>;

const navigateParams = z.strictObject({
  route: z.enum(ROUTE_NAMES),
});
const filterParams = listFilterParamsOf(uiIssueFilterSchema);
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
      'Draw a UI wireframe on the board inside the chat panel (it widens to make room), replacing the board shown. doc is a strict wireframe-v1 document: shapes from the closed set frame, text, button, input, list, image (placeholder), arrow, pen; every shape has a stable id; x, y, w, h lie inside a 0..4000 canvas; an arrow joins two shape ids ({id}) or bounded points ({x,y}). Use it when the conversation is about a screen or layout. The board holds no figure, not even one the person typed: a chart, table or key figure is drawn with forge_report and forge_show, and a board text stating a number is refused (UI_ACTION_BOARD_FIGURE).',
  },
  'ui.board.revise': {
    wire: 'ui_board_revise',
    version: UI_ACTION_VERSION,
    params: boardReviseParams,
    describe:
      'Revise the open board by shape id: ops add a shape, update fields of one ({op:"update", id, set:{x:...}}), or remove one. Read the board the person sees — including what they changed by hand — from the page snapshot\'s board before revising. The revised board must still be a valid wireframe-v1 document or nothing changes.',
  },
} as const;

type UiActionName = keyof typeof UI_ACTIONS;
export const UI_ACTION_NAMES = Object.keys(UI_ACTIONS) as UiActionName[];

export type UiAction =
  | { name: 'ui.navigate'; v: 1; params: z.infer<typeof navigateParams> }
  | { name: 'ui.issues.filter'; v: 1; params: z.infer<typeof filterParams> }
  | { name: 'ui.select'; v: 1; params: z.infer<typeof selectParams> }
  | { name: 'ui.open'; v: 1; params: z.infer<typeof openParams> }
  | { name: 'ui.board.draw'; v: 1; params: z.infer<typeof boardDrawParams> }
  | { name: 'ui.board.revise'; v: 1; params: z.infer<typeof boardReviseParams> };

type UiActionRefusalCode = 'UI_ACTION_UNKNOWN' | 'UI_ACTION_INVALID' | WireframeRefusalCode;
type UiActionParse =
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

/** The records a page can be about, each the route its own page is read as (REQ-30 BC-6). */
export const UI_PAGE_ITEM_KINDS = ['issue', 'requirement', 'feedback', 'workflow'] as const;
export type UiPageItemKind = (typeof UI_PAGE_ITEM_KINDS)[number];

/** A workflow page names its flow (`chat-turn`) or its uuid, as the page's own path does. */
export const WORKFLOW_PAGE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** The one record the page beside the chat is about, by the key its page is addressed with. */
export const uiPageItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('issue'), key: issueKey }),
  z.strictObject({
    kind: z.literal('requirement'),
    key: z.string().regex(/^REQ-\d{1,9}$/, 'a requirement key such as REQ-30'),
  }),
  z.strictObject({
    kind: z.literal('feedback'),
    key: z.string().regex(/^FB-\d{1,9}$/, 'a feedback key such as FB-12'),
  }),
  z.strictObject({
    kind: z.literal('workflow'),
    key: z.string().regex(WORKFLOW_PAGE_REF, 'a workflow flow such as chat-turn, or its uuid'),
  }),
]);
export type UiPageItem = z.infer<typeof uiPageItemSchema>;

// ---- REQ-41 additions (docs/proposals/chat-first.md, "Page actions"). The shapes land here; the
// ui-actions lane moves each into UI_ROUTES and UI_ACTIONS in the same change as its executor in
// web (`applyUiAction`) and core (`ui-actions-tool.ts`), so the model is never offered an action no
// page can run. Until then they parse and are tested on their own.

/** The Product routes the registry does not yet name (BC-4). */
export const UI_ROUTE_ADDITIONS = {
  requirements: '/requirements',
  feedback: '/feedback',
} as const;
export type UiRouteAddition = keyof typeof UI_ROUTE_ADDITIONS;

/** Every kind of record the chat can open by key (BC-6). */
export const UI_OPEN_KINDS = ['issue', 'requirement', 'feedback', 'workflow', 'release'] as const;
export type UiOpenKind = (typeof UI_OPEN_KINDS)[number];

const REQUIREMENT_KEY = /^REQ-\d{1,9}$/;
const FEEDBACK_KEY = /^FB-\d{1,9}$/;
/** A release is opened by its version, as its page is addressed (`0.4.0-dev.217`). */
const RELEASE_KEY = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const KEY_OF_KIND: Record<UiOpenKind, RegExp> = {
  issue: ISSUE_KEY_PATTERN,
  requirement: REQUIREMENT_KEY,
  feedback: FEEDBACK_KEY,
  workflow: WORKFLOW_PAGE_REF,
  release: RELEASE_KEY,
};
const KEY_EXAMPLE: Record<UiOpenKind, string> = {
  issue: 'an issue key such as ISS-47',
  requirement: 'a requirement key such as REQ-30',
  feedback: 'a feedback key such as FB-12',
  workflow: 'a workflow flow such as chat-turn',
  release: 'a release version such as 0.4.0-dev.217',
};

/**
 * The kind a key names by its own shape: REQ-n a requirement, FB-n feedback, any other PREFIX-n an
 * issue. A workflow flow and a release version look like neither, so they are opened only with
 * their kind named; null says so.
 */
export function openKindOf(key: string): 'issue' | 'requirement' | 'feedback' | null {
  if (REQUIREMENT_KEY.test(key)) return 'requirement';
  if (FEEDBACK_KEY.test(key)) return 'feedback';
  if (ISSUE_KEY_PATTERN.test(key)) return 'issue';
  return null;
}

/**
 * `ui.open` for every record kind (BC-6): `{key}` alone is read by the key's shape, so a call made
 * before kinds existed (`{key: "ISS-47"}`) still opens that issue; a key its kind does not take is
 * refused naming the shape the kind takes. The parsed params always name the kind.
 */
export const uiOpenParamsSchema = z
  .strictObject({
    kind: z.enum(UI_OPEN_KINDS).optional(),
    key: z.string().trim().min(1).max(200),
  })
  .transform((v, ctx) => {
    const kind = v.kind ?? openKindOf(v.key);
    if (kind === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['kind'],
        message: `"${v.key}" is not ISS-n, REQ-n or FB-n; name kind "workflow" or "release" to open one by its flow or version`,
      });
      return z.NEVER;
    }
    if (!KEY_OF_KIND[kind].test(v.key)) {
      ctx.addIssue({ code: 'custom', path: ['key'], message: `a ${kind} is opened by ${KEY_EXAMPLE[kind]}` });
      return z.NEVER;
    }
    return { kind, key: v.key };
  });
export type UiOpenTarget = z.output<typeof uiOpenParamsSchema>;

/** The sections each record page marks with a highlight anchor (BC-6); a workflow highlights a step. */
export const UI_HIGHLIGHT_SECTIONS = {
  issue: ['waiting', 'question', 'criteria', 'plan', 'preview'],
  requirement: ['waiting', 'question', 'criteria', 'picture', 'delivery', 'history'],
  feedback: ['waiting', 'question', 'evidence', 'triage', 'route', 'verify'],
} as const satisfies Partial<Record<UiPageItemKind, readonly string[]>>;
type HighlightSection = (typeof UI_HIGHLIGHT_SECTIONS)[keyof typeof UI_HIGHLIGHT_SECTIONS][number];
const SECTION_NAMES = [...new Set(Object.values(UI_HIGHLIGHT_SECTIONS).flat())] as [
  HighlightSection,
  ...HighlightSection[],
];

/** A workflow step's id as its design names it (`check`, `rule-merge`). */
export const WORKFLOW_STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** `ui.highlight`: mark one section of the open record, one step of the open workflow, or one row of the open list. */
export const uiHighlightParamsSchema = z.discriminatedUnion('target', [
  z.strictObject({ target: z.literal('section'), section: z.enum(SECTION_NAMES) }),
  z.strictObject({ target: z.literal('step'), step: z.string().regex(WORKFLOW_STEP_ID, 'a step id such as check') }),
  z.strictObject({ target: z.literal('row'), key: z.string().trim().min(1).max(200) }),
]);
export type UiHighlight = z.infer<typeof uiHighlightParamsSchema>;

/** The most row keys a page reports as shown, top of the list first (BC-8). */
export const UI_SHOWN_MAX = 50;

/**
 * Why a highlight does not fit the page the person sees, or null where it does: a section the open
 * record's page does not have, a step with no workflow open, a row the list is not showing. Read
 * from the snapshot core already holds, so the refusal is made before the browser is asked.
 */
export function highlightRefusal(h: UiHighlight, s: UiSnapshot): string | null {
  const no = (why: string) => `UI_ACTION_NOT_ON_PAGE: ui.highlight ${why}. Nothing was highlighted.`;
  if (h.target === 'section') {
    const kind = s.item?.kind;
    const sections: readonly string[] =
      kind && kind in UI_HIGHLIGHT_SECTIONS ? UI_HIGHLIGHT_SECTIONS[kind as keyof typeof UI_HIGHLIGHT_SECTIONS] : [];
    if (sections.includes(h.section)) return null;
    return no(
      kind
        ? `names section "${h.section}", which a ${kind} page does not have (it has ${sections.join(', ') || 'none'})`
        : `names section "${h.section}" and no record is open; open one with ui.open first`,
    );
  }
  if (h.target === 'step') {
    return s.item?.kind === 'workflow' ? null : no(`names step "${h.step}" and no workflow is open; open one with ui.open first`);
  }
  return s.shown?.includes(h.key) ? null : no(`names row ${h.key}, which the list beside the chat is not showing`);
}

/** The filter action of each Product list (BC-4), one per list in the shape `ui.issues.filter` has. */
const productFilter = (list: 'requirements' | 'feedback' | 'workflows' | 'releases', label: string) => ({
  wire: `ui_${list}_filter`,
  version: UI_ACTION_VERSION,
  params: uiListFilterParams(list),
  describe: `Open the ${label} list and set its filter. mode "merge" keeps the filter the person sees and changes only the named fields; mode "replace" drops every field it does not set. waitingOn is "you", "agent" or "running".`,
});

/** The actions REQ-41 adds, each registered into UI_ACTIONS by the ui-actions lane with its executor. */
export const UI_ACTION_ADDITIONS = {
  'ui.requirements.filter': productFilter('requirements', 'Requirements'),
  'ui.feedback.filter': productFilter('feedback', 'Feedback'),
  'ui.workflows.filter': productFilter('workflows', 'Workflows'),
  'ui.releases.filter': productFilter('releases', 'Releases'),
  'ui.open': {
    wire: 'ui_open',
    version: UI_ACTION_VERSION,
    params: uiOpenParamsSchema,
    describe:
      'Open one record in the page beside the chat: an issue (ISS-n), a requirement (REQ-n) or feedback (FB-n) by its key, a workflow by its flow with kind "workflow", a release by its version with kind "release".',
  },
  'ui.highlight': {
    wire: 'ui_highlight',
    version: UI_ACTION_VERSION,
    params: uiHighlightParamsSchema,
    describe:
      'Highlight one thing on the page beside the chat: a section of the open record (target "section"), a step of the open workflow (target "step", its step id), or a row the open list shows (target "row", its key). It scrolls to it and marks it; it changes nothing else.',
  },
} as const;

/** What the page beside the chat looks like, sent with each message — typed, never scraped. */
export const uiSnapshotSchema = z.strictObject({
  v: z.literal(UI_ACTION_VERSION),
  route: z.enum([
    ...ROUTE_NAMES,
    ...(Object.keys(UI_ROUTE_ADDITIONS) as UiRouteAddition[]),
    ...UI_PAGE_ITEM_KINDS,
    'other',
  ]),
  path: z.string().max(500),
  /** The record the page is about, which core loads for the turn; absent on a page about none. */
  item: uiPageItemSchema.optional(),
  filter: uiIssueFilterSchema.optional(),
  /** A Product list's filter as the person sees it (REQ-41 BC-8). */
  listFilter: uiListFilterSnapshotSchema.optional(),
  selection: z.array(issueKey).max(100).optional(),
  /** The keys of the rows the list shows, top first, so "the first one" means what the person sees (BC-8). */
  shown: z.array(z.string().trim().min(1).max(200)).max(UI_SHOWN_MAX).optional(),
  /** What the page has highlighted, by the chat or by the person's own anchor (BC-6). */
  highlight: uiHighlightParamsSchema.optional(),
  /** The board open in the dock, as the assistant last drew it (ISS-48). */
  board: wireframeDocSchema.optional(),
});
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;

/**
 * Snapshot keys an earlier web build sent and this contract no longer takes, each with what replaced
 * it. A tab loaded before the deploy still sends them; it is refused by name with a sentence its
 * own code prints as written, never a bare "Invalid input" (ISS-441).
 */
export const RETIRED_UI_SNAPSHOT_KEYS = {
  issueKey: 'item {kind: "issue", key}',
} as const;

/** What a person reads when their tab sent a retired snapshot key: the page is older than Forge. */
export function retiredSnapshotKeySentence(key: keyof typeof RETIRED_UI_SNAPSHOT_KEYS): string {
  return `This page was loaded before Forge was updated, so it describes itself in a shape Forge no longer reads (uiSnapshot.${key}, now ${RETIRED_UI_SNAPSHOT_KEYS[key]}). Reload the page, then send your message again.`;
}

/** The snapshot as the one line a person reads under the composer and the model reads above the message. */
export function describeUiSnapshot(s: UiSnapshot): string {
  const parts: string[] = [s.item ? s.item.key : s.route === 'other' ? s.path : s.route];
  const f = s.filter;
  if (f) {
    if (f.createdBy) parts.push('created by me');
    if (f.assignee) parts.push('assigned to me');
    if (f.priority) parts.push(`priority ${f.priority}`);
    if (f.status) parts.push(`status ${f.status.join('/')}`);
    if (f.text) parts.push(`"${f.text}"`);
  }
  if (s.listFilter) parts.push(...describeListFilter(s.listFilter.filter));
  if (s.selection && s.selection.length > 0) parts.push(`${s.selection.length} selected`);
  if (s.shown && s.shown.length > 0) parts.push(`showing ${s.shown.slice(0, 5).join(', ')}${s.shown.length > 5 ? ` and ${s.shown.length - 5} more` : ''}`);
  if (s.highlight) {
    const h = s.highlight;
    parts.push(`highlighting ${h.target === 'section' ? h.section : h.target === 'step' ? `step ${h.step}` : h.key}`);
  }
  if (s.board) parts.push(`board of ${s.board.shapes.length} shape${s.board.shapes.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
