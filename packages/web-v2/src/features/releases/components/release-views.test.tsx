// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseDetail } from "../types";
import { ReleaseActions } from "./release-actions";
import { ReleaseBanner } from "./release-bits";
import { ChecksPane } from "./release-checks";
import { ReleaseFacts } from "./release-facts";
import { CriteriaPane, OverviewPane } from "./release-panes";

expect.extend(matchers);

const decide = vi.fn();
const cut = vi.fn();
vi.mock("../hooks", () => ({
  useReleaseDecision: () => ({ mutate: decide, isPending: false, error: null }),
  useCutRelease: () => ({ mutate: cut, isPending: false, error: null }),
}));

const person = { id: "u-1", name: "Minh", kind: "human" as const };

const base: ReleaseDetail = {
  key: "1.4.0",
  version: "1.4.0",
  runId: "run-1",
  state: "awaiting_approval",
  current: false,
  attention: "you",
  waiting: { kind: "you", who: "You", act: "approve or return 1.4.0", rule: "an admin other than Lan approves" },
  headline: "Timeline check-in per reminder",
  issueCount: 1,
  requirements: ["REQ-12"],
  criteria: { proven: 1, failing: 0, open: 1, total: 2 },
  contents: [],
  owner: null,
  ownerAct: null,
  can: { cut: false, decide: true },
  openedAt: "2026-10-03T09:00:00.000Z",
  releasedAt: null,
  at: "2026-10-03T09:00:00.000Z",
  issues: [],
  requirementsCompleted: [
    {
      key: "REQ-12",
      title: "Patient timeline",
      state: "in_delivery",
      completes: false,
      advances: [{ code: "BC-2", verdict: "passing" }],
      remaining: { issues: ["ISS-9"], criteria: ["BC-3"] },
    },
  ],
  issueCriteria: [
    {
      key: "ISS-1",
      title: "Timeline",
      criteria: [
        { n: 1, statement: "Shows state", standing: "pass", bc: "BC-2", identity: "Read from production", reason: null, judgedAt: null, judgedBy: null },
        { n: 2, statement: "Sorts by time", standing: "unjudged", bc: null, identity: null, reason: null, judgedAt: null, judgedBy: null },
      ],
    },
  ],
  notes: { sections: [], withoutNotes: [] },
  gates: [
    {
      code: "CONTRACT_PROVIDER_NOT_LIVE",
      kind: "blocker",
      title: "Provider not live yet",
      sentence: "ISS-1 waits on billing 2.0.0 or later.",
      detail: "raw refusal text",
      issues: ["ISS-1"],
    },
  ],
  approval: {
    id: "ap-1",
    requestedBy: { id: "u-2", name: "Lan", kind: "human" },
    requestedAt: "2026-10-03T09:00:00.000Z",
    evidence: { environment: "preview", commit: "b77e012aaaa", reading: "passed" },
    note: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    reason: null,
  },
  approvals: [],
  approvers: [person],
  approvalRequired: true,
  attempts: [],
  bounds: { holding: false, bounds: [] },
  production: null,
  head: "b77e012aaaa",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReleaseActions", () => {
  it("offers Approve release as the primary act and Return with reason beside it to the admin who may decide", () => {
    render(<ReleaseActions projectId="p" r={base} />);
    fireEvent.click(screen.getByTestId("release-approve"));
    expect(decide).toHaveBeenCalledWith({ runId: "run-1", approvalId: "ap-1", body: { decision: "approve" } });
    expect(screen.getByTestId("release-return")).toHaveTextContent("Return with reason");
  });

  it("offers no act to a viewer who may not decide or cut", () => {
    render(<ReleaseActions projectId="p" r={{ ...base, can: { cut: false, decide: false } }} />);
    expect(screen.queryByTestId("release-actions")).toBeNull();
  });

  it("offers Cut on a draft and sends the issues it holds", () => {
    const draft: ReleaseDetail = {
      ...base,
      state: "draft",
      runId: null,
      approval: null,
      can: { cut: true, decide: false },
      issues: [{ id: "i-1", key: "ISS-1", title: "t", status: "awaiting_release", section: null, requirement: null, proof: "open", criteria: base.criteria, waiting: base.waiting }],
    };
    render(<ReleaseActions projectId="p" r={draft} />);
    fireEvent.click(screen.getByTestId("release-cut"));
    expect(cut).toHaveBeenCalledWith(["i-1"]);
  });
});

describe("a release read in plain words", () => {
  it("shows the gate as a sentence and keeps the code behind its tooltip, not on the page", () => {
    render(<OverviewPane r={base} slug="hop" all={[base]} />);
    expect(screen.getByText(/waits on billing 2.0.0 or later/)).toBeInTheDocument();
    expect(screen.queryByText(/CONTRACT_PROVIDER_NOT_LIVE/)).toBeNull();
    expect(screen.getByTestId("release-gate")).toHaveAttribute("data-code", "CONTRACT_PROVIDER_NOT_LIVE");
  });

  it("says what stands between a requirement and done", () => {
    render(<OverviewPane r={base} slug="hop" all={[base]} />);
    expect(screen.getByTestId("completes")).toHaveTextContent("Partial");
    expect(screen.getByTestId("release-requirements")).toHaveTextContent("Still open: ISS-9. Not yet passing: BC-3.");
  });

  it("names whom the banner waits on", () => {
    render(<ReleaseBanner r={base} />);
    expect(screen.getByTestId("wait-banner")).toHaveTextContent("Waiting on you: approve or return 1.4.0");
  });

  it("draws criteria per issue with the verdict as a badge", () => {
    render(<CriteriaPane r={base} />);
    expect(screen.getAllByTestId("release-criterion")).toHaveLength(2);
    expect(screen.getByText("Sorts by time")).toBeInTheDocument();
  });

  it("holds Approval, Run and Status in the rail, with the approver named by name", () => {
    render(<ReleaseFacts r={base} />);
    expect(screen.getByTestId("facts-approval")).toHaveTextContent("Minh");
    expect(screen.getByTestId("facts-run")).toHaveTextContent("b77e012");
    expect(screen.getByTestId("release-facts")).toHaveTextContent("1 of 2 proven");
  });

  it("says plainly that no run has recorded a check yet", () => {
    render(<ChecksPane r={{ ...base, approval: null }} />);
    expect(screen.getByText(/No run has recorded a check/)).toBeInTheDocument();
  });
});
