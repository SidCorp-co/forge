// REQ-41 BC-2 in chat: a turn that read `forge_needs_you` draws the decisions under its reply from
// the tool's own result, never from the model's words, and nothing from any other tool or a refused call.
//
// @direct-test-of packages/web-v2/src/features/conversations/api.ts
// @direct-test-of packages/web-v2/src/features/needs-you/index.ts

import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { decisionsIn, TurnDecisions } from "./turn-decisions";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

const Q = "8d2a3f5e-21c4-4b8e-9d62-6a4e3c1f0b77";
const READ = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-09T12:00:00.000Z",
  total: 1,
  decisions: [
    {
      group: "answer",
      area: "questions",
      entity: "question",
      key: Q,
      title: "Rotate the webhook secret now or at the next release?",
      opens: null,
      question: "Rotate the webhook secret now or at the next release?",
      recommended: { answerId: "later", why: 'Whoever asked recommends "At the next release".', by: "asker" },
      noRecommendation: null,
      answers: [
        { id: "later", label: "At the next release", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "later" }, needsReason: false, declines: false, effect: null, recommended: true },
        { id: "now", label: "Now", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "now" }, needsReason: false, declines: false, effect: null, recommended: false },
      ],
      touchedAt: null,
      stuck: false,
      dueAt: null,
      id: "d1",
      topic: "question",
      proposal: null,
    },
  ],
  notDecisions: [],
});

const block = (name: string, output: unknown, isError = false) => ({
  type: "tool" as const,
  toolCall: { id: "t1", name, input: {}, output: JSON.stringify(output), isError },
});

describe("the chat draws the decisions its turn read (REQ-41 BC-2)", () => {
  it("reads a forge_needs_you result, and nothing from another tool, a refused call or a stray shape", () => {
    expect(decisionsIn([block("forge_needs_you", READ)] as never)?.total).toBe(1);
    expect(decisionsIn([block("forge_project_status", READ)] as never)).toBeNull();
    expect(decisionsIn([block("forge_needs_you", READ, true)] as never)).toBeNull();
    expect(decisionsIn([block("forge_needs_you", { decisions: "not the read" })] as never)).toBeNull();
  });

  it("renders each decision with its recommended answer and buttons under the turn; a question on nothing opens no link", () => {
    renderWithQuery(<TurnDecisions blocks={[block("forge_needs_you", READ)] as never} slug="hop" />);
    expect(screen.getAllByTestId("needs-you-decision")).toHaveLength(1);
    expect(screen.getByTestId("needs-you-decision-recommended")).toHaveTextContent("Recommended: At the next release.");
    expect(screen.getAllByTestId("needs-you-decision-answer").map((b) => b.textContent)).toEqual(["At the next release", "Now"]);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

// REQ-41 BC-24 and BC-25 (dev, 2026-10-21 and 22, conversation a760cd5f): a card pressed under the
// reply showed "✓ Sent" and the chat stood still; and a decision the turn already made on the
// person's word must not be drawn again as a button that can only be refused.
const steward = (seq: number) => ({
  ...READ.decisions[0],
  id: `issue:ISS-${seq}:question.answer`,
  key: `ISS-${seq}`,
  entity: "issue",
  opens: { kind: "issue", key: `ISS-${seq}` },
});
const CLUSTER = needsYouDecisionsSchema.parse({ ...READ, total: 4, decisions: [603, 609, 612, 613].map(steward) });
const decided = {
  results: [
    { outcome: "already_done", decision: "ISS-603", state: { key: "ISS-603", status: "open", movedBy: "Darrel", movedAt: "2026-10-22T07:48:04.924Z" } },
    { outcome: "done", decision: "ISS-609", id: "issue:ISS-609:question.answer", answer: "Open it", state: { key: "ISS-609", status: "open", movedBy: "Darrel", movedAt: "2026-10-22T07:52:00.000Z" } },
    { outcome: "refused", decision: "ISS-612", code: "DECISION_REFUSED", detail: "QUESTION_ROUND_STALE", state: null },
  ],
  note: "Report each item exactly as read back here.",
};

describe("a decision made on the word is not drawn again, and a press is answered in the room (REQ-41 BC-24, BC-25)", () => {
  it("drops the decisions act_on_decisions made or found made, and keeps one it refused", () => {
    const left = decisionsIn([block("forge_needs_you", CLUSTER), block("act_on_decisions", decided)] as never);
    expect(left?.decisions.map((d) => d.key)).toEqual(["ISS-612", "ISS-613"]);
    expect(left?.total).toBe(2);
  });

  it("keeps every decision where the act was refused whole, or is not its result", () => {
    const refusedWhole = { ...block("act_on_decisions", { error: "CHAT_DECIDE_NO_WORD: ..." }), toolCall: { ...block("x", {}).toolCall, name: "act_on_decisions", output: JSON.stringify({ error: "CHAT_DECIDE_NO_WORD" }), isError: true } };
    expect(decisionsIn([block("forge_needs_you", CLUSTER), refusedWhole] as never)?.total).toBe(4);
    expect(decisionsIn([block("forge_needs_you", CLUSTER), block("act_on_decisions", { results: "x" })] as never)?.total).toBe(4);
  });

  it("asks core to answer a pressed card in the room, naming the decision and its item, and says so when it cannot", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
        if (url.endsWith("/answer")) return Promise.resolve(new Response(JSON.stringify({}), { headers: { "content-type": "application/json" } }));
        return Promise.resolve(new Response(JSON.stringify({ title: "conversation not found" }), { status: 404, headers: { "content-type": "application/problem+json" } }));
      }),
    );
    const { default: userEvent } = await import("@testing-library/user-event");
    renderWithQuery(
      <TurnDecisions blocks={[block("forge_needs_you", { ...CLUSTER, decisions: [steward(613)], total: 1 })] as never} slug="forge" conversationId="c0ffee00-0000-4000-8000-000000000001" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "At the next release" }));
    expect(await screen.findByTestId("decision-follow-up-failed")).toHaveTextContent("The chat could not say what this changed");
    const follow = calls.find((c) => c.url.includes("/decision-outcomes"));
    expect(follow?.url).toContain("/conversations/c0ffee00-0000-4000-8000-000000000001/decision-outcomes");
    expect(follow?.body).toEqual({ decision: "issue:ISS-613:question.answer", opens: { kind: "issue", key: "ISS-613" }, ok: true, refusal: null });
    vi.unstubAllGlobals();
  });

  it("sends the refusal a failed press got, so core says why it failed (judge K66, ISS-624 c2)", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
        if (url.endsWith("/answer")) {
          const envelope = {
            error: {
              code: "ISSUE_NOT_READY",
              message: "refused, nothing written",
              refusals: [{ code: "ISSUE_NOT_READY", path: "/status", detail: "ISS-613 has no plan:\nwrite one first" }],
            },
          };
          return Promise.resolve(new Response(JSON.stringify(envelope), { status: 422, headers: { "content-type": "application/json" } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ content: "x", state: null }), { headers: { "content-type": "application/json" } }));
      }),
    );
    const { default: userEvent } = await import("@testing-library/user-event");
    renderWithQuery(
      <TurnDecisions blocks={[block("forge_needs_you", { ...CLUSTER, decisions: [steward(613)], total: 1 })] as never} slug="forge" conversationId="c0ffee00-0000-4000-8000-000000000001" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "At the next release" }));
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes("/decision-outcomes"))).toBe(true));
    const follow = calls.find((c) => c.url.includes("/decision-outcomes"));
    expect(follow?.body).toEqual({
      decision: "issue:ISS-613:question.answer",
      opens: { kind: "issue", key: "ISS-613" },
      ok: false,
      refusal: { code: "ISSUE_NOT_READY", detail: "ISS-613 has no plan: write one first" },
    });
    vi.unstubAllGlobals();
  });
});
