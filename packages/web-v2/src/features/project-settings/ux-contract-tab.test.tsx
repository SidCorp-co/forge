// @vitest-environment jsdom
//
// ISS-577 — UX Contract settings tab state matrix: loading/error/empty
// (rules + inbox + preview) and the non-admin read-only gate. Mocks the
// project-settings hooks module the same way agent-config-section.test.tsx
// mocks `useProject`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UxContractTab } from "./components/ux-contract-tab";
import type { ProjectDetail } from "@/features/projects/types";

expect.extend(matchers);
afterEach(cleanup);

const useUxContractRules = vi.fn();
const useUxFindings = vi.fn();
const useProjectFacts = vi.fn();
const useApplyUxPreset = vi.fn();
const usePatchUxRule = vi.fn();
const useDeleteUxRule = vi.fn();

vi.mock("./hooks", () => ({
  useUxContractRules: (...args: unknown[]) => useUxContractRules(...args),
  useUxFindings: (...args: unknown[]) => useUxFindings(...args),
  useProjectFacts: (...args: unknown[]) => useProjectFacts(...args),
  useApplyUxPreset: (...args: unknown[]) => useApplyUxPreset(...args),
  usePatchUxRule: (...args: unknown[]) => usePatchUxRule(...args),
  useDeleteUxRule: (...args: unknown[]) => useDeleteUxRule(...args),
}));

function project(agentConfig: unknown = {}): ProjectDetail {
  return {
    id: "proj-1",
    slug: "forge-dev",
    agentConfig,
  } as unknown as ProjectDetail;
}

const NO_FINDINGS = { isLoading: false, isError: false, data: [], refetch: vi.fn() };
const NO_FACTS = {
  isLoading: false,
  isError: false,
  data: { projectFacts: {}, projectFactsConfig: {}, maxAlwaysInjectChars: 6000 },
  refetch: vi.fn(),
};
const IDLE_MUTATION = { mutate: vi.fn(), isPending: false };

function mockDefaults() {
  useUxFindings.mockReturnValue(NO_FINDINGS);
  useProjectFacts.mockReturnValue(NO_FACTS);
  useApplyUxPreset.mockReturnValue(IDLE_MUTATION);
  usePatchUxRule.mockReturnValue(IDLE_MUTATION);
  useDeleteUxRule.mockReturnValue(IDLE_MUTATION);
}

describe("UxContractTab", () => {
  it("renders a Skeleton while rules/facts are loading", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({ isLoading: true, isError: false, data: undefined, refetch: vi.fn() });
    useProjectFacts.mockReturnValue({ ...NO_FACTS, isLoading: true, data: undefined });
    render(<UxContractTab project={project()} canEdit />);
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders ErrorState with Retry when the rules query fails", () => {
    mockDefaults();
    const refetch = vi.fn();
    useUxContractRules.mockReturnValue({
      isLoading: false,
      isError: true,
      error: new Error("network down"),
      data: undefined,
      refetch,
    });
    render(<UxContractTab project={project()} canEdit />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("shows the first-run empty state for rules and a distinct empty state for the inbox", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
    render(<UxContractTab project={project()} canEdit />);
    expect(screen.getByText("No rules yet")).toBeInTheDocument();
    expect(screen.getByText("No proposed changes yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing compiled yet")).toBeInTheDocument();
    expect(screen.getByText("Not detected yet.")).toBeInTheDocument();
  });

  it("groups active rules by section and renders source badge + evidence link", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          id: "rule-1",
          projectId: "proj-1",
          group: "a11y",
          text: "Every interactive element has a visible focus ring.",
          severity: "must",
          source: "preset",
          status: "active",
          evidenceIssueIds: ["issue-1"],
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      refetch: vi.fn(),
    });
    render(<UxContractTab project={project()} canEdit />);
    expect(screen.getByText("§4 Accessibility")).toBeInTheDocument();
    expect(screen.getByText("Every interactive element has a visible focus ring.")).toBeInTheDocument();
    expect(screen.getAllByText("Preset").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/projects/forge-dev/issues/issue-1");
  });

  it("renders proposed rules in the inbox with Approve/Reject when canEdit", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          id: "rule-2",
          projectId: "proj-1",
          group: "states",
          text: "Loading states use Skeleton, not a blank screen.",
          severity: "must",
          source: "learned",
          status: "proposed",
          evidenceIssueIds: [],
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      refetch: vi.fn(),
    });
    render(<UxContractTab project={project()} canEdit />);
    expect(screen.getByText("Loading states use Skeleton, not a blank screen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("a proposal that supersedes a rule shows what approving retires, plus its evidence", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          id: "rule-active",
          projectId: "proj-1",
          group: "states",
          text: "empty-search is distinct from first-run empty.",
          severity: "should",
          source: "preset",
          status: "active",
          evidenceIssueIds: [],
          supersedesRuleId: null,
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "rule-proposal",
          projectId: "proj-1",
          group: "states",
          text: "empty-search is distinct from first-run empty.",
          severity: "must",
          source: "learned",
          status: "proposed",
          evidenceIssueIds: ["issue-7"],
          supersedesRuleId: "rule-active",
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      refetch: vi.fn(),
    });
    render(<UxContractTab project={project()} canEdit />);

    expect(
      screen.getByText("Replaces this rule (should → must). Approving retires it."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link").some((a) => a.getAttribute("href")?.endsWith("/issue-7")),
    ).toBe(true);
  });

  it("non-admin: disables mutating controls with a visible reason, never a silent 403", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({
      isLoading: false,
      isError: false,
      data: [
        {
          id: "rule-3",
          projectId: "proj-1",
          group: "designSystem",
          text: "No raw hex colors.",
          severity: "must",
          source: "manual",
          status: "active",
          evidenceIssueIds: [],
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "rule-4",
          projectId: "proj-1",
          group: "states",
          text: "Empty states use the mascot pattern.",
          severity: "should",
          source: "manual",
          status: "proposed",
          evidenceIssueIds: [],
          orderIndex: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      refetch: vi.fn(),
    });
    render(<UxContractTab project={project()} canEdit={false} />);
    expect(screen.getByRole("button", { name: "Apply preset" })).toBeDisabled();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getAllByText(/requires an org owner\/admin/i).length).toBeGreaterThan(0);
  });

  it("shows the stack profile read-only, and offers no Re-scan control at all", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
    render(
      <UxContractTab
        project={project({ uxContractProfile: { projectLabel: "forge-dev", bindingScope: "web-v2", knownGaps: [], designSystem: { libraryName: "web-v2 DS", tokenSource: "tokens.css" } } })}
        canEdit
      />,
    );
    expect(screen.getByText("web-v2 DS")).toBeInTheDocument();
    expect(screen.getByText("Stack profile")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /re-scan/i })).not.toBeInTheDocument();
  });

  it("renders the compiled prose preview read-only from projectFacts['ux-contract']", () => {
    mockDefaults();
    useUxContractRules.mockReturnValue({ isLoading: false, isError: false, data: [], refetch: vi.fn() });
    useProjectFacts.mockReturnValue({
      ...NO_FACTS,
      data: { ...NO_FACTS.data, projectFacts: { "ux-contract": "# UX Contract\n\nMust use Skeleton." } },
    });
    render(<UxContractTab project={project()} canEdit />);
    expect(screen.getByText(/Must use Skeleton\./)).toBeInTheDocument();
  });
});
