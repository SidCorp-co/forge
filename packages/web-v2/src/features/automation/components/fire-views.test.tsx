import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ToastProvider } from "@/providers/toast-provider";
import { useScheduleDetail } from "../hooks";
import { useRunSchedule } from "../schedule-hooks";
import type { FireDetailResponse } from "../types";
import { FireFacts } from "./fire-views";

// REQ-37 BC-9 on the page: a fire says who ran it, by name, and every read it made with its status,
// a refused one named; and a Run now whose script failed is a fire the Fires tab lists at once.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/", useParams: () => ({ slug: "hop" }) }));

const AT = "2026-10-09T08:00:00.000Z";
const own = "/api/projects/p1/requirements";

const detail = (fire: Partial<FireDetailResponse["fire"]>): Pick<FireDetailResponse, "fire" | "schedule"> =>
  ({
    fire: {
      id: "f1-fire-0001",
      scheduleId: "s1",
      scheduleName: "digest",
      trigger: "manual",
      status: "success",
      reason: null,
      refusal: null,
      error: null,
      disposition: null,
      sessionId: null,
      pipelineRunId: null,
      runAs: null,
      reads: null,
      startedAt: AT,
      finishedAt: AT,
      durationSeconds: 1,
      produced: { reports: 0, newReports: 0, proposals: 0, issues: 0, runs: 0, notifications: 0 },
      output: null,
      ...fire,
    },
    schedule: { id: "s1", name: "digest", state: "on" },
  }) as unknown as Pick<FireDetailResponse, "fire" | "schedule">;

describe("a fire page", () => {
  it("names who ran it and lists each read, a refused one with its code", () => {
    renderWithQuery(
      <FireFacts
        slug="hop"
        d={detail({
          runAs: { id: "u1", name: "Orchestrator" },
          reads: [
            { method: "GET", path: own, status: 200 },
            { method: "POST", path: own, status: null, refused: "SCRIPT_READ_REFUSED" },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("fire-ran-as")).toHaveTextContent("Orchestrator");
    expect(screen.getByTestId("fire-ran-as")).not.toHaveTextContent("u1");
    const rows = within(screen.getByTestId("fire-reads")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(`GET${own}200`);
    expect(rows[1]).toHaveTextContent(`POST${own}refused: SCRIPT_READ_REFUSED`);
  });

  it("says a script that read nothing read nothing, and shows no read list for a fire that ran no script", () => {
    const { unmount } = renderWithQuery(<FireFacts slug="hop" d={detail({ runAs: { id: "u1", name: "Orchestrator" }, reads: [] })} />);
    expect(screen.getByText("Read nothing from Forge")).toBeInTheDocument();
    expect(screen.queryByTestId("fire-reads")).toBeNull();
    unmount();
    renderWithQuery(<FireFacts slug="hop" d={detail({})} />);
    expect(screen.queryByTestId("fire-ran-as")).toBeNull();
    expect(screen.queryByText("Read nothing from Forge")).toBeNull();
    expect(screen.queryByTestId("fire-reads")).toBeNull();
  });
});

describe("a Run now whose script failed", () => {
  it("makes the schedule's Fires tab read again, so the failed fire is listed", async () => {
    let fires: Array<{ id: string }> = [];
    const calls = fakeCore(({ method, path }) => {
      if (method === "POST" && path === "/schedules/s1/run") {
        fires = [{ id: "failed-fire" }];
        return { status: 422, body: { code: "SCHEDULE_RUN_FAILED", detail: "the script ran and failed: boom" } };
      }
      if (path.startsWith("/projects/p1/automation/schedules/s1")) return { body: { fires } };
      return undefined;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => ({ tab: useScheduleDetail("p1", "s1", true), run: useRunSchedule("p1") }), { wrapper });
    await waitFor(() => expect(result.current.tab.data).toEqual({ fires: [] }));
    await act(async () => {
      await result.current.run.mutateAsync("s1").catch(() => {});
    });
    await waitFor(() => expect(result.current.tab.data).toEqual({ fires: [{ id: "failed-fire" }] }));
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });
});
