// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContractStandingList } from "../types";
import { breaking, consumedYou, row } from "./contract-fixtures";
import { ContractsScreen } from "./contracts-screen";

expect.extend(matchers);
afterEach(cleanup);
beforeEach(() => {
  window.history.replaceState(null, "", "/projects/hop/contracts");
  sessionStorage.clear();
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./contract-peek", () => ({ ContractPeek: ({ contractRef }: { contractRef: string }) => <aside data-testid="peek-stub">{contractRef}</aside> }));

const DATA: ContractStandingList = {
  generatedAt: "2026-10-04T00:00:00.000Z",
  project: { id: "id-hop", slug: "hop", name: "hop" },
  declared: true,
  contracts: [row("reminder-tools", { kind: "mcp-tools" }), breaking, consumedYou],
};
let query: { data?: ContractStandingList; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void };
vi.mock("../hooks", () => ({ useContractStanding: () => query }));
beforeEach(() => {
  query = { data: DATA, isLoading: false, isError: false, error: null, refetch: vi.fn() };
});

const keys = () => screen.queryAllByTestId("list-row").map((r) => r.dataset.key);
const heads = () => screen.getAllByTestId("list-group").map((g) => g.dataset.group);
const view = () => <ContractsScreen projectId="p" slug="hop" />;

describe("ContractsScreen", () => {
  it("groups by the attention group core derived, in its order", () => {
    render(view());
    expect(heads()).toEqual(["needs_you", "waiting", "steady"]);
    expect(keys()).toEqual(["bookings/book-follow-up", "hop/discharge-summary", "hop/reminder-tools"]);
    expect(screen.getAllByTestId("list-group").map((g) => g.textContent)).toEqual(["Needs you1", "Waiting on others1", "Steady1"]);
  });

  it("groups by direction when the view says so", () => {
    window.history.replaceState(null, "", "/projects/hop/contracts?group=direction");
    render(view());
    expect(heads()).toEqual(["provided", "consumed"]);
    expect(screen.getAllByTestId("list-group").map((g) => g.textContent)).toEqual(["Provided by hop2", "Consumed from other projects1"]);
  });

  it("draws kind and state as badges with sentence-case labels, never the raw values", () => {
    render(view());
    const grid = screen.getByTestId("grouped-list");
    expect(grid.textContent).not.toMatch(/breaking_pending|mcp-tools|graphql/);
    expect(grid.textContent).toContain("Breaking pending");
    expect(grid.textContent).toContain("MCP tools");
    expect(grid.textContent).toContain("GraphQL");
  });

  it("reads whom each row waits on and its window from core's reading", () => {
    render(view());
    const [you, waiting, steady] = screen.getAllByTestId("list-row") as HTMLElement[];
    expect(within(you as HTMLElement).getByTestId("waiting-on")).toHaveAttribute("data-kind", "you");
    expect(you?.textContent).toContain("adapt to 2.0.0 by 2099-11-02");
    expect(within(waiting as HTMLElement).getByTestId("waiting-on")).toHaveAttribute("data-kind", "project");
    expect(within(waiting as HTMLElement).getByTestId("window-left").textContent).toMatch(/^\d+d$/);
    expect(steady?.textContent).toContain("30-day notice");
  });

  it("narrows by the search text and says so when nothing matches", () => {
    render(view());
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "follow" } });
    expect(keys()).toEqual(["bookings/book-follow-up"]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches this search.")).toBeInTheDocument();
  });

  it("opens the peek on a plain click and links each row to its full page", () => {
    render(view());
    const first = screen.getAllByTestId("list-row")[0] as HTMLElement;
    expect(first).toHaveAttribute("href", "/projects/hop/contracts/bookings/book-follow-up");
    fireEvent.click(first);
    expect(screen.getByTestId("peek-stub").textContent).toBe("bookings/book-follow-up");
  });

  it("says what a contract is when there is none yet", () => {
    query = { ...query, data: { ...DATA, declared: false, contracts: [] } };
    render(view());
    expect(screen.getByText("No contract yet")).toBeInTheDocument();
  });
});
