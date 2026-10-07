// The attention screen draws the loader, then the failure (always with Retry), each centred in a
// 60vh shell, and only then the inbox. Pinned before the two branches moved onto QueryBoundary.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refetch = vi.fn();
const empty = { needsYou: [], mentions: [], failedJobs: [], channelGates: [], offlineRunners: [], total: 0 };
const hook = { view: empty, isLoading: false, isError: false, error: null as unknown, refetch };

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/needs-you/components/needs-you-list", () => ({ NeedsYouList: () => null }));
vi.mock("@/features/projects/hooks", () => ({ useOrgScopedProjects: () => ({ projects: [], projectSlugs: new Set<string>() }) }));
vi.mock("../hooks", () => ({ useAttention: () => hook }));

import { AttentionScreen } from "./attention-screen";

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
    expect(container.querySelector(".min-h-\\[60vh\\].place-items-center")).not.toBeNull();
  });

  it("draws the failure in the same shell, and Retry refetches even for a failure no second attempt can fix", () => {
    Object.assign(hook, { isError: true, error: new ApiError(403, "boom") });
    const { container } = render(<AttentionScreen />);
    expect(container.textContent).toContain("boom");
    expect(container.querySelector(".min-h-\\[60vh\\].place-items-center")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("draws the inbox, with no loader or failure, once the query has settled", () => {
    const { container } = render(<AttentionScreen />);
    expect(container.querySelector(".min-h-\\[60vh\\].place-items-center")).toBeNull();
    expect(screen.getByText("Attention")).toBeTruthy();
  });
});
