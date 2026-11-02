// @direct-test-of packages/web-v2/src/features/releases/api.ts
// @direct-test-of packages/web-v2/src/features/releases/hooks.ts
// HOP 0.1.0, 2026-10-07: a draft refused only for RELEASE_ROSTER_OVERSIZE told "A project admin" to
// split it and offered no control, so the admin posted the ids by hand. Where core says the viewer
// may split, the page offers the act the gate's effect names and sends exactly the ids core chose.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { ReleaseDetail } from "../types";
import { ReleaseActions } from "./release-actions";

afterEach(() => vi.unstubAllGlobals());

const OLDEST = Array.from({ length: 50 }, (_, k) => `i${k + 1}`);
const draft = (over: Partial<ReleaseDetail> = {}) =>
  ({
    version: "0.1.0",
    runId: null,
    approval: null,
    issues: [...OLDEST, "i51", "i52"].map((id) => ({ id })),
    can: { cut: false, decide: false, split: true },
    split: { issueIds: OLDEST, rest: 2 },
    ...over,
  }) as unknown as ReleaseDetail;

describe("splitting an oversize draft", () => {
  it("offers the split and posts the oldest 50 ids core named, not the whole roster", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: { runId: "r1", version: "0.1.0" } } : undefined));
    renderWithQuery(<ReleaseActions projectId="p1" r={draft()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cut the oldest 50 as 0.1.0" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/release-batches", body: { issueIds: OLDEST } },
      ]),
    );
  });

  it("offers neither split nor cut where core allows neither", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ReleaseActions projectId="p1" r={draft({ can: { cut: false, decide: false, split: false }, split: null })} />);
    expect(screen.queryByTestId("release-actions")).toBeNull();
  });
});

// Requirement lifecycle r15 release_check: an approval says why the release may ship, as a return
// says why it goes back; the approve button opens the reason and sends it.
describe("approving a release", () => {
  const waiting = draft({
    runId: "r1",
    approval: { id: "a1" } as ReleaseDetail["approval"],
    can: { cut: false, decide: true, split: false },
    split: null,
  });

  it("asks why it may ship, and sends that reason with the approval", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 200, body: {} } : undefined));
    renderWithQuery(<ReleaseActions projectId="p1" r={waiting} />);
    fireEvent.click(screen.getByTestId("release-approve"));
    expect(screen.getByTestId("release-approve-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("release-approve-reason"), { target: { value: "beta serves it cleanly" } });
    fireEvent.click(screen.getByTestId("release-approve-submit"));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        {
          method: "POST",
          path: "/projects/p1/release-batches/r1/approvals/a1/decision",
          body: { decision: "approve", reason: "beta serves it cleanly" },
        },
      ]),
    );
  });
});

// ISS-869: a project declaring no production cuts no run, so its draft is what its approver decides,
// keyed on the version; the page sends the decision there, never to a run that does not exist.
describe("deciding a draft of a project with no production", () => {
  const decidable = draft({
    state: "draft",
    can: { cut: false, decide: true, split: false },
    split: null,
  });

  it("sends the approval and its reason to the draft's version", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: {} } : undefined));
    renderWithQuery(<ReleaseActions projectId="p1" r={decidable} />);
    fireEvent.click(screen.getByTestId("release-approve"));
    fireEvent.change(screen.getByTestId("release-approve-reason"), { target: { value: "notes read; open the upstream MR" } });
    fireEvent.click(screen.getByTestId("release-approve-submit"));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        {
          method: "POST",
          path: "/projects/p1/releases/0.1.0/approval",
          body: { decision: "approve", reason: "notes read; open the upstream MR" },
        },
      ]),
    );
  });
});
