// @vitest-environment jsdom
//
// ISS-1156 — the Attention inbox is the attention list and the offline runners together. It says
// "Inbox zero" only once both have been read and hold nothing; a runner list that did not load is
// named, and an empty list is then not read as nothing owed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

expect.extend(matchers);

type Read = "pending" | "failed" | "read";
const state: {
  read: Read;
  devicesRead: Read;
  offline: unknown[];
  awaiting: unknown[];
  awaitingTotal?: number;
  expanding?: boolean;
  failed: unknown[];
  expand: unknown[];
  devicesError?: Error;
  error?: Error;
} = {
  read: "read",
  devicesRead: "read",
  offline: [],
  awaiting: [],
  failed: [],
  expand: [],
};
const refetch = vi.fn();
const retryAttention = vi.fn();
const retryDevices = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects: [], projectSlugs: new Set<string>() }),
}));
vi.mock("../hooks", () => ({
  useAttention: (opts: { expand?: unknown[] } = {}) => {
    state.expand = [...(opts.expand ?? [])];
    return {
    view: {
      needsReview: [],
      awaitingInput: state.awaiting,
      mentions: [],
      failedJobs: state.failed,
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      bucketTotals: {
        needsReview: 0,
        awaitingInput: state.awaitingTotal ?? state.awaiting.length,
        mentions: 0,
        failedJobs: state.failed.length,
        pendingSkillUpdates: 0,
        unseenDrafts: 0,
      },
      projectTotals: {},
      total: (state.awaitingTotal ?? state.awaiting.length) + state.failed.length,
      offlineRunners: state.offline,
    },
    read: state.read,
    devicesRead: state.devicesRead,
    expanding: state.expanding ?? false,
    error: state.error ?? new Error("attention down"),
    devicesError: state.devicesError ?? new Error("devices down"),
    refetch,
    retryAttention,
    retryDevices,
    };
  },
}));

const { AttentionScreen } = await import("./attention-screen");

afterEach(() => {
  cleanup();
  state.read = "read";
  state.devicesRead = "read";
  state.devicesError = undefined;
  state.error = undefined;
  retryAttention.mockClear();
  retryDevices.mockClear();
  state.offline = [];
  state.awaiting = [];
  state.awaitingTotal = undefined;
  state.expanding = undefined;
  state.failed = [];
  state.expand = [];
  refetch.mockClear();
});

describe("the Attention inbox", () => {
  it("says Inbox zero when both reads came in and hold nothing", () => {
    render(<AttentionScreen />);
    expect(screen.getByText("Inbox zero")).toBeInTheDocument();
  });

  it("says it is loading, not Inbox zero, while the runner list is on its way", () => {
    state.devicesRead = "pending";
    render(<AttentionScreen />);
    expect(screen.queryByText("Inbox zero")).toBeNull();
    expect(screen.getByText("loading attention…")).toBeInTheDocument();
  });

  it("says it is loading, not Inbox zero, while the attention answer is on its way", () => {
    state.read = "pending";
    render(<AttentionScreen />);
    expect(screen.queryByText("Inbox zero")).toBeNull();
    expect(screen.getByText("loading attention…")).toBeInTheDocument();
  });

  it("names a failed attention read and offers a retry", () => {
    state.read = "failed";
    render(<AttentionScreen />);
    expect(screen.queryByText("Inbox zero")).toBeNull();
    expect(screen.getByText(/attention down/u)).toBeInTheDocument();
  });

  // ISS-1229 r50 (criterion 496): a reason that already ends with a stop is not given a second.
  it("closes a reason that already ends with a stop once", () => {
    state.devicesRead = "failed";
    state.devicesError = new Error("You do not have access to this.");
    render(<AttentionScreen />);
    expect(screen.getByTestId("attention-devices-unread").textContent).not.toContain("this..");
  });

  it("names both reads when both failed, and says no Inbox zero", () => {
    state.read = "failed";
    state.devicesRead = "failed";
    render(<AttentionScreen />);
    expect(screen.queryByText("Inbox zero")).toBeNull();
    expect(screen.getByText(/attention down.*Offline runners could not be read either: devices down/u)).toBeInTheDocument();
  });

  it("names a runner list that failed and does not read an empty inbox as nothing owed", () => {
    state.devicesRead = "failed";
    render(<AttentionScreen />);
    expect(screen.queryByText("Inbox zero")).toBeNull();
    const note = screen.getByTestId("attention-devices-unread");
    expect(note).toHaveTextContent("Offline runners could not be read: devices down");
    expect(note).toHaveTextContent("does not say nothing needs you");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryDevices).toHaveBeenCalledTimes(1);
    expect(retryAttention).not.toHaveBeenCalled();
  });
});

// ISS-1229 r50 review F1: the page's one Retry for both failed reads was decided by the inbox's error alone.
describe("the Attention page's Retry where both reads failed", () => {
  it.each([
    ["the inbox refused and the runners busy", 403, 503],
    ["the inbox busy and the runners refused", 503, 403],
  ])("is offered with %s, and reads again only the busy read", (_, inbox, runners) => {
    state.read = "failed";
    state.devicesRead = "failed";
    state.error = new ApiError(inbox, inbox === 403 ? "You do not have access to this." : "The server is busy.");
    state.devicesError = new ApiError(runners, runners === 403 ? "You do not have access to this." : "The server is busy.");
    render(<AttentionScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryAttention).toHaveBeenCalledTimes(inbox === 503 ? 1 : 0);
    expect(retryDevices).toHaveBeenCalledTimes(runners === 503 ? 1 : 0);
  });
});

// ISS-1229 r13 repair: the rows were bordered, rounded cards against the owner's flat rule.
describe("an Attention group", () => {
  it("lists flush rows divided by hairlines, and says what Awaiting input counts", () => {
    state.awaiting = [
      {
        kind: "awaiting_input",
        title: "Which carrier do we keep?",
        link: "/projects/shop/issues/SHOP-41",
        since: new Date(0).toISOString(),
        issueRef: "SHOP-41",
        projectSlug: "shop",
        projectName: "Shop",
      },
    ];
    render(<AttentionScreen />);
    const row = screen.getByRole("button", { name: /Which carrier do we keep\?/u });
    expect(row.className).not.toMatch(/\b(border|rounded-md|bg-surface)\b/u);
    expect(row.closest("ul")?.className).toMatch(/divide-y/u);
    expect(screen.getByText(/filed by you and assigned to nobody, however long each has waited/u)).toBeInTheDocument();
    // The bell's six-hour notice is a park's at Waiting only: Needs info and a question elsewhere are not promised one.
    expect(screen.getByText(/of those at Waiting after six hours/u)).toBeInTheDocument();
  });

  // ISS-1229 r13 repair 2: a failed job read "drive failed: …" and only its ref, not which work it was.
  it("names a failed job's row by its issue's title, with what failed after it", () => {
    state.failed = [
      {
        kind: "failed_job",
        title: "drive failed: exit 1",
        jobType: "drive",
        failure: "session_lost",
        link: "/projects/shop/issues/d50",
        since: new Date(0).toISOString(),
        issueRef: "SHOP-50",
        issueTitle: "Refund webhook retries",
        status: "failed",
        projectSlug: "shop",
        projectName: "Shop",
      },
    ];
    render(<AttentionScreen />);
    const row = screen.getByRole("button", { name: /Refund webhook retries/u });
    const named = screen.getByText("Refund webhook retries");
    const said = screen.getByText("Issue work failed: Session lost");
    expect(row).toContainElement(said);
    expect(named.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // ISS-1229 r15, the master's ruling: an issue owed an answer and holding a failed job was two rows.
  it("lists an issue owed an answer once, as that, naming its failed job under it", () => {
    state.awaiting = [
      {
        kind: "awaiting_input",
        title: "Export the March invoices",
        link: "/projects/shop/issues/d15",
        since: new Date(0).toISOString(),
        issueRef: "SHOP-15",
        projectSlug: "shop",
        projectName: "Shop",
        failedJob: { jobType: "drive", failure: "session_lost" },
      },
    ];
    render(<AttentionScreen />);
    const row = screen.getByRole("button", { name: /Export the March invoices/u });
    expect(row).toContainElement(screen.getByText("A job on it failed: Session lost."));
    expect(screen.getAllByText("SHOP-15")).toHaveLength(1);
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("names a failed job's stuck reason under its failure, in one clause", () => {
    state.failed = [
      {
        kind: "failed_job",
        title: "drive failed: exit 1",
        jobType: "drive",
        failure: "session_lost",
        link: "/projects/shop/issues/d16",
        since: new Date(0).toISOString(),
        issueRef: "SHOP-16",
        issueTitle: "Retry the payout export",
        stuckKind: "idle",
        status: "failed",
        projectSlug: "shop",
        projectName: "Shop",
      },
    ];
    render(<AttentionScreen />);
    expect(
      screen.getByText("Issue work failed: Session lost. It is in a live status with no live work behind it."),
    ).toBeInTheDocument();
  });

  // ISS-1229 r14, judge-35: 32 parks were headed 20, with nothing saying 12 more waited.
  it("heads a capped group with every item it holds, says how many it shows, and lists them all on asking", () => {
    state.awaiting = Array.from({ length: 20 }, (_, i) => ({
      kind: "awaiting_input",
      title: `Park ${i + 1}`,
      link: `/projects/shop/issues/d${i + 1}`,
      since: new Date(0).toISOString(),
      projectSlug: "shop",
    }));
    state.awaitingTotal = 32;
    render(<AttentionScreen />);
    expect(screen.getByRole("heading", { name: /^Awaiting input/u })).toHaveTextContent("Awaiting input32");
    expect(screen.getByText(/Showing 20 of 32, highest priority first\./u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 32" }));
    expect(state.expand).toEqual(["awaitingInput"]);
  });

  // The review of r14: while the whole group is read, the button went and nothing said it was coming.
  it("says the whole group is on its way while it is read, then lists it whole", () => {
    const park = (i: number) => ({
      kind: "awaiting_input",
      title: `Park ${i + 1}`,
      link: `/projects/shop/issues/d${i + 1}`,
      since: new Date(0).toISOString(),
      projectSlug: "shop",
    });
    state.awaiting = Array.from({ length: 20 }, (_, i) => park(i));
    state.awaitingTotal = 32;
    const { rerender } = render(<AttentionScreen />);
    state.expanding = true;
    fireEvent.click(screen.getByRole("button", { name: "Show all 32" }));
    expect(screen.getByRole("button", { name: "Listing all 32…" })).toBeDisabled();
    expect(screen.getByText("Park 20")).toBeInTheDocument();

    state.expanding = false;
    state.awaiting = Array.from({ length: 32 }, (_, i) => park(i));
    rerender(<AttentionScreen />);
    expect(screen.getByText("Park 32")).toBeInTheDocument();
    expect(screen.queryByText(/Showing \d+ of 32/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /all 32/u })).toBeNull();
  });
});
