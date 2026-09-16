// @vitest-environment jsdom
//
// ISS-1048 — the compiled UX contract moved out of `agentConfig.projectFacts`
// and into a knowledge row with its own route. In the map, a missing contract
// and an unreadable one were the same reading: the key was absent and nothing
// failed. Over a route they stop being the same, and the tab has to tell them
// apart — a 500 rendered as "Nothing compiled yet" tells an operator their
// contract is gone and hands them no way to try again.
//
// Per-file jsdom + matchers-on-vitest's-own-expect, for the reasons written up
// in project-dashboard/awaiting-release-card.test.tsx.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import { ApiError } from "@/lib/api/client";
import { UxContractTab } from "./components/ux-contract-tab";

expect.extend(matchers);

const refetch = vi.fn();
let factsQ: Record<string, unknown> = {};

vi.mock("./hooks", () => ({
  useUxContractRules: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
  useUxFindings: () => ({ data: [], isLoading: false, isError: false }),
  useKnowledgeEntry: () => factsQ,
  useApplyUxPreset: () => ({ mutate: vi.fn(), isPending: false }),
  usePatchUxRule: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteUxRule: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderTab(facts: Record<string, unknown>) {
  factsQ = { isLoading: false, isError: false, data: undefined, error: null, refetch, ...facts };
  const qc = new QueryClient();
  const project = { id: "proj-1", slug: "demo", agentConfig: {} } as unknown as ProjectDetail;
  return render(
    <QueryClientProvider client={qc}>
      <UxContractTab project={project} canEdit={true} />
    </QueryClientProvider>,
  );
}

const emptyState = () => screen.queryByText("Nothing compiled yet");
const errorTitle = () => screen.queryByText("Couldn't load");
const retryBtn = () => screen.queryByRole("button", { name: /retry/i });

afterEach(() => {
  cleanup();
  refetch.mockClear();
});

describe("UX Contract tab · a failed read is not an absent contract (ISS-1048)", () => {
  it("shows the empty state for a 404 — that entry genuinely does not exist yet", () => {
    renderTab({ isError: true, error: new ApiError(404, "Not found") });
    expect(emptyState()).toBeInTheDocument();
    expect(errorTitle()).not.toBeInTheDocument();
  });

  it("shows an error and a retry for a 500 — never 'nothing compiled yet'", () => {
    renderTab({ isError: true, error: new ApiError(500, "Internal error") });
    expect(errorTitle()).toBeInTheDocument();
    expect(screen.getByText("Internal error")).toBeInTheDocument();
    expect(emptyState()).not.toBeInTheDocument();
    expect(retryBtn()).toBeInTheDocument();
  });

  it("shows an error and a retry for a 403 — a contract may exist that this reader cannot see", () => {
    renderTab({ isError: true, error: new ApiError(403, "Forbidden") });
    expect(errorTitle()).toBeInTheDocument();
    expect(emptyState()).not.toBeInTheDocument();
  });

  it("shows an error and a retry when the request never reached the server", () => {
    renderTab({ isError: true, error: new TypeError("Failed to fetch") });
    expect(errorTitle()).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    expect(emptyState()).not.toBeInTheDocument();
  });

  it("the retry control re-runs the read rather than only clearing the message", () => {
    renderTab({ isError: true, error: new ApiError(500, "Internal error") });
    (retryBtn() as HTMLButtonElement).click();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("still renders the compiled prose when the read succeeds", () => {
    renderTab({ data: { slug: "ux-contract", body: "Prefer a loud break." } });
    expect(screen.getByText("Prefer a loud break.")).toBeInTheDocument();
    expect(emptyState()).not.toBeInTheDocument();
  });

  it("shows the empty state when the entry exists but its body is empty", () => {
    renderTab({ data: { slug: "ux-contract", body: "" } });
    expect(emptyState()).toBeInTheDocument();
    expect(errorTitle()).not.toBeInTheDocument();
  });
});
