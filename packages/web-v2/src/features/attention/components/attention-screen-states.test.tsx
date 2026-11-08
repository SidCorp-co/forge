// The attention screen draws the loader, then the failure (always with Retry), each centred in a
// 60vh shell, and only then the inbox. Pinned before the two branches moved onto QueryBoundary.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refetch = vi.fn();
const empty = { needsYou: [], mentions: [], failedJobs: [], channelGates: [], statusReports: [], offlineRunners: [], total: 0 };
const hook = { view: empty, isLoading: false, isError: false, error: null as unknown, refetch };

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/projects/hooks", () => ({ useOrgScopedProjects: () => ({ projects: [], projectSlugs: new Set<string>() }) }));
vi.mock("../hooks", () => ({ useAttention: () => hook }));

import { APPROVALS_READ } from "@/test/approvals-read";
import { renderWithQuery } from "@/test/render";
import { AttentionScreen } from "./attention-screen";

// the 60vh shell, on the spacing scale (`lib/api/query-boundary.tsx` HEIGHTS)
const SHELL = ".min-h-128.place-items-center";

beforeEach(() => {
  refetch.mockClear();
  Object.assign(hook, { isLoading: false, isError: false, error: null });
});
afterEach(cleanup);

describe("the attention screen's states", () => {
  it("draws the loader in a 60vh shell", () => {
    hook.isLoading = true;
    const { container } = render(<AttentionScreen />);
    expect(screen.getByText("loading attention…")).toBeTruthy();
    expect(container.querySelector(SHELL)).not.toBeNull();
  });

  it("draws the failure in the same shell, and Retry refetches even for a failure no second attempt can fix", () => {
    Object.assign(hook, { isError: true, error: new ApiError(403, "boom") });
    const { container } = render(<AttentionScreen />);
    expect(container.textContent).toContain("boom");
    expect(container.querySelector(SHELL)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("draws the inbox, with no loader or failure, once the query has settled", () => {
    const { container } = render(<AttentionScreen />);
    expect(container.querySelector(SHELL)).toBeNull();
    expect(screen.getByText("Attention")).toBeTruthy();
  });

  // ISS-1137: each decision is its question and its buttons; what it changes, its impact and the
  // recommendation open on its own page, never inline under every row (ui-copy-rule)
  it("draws each project's decisions as their question and buttons, their consequences on demand", () => {
    hook.view = { ...empty, needsYou: [{ projectSlug: "hop", projectName: "Hop", total: APPROVALS_READ.total, decisions: APPROVALS_READ.decisions.slice(0, 3), owed: APPROVALS_READ.notDecisions }], counts: { mentions: 0, failedJobs: 0, channelGates: 0, statusReports: 0, offlineRunners: 0 }, total: APPROVALS_READ.total } as unknown as typeof empty;
    try {
      const { container } = renderWithQuery(<AttentionScreen />);
      expect(screen.getAllByTestId("needs-you-decision").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Return" })).toBeTruthy();
      expect(container.textContent).not.toContain("It waits on this until it is decided");
      expect(container.textContent).not.toContain("No recommendation");
      expect(screen.queryByTestId("needs-you-left-out")).toBeNull();
    } finally {
      hook.view = empty;
    }
  });
});
