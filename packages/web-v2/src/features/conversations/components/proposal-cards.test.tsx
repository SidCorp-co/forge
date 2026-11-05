// A chat's write waits for the person it answers (REQ-30 BC-4, ISS-439): the room shows what would
// be recorded and what it relates to, only that person can Record it or Decline, and the press is
// the one core call that writes it. Everyone else reads whom it waits on.
//
// ISS-1006: the person decides from the agent's one plain line; the held call's raw fields sit behind
// one closed "Technical" fold, the card folds to its line, and a card whose agent wrote no line says
// so. Planted red by drawing `summary.lines` outside the fold, and by drawing nothing where `plain` is
// null.
//
// @direct-test-of packages/web-v2/src/features/conversations/components/proposal-cards.tsx

import type { ChatProposalView } from "@forge/contracts/chat-proposals";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ProposalCards } from "./proposal-cards";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROOM = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";

/** Open the card's one technical fold, where the held call's own fields are. */
const openTechnical = () => fireEvent.click(within(screen.getByTestId("proposal-technical")).getByRole("button", { name: "Technical" }));

const proposal = (over: Partial<ChatProposalView> = {}): ChatProposalView => ({
  id: ID,
  conversationId: ROOM,
  kind: "feedback",
  status: "pending",
  summary: {
    title: "Feedback (bug): The dock loses my draft",
    lines: ["Switching tabs clears it."],
    relates: ["REQ-30"],
    plain: "Your draft stays when you switch tabs. I recommend recording it.",
  },
  proposedTo: { userId: "44444444-4444-4444-8444-444444444444", label: "Lan" },
  canDecide: true,
  agreedVia: null,
  agreedWords: null,
  record: null,
  failure: null,
  createdAt: "2026-10-08T03:46:00Z",
  decidedAt: null,
  ...over,
});

describe("a held write waits in the room for its person", () => {
  it("shows what it would record and what it relates to, and Record it writes it once", async () => {
    let listed = [proposal()];
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === `/conversations/${ROOM}/proposals`) return { body: { proposals: listed } };
      if (c.method === "POST" && c.path === `/conversations/${ROOM}/proposals/${ID}/agree`) {
        listed = [proposal({ status: "recorded", canDecide: false, record: { ref: "FB-7", href: null } })];
        return { body: { proposal: listed[0] } };
      }
      if (c.method === "GET" && c.path === `/conversations/${ROOM}`) return { body: {} };
      return undefined;
    });
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={2} />);

    expect(await screen.findByText("Your draft stays when you switch tabs. I recommend recording it.")).toBeTruthy();
    openTechnical();
    expect(screen.getByText("Feedback (bug): The dock loses my draft")).toBeTruthy();
    expect(screen.getByText("Switching tabs clears it.")).toBeTruthy();
    expect(screen.getByText("Relates to REQ-30")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record it" }));

    await waitFor(() => expect(screen.queryByTestId("proposal-cards")).toBeNull());
    const writes = calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.path)).toEqual([`/conversations/${ROOM}/proposals/${ID}/agree`]);
    expect(writes[0]?.body).toEqual({});
  });

  it("shows the whole proposal, every line of it, before Record it", async () => {
    const lines = [
      "Why: People lose drafts.",
      ...Array.from({ length: 14 }, (_, i) => `${i + 1}. Criterion number ${i + 1} holds.`),
      "spec: {\"openQuestions\":[\"Who sees the card?\"]}",
    ];
    fakeCore((c) => {
      if (c.method === "GET" && c.path === `/conversations/${ROOM}/proposals`) {
        return {
          body: {
            proposals: [proposal({ kind: "requirement_draft", summary: { title: "New requirement: Keep drafts", lines, relates: [], plain: null } })],
          },
        };
      }
      return undefined;
    });
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={1} />);

    await screen.findByTestId("proposal-card");
    openTechnical();
    expect(screen.getByText("New requirement: Keep drafts")).toBeTruthy();
    for (const line of lines) expect(screen.getByText(line)).toBeTruthy();
    // the title, then every line
    expect(screen.getByTestId("proposal-lines").children).toHaveLength(lines.length + 1);
  });

  it("declines without writing, through the decline route alone", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === `/conversations/${ROOM}/proposals`) return { body: { proposals: [proposal()] } };
      if (c.path === `/conversations/${ROOM}/proposals/${ID}/decline`) {
        return { body: { proposal: proposal({ status: "declined", canDecide: false }) } };
      }
      if (c.method === "GET") return { body: {} };
      return undefined;
    });
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        `/conversations/${ROOM}/proposals/${ID}/decline`,
      ]),
    );
    expect(calls.some((c) => c.path.endsWith("/agree"))).toBe(false);
  });

  it("offers no decision to anyone else in the room, and names whom it waits on", async () => {
    fakeCore((c) =>
      c.method === "GET" && c.path === `/conversations/${ROOM}/proposals`
        ? { body: { proposals: [proposal({ canDecide: false })] } }
        : undefined,
    );
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={2} />);
    expect(await screen.findByText("Waiting on Lan to agree.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record it" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("shows nothing once nothing waits", async () => {
    const calls = fakeCore((c) =>
      c.method === "GET" && c.path === `/conversations/${ROOM}/proposals`
        ? { body: { proposals: [proposal({ status: "declined", canDecide: false })] } }
        : undefined,
    );
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={2} />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId("proposal-cards")).toBeNull();
  });

  it("reads core's refusal where the press is refused", async () => {
    fakeCore((c) => {
      if (c.method === "GET" && c.path === `/conversations/${ROOM}/proposals`) return { body: { proposals: [proposal()] } };
      if (c.method === "POST") {
        return {
          status: 409,
          body: {
            code: "CHAT_PROPOSAL_SETTLED",
            message: "refused, nothing written: CHAT_PROPOSAL_SETTLED: this proposal is recorded already",
            error: { code: "CHAT_PROPOSAL_SETTLED", message: "this proposal is recorded already" },
          },
        };
      }
      return { body: {} };
    });
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record it" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/recorded already/);
  });
});

describe("the person decides from the agent's plain line (ISS-1006)", () => {
  const listing = (p: ChatProposalView) =>
    fakeCore((c) => (c.method === "GET" && c.path === `/conversations/${ROOM}/proposals` ? { body: { proposals: [p] } } : undefined));
  const RAW = {
    title: "Revision of REQ-68",
    lines: ["baseRevision: 1", 'spec: {"goal":"Problem: people re-review"}', "kind: screen", "tldr: Approvals lead", "changeSummary: Make it readable", "writtenLang: en"],
    relates: ["REQ-68"],
  };

  it("shows the plain line and the two buttons; the raw fields stay behind the closed fold", async () => {
    listing(proposal({ kind: "requirement_revision", summary: { ...RAW, plain: "Approvals open on one plain line per decision. I recommend recording this revision." } }));
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={1} />);
    const card = await screen.findByTestId("proposal-card");
    expect(within(card).getByTestId("proposal-plain").textContent).toBe("Approvals open on one plain line per decision. I recommend recording this revision.");
    for (const raw of [RAW.title, ...RAW.lines, "Relates to REQ-68"]) expect(within(card).queryByText(raw)).toBeNull();
    expect(card.textContent).not.toMatch(/REQ-68|baseRevision|writtenLang/);
    expect(within(card).getByRole("button", { name: "Record it" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Decline" })).toBeTruthy();
    openTechnical();
    expect(within(card).getByText("baseRevision: 1")).toBeTruthy();
  });

  it("says plainly that the agent wrote no line, and is still decided from its buttons", async () => {
    listing(proposal({ summary: { ...RAW, plain: null } }));
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={1} />);
    expect((await screen.findByTestId("proposal-no-plain")).textContent).toBe("No summary");
    expect(screen.getByRole("button", { name: "Record it" })).toBeTruthy();
  });

  it("folds to its one line and unfolds again, the buttons kept", async () => {
    listing(proposal());
    renderWithQuery(<ProposalCards conversationId={ROOM} threadLength={1} />);
    const fold = await screen.findByRole("button", { name: "Fold the card" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    expect(screen.getByTestId("proposal-card").getAttribute("data-folded")).toBe("true");
    expect(screen.queryByTestId("proposal-technical")).toBeNull();
    expect(screen.getByRole("button", { name: "Record it" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unfold the card" }));
    expect(screen.getByTestId("proposal-technical")).toBeTruthy();
  });
});
