// FB-93: a requirement read "Waiting on you: promote 6 draft issues" and offered no promote. The act
// sits where the ask is shown — "Promote N draft issues" among the requirement's acts, and a promote
// on each draft row — and it reads the same drafts the waiting line counts, so both go together.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { RequirementDetail } from "../types";
import { PromoteDraftRow } from "./promote-drafts";
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

function detail(statuses: string[], canSignOff = true): RequirementDetail {
  const drafts = statuses.filter((s) => s === "draft").length;
  return {
    key: "REQ-2",
    status: "agreed",
    canSignOff,
    deferral: null,
    revisions: [{ revision: 1, state: "current" }],
    issues: statuses.map((s, i) => row(10 + i, s)),
    standing: {
      state: "agreed",
      waitingOn:
        drafts === statuses.length
          ? { kind: canSignOff ? "you" : "person", who: "You", act: `promote ${drafts} draft issues`, rule: "", ref: null, dueAt: null }
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

  it("is not offered to a person who cannot sign", () => {
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft"], false)} />);
    expect(promoteAll()).toBeNull();
  });

  it("names each draft core refused while the rest moved", async () => {
    fakeCore(() => ({
      body: {
        requirement: detail(["open", "draft"]),
        promoted: [{ issueId: "i10", displayId: "ISS-10" }],
        refused: [{ issueId: "i11", displayId: "ISS-11", code: "ISSUE_ARCHIVED", detail: "ISS-11 is archived" }],
      },
    }));
    const user = userEvent.setup();
    renderWithQuery(<PrimaryActions projectId="p1" slug="epod" d={detail(["draft", "draft"])} />);
    await user.click(promoteAll() as HTMLElement);
    expect(await screen.findByTestId("promote-refused")).toHaveTextContent("ISS-11 ISSUE_ARCHIVED");
  });
});

describe("a draft row's promote", () => {
  it("promotes that one issue by name", async () => {
    const calls = fakeCore(() => ({ body: { requirement: detail(["open", "draft"]), promoted: [], refused: [] } }));
    const user = userEvent.setup();
    const d = detail(["draft", "draft"]);
    renderWithQuery(<PromoteDraftRow projectId="p1" d={d} issue={d.issues[0] as RequirementDetail["issues"][number]} />);
    await user.click(screen.getByRole("button", { name: "Promote ISS-10" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ method: "POST", path: "/projects/p1/requirements/REQ-2/promote", body: { issues: ["i10"] } }),
    );
  });

  it("is not drawn on a row past draft, nor for a person who cannot sign", () => {
    const d = detail(["open", "draft"]);
    const unsigned = detail(["draft"], false);
    const { container } = renderWithQuery(
      <>
        <PromoteDraftRow projectId="p1" d={d} issue={d.issues[0] as RequirementDetail["issues"][number]} />
        <PromoteDraftRow projectId="p1" d={unsigned} issue={unsigned.issues[0] as RequirementDetail["issues"][number]} />
      </>,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
