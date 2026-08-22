// web-v2 feature module: session — the run-report derive.
//
// A pipeline session is not a conversation: nobody typed anything, and the
// question a reader arrives with is what the agent DID and why the step
// failed. These pure functions turn the flattened `ConversationItem[]` from
// types.ts into the five views the run report renders — activity groups, a
// transcript, the tape, the blocker, and the time breakdown. Kept out of
// types.ts so the chat surface pays nothing for them.
//
// Every number is read off the transcript. A field the derive cannot find is
// omitted, never defaulted to zero — a fabricated 0 reads as a measurement.

import type { SessionRow } from "@/features/sessions/types";
import type { ConversationItem, MessageEntry, RunTotals, ToolCallData, ToolKind } from "./types";
import { getToolLabel, toolKind } from "./types";

export type OutcomeTone = "ok" | "bad" | "muted";

export interface ToolOutcome {
  text: string;
  tone: OutcomeTone;
}

const MAX_OUTCOME = 110;

function outputText(tc: ToolCallData): string {
  const r = tc.result;
  if (typeof r === "string") return r;
  if (r == null) return "";
  try {
    return JSON.stringify(r);
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > MAX_OUTCOME ? `${line.slice(0, MAX_OUTCOME - 1)}…` : line.trim();
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** `mcp__forge__forge_issues` → `forge`; "" for a non-MCP tool. */
export function mcpServer(name: string): string {
  return /^mcp__([^_]+)__/.exec(name)?.[1] ?? "";
}

function editCounts(tc: ToolCallData): { added: number; removed: number } {
  const input = tc.input ?? {};
  const edits =
    (input.edits as { old_string?: string; new_string?: string }[] | undefined) ??
    [{ old_string: input.old_string as string, new_string: (input.new_string ?? input.content) as string }];
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    added += lineCount(e.new_string ?? "");
    removed += lineCount(e.old_string ?? "");
  }
  return { added, removed };
}

const PASSED = /(\d+)\s+passed/i;
const FAILED = /(\d+)\s+failed/i;

// cm:why the LAST line carrying a passed count wins, not the first: vitest prints "Test Files 1 failed | 212 passed" above "Tests 428 passed | 1 failed", and matching across the whole blob paired 212 with the failure count from the next line, reporting a suite size that was never run.
function testCounts(text: string): { passed: number; failed: number } | null {
  let best: { passed: number; failed: number } | null = null;
  for (const line of text.split("\n")) {
    const p = PASSED.exec(line);
    if (!p) continue;
    const f = FAILED.exec(line);
    best = { passed: Number(p[1]), failed: f ? Number(f[1]) : 0 };
  }
  return best;
}

function runOutcome(text: string): ToolOutcome {
  const counts = testCounts(text);
  if (counts) {
    const { passed, failed } = counts;
    return {
      text: failed > 0 ? `${passed} passed, ${failed} failed` : `${passed} passed`,
      tone: failed > 0 ? "bad" : "ok",
    };
  }
  const first = firstLine(text);
  return first ? { text: first, tone: "muted" } : { text: "no output", tone: "muted" };
}

/**
 * One line describing how a tool call ENDED, chosen per tool kind. The generic
 * fallback is the first non-empty output line, which is what a reader scanning
 * 400 rows can actually use — a JSON blob is not.
 */
export function toolOutcome(tc: ToolCallData): ToolOutcome {
  const text = outputText(tc);
  if (tc.isError) return { text: firstLine(text) || "error", tone: "bad" };
  switch (toolKind(tc.name)) {
    case "run":
      return runOutcome(text);
    case "read":
      return { text: plural(lineCount(text), "line"), tone: "muted" };
    case "search":
      return { text: plural(lineCount(text), "hit"), tone: "muted" };
    case "edit": {
      const { added, removed } = editCounts(tc);
      return { text: `+${added} −${removed}`, tone: "ok" };
    }
    default: {
      const first = firstLine(text);
      return first ? { text: first, tone: "muted" } : { text: "done", tone: "muted" };
    }
  }
}


export type ActivityKind = "errors" | "ran" | "edited" | "forge" | "explored";

export interface ActivityChild {
  id: string;
  label: string;
  outcome: ToolOutcome;
}

export interface ActivityGroup {
  kind: ActivityKind;
  headline: string;
  meta: string;
  children: ActivityChild[];
  /** Total members — `children` is capped, so this drives "+N more". */
  total: number;
}

/** Fixed reading order: what broke, what it ran, what it changed, what it told
 *  Forge, what it looked at. Errors lead because a failed run is the reason
 *  most readers opened the page. */
const GROUP_ORDER: ActivityKind[] = ["errors", "ran", "edited", "forge", "explored"];
const CHILD_CAP = 4;

function bucketOf(tc: ToolCallData): ActivityKind {
  if (tc.isError) return "errors";
  if (mcpServer(tc.name) === "forge") return "forge";
  const kind: ToolKind = toolKind(tc.name);
  if (kind === "run") return "ran";
  if (kind === "edit") return "edited";
  return "explored";
}

function allToolCalls(items: ConversationItem[]): ToolCallData[] {
  const out: ToolCallData[] = [];
  for (const item of items) {
    if (item.kind !== "agent") continue;
    for (const block of item.blocks) if (block.type === "tool") out.push(block.tool);
  }
  return out;
}

function groupMeta(kind: ActivityKind, calls: ToolCallData[]): string {
  if (kind === "edited") {
    const totals = calls.reduce(
      (acc, tc) => {
        const { added, removed } = editCounts(tc);
        return { added: acc.added + added, removed: acc.removed + removed };
      },
      { added: 0, removed: 0 },
    );
    return `+${totals.added} −${totals.removed}`;
  }
  if (kind === "explored") {
    const reads = calls.filter((tc) => toolKind(tc.name) === "read").length;
    const searches = calls.length - reads;
    return searches > 0 ? `${reads} read · ${searches} searched` : plural(reads, "read");
  }
  return "";
}

function headlineFor(kind: ActivityKind, n: number): string {
  switch (kind) {
    case "errors":
      return `${plural(n, "tool call")} returned an error`;
    case "ran":
      return `Ran ${plural(n, "command")}`;
    case "edited":
      return `Edited ${plural(n, "file")}`;
    case "forge":
      return `Forge · ${plural(n, "call")}`;
    default:
      return `Explored ${plural(n, "file")}`;
  }
}

/**
 * The Story lens: every tool call folded into at most five rows. This is the
 * only view that answers "what happened" without scrolling — the transcript
 * answers "what happened at 01:00:41", which is a different question.
 */
export function deriveActivityGroups(items: ConversationItem[]): ActivityGroup[] {
  const calls = allToolCalls(items);
  const byKind = new Map<ActivityKind, ToolCallData[]>();
  for (const tc of calls) {
    const kind = bucketOf(tc);
    byKind.set(kind, [...(byKind.get(kind) ?? []), tc]);
  }
  const groups: ActivityGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const members = byKind.get(kind);
    if (!members?.length) continue;
    groups.push({
      kind,
      headline: headlineFor(kind, members.length),
      meta: groupMeta(kind, members),
      total: members.length,
      children: members.slice(0, CHILD_CAP).map((tc) => ({
        id: tc.id,
        label: getToolLabel(tc),
        outcome: toolOutcome(tc),
      })),
    });
  }
  return groups;
}


export interface TranscriptRow {
  id: string;
  timestamp?: number;
  /** Display name: the bare tool, or `MCP <server>` for an MCP call. */
  tool: string;
  isMcp: boolean;
  /** The one argument that identifies the call (path, pattern, command). */
  arg: string;
  outcome: ToolOutcome;
  /** Full captured output — the expanded body. */
  body: string;
  isError: boolean;
}

function transcriptArg(tc: ToolCallData): string {
  const input = tc.input ?? {};
  const first =
    (input.file_path as string) ??
    (input.pattern as string) ??
    (input.command as string) ??
    (input.description as string) ??
    (input.skill as string) ??
    (input.action as string) ??
    "";
  return first.length > 90 ? `${first.slice(0, 89)}…` : first;
}

/** Every tool call in transcript order, one row each. */
export function deriveTranscriptRows(items: ConversationItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const item of items) {
    if (item.kind !== "agent") continue;
    for (const block of item.blocks) {
      if (block.type !== "tool") continue;
      const server = mcpServer(block.tool.name);
      rows.push({
        id: block.tool.id,
        timestamp: item.timestamp,
        tool: server ? `MCP ${server}` : block.tool.name,
        isMcp: !!server,
        arg: transcriptArg(block.tool),
        outcome: toolOutcome(block.tool),
        body: outputText(block.tool),
        isError: !!block.tool.isError,
      });
    }
  }
  return rows;
}


export type TapeTick = "prose" | "tool" | "edit" | "err" | "think";

/**
 * One tick per event, in order — the shape of the session at a glance: where
 * the errors cluster, whether it read for two minutes before writing anything.
 */
export function deriveTape(items: ConversationItem[]): TapeTick[] {
  const ticks: TapeTick[] = [];
  for (const item of items) {
    if (item.kind !== "agent") continue;
    for (let i = 0; i < item.thinkingCount; i++) ticks.push("think");
    for (const block of item.blocks) {
      if (block.type === "text") ticks.push("prose");
      else if (block.type === "tool") {
        ticks.push(
          block.tool.isError ? "err" : toolKind(block.tool.name) === "edit" ? "edit" : "tool",
        );
      }
    }
  }
  return ticks;
}


export interface RunBlocker {
  /** Human label of the call that failed, e.g. `Ran pnpm test`. */
  label: string;
  /** Its captured error output. */
  output: string;
  /** How many calls failed in total — the card names one, the count says more. */
  errorCount: number;
}

/**
 * The LAST failing tool call, not the first: an agent that recovers from an
 * early ENOENT and then fails a test suite was blocked by the test suite.
 */
export function deriveBlocker(items: ConversationItem[]): RunBlocker | null {
  const failures = allToolCalls(items).filter((tc) => tc.isError);
  const last = failures[failures.length - 1];
  if (!last) return null;
  return {
    label: getToolLabel(last),
    output: outputText(last),
    errorCount: failures.length,
  };
}


export interface TranscriptMeta {
  totals: RunTotals | null;
  /** Thinking pauses. A count, not text — every thinking block Claude Code
   *  emits carries an empty string, so there is nothing to expand. */
  thinkingPauses: number;
}

/**
 * Cost, turns, API time and permission denials come off the `result` entry the
 * core derive writes, so they are read from the raw transcript rather than the
 * flattened items (a result entry has no blocks and is dropped by `parseMessages`).
 */
export function readTranscriptMeta(
  messages: unknown[] | null | undefined,
  items: ConversationItem[],
): TranscriptMeta {
  // cm:edge contract -> packages/core/src/lib/agent-stream-parser.ts — `totals`, `thinkingCount` and `isError` exist on the entry only because that derive keeps them; it dropped all three until 2026-08-23, and every number on this page silently read "—" instead of being wrong, which is why nobody noticed.
  let totals: RunTotals | null = null;
  let thinkingPauses = 0;
  for (const raw of messages ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as MessageEntry;
    if (entry.totals) totals = entry.totals;
    thinkingPauses += entry.thinkingCount ?? 0;
  }
  if (!messages?.length) {
    thinkingPauses = items.reduce((n, item) => n + item.thinkingCount, 0);
  }
  return { totals, thinkingPauses };
}


export type TimeSpanKey = "queued" | "startup" | "agent";

export interface TimeSpan {
  key: TimeSpanKey;
  label: string;
  ms: number;
  /** Wall-clock start of this span, ISO. */
  at: string;
}

export interface TimeSpend {
  spans: TimeSpan[];
  totalMs: number;
  from: string;
  to: string;
}

function msBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Where the wall clock went, from the session row's own stamps. Queued is
 * `createdAt → dispatchedAt`, startup is `dispatchedAt → startedAt`, and the
 * rest is the agent. A span whose stamps are missing is dropped rather than
 * folded into its neighbour, so the bar can be shorter than the wall time and
 * still be true.
 */
export function deriveTimeSpend(session: SessionRow): TimeSpend | null {
  const from = session.createdAt;
  const to = session.updatedAt;
  const totalMs = msBetween(from, to);
  if (totalMs === null) return null;
  const candidates: { key: TimeSpanKey; label: string; from: string | null; to: string | null }[] = [
    { key: "queued", label: "queued", from, to: session.dispatchedAt },
    { key: "startup", label: "startup", from: session.dispatchedAt, to: session.startedAt },
    { key: "agent", label: "agent", from: session.startedAt, to },
  ];
  const spans: TimeSpan[] = [];
  for (const c of candidates) {
    const ms = msBetween(c.from, c.to);
    if (ms === null || ms === 0 || !c.from) continue;
    spans.push({ key: c.key, label: c.label, ms, at: c.from });
  }
  return { spans, totalMs, from, to };
}
