// @vitest-environment jsdom
//
// ISS-813 — read-only display of agentConfig.plugins + agentConfig.stateContext,
// both reached via GET /api/projects/:id (no dedicated route). Mocks useProject
// the same way rocketchat-section relies on it for agentConfig.*.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSection } from "./components/agent-config-section";

expect.extend(matchers);
afterEach(cleanup);

const useProject = vi.fn();
vi.mock("@/features/projects/hooks", () => ({
  useProject: (...args: unknown[]) => useProject(...args),
}));

describe("AgentConfigSection", () => {
  it("renders a Skeleton while the project is loading", () => {
    useProject.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    render(<AgentConfigSection projectId="proj-1" />);
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders ErrorState with Retry on fetch failure", () => {
    const refetch = vi.fn();
    useProject.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("network down"),
      data: undefined,
      refetch,
    });
    render(<AgentConfigSection projectId="proj-1" />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders marketplace/name/short pinnedRef and the auto-update badge", () => {
    useProject.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        agentConfig: {
          plugins: [
            {
              marketplace: "SidCorp-co/forge-pipeline-skills",
              name: "forge-codemap",
              pinnedRef: "abc1234def5678",
              autoUpdate: false,
            },
          ],
        },
      },
    });
    render(<AgentConfigSection projectId="proj-1" />);
    expect(screen.getByText("SidCorp-co/forge-pipeline-skills/forge-codemap")).toBeInTheDocument();
    expect(screen.getByTitle("abc1234def5678")).toHaveTextContent("abc1234");
    expect(screen.getByText("pinned")).toBeInTheDocument();
    expect(screen.getByText(/installed at device scope/i)).toBeInTheDocument();
  });

  it("states the calm no-plugins line rather than an empty block", () => {
    useProject.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { agentConfig: {} },
    });
    render(<AgentConfigSection projectId="proj-1" />);
    expect(screen.getByText("No plugins designated for this project.")).toBeInTheDocument();
  });

  it("renders stateContext as 'Not configured' rather than omitting it, when null", () => {
    useProject.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { agentConfig: { stateContext: null } },
    });
    render(<AgentConfigSection projectId="proj-1" />);
    expect(screen.getByText("Not configured.")).toBeInTheDocument();
  });

  it("renders a stateContext entry's model override and budget", () => {
    useProject.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        agentConfig: {
          stateContext: {
            code: { modelOverride: "claude-opus-5", budget: { perRunUsd: 5, action: "warn" } },
          },
        },
      },
    });
    render(<AgentConfigSection projectId="proj-1" />);
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-5/)).toBeInTheDocument();
    expect(screen.getByText(/\$5\/run/)).toBeInTheDocument();
  });
});
