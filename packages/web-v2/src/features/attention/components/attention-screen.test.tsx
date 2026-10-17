// @vitest-environment jsdom
//
// ISS-1156 — the Attention inbox is the attention list and the offline runners together. It says
// "Inbox zero" only once both have been read and hold nothing; a runner list that did not load is
// named, and an empty list is then not read as nothing owed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

type Read = "pending" | "failed" | "read";
const state: { read: Read; devicesRead: Read; offline: unknown[]; awaiting: unknown[] } = {
  read: "read",
  devicesRead: "read",
  offline: [],
  awaiting: [],
};
const refetch = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects: [], projectSlugs: new Set<string>() }),
}));
vi.mock("../hooks", () => ({
  useAttention: () => ({
    view: {
      needsReview: [],
      awaitingInput: state.awaiting,
      mentions: [],
      failedJobs: [],
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      projectTotals: {},
      offlineRunners: state.offline,
    },
    read: state.read,
    devicesRead: state.devicesRead,
    error: new Error("attention down"),
    devicesError: new Error("devices down"),
    refetch,
  }),
}));

const { AttentionScreen } = await import("./attention-screen");

afterEach(() => {
  cleanup();
  state.read = "read";
  state.devicesRead = "read";
  state.offline = [];
  state.awaiting = [];
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
    expect(refetch).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText(/however long each has waited/u)).toBeInTheDocument();
  });
});

