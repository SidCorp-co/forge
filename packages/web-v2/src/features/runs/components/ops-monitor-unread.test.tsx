// @vitest-environment jsdom
//
// ISS-1229 r48: with the projects read failing, the ops page said so, and its Retry read the health again.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const reads = vi.hoisted(() => ({
  projectsFail: false,
  healthFail: false,
  readProjects: vi.fn(),
  readHealth: vi.fn(),
}));
const down = new Error("The server is down.");

vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({
    projects: [],
    projectIds: new Set<string>(),
    isLoading: false,
    error: reads.projectsFail ? down : null,
    refetch: reads.readProjects,
  }),
  useProjectHealth: () => ({
    data: reads.healthFail ? undefined : [],
    isLoading: false,
    isError: reads.healthFail,
    error: reads.healthFail ? down : null,
    refetch: reads.readHealth,
  }),
}));
vi.mock("../hooks", () => ({
  useStepDurations: () => ({ data: [], isLoading: false, isError: false }),
  useThroughput: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { OpsMonitor } = await import("./ops-monitor");

afterEach(() => {
  cleanup();
  reads.projectsFail = false;
  reads.healthFail = false;
  reads.readProjects.mockClear();
  reads.readHealth.mockClear();
});

describe("the ops page whose read failed", () => {
  it("reads the projects again on Retry where the projects read failed", () => {
    reads.projectsFail = true;
    render(<OpsMonitor />);
    expect(screen.getByRole("heading", { name: "Couldn't load your projects" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reads.readProjects).toHaveBeenCalledTimes(1);
  });

  it("reads the health again on Retry where the health read failed", () => {
    reads.healthFail = true;
    render(<OpsMonitor />);
    expect(screen.getByRole("heading", { name: "Couldn't load the projects' health" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reads.readHealth).toHaveBeenCalledTimes(1);
  });
});
