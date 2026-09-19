// @vitest-environment jsdom

/**
 * The unseen-drafts group has to be countable without burying the buckets
 * beside it (ISS-881). What can fail here: a long group rendering expanded,
 * the badge counting the CAPPED list instead of the real backlog, and the
 * disclosure not being a real button.
 */
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, AttentionView } from "./types";

expect.extend(matchers);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

let view: AttentionView;
vi.mock("./hooks", () => ({
  useAttention: () => ({
    view,
    total: view.total,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({
    projects: [{ id: "p1", slug: "forge-dev" }],
    projectSlugs: new Set(["forge-dev"]),
  }),
}));

const { AttentionScreen } = await import("./components/attention-screen");

function drafts(n: number, from = 900): AttentionItem[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "unseen_draft" as const,
    title: `proposal ${from - i}`,
    link: `/projects/forge-dev/issues/doc-${from - i}`,
    since: "2026-08-29T16:00:00.000Z",
    issueRef: `ISS-${from - i}`,
    status: "draft",
    projectSlug: "forge-dev",
  }));
}

function emptyView(over: Partial<AttentionView> = {}): AttentionView {
  const base: AttentionView = {
    needsReview: [],
    awaitingInput: [],
    mentions: [],
    failedJobs: [],
    pendingSkillUpdates: [],
    unseenDrafts: [],
    unseenDraftsTotal: 0,
    offlineRunners: [],
    total: 0,
  };
  const merged = { ...base, ...over };
  merged.total =
    merged.unseenDrafts.length + merged.needsReview.length + merged.offlineRunners.length;
  return merged;
}

afterEach(() => {
  cleanup();
  push.mockReset();
});

describe("AttentionScreen · unseen drafts", () => {
  it("renders a short group expanded", () => {
    view = emptyView({ unseenDrafts: drafts(3), unseenDraftsTotal: 3 });
    render(<AttentionScreen />);
    expect(screen.getByText("Unseen drafts")).toBeInTheDocument();
    expect(screen.getByText("proposal 900")).toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("starts a long group collapsed, and the rows appear on one keyboard-reachable toggle", () => {
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    render(<AttentionScreen />);
    const toggle = screen.getByRole("button", { expanded: false });
    expect(screen.queryByText("proposal 900")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("proposal 900")).toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toBe(toggle);
  });

  it("badges the unclipped total and says the list is clipped", () => {
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    render(<AttentionScreen />);
    expect(screen.getByText("22")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/Showing 20 of 22/)).toBeInTheDocument();
  });

  it("collapses a group that grows past the threshold after first render", () => {
    view = emptyView({ unseenDrafts: drafts(3), unseenDraftsTotal: 3 });
    const { rerender } = render(<AttentionScreen />);
    expect(screen.getByText("proposal 900")).toBeInTheDocument();
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    rerender(<AttentionScreen />);
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("proposal 900")).toBeNull();
  });

  it("shows the rows again when a collapsed group shrinks back under the threshold", () => {
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    const { rerender } = render(<AttentionScreen />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    view = emptyView({ unseenDrafts: drafts(3), unseenDraftsTotal: 3 });
    rerender(<AttentionScreen />);
    expect(screen.getByText("proposal 900")).toBeInTheDocument();
  });

  it("keeps the group title a heading with the disclosure inside it, not the reverse", () => {
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    render(<AttentionScreen />);
    const heading = screen.getByRole("heading", { name: /Unseen drafts/ });
    const toggle = screen.getByRole("button", { expanded: false });
    expect(heading.contains(toggle)).toBe(true);
    expect(toggle.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
  });

  it("leaves other buckets expanded however long they get", () => {
    view = emptyView({
      offlineRunners: Array.from({ length: 9 }, (_, i) => ({
        kind: "runner_offline" as const,
        title: `runner-${i} is offline`,
        link: "/runners",
        since: "2026-08-29T16:00:00.000Z",
        status: "offline",
      })),
    });
    render(<AttentionScreen />);
    expect(screen.getByText("runner-8 is offline")).toBeInTheDocument();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("hides the group entirely when there is nothing unseen", () => {
    view = emptyView({
      needsReview: [
        {
          kind: "needs_review",
          title: "review me",
          link: "/projects/forge-dev/issues/doc-1",
          since: "2026-08-29T16:00:00.000Z",
          projectSlug: "forge-dev",
        },
      ],
    });
    render(<AttentionScreen />);
    expect(screen.queryByText("Unseen drafts")).toBeNull();
    expect(screen.getByText("review me")).toBeInTheDocument();
  });
});
