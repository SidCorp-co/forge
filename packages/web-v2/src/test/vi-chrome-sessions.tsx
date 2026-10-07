import type { QueryKey } from "@tanstack/react-query";
import { fireEvent } from "@testing-library/react";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { SessionScreen } from "@/features/session/components/session-screen";
import type { SessionRow } from "@/features/sessions/types";
import { Seeded } from "./vi-chrome-requirements";

// The Sessions list and a session's page for the vi walking test: every status and kind a row can
// show, a chat with a transcript of every tool, and a pipeline session's run report with its
// blocker. Titles and transcript prose are placeholder words (what an agent wrote stays as written).

const P = "p-sessions";
const AT = "2026-10-07T08:00:00.000Z";
const LATER = "2026-10-07T08:30:00.000Z";

const row = (id: string, over: Partial<SessionRow> = {}): SessionRow =>
  ({
    id,
    projectId: P,
    userId: "u1",
    deviceId: "d1",
    pipelineRunId: null,
    title: `Phien ${id}`,
    repoPath: "/srv/hop",
    status: "completed",
    kind: "pipeline",
    parentSessionId: null,
    usage: { turns: 12, contextUsed: 1200, inputTotal: 12_000, outputTotal: 3400, cacheRead: 800, cacheWrite: 400 },
    metadata: { type: "pipeline", issueId: "i1", step: "code" },
    failureReason: null,
    dispatchedAt: AT,
    startedAt: AT,
    lastHeartbeatAt: AT,
    createdAt: AT,
    updatedAt: LATER,
    estimatedCost: 1.25,
    lastMessagePreview: "Xin chao",
    ...over,
  }) as SessionRow;

const ROWS = [
  row("s1", { status: "running" }),
  row("s2", { status: "queued", startedAt: null, usage: null, estimatedCost: 0 }),
  row("s3", { status: "failed", failureReason: "agent_exited_without_result" }),
  row("s4", { status: "failed", failureReason: "provider_usage_limit" }),
  row("s5", { status: "failed", failureReason: "something_unknown" }),
  row("s6", { status: "cancelled_stale", failureReason: "pipeline_cancelled" }),
  row("s7", { status: "cancelled", failureReason: "user_cancelled", kind: "run_session", metadata: { type: "run_session" } }),
  row("s8", { status: "completed_via_recovery" }),
  row("s9", { status: "idle", kind: "chat", metadata: { type: "interactive" }, title: null }),
  row("s10", { status: "running", kind: "master", metadata: { type: "master" }, deviceId: null }),
  row("s11", { status: "running", kind: "chat", metadata: { type: "interactive" }, parentSessionId: "s10" }),
  row("s12", { status: "running", pipelineRunId: "run-1", metadata: { type: "pipeline", issueId: "i1" } }),
];

const turn = (n: number, role: "user" | "assistant", entry: Record<string, unknown>) => ({ id: `t${n}`, agentSessionId: "s-detail", turnIndex: n, role, content: { value: entry }, editedAt: null, createdAt: AT });
const tool = (id: string, name: string, input: Record<string, unknown>, output = "xong", isError = false) => ({ type: "tool", toolCall: { id, name, input, output, isError, durationMs: 1200 } });

const TURNS = [
  turn(1, "user", { content: "Hay sua loi dang nhap", timestamp: Date.parse(AT) }),
  turn(2, "assistant", {
    timestamp: Date.parse(AT),
    thinkingCount: 2,
    blocks: [
      { type: "text", text: "Toi se doc tep truoc." },
      tool("c1", "Read", { file_path: "src/dang-nhap.ts" }, "noi dung tep"),
      tool("c2", "Edit", { file_path: "src/dang-nhap.ts", old_string: "a", new_string: "b" }, "da sua"),
      tool("c3", "Write", { file_path: "src/moi.ts", content: "x" }),
      tool("c4", "Bash", { command: "pnpm test" }, "that bai: 1 loi", true),
      tool("c5", "Grep", { pattern: "dang_nhap", path: "src" }),
      tool("c6", "Glob", { pattern: "**/*.ts" }),
      tool("c7", "Task", { description: "Tim loi", subagent_type: "explore" }),
      tool("c8", "Skill", { skill: "issue-flow" }),
      tool("c9", "mcp__forge__forge_issues", { action: "get" }),
      { type: "todos", todos: [{ content: "Viec mot", status: "completed" }, { content: "Viec hai", status: "in_progress", activeForm: "Dang lam viec hai" }, { content: "Viec ba", status: "pending" }] },
      { type: "thinking", durationMs: 2000 },
      { type: "text", text: "Da xong phan mot." },
    ],
  }),
  turn(3, "user", { content: "Cam on", timestamp: Date.parse(LATER) }),
];

const TOTALS = { type: "result", totals: { totalCostUsd: 1.25, durationMs: 125_000, durationApiMs: 90_000, numTurns: 12, permissionDenials: 1, stopReason: "end_turn", isError: false }, thinkingCount: 1 };

const detail = (over: Partial<SessionRow>) => row("s-detail", { messages: [TOTALS], totalMessages: 4, ...over });

const data = (): [QueryKey, unknown][] => [
  [["agent-sessions", "list", { projectId: P, page: 1 }], { items: ROWS, totalCount: 120 }],
  [["agent-sessions", "list", { projectId: P, issueId: "i1", page: 1 }], { items: ROWS.slice(0, 3), totalCount: 3 }],
  [["agent-sessions", "queue-stats", P], { devices: [{ deviceId: "d1", queued: 2, running: 1 }, { deviceId: null, queued: 1, running: 0 }] }],
  [["project", P], { id: P, slug: "hop", name: "Hop", devicePool: [{ id: "d1", name: "may-1", platform: "linux", status: "online", lastSeenAt: AT, runnerId: "r1" }, { id: "d2", name: "may-2", platform: "linux", status: "offline", lastSeenAt: AT, runnerId: "r2" }] }],
  [["runs-standing", P, "list", "live"], { generatedAt: AT, projectId: P, scope: "live", scopeRule: "r", items: [{ id: "run-1", sessionId: "s12", state: "stuck" }], total: 1, limit: 200, offset: 0, hasMore: false, counts: { live: 1, finished: 0, liveByState: { queued: 0, claimed: 0, running: 0, waiting_person: 0, waiting_gate: 0, stuck: 1 }, needsViewer: 0, held: 0 }, excluded: [], master: null }],
  [["issue", "i1", P], { id: "i1", displayId: "ISS-1", title: "Viec mot", status: "in_progress" }],
  [["issue", "i1"], { id: "i1", displayId: "ISS-1", title: "Viec mot", status: "in_progress" }],
  // a chat, and a pipeline run's session with its run
  [["agent-session", "s-chat"], detail({ id: "s-chat", kind: "chat", metadata: { type: "interactive" }, status: "idle", messages: [] })],
  [["agent-session", "s-chat", "turns", 40], { turns: TURNS, nextCursor: null }],
  [["agent-session", "s-run"], detail({ id: "s-run", pipelineRunId: "run-1", status: "failed", failureReason: "agent_exited_without_result", metadata: { type: "pipeline", issueId: "i1", step: "code" } })],
  [["agent-session", "s-run", "turns", 40], { turns: TURNS, nextCursor: null }],
  [["agent-session", "s-run", "cost"], { sessionId: "s-run", projectId: P, estimatedCost: 1.25, inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 800, cacheCreationTokens: 400, requests: 12, sampleCount: 12, models: [{ model: "mo-hinh", requests: 12 }] }],
  [["agent-sessions", "s-run", "cost"], { sessionId: "s-run", projectId: P, estimatedCost: 1.25, inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 800, cacheCreationTokens: 400, requests: 12, sampleCount: 12, models: [{ model: "mo-hinh", requests: 12 }] }],
  [["agent-session", "s-box"], detail({ id: "s-box", kind: "run_session", pipelineRunId: "run-1", status: "running", failureReason: null, metadata: { type: "run_session", issueId: "i1" } })],
  [["agent-session", "s-box", "turns", 40], { turns: TURNS.slice(0, 2), nextCursor: "more" }],
  [["agent-session", "s-fail"], detail({ id: "s-fail", kind: "chat", metadata: { type: "interactive" }, status: "failed", failureReason: "provider_overloaded", messages: [] })],
  [["agent-session", "s-fail", "turns", 40], { turns: [], nextCursor: null }],
  [["pipeline-run", "run-1"], {
    id: "run-1",
    projectId: P,
    issueId: "i1",
    issueRef: "ISS-1",
    issueTitle: "Viec mot",
    issueStatus: "in_progress",
    kind: "issue",
    status: "failed",
    currentStep: "code",
    startedAt: AT,
    finishedAt: LATER,
    steps: [
      { jobType: "plan", status: "completed", startedAt: AT, finishedAt: AT, durationMs: 61_000, agentSessionId: "s1" },
      { jobType: "code", status: "failed", startedAt: AT, finishedAt: LATER, durationMs: 1_800_000, agentSessionId: "s-run" },
      { jobType: "test", status: "cancelled", startedAt: null, finishedAt: null, durationMs: null, agentSessionId: null },
    ],
    cost: { estimatedCost: 1.25, inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 800, cacheCreationTokens: 400, requests: 12, sampleCount: 12 },
    liveJobs: 0,
    lastSessionBeatAt: AT,
    attempts: [],
    retrySummary: null,
    gateAtOpen: { read: "ok", condition: { verdict: "failing_open", count: 12, perDay: 4, windowMs: 3 * 86_400_000, byReason: [{ reason: "core-unreachable", count: 9 }, { reason: "timeout", count: 3 }] } },
  }],
  [["devices", "me", null], [{ id: "d1", name: "may-1", platform: "linux", status: "online", lastSeenAt: AT, agentVersion: "0.4.0", agentOutdated: false, disabledAt: null }]],
  [["sessions", "list", { projectId: P, issueId: "i1", page: 1 }], { items: ROWS.slice(0, 2), totalCount: 2 }],
];

const wrap = (children: React.ReactNode) => <Seeded data={data()}>{children}</Seeded>;
const stuck = new Set(["s12", "run-1"]);
const clickNth = (selector: string, n: number) => () => {
  const hit = document.querySelectorAll(selector)[n];
  if (!hit) throw new Error(`nothing to click at ${selector}`);
  fireEvent.click(hit);
};
const clickAll = (selector: string) => () => {
  for (const el of document.querySelectorAll(selector)) fireEvent.click(el);
};

export const SESSIONS_SCREENS = [
  { name: "Sessions · list", render: () => wrap(<SessionsScreen projectId={P} issueFilter={null} stuck={stuck} />) },
  { name: "Sessions · one issue", render: () => wrap(<SessionsScreen projectId={P} issueFilter={{ issueId: "i1", clearHref: "/x" }} stuck={stuck} />) },
  { name: "Sessions · row menu", render: () => wrap(<SessionsScreen projectId={P} issueFilter={null} stuck={stuck} />), act: clickAll("button[aria-haspopup]") },
  { name: "Sessions · empty", render: () => wrap(<SessionsScreen projectId="p-empty" issueFilter={null} stuck={stuck} />) },
  { name: "Session · chat", render: () => wrap(<SessionScreen sessionId="s-chat" projectSlug="hop" />) },
  { name: "Session · chat failed and empty", render: () => wrap(<SessionScreen sessionId="s-fail" projectSlug="hop" />) },
  { name: "Session · run report", render: () => wrap(<SessionScreen sessionId="s-run" projectSlug="hop" />) },
  { name: "Session · run report diff", render: () => wrap(<SessionScreen sessionId="s-run" projectSlug="hop" />), act: clickNth('[role="tab"]', 1) },
  { name: "Session · run report transcript", render: () => wrap(<SessionScreen sessionId="s-run" projectSlug="hop" />), act: clickNth('[role="tab"]', 2) },
  { name: "Session · box run with later turns", render: () => wrap(<SessionScreen sessionId="s-box" projectSlug="hop" />) },
  { name: "Session · missing", render: () => wrap(<SessionScreen sessionId="s-none" projectSlug="hop" />) },
];
