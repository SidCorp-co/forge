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
  merged.total = merged.unseenDrafts.length + merged.needsReview.length;
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

  // cm:guard the badge reports MATCHES, not rows sent. A 22-deep backlog badged "20" is the failure this bucket exists to remove, one layer up.
  it("badges the unclipped total and says the list is clipped", () => {
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    render(<AttentionScreen />);
    expect(screen.getByText("22")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/Showing 20 of 22/)).toBeInTheDocument();
  });

  // cm:guard a group that GROWS past the threshold between renders must collapse too — seeding the open flag from the first render is the easy way to get this wrong, and the symptom is 20 rows appearing where 3 were.
  it("collapses a group that grows past the threshold after first render", () => {
    view = emptyView({ unseenDrafts: drafts(3), unseenDraftsTotal: 3 });
    const { rerender } = render(<AttentionScreen />);
    expect(screen.getByText("proposal 900")).toBeInTheDocument();
    view = emptyView({ unseenDrafts: drafts(20), unseenDraftsTotal: 22 });
    rerender(<AttentionScreen />);
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("proposal 900")).toBeNull();
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
