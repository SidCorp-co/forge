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
const state: { read: Read; devicesRead: Read; offline: unknown[] } = { read: "read", devicesRead: "read", offline: [] };
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
      awaitingInput: [],
      mentions: [],
      failedJobs: [],
      pendingSkillUpdates: [],
      unseenDrafts: [],
      unseenDraftsTotal: 0,
      projectTotals: {},
      total: state.offline.length,
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
