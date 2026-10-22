// REQ-48 BC-11: Approvals is the one Needs you list. Each row reads the subject, the agent's proposal as
// a verb and its object, and tags, never the record's machinery; chips narrow it; a selection states
// what approving makes before it acts; a decline is refused without a reason; a decision is held five
// seconds for Undo before anything is posted; and the peek steps on to the next row once one is decided.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-row.tsx
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-peek.tsx
// @direct-test-of packages/web-v2/src/features/approvals/components/decision-answers.tsx
// @direct-test-of packages/web-v2/src/features/approvals/use-decision-keys.ts
// @direct-test-of packages/web-v2/src/features/approvals/components/bulk-bar.tsx
// @direct-test-of packages/web-v2/src/test/approvals-read.ts

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVALS_PROJECT as P, APPROVALS_READ as READ, STEWARD_DECISION } from "@/test/approvals-read";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ApprovalsScreen } from "./components/approvals-screen";
import { bulkSummary } from "./derive";
import { UNDO_MS } from "./use-decide";

/** The peek's button for one answer, by the id core gave it. */
const answerIn = (peek: HTMLElement, id: string) => {
  const b = peek.querySelector<HTMLElement>(`[data-testid=approval-peek-answer][data-answer="${id}"]`);
  if (!b) throw new Error(`the peek draws no answer ${id}`);
  return b;
};

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

const DECISIONS = `/projects/${P}/needs-you/decisions`;

function core() {
  return fakeCore(({ path, method }) => {
    if (method === "GET" && path === DECISIONS) return { body: READ };
    if (method === "POST") return { body: { ok: true } };
    return undefined;
  });
}

const rowOf = (key: string) => {
  const row = screen.getAllByTestId("approval-row").find((r) => within(r).queryByText(key, { exact: true }));
  if (!row) throw new Error(`no row ${key}`);
  return row;
};
const posts = <C extends { method: string }>(calls: C[]): C[] => calls.filter((c) => c.method === "POST");

beforeEach(() => window.history.replaceState(null, "", "/projects/hop/approvals"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Approvals page", () => {
  it("lists every decision once, grouped, each read as its proposal and tags, with the read's own count", async () => {
    core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    expect(screen.getAllByTestId("approval-row")).toHaveLength(READ.total);
    expect(screen.getByTestId("approvals-count")).toHaveTextContent(`Decisions waiting on you: ${READ.total}`);
    const groups = [...document.querySelectorAll("[data-testid^=approval-group-]")].map((g) => g.getAttribute("data-testid"));
    expect(groups).toEqual(["approval-group-feedback", "approval-group-breakdown", "approval-group-design_update", "approval-group-mockup", "approval-group-requirement", "approval-group-release", "approval-group-question"]);

    const fb = rowOf("FB-135");
    expect(within(fb).getByTestId("approval-proposal")).toHaveTextContent("New issue “Do not reset merged issues as wedges”");
    expect(within(fb).getByTestId("approval-tags")).toHaveTextContent(/Check first.*Bug · medium.*Not reproduced.*≈ FB-163 80%.*REQ-2 BC-10/);
    expect(within(rowOf("FB-137")).getByTestId("approval-tags")).toHaveTextContent(/Agent recommends.*Reproduced/);
    expect(within(rowOf("system-context")).getByTestId("approval-proposal")).toHaveTextContent("Follow r17 2 designs built on it move to its approved revision");
    // a person's question reads as asked, with no proposal tag
    expect(within(rowOf("ISS-41")).getByTestId("approval-proposal")).toHaveTextContent("Should the export keep the old column order");

    const text = screen.getByTestId("approvals-screen").textContent ?? "";
    for (const internal of ["Suggestion ·", "Feedback triage", "Re-pin", "Decided on its page", "Asker not recorded", "feedback_triage", "suggestion:"]) expect(text).not.toContain(internal);
    expect(screen.getByTestId("approvals-left-out")).toHaveTextContent("FB-140");
  });

  it("narrows by topic chip and to what the agent recommends, kept in the URL", async () => {
    core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(screen.getByTestId("approval-chip-feedback"));
    expect(screen.getAllByTestId("approval-row").map((r) => r.dataset.topic)).toEqual(["feedback", "feedback", "feedback", "feedback"]);
    expect(window.location.search).toContain("topic=feedback");
    fireEvent.click(screen.getByTestId("approval-chip-recommends"));
    expect(screen.getAllByTestId("approval-row").map((r) => within(r).getByTestId("approval-tags").textContent)).toEqual([expect.stringContaining("Agent recommends"), expect.stringContaining("Agent recommends")]);
    // the count is the read's, whatever the chips narrow
    expect(screen.getByTestId("approvals-count")).toHaveTextContent(`Decisions waiting on you: ${READ.total}`);
  });

  it("states what approving a selection makes before it acts, and approves only those an ✓ can", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(screen.getByTestId("approval-group-feedback")).getByRole("checkbox", { name: "Select all Feedback" }));
    expect(screen.getByTestId("approval-bulk")).toHaveTextContent("4 selected");
    expect(screen.getByTestId("approval-bulk-summary")).toHaveTextContent("Approving makes 2 new issues · 1 requirement revision · 1 closed · 2 marked Check first");
    expect(posts(calls)).toHaveLength(0);
    fireEvent.click(screen.getByTestId("approval-bulk-approve"));
    expect(screen.queryAllByTestId("approval-row").filter((r) => r.dataset.topic === "feedback")).toHaveLength(0);
    expect(screen.getByTestId("approval-undo")).toHaveTextContent("4 items approved");
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls).map((c) => c.path)).toEqual(["s135", "s137", "s139", "s131"].map((s) => `/projects/${P}/suggestions/${s}/accept`)));
  });

  it("refuses a decline with no reason, then sends the reason the person typed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("FB-135")).getByTestId("approval-decline"));
    const peek = await screen.findByTestId("approval-peek");
    fireEvent.click(within(peek).getByTestId("approval-words-send"));
    expect(within(peek).getByRole("alert")).toHaveTextContent("A decline needs a reason");
    fireEvent.change(within(peek).getByTestId("approval-words"), { target: { value: "Already fixed by ISS-1229." } });
    fireEvent.click(within(peek).getByTestId("approval-words-send"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: `/projects/${P}/suggestions/s135/reject`, body: { reason: "Already fixed by ISS-1229." } })]));
  });

  it("holds a decision five seconds: Undo puts the row back and nothing is ever posted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("FB-137")).getByTestId("approval-approve"));
    expect(screen.queryAllByText("FB-137", { exact: true })).toHaveLength(0);
    expect(screen.getByTestId("approval-undo")).toHaveTextContent("FB-137 approved");
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS - 100));
    expect(posts(calls)).toHaveLength(0);
    fireEvent.click(screen.getByTestId("approval-undo-button"));
    expect(rowOf("FB-137")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS * 2));
    expect(posts(calls)).toHaveLength(0);
  });

  it("opens a row in its peek, approves it there, and steps on to the next row", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("system-context")).getByTestId("approval-open"));
    const peek = await screen.findByTestId("approval-peek");
    expect(within(peek).getByTestId("approval-peek-proposal")).toHaveTextContent("Follow r17: 2 designs built on it move to its approved revision");
    expect(within(peek).getByTestId("approval-peek-table")).toHaveTextContent("design-runner");
    fireEvent.click(answerIn(peek, "approve"));
    await waitFor(() => expect(within(screen.getByTestId("approval-peek")).getByTestId("approval-peek-proposal")).toHaveTextContent("Accept mockup: Approvals page"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: `/projects/${P}/workflows/wf-system-context/design/repins`, body: { revision: 17, designs: [{ workflowId: "wf-design-steward", revision: 10 }, { workflowId: "wf-design-runner", revision: 11 }] } })]));
  });
});

// ISS-539 c2 (K31, 0.4.0-dev.269): a row never sends an answer its person cannot see, and its ✕ is
// the answer core marks as declining, never whichever answer happens to take words.
describe("what each row's ✓ and ✕ send", () => {
  it("names on a question row the answer its ✓ sends, and opens its other answers in the peek", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    const row = rowOf("ISS-41");
    expect(within(row).getByTestId("approval-approve")).toHaveTextContent("Keep the old order");
    expect(within(row).getByTestId("approval-approve")).toHaveAccessibleName("Send “Keep the old order” for ISS-41");
    fireEvent.click(within(row).getByTestId("approval-other-answers"));
    const peek = await screen.findByTestId("approval-peek");
    expect(within(peek).getAllByTestId("approval-peek-answer-label").map((b) => b.textContent)).toEqual(["Keep the old order", "Use the new order"]);
    fireEvent.click(answerIn(peek, "new"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: "/questions/q41/answer", body: { round: 1, optionId: "new" } })]));
  });

  // each answer's effect was only the button's tooltip, which a phone and a keyboard never open; then
  // it was said twice, once in a list and once beside the button (REQ-48 r3 BC-14): now once, on it
  it("says on each of the steward's answers, once, what it does to the item, the recommended one first and marked", async () => {
    fakeCore(({ path, method }) => (method === "GET" && path === DECISIONS ? { body: { ...READ, total: 1, decisions: [STEWARD_DECISION] } } : undefined));
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("ISS-7")).getByTestId("approval-open"));
    const peek = await screen.findByTestId("approval-peek");
    const buttons = within(peek).getAllByTestId("approval-peek-answer");
    expect(buttons.map((e) => e.dataset.answer)).toEqual(STEWARD_DECISION.answers.map((a) => a.id));
    STEWARD_DECISION.answers.forEach((a, i) => {
      expect(a.effect, `the fixture's ${a.id} carries no effect`).toMatch(/ISS-7/);
      expect(buttons[i]).toHaveTextContent(`${a.label}${a.recommended ? "Recommended" : ""}${i + 1}${a.effect ?? ""}`);
      expect(peek.textContent?.split(a.effect ?? "").length).toBe(2);
    });
    expect(within(peek).getByTestId("approval-peek-why")).toHaveTextContent("Its plan and criteria pass the issue-ready check.");
    expect(within(peek).getByTestId("approval-peek-proposal")).toHaveTextContent("Open it, keep it as a draft, or drop it?");
  });

  it("names what it left out by title and next step, each opening its page, never by slug (REQ-48 r3 BC-17)", async () => {
    core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    const items = within(screen.getByTestId("approvals-left-out")).getAllByTestId("approvals-left-out-item");
    const flow = items.find((i) => i.textContent?.startsWith("Issue lifecycle"));
    expect(flow).toHaveTextContent("Issue lifecycle· next: update the design to the contract");
    expect(within(flow as HTMLElement).getByRole("link").getAttribute("href")).toBe("/projects/hop/workflows/issue-lifecycle");
    expect(screen.getByTestId("approvals-left-out")).not.toHaveTextContent("(issue-lifecycle");
  });

  it("names the across-projects figure the Attention tab carries beside its own count, never as its own (REQ-48 r3 BC-17)", async () => {
    core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" across={128} />);
    await screen.findByTestId("approvals-screen");
    const count = screen.getByTestId("approvals-count");
    expect(count).toHaveTextContent(`Decisions waiting on you: ${READ.total}`);
    expect(within(count).getByTestId("approvals-count-across")).toHaveTextContent("128 across your projects");
    // the left-out line counts no figure under the header's words: one phrase, one count
    const left = screen.getByTestId("approvals-left-out");
    expect(left).not.toHaveTextContent("waiting on you");
    expect(left).toHaveTextContent("Also yours, not counted above:");
  });

  it("presses the answer a digit names, as the peek shows it on that answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("ISS-41")).getByTestId("approval-open"));
    const peek = await screen.findByTestId("approval-peek");
    expect(answerIn(peek, "new").querySelector("kbd")).toHaveTextContent("2");
    expect(within(peek).getByTestId("approval-peek-keys")).not.toHaveTextContent(/approve/);
    fireEvent.keyDown(window, { key: "2" });
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: "/questions/q41/answer", body: { round: 1, optionId: "new" } })]));
  });

  it("declines a release with the reason typed, and never sends its approve from the ✕", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("0.4.0-dev.270")).getByTestId("approval-decline"));
    const peek = await screen.findByTestId("approval-peek");
    fireEvent.click(within(peek).getByTestId("approval-words-send"));
    expect(within(peek).getByRole("alert")).toHaveTextContent("A decline needs a reason");
    fireEvent.change(within(peek).getByTestId("approval-words"), { target: { value: "Two criteria still red." } });
    fireEvent.click(within(peek).getByTestId("approval-words-send"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: `/projects/${P}/release-batches/run-7/approvals/ap-7/decision`, body: { decision: "return", reason: "Two criteria still red." } })]));
  });

  it("asks the words a release approval takes before its ✓ sends it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    fireEvent.click(within(rowOf("0.4.0-dev.270")).getByTestId("approval-approve"));
    const peek = await screen.findByTestId("approval-peek");
    fireEvent.change(within(peek).getByTestId("approval-words"), { target: { value: "Judged green." } });
    fireEvent.click(within(peek).getByTestId("approval-words-send"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ body: { decision: "approve", reason: "Judged green." } })]));
  });

  it("offers in the peek a proposal's answers its ✓ and ✕ do not press (a lesson's Keep)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = READ.decisions.find((d) => d.key === "REQ-48");
    if (!base?.proposal) throw new Error("no proposal row");
    const path = `/api/projects/${P}/lessons/LS-3`;
    const retire = {
      ...base,
      id: "lesson-retire:l3",
      key: "LS-3",
      title: "Name the branch after the issue",
      opens: null,
      answers: [
        { id: "approve", label: "Retire", act: "lesson.retire" as const, path: `${path}/retire`, body: { reason: "No agent applied it in 30 days." }, needsReason: false, declines: false, effect: null, recommended: true },
        { id: "keep", label: "Keep", act: "lesson.keep" as const, path: `${path}/keep`, body: {}, needsReason: false, declines: false, effect: null, recommended: false },
      ],
    };
    const calls = fakeCore(({ path: at, method }) => {
      if (method === "GET" && at === DECISIONS) return { body: { ...READ, total: 1, decisions: [retire] } };
      if (method === "POST") return { body: { ok: true } };
      return undefined;
    });
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    expect(within(rowOf("LS-3")).queryByTestId("approval-decline")).toBeNull();
    fireEvent.click(within(rowOf("LS-3")).getByTestId("approval-open"));
    const peek = await screen.findByTestId("approval-peek");
    fireEvent.click(answerIn(peek, "keep"));
    await act(async () => vi.advanceTimersByTimeAsync(UNDO_MS));
    await waitFor(() => expect(posts(calls)).toEqual([expect.objectContaining({ path: `/projects/${P}/lessons/LS-3/keep` })]));
  });

  it("gives a ✕ to every row with a declining answer, and none to a kind core gives no decline", async () => {
    core();
    renderWithQuery(<ApprovalsScreen projectId={P} slug="hop" />);
    await screen.findByTestId("approvals-screen");
    for (const key of ["FB-135", "REQ-41", "REQ-49", "0.4.0-dev.270"]) expect(within(rowOf(key)).getByTestId("approval-decline")).toBeTruthy();
    for (const key of ["system-context", "ISS-41"]) expect(within(rowOf(key)).queryByTestId("approval-decline")).toBeNull();
  });
});

describe("bulkSummary", () => {
  it("counts each proposal's yields, the rows marked Check first, and the ones no ✓ approves", () => {
    const s = bulkSummary(READ.decisions);
    expect(s.yields).toEqual([
      { kind: "new_issue", n: 2 },
      { kind: "revision", n: 1 },
      { kind: "closed", n: 1 },
      { kind: "design_update", n: 3 },
      { kind: "draft_issue", n: 3 },
      { kind: "approved", n: 1 },
    ]);
    expect(s.checkFirst).toBe(3);
    // the sign-off's one plain answer and the question's recommended one are each an ✓; the release's
    // approve takes words, so a bulk approve leaves it for its peek
    expect(s.noApprove).toBe(1);
    // a question with two plain answers and none recommended is answered in its peek, never guessed
    const open = READ.decisions.filter((d) => d.key === "ISS-41").map((d) => ({ ...d, answers: d.answers.map((a) => ({ ...a, recommended: false })) }));
    expect(bulkSummary(open)).toEqual({ yields: [], checkFirst: 0, noApprove: 1 });
  });
});
