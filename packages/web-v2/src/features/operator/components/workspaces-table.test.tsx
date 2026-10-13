// @vitest-environment jsdom
//
// ISS-1263 — the Top workspaces table ranks by a header instead of a segmented control. The server
// does the ranking and only knows largest first, so a header names the ranking it asks for, the rows
// stay in the order the server sent, and no header can ask for an ascending one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminWorkspaceRow } from "../types";
import { WorkspacesTable } from "./workspaces-table";

expect.extend(matchers);
afterEach(cleanup);

// The server's order is by the ranking asked for, which is not by every column: here spend runs the
// other way, so a table that sorted its rows itself would visibly reorder them.
const row = (slug: string, runs: number, spendUsd: number): AdminWorkspaceRow => ({
  projectId: slug,
  slug,
  runs,
  spendUsd,
  medianLeadTimeMin: runs === 1 ? null : runs * 10,
  openIssues: runs,
});

const ROWS = [row("forge-dev", 30, 1), row("trai-heo", 12, 5), row("archmap", 1, 9)];
const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent);
const header = (name: RegExp) => screen.getByRole("columnheader", { name });

describe("the Top workspaces table", () => {
  it("has no segmented control to choose the ranking with", () => {
    render(<WorkspacesTable rows={ROWS} sort="runs" onSortChange={() => {}} />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("marks the ranking it was given and shows the rows in the order the server sent", () => {
    render(<WorkspacesTable rows={ROWS} sort="spend" onSortChange={() => {}} />);
    expect(header(/Spend/)).toHaveAttribute("aria-sort", "descending");
    expect(header(/Runs/)).toHaveAttribute("aria-sort", "none");
    expect(names()).toEqual(["forge-dev", "trai-heo", "archmap"]);
  });

  it("asks for the ranking of the header activated", () => {
    const onSortChange = vi.fn();
    render(<WorkspacesTable rows={ROWS} sort="runs" onSortChange={onSortChange} />);
    fireEvent.click(within(header(/Median lead/)).getByRole("button"));
    expect(onSortChange).toHaveBeenLastCalledWith("leadTime");
    fireEvent.click(within(header(/Spend/)).getByRole("button"));
    expect(onSortChange).toHaveBeenLastCalledWith("spend");
  });

  it("asks again for the ranking it already has when its own header is activated", () => {
    const onSortChange = vi.fn();
    render(<WorkspacesTable rows={ROWS} sort="runs" onSortChange={onSortChange} />);
    fireEvent.click(within(header(/Runs/)).getByRole("button"));
    expect(onSortChange).toHaveBeenLastCalledWith("runs");
    expect(header(/Runs/)).toHaveAttribute("aria-sort", "descending");
  });

  it("offers no ranking on the columns the server does not rank by", () => {
    render(<WorkspacesTable rows={ROWS} sort="runs" onSortChange={() => {}} />);
    expect(within(header(/Workspace/)).queryByRole("button")).toBeNull();
    expect(within(header(/Open/)).queryByRole("button")).toBeNull();
  });

  it("says so, and draws no table, when no project ran anything", () => {
    render(<WorkspacesTable rows={[]} sort="runs" onSortChange={() => {}} />);
    expect(screen.getByText("No workspace activity")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
