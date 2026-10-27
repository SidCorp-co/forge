// @vitest-environment jsdom
//
// ISS-1156 — an empty list is "All caught up" only where nothing is owed beyond it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusChip } from "@/design/primitives/status-chip";
import { AttentionQueue } from "./attention-queue";

expect.extend(matchers);
afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("the Needs your attention list with nothing in it", () => {
  it("says all caught up where nothing is owed", () => {
    render(<AttentionQueue items={[]} cut={null} slug="pair" now={0} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("does not say all caught up where more is owed than the list reached", () => {
    render(<AttentionQueue items={[]} cut={{ shown: 0, whole: 3, peopleCut: true }} slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByText("Nothing is listed to act on here.")).toBeInTheDocument();
    expect(screen.getByText(/Showing 0 of 3\./u)).toBeInTheDocument();
  });

  // ISS-1229 r14, the master on the shots: the footer read "Every blocked on a person issue is in Issues".
  it("says where the rest are in a sentence", () => {
    render(<AttentionQueue items={[]} cut={{ shown: 0, whole: 3, peopleCut: true }} slug="pair" now={0} />);
    const link = screen.getByRole("link", { name: "Every issue blocked on a person is in Issues" });
    expect(link).toHaveAttribute("href", "/projects/pair/issues?filter=blocked_on_person");
  });

  it("does not say all caught up where the response was refused", () => {
    render(<AttentionQueue items={[]} cut={null} refusal="Needs you cannot say how much it leaves out." slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByTestId("attention-refusal")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is listed to act on here.")).toBeNull();
  });

  it("does not say all caught up while a read beside its own has not arrived", () => {
    render(<AttentionQueue items={[]} cut={null} shape="unread" slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.getByText("Not all of this page is read yet")).toBeInTheDocument();
    expect(screen.getByText(/not an all clear/u)).toBeInTheDocument();
  });

  it("keeps the cut under an unread page and says nothing is listed to act on only where the read is whole", () => {
    render(<AttentionQueue items={[]} cut={{ shown: 0, whole: 3, peopleCut: true }} shape="unread" slug="pair" now={0} />);
    expect(screen.queryByText("All caught up")).toBeNull();
    expect(screen.queryByText("Nothing is listed to act on here.")).toBeNull();
    expect(screen.getByText(/not all of this page is read yet/iu)).toBeInTheDocument();
    expect(screen.getByText(/Showing 0 of 3\./u)).toBeInTheDocument();
  });

  it.each(["quiet", "working"] as const)("says all caught up under a %s page", (shape) => {
    render(<AttentionQueue items={[]} cut={null} shape={shape} slug="pair" now={0} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  // ISS-1229 r13 repair: "Nothing here needs you." under a red "Action needed" contradicted it.
  it("is not shown under a degraded page it holds nothing of, rather than say nothing needs you", () => {
    const { container } = render(<AttentionQueue items={[]} cut={null} shape="degraded" slug="pair" now={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the stuck issues the headline counts, each by what its notice says, under a degraded page", () => {
    render(
      <AttentionQueue
        items={[]}
        cut={null}
        shape="degraded"
        slug="pair"
        now={0}
        stuck={{
          total: 3,
          refs: [
            { issueId: "PAIR-41", documentId: "d41", title: "Pick a carrier", kind: "waiting" },
            { issueId: "PAIR-50", documentId: "d50", title: "Export invoices", kind: "idle" },
          ],
        }}
      />,
    );
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(list).not.toHaveTextContent("Nothing here needs you");
    expect(list).toHaveTextContent("PAIR-41Pick a carrierHas been waiting for you for over six hours");
    expect(list).toHaveTextContent("PAIR-50Export invoicesIs in a live status with no live work behind it");
    expect(list).toHaveTextContent("And 1 more stuck. All 3 stuck issues are in Issues.");
    // The link lands on the Issues list of exactly the stuck issues, not an unfiltered one (ISS-1229 r14).
    expect(screen.getByRole("link", { name: "All 3 stuck issues are in Issues" })).toHaveAttribute(
      "href",
      "/projects/pair/issues?stuck=1",
    );
    expect(screen.getAllByRole("button", { name: "Open issue" })).toHaveLength(2);
  });

  it("counts every row it heads in the heading, the stuck rows among them", () => {
    render(
      <AttentionQueue
        items={[
          {
            key: "q",
            actionKind: "input",
            actionLabel: "Provide info",
            title: "Which carrier?",
            issueRef: "PAIR-41",
            link: "/projects/pair/issues/d41",
            since: new Date(0).toISOString(),
          },
        ]}
        cut={null}
        shape="degraded"
        slug="pair"
        now={0}
        stuck={{
          total: 2,
          refs: [
            { issueId: "PAIR-50", documentId: "d50", title: "Export invoices", kind: "idle" },
            { issueId: "PAIR-53", documentId: "d53", title: "Rotate the SMTP key", kind: "idle" },
          ],
        }}
      />,
    );
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(list).toHaveTextContent(/^Needs your attention3/u);
    expect(list).toHaveTextContent("Also reported stuck");
    expect(list).not.toHaveTextContent(/Also reported stuck ·/u);
  });

  // ISS-1229 r15, judge-38 on 81: two Waiting parks became stuck and were listed as plain parks, the
  // overflow said 9 more where 7 were missing, and "Also reported stuck · 14" read as 14 beyond them.
  it("tells a stuck park by its notice, says truly how many stuck issues it leaves out, and heads the whole", () => {
    const park = (n: number) => ({
      key: `parked-${n}`,
      actionKind: "parked" as const,
      actionLabel: "Open issue",
      title: `Park ${n}`,
      detail: "Blocked on a person — Waiting",
      issueRef: `ISS-${n}`,
      link: `/projects/pair/issues/d${n}`,
      stuckKind: "waiting" as const,
    });
    render(
      <AttentionQueue
        items={[park(11), park(12)]}
        cut={{ shown: 7, whole: 14, peopleCut: false }}
        whole={14}
        shape="degraded"
        slug="pair"
        now={0}
        stuck={{
          total: 14,
          refs: [10, 9, 8, 4, 2].map((n) => ({
            issueId: `ISS-${n}`,
            documentId: `d${n}`,
            title: `Stuck ${n}`,
            kind: "idle" as const,
          })),
        }}
      />,
    );
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(list).toHaveTextContent(/^Needs your attention14/u);
    expect(screen.getAllByText("Has been waiting for you for over six hours")).toHaveLength(2);
    expect(list).not.toHaveTextContent("Blocked on a person — Waiting");
    expect(screen.getAllByText("Stuck")).toHaveLength(7);
    expect(list).toHaveTextContent("And 7 more stuck. All 14 stuck issues are in Issues.");
    expect(list).not.toHaveTextContent(/9 more|· 14/u);
    expect(list).toHaveTextContent("Showing 7 of 14.");
  });

  // ISS-1229 r16, judge-41 on criterion 98: the Member's parks read to the Owner as waiting for the
  // Owner. A park somebody else owes names them, whether listed as a park or as a stuck row.
  it("names who another person's park waits for, never the reader", () => {
    render(
      <AttentionQueue
        items={[
          {
            key: "parked-d2",
            actionKind: "parked" as const,
            actionLabel: "Open issue",
            title: "Choose a carrier",
            detail: "Blocked on a person — Waiting",
            issueRef: "ISS-2",
            link: "/projects/pair/issues/d2",
            stuckKind: "waiting_on_others" as const,
            stuckOwedBy: "Mai",
          },
        ]}
        cut={{ shown: 2, whole: 2, peopleCut: false }}
        whole={2}
        shape="degraded"
        slug="pair"
        now={0}
        stuck={{
          total: 2,
          refs: [
            { issueId: "ISS-2", documentId: "d2", title: "Choose a carrier", kind: "waiting_on_others" as const, owedBy: "Mai" },
            { issueId: "ISS-3", documentId: "d3", title: "Price list", kind: "waiting_on_others" as const, owedBy: "Bao" },
          ],
        }}
      />,
    );
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(screen.getByText("Has been waiting for Mai for over six hours")).toBeInTheDocument();
    expect(screen.getByText("Has been waiting for Bao for over six hours")).toBeInTheDocument();
    expect(list).not.toHaveTextContent(/waiting for you/u);
  });

  // ISS-1229 r15, the master's ruling: an answer owed outranks a failed job, which outranks a stuck
  // reason; a row takes the highest and names the next one down under it, and a failed job's issue is
  // counted as that, never among the stuck issues too.
  it("heads each row by its highest reason and names the next one under it", () => {
    const base = { since: new Date(0).toISOString() };
    render(
      <AttentionQueue
        items={[
          {
            ...base,
            key: "retry",
            actionKind: "retry",
            actionLabel: "Retry job",
            title: "Export the March invoices",
            detail: "Issue work failed: Session lost",
            issueRef: "ISS-15",
            link: "/projects/pair/issues/d15",
            stuckKind: "idle",
          },
          {
            ...base,
            key: "input",
            actionKind: "input",
            actionLabel: "Provide info",
            title: "Which carrier?",
            issueRef: "ISS-21",
            link: "/projects/pair/issues/d21",
            owed: true,
            failedJob: { jobType: "drive", failure: "session_lost" },
            stuckKind: "waiting",
          },
          {
            ...base,
            key: "own-park",
            actionKind: "parked",
            actionLabel: "Open issue",
            title: "Pick the carrier",
            detail: "Blocked on a person — Waiting",
            issueRef: "ISS-22",
            link: "/projects/pair/issues/d22",
            owed: true,
            stuckKind: "waiting",
          },
          {
            ...base,
            key: "their-park",
            actionKind: "parked",
            actionLabel: "Open issue",
            title: "Close the ledger",
            detail: "Blocked on a person — Waiting",
            issueRef: "ISS-23",
            link: "/projects/pair/issues/d23",
            stuckKind: "owed_close",
          },
        ]}
        cut={null}
        shape="degraded"
        slug="pair"
        now={0}
        stuck={{
          total: 5,
          refs: [21, 22, 23, 24].map((n) => ({
            issueId: `ISS-${n}`,
            documentId: `d${n}`,
            title: `Stuck ${n}`,
            kind: "waiting" as const,
          })),
        }}
      />,
    );
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(screen.getByText("Issue work failed: Session lost. It is in a live status with no live work behind it.")).toBeInTheDocument();
    expect(screen.getByText("A job on it failed: Session lost.")).toBeInTheDocument();
    expect(
      screen.getByText("Blocked on a person — Waiting. It has been waiting for you for over six hours."),
    ).toBeInTheDocument();
    expect(screen.getByText("Was marked merged and never closed")).toBeInTheDocument();
    // Another person's park and the one stuck row left unlisted wear the Stuck tag; the owed rows do not.
    expect(screen.getAllByText("Stuck")).toHaveLength(2);
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getAllByText("Awaiting")).toHaveLength(1);
    // Five stuck: four on the page, ISS-15 not among them, so one is left out.
    expect(list).toHaveTextContent("And 1 more stuck.");
  });

  it("names a stuck issue once where it is already listed to act on", () => {
    render(
      <AttentionQueue
        items={[
          {
            key: "q",
            actionKind: "input",
            actionLabel: "Provide info",
            title: "Which carrier?",
            issueRef: "PAIR-41",
            link: "/projects/pair/issues/d41",
            since: new Date(0).toISOString(),
          },
        ]}
        cut={null}
        shape="degraded"
        slug="pair"
        now={0}
        stuck={{ total: 1, refs: [{ issueId: "PAIR-41", documentId: "d41", title: "Pick a carrier", kind: "waiting" }] }}
      />,
    );
    expect(screen.getAllByText("PAIR-41")).toHaveLength(1);
  });
});

// ISS-1228 round 9 (judge-22): at 390 a row was cut short and showed no age. Each row reads whole,
// wrapping rather than truncating, with its age beside it.
describe("a Needs you row at a phone's width", () => {
  const NOW = Date.parse("2026-10-16T10:00:00.000Z");
  const title = "run: ISS-9 waits on you — approve the database restore in Coolify before the window closes";
  const items = [
    {
      key: "session-s9",
      actionKind: "session" as const,
      actionLabel: "Open session",
      title,
      issueRef: "ISS-9",
      link: "/projects/pair/agents/s9",
      since: new Date(NOW - 3 * 3_600_000).toISOString(),
    },
  ];

  it("shows the whole title, wrapping instead of truncating, and its age", () => {
    render(<AttentionQueue items={items} cut={null} slug="pair" now={NOW} />);
    const row = screen.getByText(title);
    expect(row.className).not.toMatch(/\b(truncate|line-clamp-\d|whitespace-nowrap|overflow-hidden)\b/);
    expect(row.className).toMatch(/\bbreak-words\b/);
    const li = row.closest("li");
    expect(li?.className).toMatch(/\bflex-wrap\b/);
    expect(li?.querySelector("[data-testid=age-chip]")).toHaveTextContent("3h");
  });
});

// ISS-1228 round 9 (coordinator): the Waiting chip wore the Working sparkle. A chip that shows a
// session's status draws the mark the session chips give that status.
describe("the Needs you chip of a session waiting on you", () => {
  const drawing = (root: ParentNode | null) => {
    const svg = root?.querySelector("svg");
    return svg ? [...svg.children].map((c) => c.outerHTML).join("") : "";
  };
  const chipMark = (status: "waiting" | "running") => {
    const { container } = render(<StatusChip domain="session" status={status} />);
    const mark = drawing(container);
    cleanup();
    return mark;
  };

  it("draws the session chips' Waiting mark, never the Working sparkle", () => {
    const waiting = chipMark("waiting");
    const working = chipMark("running");
    const item = {
      key: "session-s1",
      actionKind: "session" as const,
      actionLabel: "Open session",
      title: "run: ISS-1 waits on you",
      issueRef: "ISS-1",
      link: "/projects/pair/agents/s1",
      since: new Date(0).toISOString(),
    };
    render(<AttentionQueue items={[item]} cut={null} slug="pair" now={60_000} />);
    const tag = screen.getByText("Waiting").parentElement;
    expect(drawing(tag)).toBe(waiting);
    expect(drawing(tag)).not.toBe(working);
  });
});

// ISS-1229 r16, judge-41: "Approve & retry" opened the issue page and retried nothing. A failed job's
// button retries the job; a failed row with no job to retry says where it goes instead.
describe("a failed job's row", () => {
  const failed = {
    since: new Date(0).toISOString(),
    key: "retry-1",
    actionKind: "retry" as const,
    actionLabel: "Retry job",
    title: "Export the March invoices",
    issueRef: "ISS-15",
    link: "/projects/pair/issues/d15",
  };

  it("retries the job, and goes nowhere", () => {
    push.mockClear();
    const onRetryJob = vi.fn();
    render(
      <AttentionQueue items={[{ ...failed, jobId: "j-15" }]} cut={null} onRetryJob={onRetryJob} slug="pair" now={0} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
    expect(onRetryJob).toHaveBeenCalledWith("j-15");
    expect(push).not.toHaveBeenCalled();
  });

  it("waits while its retry is on the way", () => {
    render(
      <AttentionQueue
        items={[{ ...failed, jobId: "j-15" }]}
        cut={null}
        onRetryJob={() => {}}
        retryingJobId="j-15"
        slug="pair"
        now={0}
      />,
    );
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled();
  });

  it("says Open issue where it has no job to retry, and opens it", () => {
    push.mockClear();
    render(<AttentionQueue items={[failed]} cut={null} onRetryJob={() => {}} slug="pair" now={0} />);
    expect(screen.queryByRole("button", { name: "Retry job" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open issue" }));
    expect(push).toHaveBeenCalledWith("/projects/pair/issues/d15");
  });
});
