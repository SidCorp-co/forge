// @vitest-environment jsdom
//
// ISS-1150 — the run's status and the issue's status are two facts. The status control draws the
// issue's alone; where the run has a state it gets its own session chip, never the issue's label.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ToastProvider } from "@/providers/toast-provider";
import { StatusEdit } from "./inline-edit-cell";
import { IssueQuickActions } from "./issue-quick-actions";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("../registry-api", () => ({
  registryApi: { get: () => ({ version: 1, runnerCapabilities: {}, statusExits: { open: ["confirmed"] } }) },
}));

afterEach(cleanup);

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe("the status control", () => {
  it("draws one chip with the issue's own label while its run is queued", () => {
    wrap(<StatusEdit status="open" agentStatus="queued" onTransition={vi.fn()} />);
    const control = screen.getByRole("button", { name: "Change status (currently Open)" });
    expect(control).toHaveTextContent(/^Open$/);
    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("names the status by its label, not its wire value", () => {
    wrap(<StatusEdit status="in_progress" onTransition={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Change status (currently In progress)" })).toBeInTheDocument();
  });
});

describe("the board's quick actions", () => {
  it("shows the run's state as its own chip beside the issue's", () => {
    wrap(<IssueQuickActions issueId="i1" status="open" agentStatus="queued" priority="medium" />);
    expect(screen.getByRole("button", { name: "Change status (currently Open)" })).toHaveTextContent(/^Open$/);
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("shows no run chip when the run has no state", () => {
    wrap(<IssueQuickActions issueId="i1" status="open" agentStatus={null} priority="medium" />);
    expect(screen.queryByText("Queued")).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();
  });
});
