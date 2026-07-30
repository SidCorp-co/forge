// @vitest-environment jsdom
//
// Component test for the bulk-release action (ISS-621). This is web-v2's
// first DOM-rendering test — the vitest config stays `environment: 'node'`
// globally (every other test here is pure-unit), so this file opts into
// jsdom per-file via the docblock above instead of flipping the shared
// config. Matchers are extended on vitest's OWN `expect` (not the
// `@testing-library/jest-dom/vitest` convenience entry) because that entry
// resolves its own vitest peer, which under pnpm hoisting can land on a
// different vitest than the one running this file (ISS-397 bit `packages/dev`
// the same way).
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import { AwaitingReleaseCard } from "./components/awaiting-release-card";

expect.extend(matchers);

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const mutate = vi.fn();
vi.mock("@/features/issues/hooks", () => ({
  useBatchRelease: () => ({ mutate, isPending: false }),
}));
let lastDialogProps: { selectedIssues: Array<{ id: string }> } | null = null;
vi.mock("@/features/issues/components/batch-release-dialog", () => ({
  BatchReleaseDialog: (props: { selectedIssues: Array<{ id: string }> }) => {
    lastDialogProps = props;
    return null;
  },
}));

function renderCard(runs: PipelineRunListItem[]) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <AwaitingReleaseCard runs={runs} slug="acme" projectId="proj-1" />
    </QueryClientProvider>,
  );
}

const RUNS = [
  {
    id: "run-1",
    issueId: "iss-1",
    issueRef: "ISS-1",
    issueTitle: "Fix a",
    startedAt: "2026-01-01T00:00:00Z",
    cost: { estimatedCost: 1 },
  },
  {
    id: "run-2",
    issueId: "iss-2",
    issueRef: "ISS-2",
    issueTitle: "Fix b",
    startedAt: "2026-01-02T00:00:00Z",
    cost: { estimatedCost: 2 },
  },
] as PipelineRunListItem[];

describe("AwaitingReleaseCard — bulk release", () => {
  beforeEach(() => {
    push.mockClear();
    mutate.mockClear();
  });

  afterEach(() => cleanup());

  it("disables Release at 0 selected", () => {
    renderCard(RUNS);
    expect(screen.getByRole("button", { name: "Release" })).toBeDisabled();
  });

  it("selecting a row enables Release and shows the count", () => {
    renderCard(RUNS);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ISS-1" }));
    expect(screen.getByRole("button", { name: "Release 1" })).toBeEnabled();
  });

  it("toggling a row checkbox does not trigger row navigation", () => {
    renderCard(RUNS);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ISS-1" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("clicking Release opens the batch dialog (not a direct mutate)", () => {
    renderCard(RUNS);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ISS-1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ISS-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Release 2" }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps a selected row in selectedIssues after it scrolls out of the visible window", () => {
    const { rerender } = renderCard(RUNS);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ISS-2" }));
    expect(lastDialogProps?.selectedIssues.map((i) => i.id)).toEqual(["iss-2"]);

    const olderRuns = Array.from({ length: 5 }, (_, i) => ({
      id: `run-older-${i}`,
      issueId: `iss-older-${i}`,
      issueRef: `ISS-older-${i}`,
      issueTitle: "Older",
      startedAt: `2025-01-0${i + 1}T00:00:00Z`,
      cost: { estimatedCost: 0 },
    })) as PipelineRunListItem[];
    const qc = new QueryClient();
    rerender(
      <QueryClientProvider client={qc}>
        <AwaitingReleaseCard runs={[...olderRuns, ...RUNS]} slug="acme" projectId="proj-1" />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("checkbox", { name: "Select ISS-2" })).toBeNull();
    expect(lastDialogProps?.selectedIssues.map((i) => i.id)).toEqual(["iss-2"]);
  });

  it("rows with no issueId render without a checkbox and don't count toward selection", () => {
    const runs = [
      {
        id: "run-3",
        issueId: null,
        issueRef: null,
        issueTitle: null,
        startedAt: "2026-01-03T00:00:00Z",
        cost: { estimatedCost: 0 },
      },
    ] as PipelineRunListItem[];
    renderCard(runs);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
