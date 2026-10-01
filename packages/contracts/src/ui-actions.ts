// cm:why the chat assistant drives the page beside it through a CLOSED registry: the model names an
// action and core forwards it, the browser executes it as the signed-in person, and an action outside
// this file, or one whose params do not parse, is refused by name — never guessed, never half applied.
// Every action changes view state only (route, list filter, selection); none writes data.

import { z } from 'zod';
import { REGISTRY_ISSUE_PRIORITIES, REGISTRY_ISSUE_STATUSES } from './pipeline-registry.js';

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
} as const;

export type UiActionName = keyof typeof UI_ACTIONS;
export const UI_ACTION_NAMES = Object.keys(UI_ACTIONS) as UiActionName[];

export type UiAction =
  | { name: 'ui.navigate'; v: 1; params: z.infer<typeof navigateParams> }
  | { name: 'ui.issues.filter'; v: 1; params: z.infer<typeof filterParams> }
  | { name: 'ui.select'; v: 1; params: z.infer<typeof selectParams> }
  | { name: 'ui.open'; v: 1; params: z.infer<typeof openParams> };

export type UiActionRefusalCode = 'UI_ACTION_UNKNOWN' | 'UI_ACTION_INVALID';
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
  return parts.join(' · ');
}
