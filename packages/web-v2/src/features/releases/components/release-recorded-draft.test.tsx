// @direct-test-of packages/web-v2/src/features/releases/components/release-actions.tsx
// @direct-test-of packages/web-v2/src/features/releases/components/release-report.tsx
// ISS-1019: catalog-fe's draft 0.13.0 stood at NO_RELEASE_GATE (no production declared) and its page
// offered "Approve release" while Needs attention listed only what it removes. The page draws a draft's
// decision only where core's read says the draft door takes it, words it as approving the master's
// record, and names the blocker in one attention line whose detail opens on demand.

import type { ReleasePage } from "@forge/contracts/release-page";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { releasePage } from "@/test/release-page";
import type { ReleaseDetail } from "../types";
import { ReleaseActions } from "./release-actions";
import { NeedsAttention } from "./release-report";

const draft = (decide: boolean) =>
  ({
    version: "0.13.0",
    state: "draft",
    runId: null,
    approval: null,
    issues: [{ id: "i1" }],
    can: { cut: false, decide, split: false },
    split: null,
  }) as unknown as ReleaseDetail;

const recorded = (recordedNotCut: boolean): ReleasePage => {
  const page = releasePage();
  return { ...page, header: { ...page.header, state: "draft", recordedNotCut }, actionRequired: [] };
};

describe("a draft's decision", () => {
  it("draws no Approve where core's read says the draft door does not take one", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ReleaseActions projectId="p1" r={draft(false)} />);
    expect(screen.queryByTestId("release-approve")).toBeNull();
    expect(screen.queryByTestId("release-return")).toBeNull();
  });

  it("words the Approve it draws as approving the master's record, not a release to cut", () => {
    fakeCore(() => undefined);
    renderWithQuery(<ReleaseActions projectId="p1" r={draft(true)} />);
    expect(screen.getByTestId("release-approve").textContent).toBe("Approve record");
  });
});

describe("Needs attention on a draft its master records", () => {
  it("names the blocker in one line, its detail behind the line, with no code as visible text", () => {
    renderWithQuery(<NeedsAttention page={recorded(true)} />);
    const line = screen.getAllByTestId("page-attention-item").find((li) => li.dataset.kind === "recorded");
    expect(line?.textContent).toBe("Recorded by the master, not cut");
    expect(line?.querySelector("[title]")?.getAttribute("title")).toContain("declares no production");
    expect(screen.getByTestId("page-attention").textContent).not.toContain("NO_RELEASE_GATE");
  });

  it("says nothing of it on a release cut as a run", () => {
    renderWithQuery(<NeedsAttention page={recorded(false)} />);
    const kinds = screen.queryAllByTestId("page-attention-item").map((li) => li.dataset.kind);
    expect(kinds).not.toContain("recorded");
  });
});
