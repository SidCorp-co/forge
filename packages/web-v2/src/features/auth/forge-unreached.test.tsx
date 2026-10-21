// @vitest-environment jsdom
//
// ISS-1228 round 23 (judge-74, criterion 235): the workspace opened while Forge could not be reached
// replaced the page with Sign in. It now stays, says why and offers Retry.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { markUnreachable, UNREACHABLE_SENTENCE } from "@/lib/api/transport-failure";

expect.extend(matchers);
afterEach(cleanup);

const replace = vi.fn();
const push = vi.fn();
let auth: { user: object | null; isLoading: boolean; failure: unknown; retry: () => void };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => "/projects/forge-dev/issues/ISS-7",
}));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => auth, useUserInitials: () => undefined }));

const { default: WorkspaceLayout } = await import("@/app/(workspace)/layout");

function lost() {
  const err = new TypeError("Failed to fetch");
  markUnreachable(err);
  return err;
}

describe("a workspace page whose account could not be read (criterion 235)", () => {
  it("stays on the page, says Forge could not be reached and offers Retry, never Sign in", () => {
    const retry = vi.fn();
    auth = { user: null, isLoading: false, failure: lost(), retry };
    render(<WorkspaceLayout>the issue page</WorkspaceLayout>);
    expect(screen.getByText(UNREACHABLE_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).toBeNull();
    expect(screen.queryByText("Failed to fetch")).toBeNull();
    screen.getByRole("button", { name: /retry/i }).click();
    expect(retry).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("gives a server failure's own sentence", () => {
    auth = { user: null, isLoading: false, failure: new ApiError(503, "Forge is restarting.", "UNAVAILABLE"), retry: vi.fn() };
    render(<WorkspaceLayout>the issue page</WorkspaceLayout>);
    expect(screen.getByText("Forge is restarting.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
