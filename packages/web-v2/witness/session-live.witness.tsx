// The session chat on a live turn (ISS-1268), at a laptop's 1440 px and a phone's 390 px: a stored
// turn whose `Agent` call holds its subagent's steps, then the live frames a running turn sends —
// a reply streaming as it is generated, a retry and the context it fills on the status line — then
// the turn's end and the next prompt it suggests as a chip under the composer. Each stage logs the
// words a person sees on the page (`page says words <stage> <n>`), the count `ui-copy-rule` asks for.
// It routes frames only through `lib/ws/event-router.ts:routeEvent`, so the same entry runs against
// a tree that predates the live channel and reads that tree's words for the same transcript.
//
//   pnpm --filter web-v2 witness witness/session-live.witness.tsx --out <dir>

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SessionScreen } from "@/features/session";
import { routeEvent } from "@/lib/ws/event-router";
import "./entry";
import { InRouter } from "./router";

const P = "7f1c1d1e-0000-4000-8000-000000001268";
const S = "5e551011-0000-4000-8000-000000001268";
const AT = "2026-11-17T05:05:45.000Z";

let status: "running" | "completed" = "running";
const session = () => ({
  id: S,
  projectId: P,
  userId: "u-1",
  deviceId: "d-1",
  pipelineRunId: null,
  title: "Why does sign-in fail on staging",
  repoPath: "/work/forge",
  status,
  kind: "chat",
  usage: null,
  metadata: null,
  failureReason: null,
  dispatchedAt: AT,
  startedAt: AT,
  lastHeartbeatAt: AT,
  createdAt: AT,
  updatedAt: AT,
});

const tool = (id: string, name: string, input: Record<string, unknown>, output?: string) => ({
  type: "tool",
  toolCall: { id, name, input, ...(output === undefined ? {} : { output }) },
});

const turns = [
  { role: "user", value: { type: "user", content: "Why does sign-in fail on staging? Check the logs and the auth config.", timestamp: Date.parse(AT) } },
  {
    role: "assistant",
    value: {
      type: "assistant",
      timestamp: Date.parse(AT),
      blocks: [
        { type: "text", text: "I'll split this: a subagent reads the staging logs while I read the auth config." },
        tool("t1", "TodoWrite", { todos: [{ content: "Read logs", status: "in_progress", activeForm: "Reading logs" }, { content: "Read auth config", status: "pending" }] }, "ok"),
        {
          type: "tool",
          toolCall: {
            id: "t2",
            name: "Agent",
            input: { description: "Read staging sign-in logs", subagent_type: "general-purpose" },
            output: "The callback URL is rejected: redirect_uri mismatch since 04:10.",
            subagent: [
              tool("s1", "Bash", { command: "journalctl -u forge-core --since 04:00 | grep auth" }, "04:10 redirect_uri mismatch"),
              { type: "text", text: "The callback URL is rejected: redirect_uri mismatch since 04:10." },
            ],
          },
        },
        tool("t3", "Read", { file_path: "packages/core/src/auth/oidc.ts" }, "export const CALLBACK = …"),
      ],
    },
  },
].map((t, i) => ({ id: `turn-${i}`, agentSessionId: S, turnIndex: i, role: t.role, content: { value: t.value }, editedAt: null, createdAt: AT }));

/** The reply once the transcript holds it: what streamed, as the stored line keeps it. */
const REPLY =
  "The staging client was registered with the old callback, so every sign-in is refused at the redirect. Re-register it with https://staging.forge.dev/api/auth/callback.";
const stored = { id: "turn-2", agentSessionId: S, turnIndex: 2, role: "assistant", content: { value: { type: "assistant", timestamp: Date.parse(AT), blocks: [{ type: "text", text: REPLY }] } }, editedAt: null, createdAt: AT };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes(`/agent-sessions/${S}/turns`)) return json({ turns: status === "completed" ? [...turns, stored] : turns, nextCursor: null });
  if (url.includes(`/agent-sessions/${S}`)) return json(session());
  if (url.endsWith("/projects") || url.includes("/projects?")) return json([{ id: P, slug: "forge", name: "Forge", role: "admin" }]);
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={qc}>
    <InRouter at={`/projects/forge/agents/${S}?view=developer`} pattern="/projects/$slug/agents/$id">
      <SessionScreen sessionId={S} projectSlug="forge" />
    </InRouter>
  </QueryClientProvider>,
);

const live = (items: unknown[]) =>
  routeEvent({ event: "agent-session.live", data: { sessionId: S, projectId: P, conversationId: null, items }, timestamp: AT } as never, qc);

const WORD = /[\p{L}\p{N}]+(?:['’.\-/:][\p{L}\p{N}]+)*/gu;
/** The words a person sees: the page's rendered text, inputs' placeholders and values left out. */
function wordsOn(stage: string): string[] {
  const n = (document.body.innerText.match(WORD) ?? []).length;
  console.log(`words ${stage} ${n}`);
  return [];
}

const settle = () => new Promise((r) => setTimeout(r, 300));
const click = (label: string) => {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  button?.click();
};

window.__witness = {
  cases: [
    { name: "desktop-1440", width: 1440, height: 900 },
    { name: "phone-390", width: 390, height: 844 },
  ],
  ready: () => document.querySelector('[data-testid="agent-turn"]') !== null,
  stages: [
    {
      name: "stored",
      run: async () => {
        click("Developer");
        await settle();
        click("2 steps");
        await settle();
        return wordsOn("stored");
      },
    },
    {
      name: "retrying",
      run: async () => {
        live([
          { kind: "context", used: null, window: 1_000_000 },
          { kind: "status", status: "requesting" },
          { kind: "retry", attempt: 2, maxRetries: 10, delayMs: 4000, errorStatus: 529 },
        ]);
        await settle();
        return wordsOn("retrying");
      },
    },
    {
      name: "streaming",
      run: async () => {
        live([
          { kind: "message", id: "msg_2", parent: null },
          { kind: "context", used: 412_000, window: null },
          { kind: "text", text: "The staging client was registered with the old callback, so every sign-in is refused at", parent: null },
        ]);
        await settle();
        return wordsOn("streaming");
      },
    },
    {
      name: "ended",
      run: async () => {
        live([
          { kind: "text", text: " the redirect. Re-register it with https://staging.forge.dev/api/auth/callback.", parent: null },
          { kind: "messageEnd", id: "msg_2", parent: null },
          { kind: "ended", reason: "completed" },
          { kind: "suggestion", text: "Re-register the staging callback and retry sign-in" },
        ]);
        status = "completed";
        routeEvent({ event: "agent-session.status", data: { sessionId: S, projectId: P, deviceId: "d-1", status: "completed" }, timestamp: AT } as never, qc);
        await new Promise((r) => setTimeout(r, 900));
        return wordsOn("ended");
      },
    },
  ],
};
