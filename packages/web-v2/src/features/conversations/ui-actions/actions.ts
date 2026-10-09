// The browser's half of the UI-action registry (ISS-47, REQ-41): what the page beside the chat looks like
// as a typed snapshot, and how one parsed action is applied to it. Every action changes the URL, the
// list selection, the highlight or the board, never data (BC-9), and a call that cannot be applied
// whole is refused by name before anything moves.

import { enumLabel, statusReading } from "@/design/vocabulary";
import { highlightOnPage, highlightStore } from "@/design/hooks/use-highlight";
import {
  highlightTargetOf,
  parseUiAction,
  UI_ACTION_VERSION,
  UI_PRODUCT_LISTS,
  UI_ROUTES,
  type UiAction,
  type UiHighlight,
  type UiIssueFilter,
  type UiListFilterAction,
  type UiOpenTarget,
  type UiPageItem,
  type UiProductList,
  type UiRoute,
  type UiSnapshot,
  uiActionNamed,
  uiPageItemSchema,
} from "@forge/contracts/ui-actions";
import {
  describeListFilter,
  listFilterFromSearch,
  UI_FILTER_PARAMS,
  type UiFilterField,
  type UiListFilterSnapshot,
} from "@forge/contracts/ui-list-filters";
import { ISSUE_STATUSES } from "@forge/contracts/issue-machine";
import { REGISTRY_ISSUE_PRIORITIES } from "@forge/contracts/pipeline-registry";
import { applyWireframePatch, type WireframeDoc } from "@forge/contracts/wireframe";
import { boardStore } from "@/features/board/board-store";
import { assistantFilters } from "@/features/chat-dock/assistant-filters";
import type { IssueSelectionBridge } from "@/features/chat-dock/selection-bridge";
import type { Copy, ProductCopyKey } from "@/lib/i18n/product-copy";
import { feedbackHref } from "@/lib/routes/feedback";
import { issueHref } from "@/lib/routes/issues";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import { findHighlighted, selectorsOf, tabOf } from "./highlight-anchors";

/** The board as the one line the person reads: its title and what it holds. */
export function describeBoard(doc: WireframeDoc, t: Copy): string {
  const counts = new Map<string, number>();
  for (const s of doc.shapes) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
  const what = [...counts].map(([type, n]) => `${n} ${type}`).join(", ");
  return t("conversations.board.describe", { title: doc.title ? `"${doc.title}" ` : "", what: what || t("conversations.board.empty") });
}

/** "3 shapes" in the reader's language. */
export const shapesText = (n: number, t: Copy): string => t(n === 1 ? "conversations.shapes.one" : "conversations.shapes.many", { n });

/** A route's name as the reader says it. */
export const routeWord = (route: string, t: Copy): string => (route in UI_ROUTES ? t(`conversations.route.${route}` as ProductCopyKey) : route);

const ROUTE_BY_SUFFIX = Object.entries(UI_ROUTES) as [UiRoute, string][];

function projectPath(pathname: string): { slug: string; rest: string } | null {
  const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
  return m ? { slug: m[1] as string, rest: (m[2] ?? "").replace(/\/$/, "") } : null;
}

/** The Issues filter a URL holds, in the registry's closed fields; "me" only where the id is the reader's. */
export function filterFromSearch(search: string, userId: string | null): UiIssueFilter {
  const sp = new URLSearchParams(search);
  const out: UiIssueFilter = {};
  const statuses = (sp.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is (typeof ISSUE_STATUSES)[number] =>
      (ISSUE_STATUSES as readonly string[]).includes(s),
    );
  if (statuses.length) out.status = statuses;
  const priority = sp.get("priority");
  if (priority && (REGISTRY_ISSUE_PRIORITIES as readonly string[]).includes(priority))
    out.priority = priority as UiIssueFilter["priority"];
  if (userId && sp.get("createdBy") === userId) out.createdBy = "me";
  if (userId && sp.get("assignee") === userId) out.assignee = "me";
  const waiting = listFilterFromSearch("issues", sp).waitingOn;
  if (waiting) out.waitingOn = waiting;
  const q = sp.get("q")?.trim();
  if (q) out.text = q;
  return out;
}

const isProductList = (route: string): route is UiProductList => (UI_PRODUCT_LISTS as readonly string[]).includes(route);

/** A Product list's filter as its URL holds it, for the snapshot; absent where nothing narrows it. */
export function listFilterOf(list: UiProductList, search: string): UiListFilterSnapshot | undefined {
  const filter = listFilterFromSearch(list, search);
  return Object.keys(filter).length ? ({ list, filter } as UiListFilterSnapshot) : undefined;
}

// each record page's list segment under /projects/<slug>, and the kind of record it shows
const ITEM_SEGMENT: Record<string, UiPageItem["kind"]> = {
  issues: "issue",
  requirements: "requirement",
  feedback: "feedback",
  workflows: "workflow",
};

/** The record a project path is the page of (`/requirements/REQ-30`), or null: a key its kind does not take names none. */
export function pageItemOf(rest: string): UiPageItem | null {
  const m = /^\/([a-z]+)\/([^/]+)$/.exec(rest);
  const kind = m ? ITEM_SEGMENT[m[1] as string] : undefined;
  if (!m || !kind) return null;
  let key: string;
  try {
    key = decodeURIComponent(m[2] as string);
  } catch {
    return null;
  }
  const parsed = uiPageItemSchema.safeParse({ kind, key });
  return parsed.success ? parsed.data : null;
}

export function uiSnapshotOf(args: {
  pathname: string;
  search: string;
  userId: string | null;
  selection: string[];
  board?: { open: boolean; doc: UiSnapshot["board"] | null };
  /** The rows the list on the page reports, top first (BC-8). */
  shown?: readonly string[] | null;
  /** What the page has marked, once it is on screen (BC-6). */
  highlight?: UiHighlight | null;
}): UiSnapshot {
  const b = args.board;
  const base = {
    v: UI_ACTION_VERSION,
    path: args.pathname.slice(0, 500),
    ...(b?.open && b.doc ? { board: b.doc } : {}),
    ...(args.highlight ? { highlight: args.highlight } : {}),
  };
  const at = projectPath(args.pathname);
  if (!at) return { ...base, route: "other" };
  const item = pageItemOf(at.rest);
  if (item) return { ...base, route: item.kind, item };
  const route = ROUTE_BY_SUFFIX.find(([, suffix]) => suffix === at.rest)?.[0];
  if (!route) return { ...base, route: "other" };
  const shown = args.shown?.length ? { shown: [...args.shown] } : {};
  if (isProductList(route)) {
    const listFilter = listFilterOf(route, args.search);
    return { ...base, route, ...shown, ...(listFilter ? { listFilter } : {}) };
  }
  if (route !== "issues") return { ...base, route };
  const filter = filterFromSearch(args.search, args.userId);
  return {
    ...base,
    route,
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(args.selection.length ? { selection: args.selection.slice(0, 100) } : {}),
    ...shown,
  };
}

export interface UiActionEnv {
  t: Copy;
  language: string;
  slug: string;
  userId: string | null;
  /** The page as it stands: pathname + search. */
  href: () => string;
  go: (href: string) => void;
  selection: () => IssueSelectionBridge | null;
  /** The first element on the page the selectors name, or null. */
  find: (selectors: readonly string[]) => Element | null;
  /** Marks the highlight on the page at `path`, once its element is there. */
  mark: (h: UiHighlight, path: string, selectors: readonly string[]) => void;
  unmark: () => void;
}

/** The page's own half of `find`, `mark` and `unmark`: the DOM and the highlight store. */
export const pageHighlighter = {
  find: (selectors: readonly string[]) => findHighlighted(selectors),
  mark: (h: UiHighlight, path: string, selectors: readonly string[]) => highlightOnPage(h, path, () => findHighlighted(selectors)),
  unmark: () => highlightStore.clear(),
};

export interface UiFilterChip {
  field: UiFilterField;
  label: string;
}

export type UiActionOutcome =
  | { ok: true; summary: string; undo: () => void; chips: UiFilterChip[] }
  | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): UiActionOutcome => ({ ok: false, code, message });

function chipLabel(field: UiFilterField, f: Record<string, unknown>, env: Pick<UiActionEnv, "t" | "language">): string {
  const { t, language } = env;
  if (field === "createdBy") return t("conversations.ui.chipCreatedBy");
  if (field === "assignee") return t("conversations.ui.chipAssignee");
  if (field === "priority") return t("conversations.ui.chipPriority", { value: enumLabel("priority", String(f.priority ?? ""), language) });
  if (field === "status") return t("conversations.ui.chipStatus", { value: ((f.status as string[] | undefined) ?? []).map((s) => statusReading("issue", s, language).label).join(", ") });
  if (field === "text") return t("conversations.ui.chipSearch", { text: String(f.text ?? "") });
  const [words] = describeListFilter({ [field]: f[field] });
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
}

function issuesPath(slug: string): string {
  return `/projects/${slug}${UI_ROUTES.issues}`;
}

/** The href that clears one field the assistant set, from the page as it now stands. */
export function hrefWithout(href: string, field: UiFilterField): string {
  const url = new URL(href, "http://x");
  url.searchParams.delete(UI_FILTER_PARAMS[field]);
  url.searchParams.delete("page");
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

const ISSUE_FIELDS: readonly UiFilterField[] = ["status", "priority", "createdBy", "assignee", "waitingOn", "text"];

/** Records each param an action set as the assistant's, so its chip reads orange until the person changes it (BC-7). */
function markSet(set: Record<string, unknown>, next: URLSearchParams, mode: "merge" | "replace") {
  const marked: Record<string, string> = {};
  for (const f of Object.keys(set) as UiFilterField[]) {
    const v = next.get(UI_FILTER_PARAMS[f]);
    if (set[f] !== undefined && v) marked[UI_FILTER_PARAMS[f]] = v;
  }
  assistantFilters.mark(marked, mode === "replace");
}

/** The page a record is opened on, by its kind. */
export function recordHref(slug: string, target: UiOpenTarget): string {
  switch (target.kind) {
    case "issue":
      return issueHref(slug, target.key);
    case "requirement":
      return requirementHref(slug, target.key);
    case "feedback":
      return feedbackHref(slug, target.key);
    case "workflow":
      return workflowHref(slug, target.key);
    case "release":
      return releaseHref(slug, target.key);
  }
}

/** A Product list's filter (BC-4): opens the list and writes each field to its one URL param. */
function applyListFilter(action: UiListFilterAction, env: UiActionEnv): UiActionOutcome {
  const list = action.name.split(".")[1] as UiProductList;
  const { mode, clear } = action.params;
  const set = action.params.set as Record<string, unknown>;
  const path = `/projects/${env.slug}${UI_ROUTES[list]}`;
  const url = new URL(env.href(), "http://x");
  const next = new URLSearchParams(url.pathname === path ? url.searchParams : undefined);
  next.delete("page");
  next.delete("peek");
  const fields = Object.keys(set).filter((f) => set[f] !== undefined) as UiFilterField[];
  if (mode === "replace") for (const p of Object.values(UI_FILTER_PARAMS)) next.delete(p);
  for (const f of clear as UiFilterField[]) next.delete(UI_FILTER_PARAMS[f]);
  for (const f of fields) {
    const v = set[f];
    next.set(UI_FILTER_PARAMS[f], Array.isArray(v) ? v.join(",") : String(v));
  }
  const qs = next.toString();
  const before = env.href();
  env.go(`${path}${qs ? `?${qs}` : ""}`);
  markSet(set, next, mode);
  const verb = env.t(mode === "replace" ? "conversations.ui.filtered" : "conversations.ui.narrowed");
  const what = fields.map((f) => chipLabel(f, set, env)).join(", ");
  return {
    ok: true,
    summary: `${env.t("conversations.ui.openedRoute", { route: routeWord(list, env.t) })} · ${verb}${what ? `: ${what}` : ""}${clear.length ? ` (${env.t("conversations.ui.cleared", { fields: (clear as UiFilterField[]).map((f) => env.t(`conversations.ui.field.${f}` as ProductCopyKey)).join(", ") })})` : ""}`,
    undo: () => env.go(before),
    chips: fields.map((field) => ({ field, label: chipLabel(field, set, env) })),
  };
}

/**
 * Marks a section, a step or a row on the page as it stands (BC-6). A section the record's page shows
 * under another tab switches to that tab first; one the page does not draw at all is refused
 * UI_ACTION_NOT_ON_PAGE, the code core gives a highlight its snapshot already rules out.
 */
function applyHighlight(h: UiHighlight, env: UiActionEnv): UiActionOutcome {
  const before = env.href();
  const url = new URL(before, "http://x");
  const at = projectPath(url.pathname);
  const item = at ? pageItemOf(at.rest) : null;
  const what = highlightTargetOf(h);
  const no = (why: string) => refuse("UI_ACTION_NOT_ON_PAGE", `UI_ACTION_NOT_ON_PAGE: ui.highlight ${why}. Nothing was highlighted.`);
  if (h.target === "step" && item?.kind !== "workflow") return no(`names step "${what}" and no workflow is open beside the chat`);
  if (h.target === "section" && !item) return no(`names section "${what}" and no record is open beside the chat`);
  const selectors = selectorsOf(h, item?.kind ?? null);
  if (selectors.length === 0) return no(`names section "${what}", which ${item?.kind === "issue" ? "an" : "a"} ${item?.kind} page does not draw`);
  const onPage = env.find(selectors);
  const tab = tabOf(h, item?.kind ?? null);
  if (!onPage) {
    if (tab === null || url.searchParams.get("tab") === tab)
      return no(h.target === "row" ? `names row ${what}, which the list beside the chat is not showing` : `names ${h.target} "${what}", which this page is not showing`);
    url.searchParams.set("tab", tab);
    env.go(`${url.pathname}?${url.searchParams.toString()}`);
  }
  env.mark(h, url.pathname, selectors);
  return {
    ok: true,
    summary: env.t("conversations.ui.highlighted", { what: h.target === "step" ? `${env.t("conversations.ui.step")} ${what}` : what }),
    undo: () => {
      env.unmark();
      if (env.href() !== before) env.go(before);
    },
    chips: [],
  };
}

export function applyUiAction(action: UiAction, env: UiActionEnv): UiActionOutcome {
  const before = env.href();
  const back = () => env.go(before);
  switch (action.name) {
    case "ui.navigate": {
      env.go(`/projects/${env.slug}${UI_ROUTES[action.params.route]}`);
      return { ok: true, summary: env.t("conversations.ui.openedRoute", { route: routeWord(action.params.route, env.t) }), undo: back, chips: [] };
    }
    case "ui.open": {
      env.go(recordHref(env.slug, action.params));
      return { ok: true, summary: env.t("conversations.ui.openedKey", { key: action.params.key }), undo: back, chips: [] };
    }
    case "ui.requirements.filter":
    case "ui.feedback.filter":
    case "ui.workflows.filter":
    case "ui.releases.filter":
      return applyListFilter(action, env);
    case "ui.highlight":
      return applyHighlight(action.params, env);
    case "ui.issues.filter": {
      const { mode, set, clear } = action.params;
      const wantsMe = set.createdBy === "me" || set.assignee === "me";
      if (wantsMe && !env.userId)
        return refuse(
          "UI_ACTION_UNAVAILABLE",
          "UI_ACTION_UNAVAILABLE: ui.issues.filter names \"me\", and this page has no signed-in person to resolve it to. Nothing was changed.",
        );
      const url = new URL(before, "http://x");
      const onIssues = url.pathname === issuesPath(env.slug);
      const next = new URLSearchParams(onIssues ? url.searchParams : undefined);
      next.delete("page");
      if (mode === "replace") for (const f of ISSUE_FIELDS) next.delete(UI_FILTER_PARAMS[f]);
      for (const f of clear) next.delete(UI_FILTER_PARAMS[f]);
      if (set.status) next.set("status", set.status.join(","));
      if (set.priority) next.set("priority", set.priority);
      if (set.createdBy) next.set("createdBy", env.userId as string);
      if (set.assignee) next.set("assignee", env.userId as string);
      if (set.waitingOn) {
        next.set(UI_FILTER_PARAMS.waitingOn, set.waitingOn);
        // whom an issue waits on is read by the grouped views (the standing read); the paged Table has none
        if (next.get("group") === "table") next.delete("group");
      }
      if (set.text) next.set("q", set.text);
      const qs = next.toString();
      env.go(`${issuesPath(env.slug)}${qs ? `?${qs}` : ""}`);
      markSet(set as Record<string, unknown>, next, mode);
      const fields = (Object.keys(set) as UiFilterField[]).filter((f) => (set as Record<string, unknown>)[f] !== undefined);
      const verb = env.t(mode === "replace" ? "conversations.ui.filtered" : "conversations.ui.narrowed");
      const what = fields.map((f) => chipLabel(f, set as Record<string, unknown>, env)).join(", ");
      return {
        ok: true,
        summary: `${verb}${what ? `: ${what}` : ""}${clear.length ? ` (${env.t("conversations.ui.cleared", { fields: clear.map((f) => env.t(`conversations.ui.field.${f}` as ProductCopyKey)).join(", ") })})` : ""}`,
        undo: back,
        chips: fields.map((field) => ({ field, label: chipLabel(field, set as Record<string, unknown>, env) })),
      };
    }
    case "ui.board.draw": {
      const prior = boardStore.get();
      boardStore.load(action.params.doc);
      return {
        ok: true,
        summary: env.t("conversations.ui.drew", { board: describeBoard(action.params.doc, env.t) }),
        undo: () => (prior.open && prior.doc ? boardStore.load(prior.doc) : boardStore.close()),
        chips: [],
      };
    }
    case "ui.board.revise": {
      const prior = boardStore.get();
      if (!prior.open || !prior.doc)
        return refuse(
          "UI_ACTION_UNAVAILABLE",
          "UI_ACTION_UNAVAILABLE: ui.board.revise needs a board open in the chat panel, and none is. Draw one with ui.board.draw. Nothing was changed.",
        );
      const was = prior.doc;
      const next = applyWireframePatch(was, action.params.ops);
      if (!next.ok) return refuse(next.code, next.message);
      boardStore.load(next.doc);
      const n = action.params.ops.length;
      return {
        ok: true,
        summary: env.t(n === 1 ? "conversations.ui.revisedOne" : "conversations.ui.revisedMany", {
          n,
          ops: action.params.ops.map((o) => `${o.op} ${o.op === "add" ? o.shape.id : o.id}`).join(", "),
        }),
        undo: () => boardStore.load(was),
        chips: [],
      };
    }
    case "ui.select": {
      const bridge = env.selection();
      if (!bridge)
        return refuse(
          "UI_ACTION_UNAVAILABLE",
          "UI_ACTION_UNAVAILABLE: ui.select needs the Issues list open beside the chat in its Table view (the grouped views select nothing), and it is not. Nothing was selected.",
        );
      const rows = bridge.rows();
      const byKey = new Map(rows.map((r) => [r.displayId, r.id]));
      const missing = action.params.keys.filter((k: string) => !byKey.has(k));
      if (missing.length)
        return refuse(
          "UI_ACTION_INVALID",
          `UI_ACTION_INVALID: ui.select names ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not on the page of the Issues list the person sees. Nothing was selected.`,
        );
      const prior = new Set(rows.filter((r) => bridge.selectedKeys().includes(r.displayId)).map((r) => r.id));
      bridge.setSelectedIds(new Set(action.params.keys.map((k: string) => byKey.get(k) as string)));
      return {
        ok: true,
        summary: action.params.keys.length ? env.t("conversations.ui.selected", { keys: action.params.keys.join(", ") }) : env.t("conversations.ui.clearedSelection"),
        undo: () => env.selection()?.setSelectedIds(prior),
        chips: [],
      };
    }
  }
  const unknown: never = action;
  return refuse("UI_ACTION_UNKNOWN", `UI_ACTION_UNKNOWN: ${JSON.stringify(unknown)} is not a UI action. Nothing was changed.`);
}

/** One ui_* tool call as the thread stores it, read back into an action or the refusal it carried. */
export type UiCallReading =
  | { kind: "action"; action: UiAction }
  | { kind: "refused"; name: string; code: string; message: string };

export function textOf(output: unknown): string {
  if (typeof output !== "string") return JSON.stringify(output ?? "");
  try {
    const parsed: unknown = JSON.parse(output);
    const content = (parsed as { content?: { type: string; text?: string }[] } | null)?.content;
    if (Array.isArray(content)) return content.map((b) => b.text ?? "").join("\n");
  } catch {
    // a plain text result, read as is
  }
  return output;
}

/** Null where the call is not a UI action at all, or its result has not arrived yet. */
export function readUiCall(call: {
  name: string;
  output?: string;
  isError?: boolean;
}): UiCallReading | null {
  if (!call.name.startsWith("ui_") && !call.name.startsWith("ui.")) return null;
  if (call.output === undefined) return null;
  const text = textOf(call.output);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { error: text };
  }
  if (call.isError || typeof body.error === "string") {
    const message = typeof body.error === "string" ? body.error : text;
    const code = /^(UI_ACTION_[A-Z_]+)/.exec(message)?.[1] ?? "UI_ACTION_REFUSED";
    return { kind: "refused", name: uiActionNamed(call.name) ?? call.name, code, message };
  }
  const forwarded = body.action as { name?: unknown; params?: unknown } | undefined;
  const parsed = parseUiAction(typeof forwarded?.name === "string" ? forwarded.name : call.name, forwarded?.params);
  if (!parsed.ok) return { kind: "refused", name: parsed.name, code: parsed.code, message: parsed.message };
  return { kind: "action", action: parsed.action };
}
