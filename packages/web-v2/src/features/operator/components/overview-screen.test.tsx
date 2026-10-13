// @vitest-environment jsdom
//
// ISS-1263 round 2 — pressing a Top workspaces header re-ranks the table without unmounting it, so
// the header a keyboard user pressed keeps focus instead of dropping it to the page body.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminWorkspaceRow } from "../types";
import { OperatorOverviewScreen } from "./overview-screen";

expect.extend(matchers);

const { workspaces } = vi.hoisted(() => ({ workspaces: vi.fn() }));
vi.mock("@/lib/ws/client", () => ({ wsClient: { subscribe: vi.fn(), unsubscribe: vi.fn() } }));
vi.mock("../api", () => ({
  operatorApi: {
    overview: async () => ({ counts: {}, kpis: {}, glance: {} }),
    alerts: async () => ({ items: [], totalCount: 0 }),
    adoption: async () => [],
    workspaces,
  },
}));
vi.mock("./kpi-row", () => ({ KpiRow: () => null, KpiRowSkeleton: () => null }));
vi.mock("./glance-cards", () => ({ GlanceCards: () => null, GlanceCardsSkeleton: () => null }));
vi.mock("./adoption-panel", () => ({ AdoptionPanel: () => null, AdoptionPanelSkeleton: () => null }));
vi.mock("./alert-feed", () => ({ AlertFeed: () => null, AlertFeedSkeleton: () => null }));

afterEach(cleanup);

const row = (slug: string, runs: number, spendUsd: number): AdminWorkspaceRow => ({
  projectId: slug, slug, runs, spendUsd, medianLeadTimeMin: runs, openIssues: runs,
});
const byRuns = { items: [row("a", 9, 1), row("b", 5, 8)], totalCount: 2 };
const bySpend = { items: [row("b", 5, 8), row("a", 9, 1)], totalCount: 2 };

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OperatorOverviewScreen />
    </QueryClientProvider>,
  );
}
const header = (name: RegExp) => screen.getByRole("columnheader", { name });

describe("re-ranking Top workspaces", () => {
  it("keeps the table mounted and the pressed header focused while the new ranking loads", async () => {
    let release: (v: typeof bySpend) => void = () => {};
    workspaces.mockImplementation((_w: string, sort: string) =>
      sort === "runs" ? Promise.resolve(byRuns) : new Promise((resolve) => (release = resolve)),
    );
    mount();
    await waitFor(() => expect(screen.getByRole("table", { name: "Top workspaces" })).toBeInTheDocument());
    const table = screen.getByRole("table", { name: "Top workspaces" });
    const button = within(header(/Spend/)).getByRole("button");
    button.focus();
    fireEvent.click(button);

    await waitFor(() => expect(workspaces).toHaveBeenCalledWith("24h", "spend"));
    expect(screen.getByRole("table", { name: "Top workspaces" })).toBe(table);
    expect(document.activeElement).toBe(button);
    expect(header(/Spend/)).toHaveAttribute("aria-sort", "descending");
    expect(table.closest("[aria-busy='true']")).not.toBeNull();

    await act(async () => release(bySpend));
    await waitFor(() => expect(table.closest("[aria-busy='true']")).toBeNull());
    expect(screen.getByRole("table", { name: "Top workspaces" })).toBe(table);
    expect(document.activeElement).toBe(button);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("b");
  });
});
