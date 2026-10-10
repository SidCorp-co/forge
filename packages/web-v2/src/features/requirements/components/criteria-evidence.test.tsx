// A criterion's evidence reads in a BA's terms first (what was judged, when, which work), with the
// issue key as a secondary link; the inline issue link leads with the title.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CriteriaChecklist } from "./requirement-proof";
import type { RequirementDetail } from "../types";

/** jsdom has no object URLs: hand out a stable one per file. */
function stubObjectUrls() {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:clip-${++n}`);
  URL.revokeObjectURL = vi.fn();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const d = {
  criteria: [{ code: "BC-1", form: "plain", sinceRevision: 1 }],
  standing: {
    shownRevision: 1,
    coverage: [
      {
        code: "BC-1",
        body: "Checkout totals include tax.",
        verdict: "passing",
        issues: [
          { issueId: "i1", displayId: "ISS-12", title: "Add tax to checkout", status: "closed", tone: "done", note: null, files: [], criterion: 2, verdict: "pass", verdictAt: "2026-10-05T09:30:00Z", stale: false },
        ],
      },
    ],
  },
} as unknown as RequirementDetail;

describe("a criterion's evidence", () => {
  it("says what passed and when, with the issue key secondary", async () => {
    render(<CriteriaChecklist d={d} slug="epod" />);
    await userEvent.click(screen.getByText(/What the evidence says/));
    const row = screen.getByTestId("criterion-evidence-row");
    expect(row).toHaveTextContent("Pass");
    expect(row.querySelector("span[title]")).not.toBeNull();
    const key = within(row).getByRole("link", { name: "ISS-12" });
    expect(key).toHaveAttribute("href", "/projects/epod/issues/ISS-12");
    expect(key.className).toContain("text-subtle");
  });

  // REQ-40 BC-4 (QA 0.4.0-dev.218): the row printed the issue title where the verdict's own evidence
  // note belongs, and the clip the verdict kept was not reachable from the criterion
  it("shows the verdict's own evidence note, not the issue title, and plays the clip it kept", async () => {
    const kept = {
      criteria: [{ code: "BC-1", form: "plain", sinceRevision: 1 }],
      standing: {
        shownRevision: 1,
        coverage: [
          {
            code: "BC-1",
            body: "Each release has a page.",
            verdict: "passing",
            issues: [
              {
                issueId: "i1",
                displayId: "ISS-492",
                title: "A release page a person can read",
                status: "developed",
                tone: "done",
                criterion: 1,
                verdict: "pass",
                verdictAt: "2026-10-09T10:00:00Z",
                note: "Opened 0.4.0 and read its version, date, commit and approver.",
                files: [{ attachmentId: "00000000-0000-4000-8000-0000000000aa", name: "bc1-header.webm", mime: "video/webm" }],
                stale: false,
              },
            ],
          },
        ],
      },
    } as unknown as RequirementDetail;
    stubObjectUrls();
    const fetchMock = vi.fn(async () => new Response("webm", { headers: { "content-type": "video/webm" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CriteriaChecklist d={kept} slug="epod" />);
    await userEvent.click(screen.getByText(/What the evidence says/));
    const row = screen.getByTestId("criterion-evidence-row");
    expect(within(row).getByTestId("verdict-note")).toHaveTextContent("Opened 0.4.0 and read its version, date, commit and approver.");
    expect(row).not.toHaveTextContent("A release page a person can read");
    await userEvent.click(within(row).getByRole("button", { name: /Watch the clip: bc1-header.webm/ }));
    const video = await within(row).findByTestId("verdict-clip");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("src", "blob:clip-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/attachments/00000000-0000-4000-8000-0000000000aa/download");
    expect(init.credentials).toBe("include");
  });

  it("leads the inline link with the issue's title, not its key", () => {
    render(<CriteriaChecklist d={d} slug="epod" />);
    const row = screen.getByTestId("criterion-row");
    expect(within(row).getByRole("link", { name: "Add tax to checkout" })).toBeInTheDocument();
  });

  // coverage-truth: REQ-32 read 1 of 16 passing while 7 held live, and nothing on the page said which
  // verdict a BC's standing came from; each BC now names the newest verdict, the one that counts
  it("names the verdict that counts, with its issue, criterion and identity, and why one does not count", async () => {
    const OLD = "e523c4b0ff9038187ad0e7d81f69a3e087c8c252";
    const NEW = "0fecd0850aa11bb22cc33dd44ee55ff6677889900";
    const two = {
      criteria: [{ code: "BC-1", form: "plain", sinceRevision: 1 }],
      standing: {
        shownRevision: 1,
        coverage: [
          {
            code: "BC-1",
            body: "Checkout totals include tax.",
            verdict: "passing",
            counts: { issueId: "i2", displayId: "ISS-31", note: null, files: [], criterion: 4, verdict: "short", at: "2026-10-08T16:17:36Z", identity: `runtime ${NEW.slice(0, 12)}`, commit: NEW, inLiveBuild: true },
            why: null,
            issues: [
              { issueId: "i1", displayId: "ISS-12", title: "Add tax", status: "closed", tone: "done", note: null, files: [], criterion: 2, verdict: "fail", verdictAt: "2026-10-01T09:30:00Z", identity: `commit ${OLD.slice(0, 12)}`, commit: OLD, inLiveBuild: false, notCounted: `judged at commit ${OLD.slice(0, 12)}, which the live build does not hold`, stale: false },
              { issueId: "i2", displayId: "ISS-31", title: "Fix tax", status: "closed", tone: "done", note: null, files: [], criterion: 4, verdict: "short", verdictAt: "2026-10-08T16:17:36Z", identity: `runtime ${NEW.slice(0, 12)}`, commit: NEW, inLiveBuild: true, notCounted: null, stale: false },
            ],
          },
        ],
      },
    } as unknown as RequirementDetail;
    // the verdict that counts, its identity and build are agent text: the developer view's (REQ-43 BC-7)
    const { unmount } = render(<CriteriaChecklist d={two} slug="epod" />);
    expect(screen.queryByTestId("criterion-counts")).toBeNull();
    expect(screen.queryByTestId("criterion-code")).toBeNull();
    unmount();
    render(<CriteriaChecklist d={two} slug="epod" developer />);
    expect(screen.getByTestId("criterion-code")).toHaveTextContent("BC-1");
    const counts = screen.getByTestId("criterion-counts");
    expect(counts).toHaveTextContent("Counts: Short on ISS-31 criterion 4, the newest verdict");
    expect(counts).toHaveTextContent("runtime 0fecd0850aa1");
    await userEvent.click(screen.getByText(/What the evidence says/));
    const [old, fresh] = screen.getAllByTestId("criterion-evidence-row");
    expect(old).toHaveTextContent("commit e523c4b0ff90");
    expect(old).toHaveTextContent("does not count: judged at commit e523c4b0ff90, which the live build does not hold");
    expect(fresh).not.toHaveTextContent("does not count");
  });

  // ISS-489 r2: "Stale" meant an earlier wording and a build the live one lacks alike, and the reason
  // sat only inside the evidence expander; each now has its own word and its reason on the row
  it("gives an earlier wording and another build each its own word, with its reason on the row", () => {
    const two = {
      criteria: [
        { code: "BC-10", form: "plain", sinceRevision: 1 },
        { code: "BC-11", form: "plain", sinceRevision: 1 },
      ],
      standing: {
        shownRevision: 2,
        coverage: [
          {
            code: "BC-10",
            body: "One.",
            verdict: "stale",
            counts: null,
            why: "ISS-7 trace only an earlier wording of this criterion, so no verdict on them counts: tie it again from the issue's Criteria tab, then judge it",
            issues: [{ issueId: "i7", displayId: "ISS-7", title: "Seven", status: "closed", tone: "done", note: null, files: [], criterion: 1, verdict: "pass", verdictAt: "2026-10-01T09:30:00Z", identity: "commit aaaaaaaaaaaa", commit: "a".repeat(40), inLiveBuild: null, notCounted: null, stale: true }],
          },
          {
            code: "BC-11",
            body: "Two.",
            verdict: "not_live",
            counts: null,
            why: "judged only at builds the live one does not hold (ISS-8 criterion 1: commit bbbbbbbbbbbb): judge it again on the live build",
            issues: [{ issueId: "i8", displayId: "ISS-8", title: "Eight", status: "closed", tone: "done", note: null, files: [], criterion: 1, verdict: "pass", verdictAt: "2026-10-01T09:30:00Z", identity: "commit bbbbbbbbbbbb", commit: "b".repeat(40), inLiveBuild: false, notCounted: "judged at commit bbbbbbbbbbbb, which the live build does not hold", stale: false }],
          },
        ],
      },
    } as unknown as RequirementDetail;
    render(<CriteriaChecklist d={two} slug="epod" />);
    const [earlier, other] = screen.getAllByTestId("criterion-row");
    expect(within(earlier as HTMLElement).getByTestId("verdict-dot")).toHaveAccessibleName("Stale");
    expect(within(earlier as HTMLElement).getByTestId("criterion-why")).toHaveTextContent("tie it again from the issue's Criteria tab");
    expect(within(other as HTMLElement).getByTestId("verdict-dot")).toHaveAccessibleName("Not live");
    expect(within(other as HTMLElement).getByTestId("criterion-why")).toHaveTextContent("judged only at builds the live one does not hold");
  });

  it("names no counting verdict where none is judged", () => {
    render(<CriteriaChecklist d={d} slug="epod" />);
    expect(screen.queryByTestId("criterion-counts")).toBeNull();
  });

  it("names why the accepted breakdown left a gap without an issue (R-6)", () => {
    const gap = {
      criteria: [{ code: "BC-2", form: "plain", sinceRevision: 1 }],
      standing: {
        shownRevision: 1,
        facts: { issuesTotal: 1 },
        coverage: [
          { code: "BC-2", body: "Refunds post the same day.", verdict: "gap", issues: [], uncoveredReason: "the bank's batch decides this" },
        ],
      },
    } as unknown as RequirementDetail;
    render(<CriteriaChecklist d={gap} slug="epod" />);
    expect(screen.getByTestId("criterion-uncovered")).toHaveTextContent(
      "Left without an issue by the accepted breakdown: the bank's batch decides this",
    );
  });
});
