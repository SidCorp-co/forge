// @direct-test-of packages/web-v2/src/features/releases/components/release-actions.tsx
// @direct-test-of packages/web-v2/src/features/releases/components/release-checks.tsx
// @direct-test-of packages/web-v2/src/features/releases/types.ts
// ISS-914: an approval refused only on its unproven criteria offers to carry them all with a why,
// and sends that carry; an approval that carried criteria shows a count that opens to each one.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { ReleaseApprovalView, ReleaseDetail } from "../types";
import { ReleaseActions } from "./release-actions";
import { ReleaseHistory } from "./release-checks";

afterEach(() => vi.unstubAllGlobals());

const waiting = {
  version: "0.1.0",
  runId: "r1",
  approval: { id: "a1" },
  issues: [],
  can: { cut: false, decide: true, split: false },
  split: null,
} as unknown as ReleaseDetail;

const refusedOn = (paths: string[]) => ({
  status: 422,
  body: {
    code: "CHECKLIST_INCOMPLETE",
    error: {
      code: "CHECKLIST_INCOMPLETE",
      message: "refused",
      refusals: paths.map((path) => ({ code: "CHECKLIST_INCOMPLETE", path, detail: `gap at ${path}` })),
    },
  },
});

async function approveOnce(reason: string) {
  fireEvent.click(screen.getByTestId("release-approve"));
  fireEvent.change(screen.getByTestId("release-approve-reason"), { target: { value: reason } });
  fireEvent.click(screen.getByTestId("release-approve-submit"));
  await screen.findByTestId("release-refusal");
}

describe("carrying unproven criteria on the approve step", () => {
  it("offers the carry only once the approval is refused on unproven criteria alone, and sends it with its why", async () => {
    const posts: unknown[] = [];
    fakeCore((c) => {
      if (c.method !== "POST") return undefined;
      posts.push(c.body);
      return posts.length === 1 ? refusedOn(["/answers/verdicts"]) : { status: 200, body: {} };
    });
    renderWithQuery(<ReleaseActions projectId="p1" r={waiting} />);
    fireEvent.click(screen.getByTestId("release-approve"));
    expect(screen.queryByTestId("release-carry")).toBeNull();
    fireEvent.click(screen.getByTestId("release-approve"));
    await approveOnce("beta serves it");

    fireEvent.click(screen.getByRole("checkbox", { name: "Carry unproven" }));
    expect(screen.getByTestId("release-approve-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("release-carry-why"), { target: { value: "flag off on beta" } });
    fireEvent.click(screen.getByTestId("release-approve-submit"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({
      decision: "approve",
      reason: "beta serves it",
      carry: { all: true, why: "flag off on beta" },
    });
  });

  it("offers no carry where the approval is refused on anything besides unproven criteria", async () => {
    fakeCore((c) => (c.method === "POST" ? refusedOn(["/answers/verdicts", "/answers/carried"]) : undefined));
    renderWithQuery(<ReleaseActions projectId="p1" r={waiting} />);
    await approveOnce("beta serves it");
    expect(screen.queryByTestId("release-carry")).toBeNull();
  });
});

const approval = (carried: ReleaseApprovalView["carried"]): ReleaseApprovalView => ({
  id: "a1",
  requestedBy: { id: "u2", name: "Master", kind: "agent" },
  requestedAt: "2026-11-03T09:00:00.000Z",
  evidence: { environment: "stg", commit: "e7af41887a0e90ed541bb0dbfb34d4f9cb4f8510", reading: "GET /health 200" },
  note: null,
  decision: "approved",
  decidedBy: { id: "u1", name: "Lan", kind: "human" },
  decidedAt: "2026-11-03T10:00:00.000Z",
  reason: "approved on my word",
  carried,
});

const cut = (a: ReleaseApprovalView) =>
  ({ version: "0.1.0", state: "shipped", attempts: [], approvals: [a], cuts: [], draftApproval: null }) as unknown as ReleaseDetail;

describe("what an approval carried, on the release page", () => {
  it("shows a count that opens to each carried criterion and its why", () => {
    renderWithQuery(
      <ReleaseHistory
        slug="adminhub"
        r={cut(
          approval([
            { issue: "ISS-12", n: 2, standing: "not judged", why: "flag off on stg" },
            { issue: "ISS-14", n: 1, standing: "fail", why: "docs only" },
          ]),
        )}
      />,
    );
    const toggle = screen.getByTestId("release-approval-carried-toggle");
    expect(toggle.textContent).toBe("Carried (2)");
    expect(screen.queryByText("flag off on stg")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("release-approval-carried").textContent).toContain("ISS-12 #2 flag off on stg");
    expect(screen.getByText("docs only")).toBeTruthy();
  });

  it("shows nothing where the approval carried nothing", () => {
    renderWithQuery(<ReleaseHistory slug="adminhub" r={cut(approval([]))} />);
    expect(screen.queryByTestId("release-approval-carried")).toBeNull();
  });
});
