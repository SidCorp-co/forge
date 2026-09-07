// @vitest-environment jsdom
//
// ISS-949 — the Modules view is reachable at `?tab=modules` and is restored from the URL, which
// is the one property the view's own tests cannot see: they mount the component directly.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IssuesScreen } from "./components/issues-screen";
import { ToastProvider } from "@/providers/toast-provider";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "forge-dev", role: "admin" }] }),
}));
vi.mock("./components/release-gate-panel", () => ({ ReleaseGatePanel: () => null }));
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useModuleRollup: () => ({
      data: {
        activeWithinDays: 30,
        generatedAt: "2026-09-07T00:00:00.000Z",
        modules: [],
        unassigned: { total: 0, open: 0, closed: 0, recentlyActive: 0 },
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

it("opens the Modules view from ?tab=modules", () => {
  window.history.replaceState({}, "", "/projects/forge-dev/issues?tab=modules");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <IssuesScreen scope={{ projectId: "p1", slug: "forge-dev" }} />
      </ToastProvider>
    </QueryClientProvider>,
  );

  expect(screen.getByText("No modules yet")).toBeInTheDocument();
});
