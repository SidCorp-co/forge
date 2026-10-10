// FB-93: a requirement read "Waiting on you: promote 6 draft issues" and offered no promote. The act
// sits where the ask is shown — "Promote N draft issues" among the requirement's acts, and a promote
// on each draft row — and it reads the same drafts the waiting line counts, so both go together. Only
// a signer who can admit issues is offered it (`canPromote`, question 3b8292dc): a signer without
// issues.admit is not invited to an act core would refuse.

import { ISSUE_READY_CHECKLIST } from "@forge/contracts/checklist-registry";
import { checklistRefusals, evaluateChecklist, fieldKeyShownIn } from "@forge/contracts/checklists";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { RequirementDetail } from "../types";
import { PromotableDraft } from "./promote-drafts";
import { PrimaryActions } from "./requirement-actions";

const row = (n: number, status: string) => ({
  issueId: `i${n}`,
  displayId: `ISS-${n}`,
  title: `slice ${n}`,
  status,
  tone: "calm",
  plannedRevision: 1,
  changedSincePlan: false,
});

function detail(statuses: string[], canSignOff = true, canPromote = canSignOff): RequirementDetail {
  const drafts = statuses.filter((s) => s === "draft").length;
  return {
    key: "REQ-2",
    status: "agreed",
    canSignOff,
    canPromote,
    deferral: null,
    revisions: [{ revision: 1, state: "current" }],
    issues: statuses.map((s, i) => row(10 + i, s)),
    standing: {
      state: "agreed",
      waitingOn:
        drafts === statuses.length
          ? { kind: canPromote ? "you" : "person", who: canPromote ? "You" : "a BA or owner who can admit issues", act: `promote ${drafts} draft issues`, rule: "", ref: null, dueAt: null }
          : { kind: "issue", who: "Issues", act: `Shipped 0 of ${statuses.length}`, rule: "", ref: null, dueAt: null },
      facts: { stalePins: [], staleContractPins: [], unapprovedDesigns: [] },
    },
  } as unknown as RequirementDetail;
}

const promoteAll = () => screen.queryByRole("button", { name: /^Promote \d+ draft issues?$/ });

describe("the requirement's promote act", () => {
  it("is offered to a signer beside the ask, and promotes every draft in one call", async () => {
    const after = detail(["open", "open", "open"]);
    const calls = fakeCore(() => ({ body: { requirement: after, promoted: [], refused: [] } }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft", "draft"])} />);
    expect(promoteAll()).toHaveTextContent("Promote 3 draft issues");
    await user.click(promoteAll() as HTMLElement);
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-2/promote", body: {} }));
  });

  it("is gone with the waiting line once nothing is at draft", () => {
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["open", "in_progress"])} />);
    expect(promoteAll()).toBeNull();
  });

  it("is offered for the drafts left once one row was promoted", () => {
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["open", "draft", "draft"])} />);
    expect(promoteAll()).toHaveTextContent("Promote 2 draft issues");
  });

  it("is not offered to a person who cannot sign", () => {
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft"], false)} />);
    expect(promoteAll()).toBeNull();
  });

  it("is not offered to a signer who cannot admit issues", () => {
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft"], true, false)} />);
    expect(promoteAll()).toBeNull();
  });

  // core's detail for a refused move is an API instruction carrying the project id; a person reads words
  const archivedDetail = "ISS-11 is archived. Unarchive it first — POST /api/projects/8a2f0c1e-0000-4000-8000-000000000001/issues/unarchive with {filter: {ids}} — then retry";

  it("names each draft core refused while the rest moved, in words for a person", async () => {
    fakeCore(() => ({
      body: {
        requirement: detail(["open", "draft"]),
        promoted: [{ issueId: "i10", displayId: "ISS-10" }],
        refused: [{ issueId: "i11", displayId: "ISS-11", code: "ISSUE_ARCHIVED", detail: archivedDetail }],
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft"])} />);
    await user.click(promoteAll() as HTMLElement);
    const line = await screen.findByTestId("promote-refused");
    expect(line).toHaveTextContent("ISS-11 is archived, so it stays a draft");
    expect(line.textContent).not.toMatch(/\/api\/|POST|8a2f0c1e|\{filter/);
  });

  it("words a refusal of the whole act from the issue it names, not core's API detail", async () => {
    fakeCore(() => ({
      status: 422,
      body: {
        error: {
          code: "ISSUE_ARCHIVED",
          message: "refused, nothing written",
          refusals: [{ code: "ISSUE_ARCHIVED", path: "/issues/ISS-11", detail: `ISS-11: ${archivedDetail}` }],
        },
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft"])} />);
    await user.click(screen.getByRole("button", { name: "Promote 1 draft issue" }));
    const line = await screen.findByTestId("promote-refused");
    expect(line).toHaveTextContent("ISS-11 is archived, so it stays a draft");
    expect(line.textContent).not.toMatch(/\/api\/|POST|8a2f0c1e|\{filter/);
  });
});

// REQ-34 BC-2, BC-18: a draft the issue-ready checklist holds back is refused once per blocking gap,
// each in core's plain words on its question's path. These are the refusals the shared contract
// produces for the kernel, so the page is read against the words a person is actually sent.
const GAPS = checklistRefusals(
  evaluateChecklist(ISSUE_READY_CHECKLIST, {
    given: {},
    record: {
      requirement: {
        gap: "It is linked to REQ-2, and it has no plan yet.",
        fix: "Write the issue's plan: saving it records the current revision of REQ-2 as the one it is written against.",
      },
      criteria: { gap: "The issue has no acceptance criteria.", fix: "Write its numbered acceptance criteria." },
      design: { value: "None: it builds no workflow design." },
    },
  }),
);

/** What a person reads of the refused drafts: core's words once each, no code, no field key. */
function expectCoresWords(line: HTMLElement) {
  expect(GAPS.map((g) => g.path)).toEqual(["/answers/requirement", "/answers/criteria"]);
  const text = line.textContent ?? "";
  expect(text.match(/ISS-11 stays a draft:/g)).toHaveLength(1);
  for (const g of GAPS) expect(text.split(g.detail)).toHaveLength(2);
  expect(text).not.toMatch(/CHECKLIST_|ISS-11: /);
  expect(fieldKeyShownIn(ISSUE_READY_CHECKLIST, text), text).toBeNull();
  // the code and the field stay machine-readable, on the line for its question
  const item = within(line).getByText(GAPS[0]?.detail ?? "");
  expect(item).toHaveAttribute("data-path", "/answers/requirement");
  expect(item).toHaveAttribute("data-code", "CHECKLIST_INCOMPLETE");
}

describe("a draft the issue-ready checklist holds back", () => {
  it("is named once with each of core's refusals once, while the rest moved", async () => {
    fakeCore(() => ({
      body: {
        requirement: detail(["open", "draft"]),
        promoted: [{ issueId: "i10", displayId: "ISS-10" }],
        refused: GAPS.map((g) => ({ issueId: "i11", displayId: "ISS-11", code: g.code, path: g.path, detail: g.detail })),
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft"])} />);
    await user.click(promoteAll() as HTMLElement);
    expectCoresWords(await screen.findByTestId("promote-refused"));
    expect(screen.queryByTestId("refusal")).toBeNull();
  });

  it("is named the same way when none moved and the act is refused whole", async () => {
    const refusals = GAPS.map((g) => ({ code: g.code, path: `/issues/ISS-11${g.path}`, detail: `ISS-11: ${g.detail}` }));
    fakeCore(() => ({
      status: 422,
      body: { error: { code: "CHECKLIST_INCOMPLETE", message: "refused, nothing written", refusals } },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft"])} />);
    await user.click(screen.getByRole("button", { name: "Promote 1 draft issue" }));
    expectCoresWords(await screen.findByTestId("promote-refused"));
    expect(screen.queryByTestId("refusal")).toBeNull();
  });

  it("reads a refusal of the act itself as core wrote it, with this page's words where it gives them", async () => {
    fakeCore(() => ({
      status: 422,
      body: {
        error: {
          code: "REQUIREMENT_NO_DRAFT_ISSUES",
          message: "refused, nothing written",
          refusals: [{ code: "REQUIREMENT_NO_DRAFT_ISSUES", path: "", detail: "REQ-2 has no linked issue at draft, so there is nothing to promote." }],
        },
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft"])} />);
    await user.click(screen.getByRole("button", { name: "Promote 1 draft issue" }));
    expect(await screen.findByTestId("refusal")).toHaveTextContent("No drafts");
  });
});

describe("a draft row's promote", () => {
  it("promotes that one issue by name", async () => {
    const calls = fakeCore(() => ({ body: { requirement: detail(["open", "draft"]), promoted: [], refused: [] } }));
    const user = userEvent.setup();
    const d = detail(["draft", "draft"]);
    renderWithQuery(<PromotableDraft projectId="p1" d={d} issue={d.issues[0]} />);
    await user.click(screen.getByRole("button", { name: "Promote ISS-10" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-2/promote", body: { issues: ["i10"] } }),
    );
  });

  it("is not drawn on a row past draft, for a person who cannot sign, nor for a signer who cannot admit", () => {
    const d = detail(["open", "draft"]);
    const unsigned = detail(["draft"], false);
    const unadmitted = detail(["draft"], true, false);
    const { container } = renderWithQuery(
      <>
        <PromotableDraft projectId="p1" d={d} issue={d.issues[0]} />
        <PromotableDraft projectId="p1" d={unsigned} issue={unsigned.issues[0]} />
        <PromotableDraft projectId="p1" d={unadmitted} issue={unadmitted.issues[0]} />
      </>,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
