// @vitest-environment jsdom
//
// ISS-1421 r31, judge-127: a viewer pressing New issue (the top bar and ⌘K push `?new=1`) got the
// list with `?new=1` in the address and nothing else: no form, and nothing saying why.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssuesScreen } from "./issues-screen";

expect.extend(matchers);
afterEach(cleanup);

const held = vi.hoisted(() => ({ role: "viewer", search: "new=1" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(held.search),
}));
vi.mock("@/lib/utils/use-location-search", () => ({
  useLocationSearch: () => `?${held.search}`,
  replaceLocationSearch: vi.fn(),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "forge-dev", role: held.role }] }),
}));
vi.mock("./issues-list-view", () => ({ IssuesListView: () => <div data-testid="issues-list" /> }));
vi.mock("./new-issue-dialog", () => ({
  NewIssueDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="New issue form" /> : null,
}));

const scope = { projectId: "p1", slug: "forge-dev" };

describe("IssuesScreen — New issue for a reader who may not create one", () => {
  it("tells a viewer who opened New issue that they cannot, and who may, and opens no form", () => {
    held.role = "viewer";
    held.search = "new=1";
    render(<IssuesScreen scope={scope} />);
    expect(screen.getByTestId("new-issue-refused")).toHaveTextContent(
      "You are a viewer of this project, so you cannot create an issue in it. Only a member or admin of this project can, so ask one of them.",
    );
    expect(screen.queryByRole("dialog", { name: "New issue form" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
  });

  it("says nothing to a viewer who did not ask for New issue", () => {
    held.role = "viewer";
    held.search = "";
    render(<IssuesScreen scope={scope} />);
    expect(screen.queryByTestId("new-issue-refused")).toBeNull();
  });

  it("opens the form for a member, with no refusal", () => {
    held.role = "member";
    held.search = "new=1";
    render(<IssuesScreen scope={scope} />);
    expect(screen.getByRole("dialog", { name: "New issue form" })).toBeInTheDocument();
    expect(screen.queryByTestId("new-issue-refused")).toBeNull();
  });
});
