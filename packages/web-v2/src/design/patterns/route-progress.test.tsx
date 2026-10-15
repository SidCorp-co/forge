// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useInsertionEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/guides" }));
vi.mock("@tanstack/react-query", () => ({ useIsFetching: () => 0 }));

const { RouteProgress } = await import("./route-progress");

afterEach(cleanup);

/** Next's router writes the address from an insertion effect as it commits a navigation. */
function PushesOnCommit({ to }: { to: string }) {
  useInsertionEffect(() => {
    history.pushState(null, "", to);
  }, [to]);
  return null;
}

describe("the route progress bar", () => {
  it("schedules no update from inside the router's insertion effect, and still shows the bar", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, rerender } = render(<RouteProgress />);
    await act(async () => {
      rerender(
        <>
          <RouteProgress />
          <PushesOnCommit to="/guides/issue-dependencies" />
        </>,
      );
    });

    const said = errors.mock.calls.map((c) => String(c[0]));
    errors.mockRestore();
    expect(said.filter((s) => s.includes("useInsertionEffect must not schedule updates"))).toEqual([]);
    expect((container.firstElementChild as HTMLElement).style.opacity).toBe("1");
  });
});
