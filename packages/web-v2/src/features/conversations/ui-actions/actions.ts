// The browser's half of the UI-action registry (ISS-47): what the page beside the chat looks like as a
// typed snapshot, and how one parsed action is applied to it. Every action changes the URL or the list
// selection, never data, and a call that cannot be applied whole is refused by name before anything moves.

import { enumLabel, statusReading } from "@/design/vocabulary";
import {
  parseUiAction,
  UI_ACTION_VERSION,
  UI_ROUTES,
  type UiAction,
  type UiIssueFilter,
  type UiIssueFilterField,
  type UiRoute,
  type UiSnapshot,
  uiActionNamed,
} from "@forge/contracts/ui-actions";
import { ISSUE_STATUSES } from "@forge/contracts/issue-machine";
import { REGISTRY_ISSUE_PRIORITIES } from "@forge/contracts/pipeline-registry";
import { applyWireframePatch, describeWireframe } from "@forge/contracts/wireframe";
import { boardStore } from "../board/board-store";
import { assistantFilters } from "./assistant-filters";
import type { IssueSelectionBridge } from "./selection-bridge";

/** The URL params each filter field lives in on the Issues list. */
const FIELD_PARAM: Record<UiIssueFilterField, string> = {
  status: "status",
  priority: "priority",
  createdBy: "createdBy",
  assignee: "assignee",
  text: "q",
};

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
  const q = sp.get("q")?.trim();
  if (q) out.text = q;
  return out;
}

export function uiSnapshotOf(args: {
  pathname: string;
  search: string;
  userId: string | null;
  selection: string[];
  board?: { open: boolean; doc: UiSnapshot["board"] | null };
}): UiSnapshot {
  const b = args.board;
  const base = {
    v: UI_ACTION_VERSION,
    path: args.pathname.slice(0, 500),
    ...(b?.open && b.doc ? { board: b.doc } : {}),
  };
  const at = projectPath(args.pathname);
  if (!at) return { ...base, route: "other" };
  const issue = /^\/issues\/([A-Z][A-Z0-9]*-\d+)$/.exec(at.rest);
  if (issue) return { ...base, route: "issue", issueKey: issue[1] as string };
  const route = ROUTE_BY_SUFFIX.find(([, suffix]) => suffix === at.rest)?.[0];
  if (!route) return { ...base, route: "other" };
  if (route !== "issues") return { ...base, route };
  const filter = filterFromSearch(args.search, args.userId);
  return {
    ...base,
    route,
    ...(Object.keys(filter).length ? { filter } : {}),
    ...(args.selection.length ? { selection: args.selection.slice(0, 100) } : {}),
  };
}

export interface UiActionEnv {
  slug: string;
  userId: string | null;
  /** The page as it stands: pathname + search. */
  href: () => string;
  go: (href: string) => void;
  selection: () => IssueSelectionBridge | null;
}

export interface UiFilterChip {
  field: UiIssueFilterField;
  label: string;
}

export type UiActionOutcome =
  | { ok: true; summary: string; undo: () => void; chips: UiFilterChip[] }
  | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): UiActionOutcome => ({ ok: false, code, message });

function chipLabel(field: UiIssueFilterField, f: UiIssueFilter): string {
  if (field === "createdBy") return "Created by me";
  if (field === "assignee") return "Assigned to me";
  if (field === "priority") return `Priority: ${enumLabel("priority", f.priority ?? "")}`;
  if (field === "status") return `Status: ${(f.status ?? []).map((s) => statusReading("issue", s).label).join(", ")}`;
  return `Search: "${f.text}"`;
}

function issuesPath(slug: string): string {
  return `/projects/${slug}${UI_ROUTES.issues}`;
}

/** The href that clears one field the assistant set, from the page as it now stands. */
export function hrefWithout(href: string, field: UiIssueFilterField): string {
  const url = new URL(href, "http://x");
  url.searchParams.delete(FIELD_PARAM[field]);
  url.searchParams.delete("page");
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

type ParamsOf<N extends UiAction["name"]> = Extract<UiAction, { name: N }>["params"];

function applyFilter(params: ParamsOf<"ui.issues.filter">, env: UiActionEnv, before: string, back: () => void): UiActionOutcome {
  const { mode, set, clear } = params;
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
  if (mode === "replace") for (const p of Object.values(FIELD_PARAM)) next.delete(p);
  for (const f of clear) next.delete(FIELD_PARAM[f]);
  if (set.status) next.set("status", set.status.join(","));
  if (set.priority) next.set("priority", set.priority);
  if (set.createdBy) next.set("createdBy", env.userId as string);
  if (set.assignee) next.set("assignee", env.userId as string);
  if (set.text) next.set("q", set.text);
  const qs = next.toString();
  env.go(`${issuesPath(env.slug)}${qs ? `?${qs}` : ""}`);
  const marked: Record<string, string> = {};
  for (const f of Object.keys(set) as UiIssueFilterField[]) {
    const v = next.get(FIELD_PARAM[f]);
    if (set[f] !== undefined && v) marked[FIELD_PARAM[f]] = v;
  }
  assistantFilters.mark(marked, mode === "replace");
  const fields = (Object.keys(set) as UiIssueFilterField[]).filter((f) => set[f] !== undefined);
  const verb = mode === "replace" ? "Filtered issues" : "Narrowed issues";
  const what = fields.map((f) => chipLabel(f, set)).join(", ");
  return {
    ok: true,
    summary: `${verb}${what ? `: ${what}` : ""}${clear.length ? ` (cleared ${clear.join(", ")})` : ""}`,
    undo: back,
    chips: fields.map((field) => ({ field, label: chipLabel(field, set) })),
  };
}

function reviseBoard(params: ParamsOf<"ui.board.revise">): UiActionOutcome {
  const prior = boardStore.get();
  if (!prior.open || !prior.doc)
    return refuse(
      "UI_ACTION_UNAVAILABLE",
      "UI_ACTION_UNAVAILABLE: ui.board.revise needs a board open in the chat panel, and none is. Draw one with ui.board.draw. Nothing was changed.",
    );
  const was = prior.doc;
  const next = applyWireframePatch(was, params.ops);
  if (!next.ok) return refuse(next.code, next.message);
  boardStore.load(next.doc);
  const n = params.ops.length;
  return {
    ok: true,
    summary: `Revised the board (${n} edit${n === 1 ? "" : "s"}: ${params.ops.map((o) => `${o.op} ${o.op === "add" ? o.shape.id : o.id}`).join(", ")})`,
    undo: () => boardStore.load(was),
    chips: [],
  };
}

function selectIssues(params: ParamsOf<"ui.select">, env: UiActionEnv): UiActionOutcome {
  const bridge = env.selection();
  if (!bridge)
    return refuse(
      "UI_ACTION_UNAVAILABLE",
      "UI_ACTION_UNAVAILABLE: ui.select needs the Issues list open beside the chat in its Table view (the grouped views select nothing), and it is not. Nothing was selected.",
    );
  const rows = bridge.rows();
  const byKey = new Map(rows.map((r) => [r.displayId, r.id]));
  const missing = params.keys.filter((k: string) => !byKey.has(k));
  if (missing.length)
    return refuse(
      "UI_ACTION_INVALID",
      `UI_ACTION_INVALID: ui.select names ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not on the page of the Issues list the person sees. Nothing was selected.`,
    );
  const prior = new Set(rows.filter((r) => bridge.selectedKeys().includes(r.displayId)).map((r) => r.id));
  bridge.setSelectedIds(new Set(params.keys.map((k: string) => byKey.get(k) as string)));
  return {
    ok: true,
    summary: params.keys.length ? `Selected ${params.keys.join(", ")}` : "Cleared the selection",
    undo: () => env.selection()?.setSelectedIds(prior),
    chips: [],
  };
}

export function applyUiAction(action: UiAction, env: UiActionEnv): UiActionOutcome {
  const before = env.href();
  const back = () => env.go(before);
  switch (action.name) {
    case "ui.navigate": {
      env.go(`/projects/${env.slug}${UI_ROUTES[action.params.route]}`);
      return { ok: true, summary: `Opened ${action.params.route}`, undo: back, chips: [] };
    }
    case "ui.open": {
      env.go(`/projects/${env.slug}/issues/${action.params.key}`);
      return { ok: true, summary: `Opened ${action.params.key}`, undo: back, chips: [] };
    }
    case "ui.issues.filter":
      return applyFilter(action.params, env, before, back);
    case "ui.board.draw": {
      const prior = boardStore.get();
      boardStore.load(action.params.doc);
      return {
        ok: true,
        summary: `Drew ${describeWireframe(action.params.doc)}`,
        undo: () => (prior.open && prior.doc ? boardStore.load(prior.doc) : boardStore.close()),
        chips: [],
      };
    }
    case "ui.board.revise":
      return reviseBoard(action.params);
    case "ui.select":
      return selectIssues(action.params, env);
  }
  const unknown: never = action;
  return refuse("UI_ACTION_UNKNOWN", `UI_ACTION_UNKNOWN: ${JSON.stringify(unknown)} is not a UI action. Nothing was changed.`);
}

/** One ui_* tool call as the thread stores it, read back into an action or the refusal it carried. */
export type UiCallReading =
  | { kind: "action"; action: UiAction }
  | { kind: "refused"; name: string; code: string; message: string };

function textOf(output: unknown): string {
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
