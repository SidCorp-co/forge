// @vitest-environment jsdom
//
// ISS-1010 — the rail's Priority and Complexity are two of the fields a drive
// job writes, so while one is live they are two ways for a person to lose a
// click. The reason is rendered rather than left as a greyed-out Select: a
// disabled control takes no focus, so a `title` is unreachable by keyboard and
// absent on touch.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { IssueAgentStatus, IssueDetail, IssueStatus } from "../types";
import { PropertiesRail } from "./properties-rail";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

// The status control has its own suite; stubbing it here keeps this file about
// the two fields the rail owns and off the registry read StatusEdit makes.
vi.mock("./inline-edit-cell", async () => {
  const actual = await vi.importActual<typeof import("./inline-edit-cell")>("./inline-edit-cell");
  return { ...actual, StatusEdit: () => <span>status</span> };
});

vi.mock("./merge-marker-control", () => ({
  MergeMarkerControl: () => null,
}));

afterEach(cleanup);

const HELD = "An agent is working this — your edit would be overwritten";

function rail(status: IssueStatus, agentStatus: IssueAgentStatus): ReactNode {
  const issue = {
    id: "i1",
    displayId: "ISS-1",
    status,
    agentStatus,
    priority: "medium",
    complexity: "m",
    labels: [],
    mergedAt: null,
  } as unknown as IssueDetail;
  return (
    <PropertiesRail
      issue={issue}
      slug="p1"
      cost={undefined}
      deps={undefined}
      pending={false}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
    />
  );
}

const control = (name: string) => screen.getByRole("combobox", { name });

describe("PropertiesRail, while an agent is working the issue", () => {
  it("does not accept a priority change", () => {
    render(rail("in_progress", "running"));
    expect(control("Priority")).toBeDisabled();
  });

  it("does not accept a complexity change", () => {
    render(rail("in_progress", "running"));
    expect(control("Complexity")).toBeDisabled();
  });

  it("states why, where a reader sees it without hovering", () => {
    render(rail("in_progress", "running"));
    expect(screen.getByText(HELD)).toBeInTheDocument();
  });

  it("accepts a priority change on a needs_info issue", () => {
    render(rail("needs_info", "running"));
    expect(control("Priority")).not.toBeDisabled();
  });

  it("accepts a complexity change on a needs_info issue", () => {
    render(rail("needs_info", "running"));
    expect(control("Complexity")).not.toBeDisabled();
    expect(screen.queryByText(HELD)).toBeNull();
  });

  it("locks nothing while the job is only queued", () => {
    render(rail("in_progress", "queued"));
    expect(control("Priority")).not.toBeDisabled();
    expect(screen.queryByText(HELD)).toBeNull();
  });

  it("locks nothing when no agent holds the issue", () => {
    render(rail("in_progress", null));
    expect(control("Priority")).not.toBeDisabled();
    expect(control("Complexity")).not.toBeDisabled();
  });
});
