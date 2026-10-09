// REQ-34 BC-3, BC-26: the checklist form a refused move opens keeps what the person typed. Driven
// through the real `useGuardedTransition` against a stand-in core answering the problem body every
// refusal answers, its rows the ones the shared contract produces for the kernel.

import { ISSUE_READY_CHECKLIST } from "@forge/contracts/checklist-registry";
import { checklistRefusals, evaluateChecklist, type RecordAnswers } from "@forge/contracts/checklists";
import { type ProblemBody, type Refusal, refusalTitle, refusalType } from "@forge/contracts/refusal";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import type { IssueStatus } from "../types";
import { useGuardedTransition } from "./use-guarded-transition";

const HOTFIX = "Fixes FB-12, restoring BC-3";

const READY: RecordAnswers = {
  criteria: { value: "1 criterion, tracing BC-1 of REQ-1 revision 1" },
  design: { value: "None: it builds no workflow design." },
};

/** What core answers a draft whose record still names no requirement. */
function refusedForTheRecord(): { status: number; body: ProblemBody } {
  const refusals: Refusal[] = checklistRefusals(
    evaluateChecklist(ISSUE_READY_CHECKLIST, {
      given: {},
      record: {
        ...READY,
        requirement: { gap: "The issue is not linked to a requirement.", fix: "Link it, then write its plan." },
      },
    }),
  );
  const code = "CHECKLIST_INCOMPLETE";
  const message = `refused, nothing written: ${refusals.map((r) => r.detail).join("; ")}`;
  return {
    status: 422,
    body: {
      type: refusalType(code),
      title: refusalTitle(code),
      status: 422,
      detail: refusals[0]?.detail ?? "",
      code,
      message,
      error: { code, message, refusals },
    },
  };
}

function Harness({ id, status = "draft" }: { id: string; status?: IssueStatus }) {
  const guarded = useGuardedTransition();
  return (
    <>
      <button type="button" onClick={() => guarded.requestTransition({ id, status }, "open")}>
        Move to open
      </button>
      {guarded.dialog}
    </>
  );
}

/** A core that refuses the move while `recordFixed` is false, and lets it through after. */
function coreWith(state: { recordFixed: boolean }): Call[] {
  return fakeCore((call) => {
    if (call.method !== "POST" || !call.path.endsWith("/transition")) return { body: {} };
    return state.recordFixed ? { body: { id: "x", status: "open" } } : refusedForTheRecord();
  });
}

const posted = (calls: Call[]) => calls.filter((c) => c.method === "POST").map((c) => c.body);
const hotfixBox = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("the checklist form keeps what the person typed", () => {
  it("when the move is refused again for a gap in the record", async () => {
    const state = { recordFixed: false };
    const calls = coreWith(state);
    const user = userEvent.setup();
    renderWithQuery(<Harness id="issue-refused-again" />);

    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await user.type(await screen.findByRole("textbox"), HOTFIX);
    await user.click(screen.getByRole("button", { name: "Answer and move" }));

    await waitFor(() => expect(posted(calls)).toHaveLength(2));
    expect(posted(calls)).toEqual([{ toStatus: "open" }, { toStatus: "open", answers: { hotfix: HOTFIX } }]);
    await waitFor(() => expect(hotfixBox().value).toBe(HOTFIX));
  });

  it("when the form is closed, and sends it as given with the next move once the record is fixed", async () => {
    const state = { recordFixed: false };
    const calls = coreWith(state);
    const user = userEvent.setup();
    renderWithQuery(<Harness id="issue-closed" />);

    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await user.type(await screen.findByRole("textbox"), HOTFIX);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();

    // refused again: the form comes back holding what was typed
    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await waitFor(() => expect(hotfixBox().value).toBe(HOTFIX));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // the person fixes the record elsewhere; the next move carries their answer, not the assumed one
    state.recordFixed = true;
    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(3));
    expect(posted(calls).at(-1)).toEqual({ toStatus: "open", answers: { hotfix: HOTFIX } });

    // a passed move forgets the draft
    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(4));
    expect(posted(calls).at(-1)).toEqual({ toStatus: "open" });
  });
});

/** What the kernel answers a move whose edge asks no checklist when it is sent answers anyway. */
function refusedForAnswers(): { status: number; body: ProblemBody } {
  const code = "CHECKLIST_ANSWER_INVALID";
  const detail =
    'Moving this issue from "Needs info" to "Open" asks no checklist questions, so it takes no answers. Send the move without answers.';
  const refusals: Refusal[] = [{ code, path: "/answers", detail }];
  return {
    status: 400,
    body: { type: refusalType(code), title: refusalTitle(code), status: 400, detail, code, message: detail, error: { code, message: detail, refusals } },
  };
}

/**
 * A core that refuses a draft's move to open for its record, refuses answers sent to any move that
 * asks no checklist, and lets every other move through: the kernel's own rules for these moves.
 */
function kernel(issue: { status: IssueStatus }): Call[] {
  return fakeCore((call) => {
    if (call.method !== "POST" || !call.path.endsWith("/transition")) return { body: {} };
    const sent = call.body as { toStatus: IssueStatus; answers?: Record<string, string> };
    if (issue.status === "draft") return refusedForTheRecord();
    if (sent.answers) return refusedForAnswers();
    issue.status = sent.toStatus;
    return { body: { id: "x", status: sent.toStatus } };
  });
}

describe("an answer kept for one move never goes with another (REQ-34 BC-26)", () => {
  it("is dropped once the issue moved some other way, so moving it back to open from a park sends none", async () => {
    const issue: { status: IssueStatus } = { status: "draft" };
    const calls = kernel(issue);
    const user = userEvent.setup();
    const { rerender, client } = renderWithQuery(<Harness id="issue-admitted-elsewhere" status="draft" />);

    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await user.type(await screen.findByRole("textbox"), HOTFIX);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // admitted another way (the requirement page's Promote, a colleague, an agent), then parked
    issue.status = "needs_info";
    rerender(
      <QueryClientProvider client={client}>
        <Harness id="issue-admitted-elsewhere" status="needs_info" />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(2));
    expect(posted(calls).at(-1)).toEqual({ toStatus: "open" });
    await waitFor(() => expect(issue.status).toBe("open"));
  });

  it("is dropped when the kernel refuses it for a move that asks no checklist, read while the screen still showed a draft", async () => {
    const issue: { status: IssueStatus } = { status: "draft" };
    const calls = kernel(issue);
    const user = userEvent.setup();
    renderWithQuery(<Harness id="issue-read-stale" status="draft" />);

    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await user.type(await screen.findByRole("textbox"), HOTFIX);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // the issue moved on while this screen still reads it at draft
    issue.status = "needs_info";
    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(2));
    expect(posted(calls).at(-1)).toEqual({ toStatus: "open", answers: { hotfix: HOTFIX } });

    // refused once, for answers with no checklist to hold them: they are forgotten, and the next press goes
    await user.click(screen.getByRole("button", { name: "Move to open" }));
    await waitFor(() => expect(posted(calls)).toHaveLength(3));
    expect(posted(calls).at(-1)).toEqual({ toStatus: "open" });
    await waitFor(() => expect(issue.status).toBe("open"));
  });
});
