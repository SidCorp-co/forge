// @vitest-environment jsdom
//
// ISS-1334: the ⌘K box filtered a fixed command list and asked no server, so `ISS-1280` answered
// "No matches.". In a project it now sends its text to the issues search and hands back what that
// answered, never reading a key itself.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/features/issues/api", () => ({ issuesApi: { lookup } }));

const { useIssueSearchCommands } = await import("./issue-search-commands");

afterEach(() => lookup.mockReset());

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mount(query: string, projectId: string | undefined) {
  const router = { push: vi.fn() };
  const view = renderHook(
    () => useIssueSearchCommands({ projectId, slug: "forge-dev", query, router }),
    { wrapper },
  );
  return { ...view, router };
}

it("lists what the search answered, opening the issue on run", async () => {
  lookup.mockResolvedValue({
    items: [{ id: "u-1280", displayId: "ISS-1280", title: "the release door" }],
    totalCount: 1,
  });
  const { result, router } = mount("#1280", "p1");

  await waitFor(() =>
    expect(result.current.commands.map((c) => c.label)).toContain("ISS-1280 · the release door"),
  );
  expect(lookup).toHaveBeenCalledWith("p1", "#1280");
  const hit = result.current.commands.find((c) => c.label.startsWith("ISS-1280"));
  expect(hit?.group).toBe("search");
  hit?.onRun?.();
  expect(router.push).toHaveBeenCalledWith("/projects/forge-dev/issues/u-1280");
});

it("offers Search issues, opening the issues screen with the text in its box", () => {
  lookup.mockResolvedValue({ items: [], totalCount: 0 });
  const { result, router } = mount("release door", "p1");

  const search = result.current.commands.find((c) => c.label.startsWith("Search issues"));
  search?.onRun?.();

  expect(search?.group).toBe("search");
  expect(router.push).toHaveBeenCalledWith("/projects/forge-dev/issues?q=release%20door");
});

it("hands back a key refusal as the notice, beside Search issues", async () => {
  lookup.mockRejectedValue(
    new ApiError(404, "`ISS-9999` reads as an issue key, and this project holds no issue ISS-9999.", "ISSUE_KEY_NOT_HELD"),
  );
  const { result } = mount("ISS-9999", "p1");

  await waitFor(() => expect(result.current.notice).toContain("ISS-9999"));
  expect(result.current.commands.map((c) => c.label)).toEqual(["Search issues for “ISS-9999”"]);
});

it("says the search did not answer when it fails for any other reason, beside Search issues", async () => {
  lookup.mockRejectedValue(new ApiError(503, "Service unavailable", "UNAVAILABLE"));
  const { result } = mount("ISS-1280", "p1");

  await waitFor(() => expect(result.current.notice).toMatch(/^The issues search did not answer/));
  expect(result.current.notice).toContain("Service unavailable");
  expect(result.current.commands.map((c) => c.label)).toEqual(["Search issues for “ISS-1280”"]);
});

it("asks nothing outside a project or for an empty box", () => {
  expect(mount("ISS-1280", undefined).result.current.commands).toEqual([]);
  expect(mount("   ", "p1").result.current.commands).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
});
