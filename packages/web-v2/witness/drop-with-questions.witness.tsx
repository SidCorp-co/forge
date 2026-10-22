// Dropping an issue that holds open questions (ISS-560, FB-130), witnessed at desktop and phone width
// over a stubbed core that refuses a drop meeting an open question unless the move voids it, as core
// does. From the issue's status menu: the drop dialog lists both questions, one is answered there,
// and one Drop voids the other with the reason typed. In chat: the assistant's drop card lists the
// issue's question and one press voids it with the person's reason. No stage may show core's field
// name `voidQuestions`, and nothing may scroll sideways.
//
//   pnpm --filter web-v2 witness witness/drop-with-questions.witness.tsx --out <dir> [--clip]

import { issueMovesFrom } from "@forge/contracts/issue-machine";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useActOffers } from "@/features/conversations/act-offers";
import type { ConversationMessage } from "@/features/conversations/types";
import { IssueQuickActions } from "@/features/issues/components/issue-quick-actions";
import type { AgentQuestion } from "@/features/questions";
import "./entry";
import { InRouter } from "./router";

const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const PAGE_ISSUE = "8c3a0f3e-5b1e-4f7a-9d55-2f0a8e6b1c49";
const CHAT_ISSUE = "a37ef0fd-13e6-4a48-9b6b-76127dc386fc";
const AT = new Date(Date.now() - 3 * 3_600_000).toISOString();
const REASON = "superseded by ISS-561, which carries the same fix";
const CHAT_REASON = "the export moved to the reports page";
const ANSWER = "the columns as clinics file them today";

const ask = (id: string, issueId: string, prompt: string): AgentQuestion => ({
  id,
  projectId: PROJECT,
  issueId,
  status: "open",
  blockerKind: "human",
  steps: [{ round: 1, prompt, askedAt: AT, answerShape: "free_text", needed: "an answer" }],
  round: 1,
  prompt,
  askedAt: AT,
  maxRounds: 3,
  voidReason: null,
  endedReason: null,
  parkDeadlineAt: null,
  createdAt: AT,
  updatedAt: AT,
  answerShape: "free_text",
  options: [],
  recommendedOptionId: "",
  needed: "an answer",
  locked: false,
});

const KEEP = "Which export columns ship first?";
const MOOT = "How should ISS-41 close: keep, drop or open?";
const CHAT_MOOT = "How should ISS-744 close: keep, drop or open?";
const open: Record<string, AgentQuestion[]> = {
  [PAGE_ISSUE]: [ask("q1", PAGE_ISSUE, KEEP), ask("q2", PAGE_ISSUE, MOOT)],
  [CHAT_ISSUE]: [ask("q3", CHAT_ISSUE, CHAT_MOOT)],
};
const status: Record<string, string> = { [PAGE_ISSUE]: "in_progress", [CHAT_ISSUE]: "in_progress" };

/** Every move and answer the page sent, in order, as its path and JSON body. */
const sent: { path: string; body: Record<string, unknown> }[] = [];
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

function refusedForOpenQuestions(issueId: string, to: string) {
  const ids = (open[issueId] ?? []).map((q) => q.id);
  const code = "OPEN_QUESTIONS";
  const detail = `this issue holds ${ids.length} open question(s) (${ids.join(", ")}), and \`${to}\` would leave them asking a person for a decision nothing can act on. Answer them first, or send this move again with \`voidQuestions: "<why they died with the work>"\`, which voids each one with that reason in the same write.`;
  const message = `refused, nothing written: ${code} at /: ${detail}`;
  return json({ type: `urn:forge:refusal:${code}`, title: "Open questions", status: 422, detail, code, message, error: { code, message, refusals: [{ to, openQuestionIds: ids, code, path: "", detail }] } }, 422);
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://forge.test");
  const path = url.pathname.replace(/^\/api/, "");
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  if (method === "GET" && path === "/questions") return json({ questions: open[url.searchParams.get("issueId") ?? ""] ?? [] });
  const answer = /^\/questions\/(q\d)\/answer$/.exec(path);
  if (method === "POST" && answer) {
    sent.push({ path, body });
    for (const id of Object.keys(open)) open[id] = (open[id] ?? []).filter((q) => q.id !== answer[1]);
    return json({ ...ask(answer[1] ?? "", "", ""), status: "answered" });
  }
  const move = /^\/issues\/([^/]+)\/transition$/.exec(path);
  if (method === "POST" && move) {
    const id = move[1] ?? "";
    sent.push({ path, body });
    const voids = typeof body.voidQuestions === "string" && body.voidQuestions.trim() !== "";
    if ((open[id] ?? []).length > 0 && !voids) return refusedForOpenQuestions(id, String(body.toStatus));
    open[id] = [];
    status[id] = String(body.toStatus);
    return json({ id, status: body.toStatus });
  }
  const issue = /^\/issues\/([^/]+)$/.exec(path);
  if (method === "GET" && issue) {
    const id = issue[1] ?? "";
    return json({ id, projectId: PROJECT, status: status[id], displayId: "ISS-744", title: "Old export" });
  }
  return new Promise<Response>(() => {});
};

const offer = { v: 1, act: "drop", effect: "transition", projectId: PROJECT, issueId: CHAT_ISSUE, key: "ISS-744", title: "Old export", from: "in_progress", to: "dropped", reason: CHAT_REASON };
const MESSAGE = {
  id: "m1",
  blocks: [{ type: "tool", toolCall: { id: "call-1", name: "offer_act", output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ offer }) }] }) } }],
} as unknown as ConversationMessage;

function ChatCard() {
  const { offersFor } = useActOffers({ messages: [MESSAGE], progress: null });
  return <div data-witness="chat">{offersFor("m1")}</div>;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root") as HTMLElement).render(
  <InRouter at="/projects/hop/issues/ISS-41">
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl space-y-8 p-4">
        <div data-witness="page">
          <IssueQuickActions issueId={PAGE_ISSUE} status="in_progress" moves={issueMovesFrom("in_progress", null, false)} priority="medium" />
        </div>
        <ChatCard />
      </div>
    </QueryClientProvider>
  </InRouter>,
);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const all = <T extends HTMLElement = HTMLElement>(sel: string, from: ParentNode = document) => [...from.querySelectorAll<T>(sel)];
const text = () => document.body.textContent ?? "";
const until = async (ok: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 50 && !ok(); i += 1) await pause(50);
  return ok();
};
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const buttonIn = (root: ParentNode | null, name: string) =>
  root ? (all<HTMLButtonElement>("button", root).find((b) => b.textContent?.trim() === name) ?? null) : null;

/** The textarea a label names, inside `root`. */
function field(root: ParentNode | null, label: string): HTMLTextAreaElement | null {
  if (!root) return null;
  const named = all<HTMLLabelElement>("label", root).find((l) => l.textContent?.trim().startsWith(label));
  if (!named) return null;
  return (named.htmlFor ? (document.getElementById(named.htmlFor) as HTMLTextAreaElement | null) : null) ?? named.parentElement?.querySelector("textarea") ?? null;
}
function type(box: HTMLTextAreaElement | null, value: string) {
  if (!box) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

/** What every stage owes: no field name, no sideways scroll. */
function always(): string[] {
  const wrong: string[] = [];
  if (/voidQuestions/.test(text())) wrong.push("the page shows core's field name voidQuestions");
  const width = window.innerWidth;
  if (document.documentElement.scrollWidth > width) wrong.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} px in ${width}`);
  return wrong;
}
const lastMove = (issueId: string) => [...sent].reverse().find((s) => s.path === `/issues/${issueId}/transition`)?.body;

window.__witness = {
  cases: [
    { name: "desktop", width: 1440 },
    { name: "phone", width: 390 },
  ],
  ready: () => all("[data-witness=page] button").length > 0 && all("[data-witness=chat] button").some((b) => b.textContent?.trim() === "Confirm"),
  stages: [
    {
      name: "1-drop-lists-questions",
      run: async () => {
        all<HTMLButtonElement>("[data-witness=page] button").find((b) => b.getAttribute("aria-label")?.startsWith("Change status"))?.click();
        await until(() => all("[role=menuitem]").length > 0);
        all<HTMLElement>("[role=menuitem]").find((m) => /^Drop/.test(m.textContent?.trim() ?? ""))?.click();
        const listed = await until(() => (dialog()?.textContent ?? "").includes(MOOT) && (dialog()?.textContent ?? "").includes(KEEP));
        const wrong = always();
        if (!listed) wrong.push("the drop dialog does not list the issue's two open questions");
        if (!(dialog()?.textContent ?? "").includes("Withdrawn with this move (2)")) wrong.push("the dialog does not say both questions end with the drop");
        return wrong;
      },
    },
    {
      name: "2-answers-one-in-place",
      run: async () => {
        const card = all("[data-testid=moot-questions] > *", dialog() ?? document).find((c) => c.textContent?.includes(KEEP)) ?? null;
        type(field(card, "Your answer"), ANSWER);
        await pause(100);
        buttonIn(card, "Send answer")?.click();
        const gone = await until(() => !(dialog()?.textContent ?? "").includes(KEEP));
        const wrong = always();
        if (!gone) wrong.push("the answered question is still listed in the drop dialog");
        if (!sent.some((s) => s.path === "/questions/q1/answer" && s.body.text === ANSWER)) wrong.push("the answer was not sent from the drop dialog");
        if (!(dialog()?.textContent ?? "").includes(MOOT)) wrong.push("the question left unanswered is no longer listed");
        return wrong;
      },
    },
    {
      name: "3-one-drop-voids-the-rest",
      run: async () => {
        type(field(dialog(), "Reason"), REASON);
        await pause(100);
        buttonIn(dialog(), "Drop")?.click();
        const closed = await until(() => dialog() === null);
        const wrong = always();
        const move = lastMove(PAGE_ISSUE);
        const moves = sent.filter((s) => s.path === `/issues/${PAGE_ISSUE}/transition`).length;
        if (!closed) wrong.push("the drop dialog is still open after Drop");
        if (moves !== 1) wrong.push(`the drop took ${moves} moves, not one`);
        if (move?.toStatus !== "dropped" || move.reason !== REASON || move.voidQuestions !== REASON)
          wrong.push(`the drop sent ${JSON.stringify(move)}, not the reason given as both the drop's and the void's`);
        return wrong;
      },
    },
    {
      name: "4-chat-card-lists-question",
      run: async () => {
        document.querySelector("[data-witness=chat]")?.scrollIntoView({ block: "start" });
        const listed = await until(() => (document.querySelector("[data-witness=chat]")?.textContent ?? "").includes(CHAT_MOOT));
        const wrong = always();
        if (!listed) wrong.push("the chat drop card does not list the issue's open question");
        return wrong;
      },
    },
    {
      name: "5-chat-press-voids-it",
      run: async () => {
        buttonIn(document.querySelector("[data-witness=chat]"), "Confirm")?.click();
        const done = await until(() => (document.querySelector("[data-witness=chat]")?.textContent ?? "").includes("Done."));
        const wrong = always();
        const move = lastMove(CHAT_ISSUE);
        if (!done) wrong.push("the chat drop card did not finish");
        if (move?.toStatus !== "dropped" || move.reason !== CHAT_REASON || move.voidQuestions !== CHAT_REASON)
          wrong.push(`the chat drop sent ${JSON.stringify(move)}, not the person's reason as both the drop's and the void's`);
        return wrong;
      },
    },
  ],
};
