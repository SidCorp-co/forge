// ISS-489 r2: tying REQ-37 BC-8 again on ISS-479 retired its row (d20b73bf) and the verdict on it
// (ce01a817) showed in no read and no view, so an earlier judge's finding was out of reach. The
// criteria read answers the retired rows beside the live ones, and the Criteria tab shows each marked
// Retired with every verdict it earned.

import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssueDetail } from "../types";
import { CriteriaTab } from "./detail/issue-tabs";

const RUNTIME = "880cc8c4d471572bffefc43eb2ba654fd6a252ef";

const verdict = (over: Record<string, unknown>) => ({
  verdict: "pass",
  reason: null,
  identityKind: "commit",
  commitSha: "a".repeat(40),
  runtimeRef: null,
  designFlow: null,
  designWorkflowId: null,
  designRevision: null,
  contractRef: null,
  contractVersion: null,
  storefrontWorkflowId: null,
  storefrontDraftVersion: null,
  storefrontEnvironment: null,
  corroboration: null,
  corroborationNote: null,
  evidence: [],
  authorAgency: "agent",
  backfilled: false,
  createdAt: "2026-10-08T10:00:00Z",
  ...over,
});

const live = {
  id: "bf695080",
  n: 8,
  statement: "(REQ-37 BC-8) The output cap names its size",
  position: 7,
  requirementCriterionId: "w8-r2",
  latest: null,
};

const retired = {
  id: "d20b73bf",
  n: 8,
  statement: "(REQ-37 BC-8) The output is capped",
  requirementCriterionId: "w8-r1",
  retiredAt: "2026-10-09T03:40:00Z",
  verdicts: [
    verdict({ verdict: "fail", identityKind: "runtime", commitSha: null, runtimeRef: RUNTIME, reason: "The cap held but named no size.", createdAt: "2026-10-09T03:30:00Z" }),
    verdict({ verdict: "pass", reason: "Capped at the first read.", createdAt: "2026-10-08T10:00:00Z" }),
  ],
};

const issue = { id: "i1", projectId: "p1", status: "closed", mergedCommitSha: null, liveReach: null } as unknown as IssueDetail;

describe("a criterion tied again", () => {
  it("keeps its retired row readable, marked Retired, with every verdict it earned", async () => {
    fakeCore((c) => (c.method === "GET" && c.path === "/issues/i1/criteria" ? { body: { criteria: [live], retired: [retired] } } : undefined));
    renderWithQuery(<CriteriaTab issue={issue} projectId="p1" hasCriteriaRows checklist={[]} canWrite={false} requirementKey="REQ-37" />);
    const section = await screen.findByTestId("retired-criteria");
    expect(section).toHaveTextContent("Retired criteria · 1");
    await userEvent.click(within(section).getByText("Retired criteria · 1"));
    const row = within(section).getByTestId("retired-criterion");
    expect(row).toHaveTextContent("8.");
    expect(row).toHaveTextContent("The output is capped");
    expect(within(row).getByTestId("retired-mark")).toHaveTextContent(/^Retired /);
    const [newest, older] = within(row).getAllByTestId("retired-verdict");
    expect(newest).toHaveTextContent("Fail");
    expect(newest).toHaveTextContent(`runtime ${RUNTIME.slice(0, 12)}`);
    expect(newest).toHaveTextContent("The cap held but named no size.");
    expect(older).toHaveTextContent("Pass");
    expect(older).toHaveTextContent("Capped at the first read.");
  });

  it("shows no retired section where nothing was retired", async () => {
    fakeCore((c) => (c.method === "GET" && c.path === "/issues/i1/criteria" ? { body: { criteria: [live], retired: [] } } : undefined));
    renderWithQuery(<CriteriaTab issue={issue} projectId="p1" hasCriteriaRows checklist={[]} canWrite={false} requirementKey="REQ-37" />);
    expect(await screen.findByText("(REQ-37 BC-8) The output cap names its size")).toBeInTheDocument();
    expect(screen.queryByTestId("retired-criteria")).toBeNull();
  });
});
