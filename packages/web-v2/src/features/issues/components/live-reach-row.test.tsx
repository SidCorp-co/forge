// @vitest-environment jsdom
//
// ISS-1217 — the rail says whether a merged issue's work reached the live branch.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail, LiveReach } from "../types";
import { PropertiesRail } from "./properties-rail";

expect.extend(matchers);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("./inline-edit-cell", async () => {
  const actual = await vi.importActual<typeof import("./inline-edit-cell")>("./inline-edit-cell");
  return { ...actual, StatusEdit: () => <span>status</span> };
});

vi.mock("./merge-marker-control", () => ({
  MergeMarkerControl: () => null,
}));

afterEach(cleanup);

const measured = {
  baseBranch: "staging",
  liveBranch: "master",
  measuredAt: "2026-09-23T14:00:00.000Z",
  baseSha: "f".repeat(40),
  liveSha: "52c66950".padEnd(40, "0"),
};

function rail(liveReach: LiveReach | null | undefined): ReactNode {
  const issue = {
    id: "i1",
    displayId: "ISS-442",
    status: "closed",
    agentStatus: "idle",
    priority: "high",
    complexity: "m",
    labels: [],
    mergedAt: "2026-09-23T04:22:00.000Z",
    mergeMark: "asserted",
    liveReach,
  } as unknown as IssueDetail;
  return (
    <PropertiesRail
      issue={issue}
      slug="sid-desk"
      cost={undefined}
      deps={undefined}
      pending={false}
      onPatch={vi.fn()}
      onTransition={vi.fn()}
    />
  );
}

describe("the Production row", () => {
  it("says not on production and names the commit that is waiting", () => {
    render(
      rail({
        ...measured,
        state: "not_on_live",
        evidence: [{ sha: "11d071b3".padEnd(40, "0"), subject: "fix(desk): owner (ISS-442)", via: "declares_issue" }],
      }),
    );
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Not on production")).toBeInTheDocument();
    expect(screen.getByText("11d071b3 fix(desk): owner (ISS-442)")).toBeInTheDocument();
    expect(screen.getByText("staging ffffffff vs master 52c66950 · read 2026-09-23 14:00")).toBeVisible();
  });

  it("shows the reason when the branches could not be compared", () => {
    render(
      rail({
        state: "unmeasured",
        baseBranch: "staging",
        liveBranch: "master",
        measuredAt: null,
        reason: "this project has no active GitHub binding",
      }),
    );
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.getByText("this project has no active GitHub binding")).toBeInTheDocument();
    expect(screen.queryByText("Not on production")).not.toBeInTheDocument();
  });

  it("says only that nothing is waiting when no waiting commit is this issue's", () => {
    render(rail({ ...measured, state: "none_waiting", unowned: [] }));
    const value = screen.getByText("Nothing waiting for master");
    expect(value).toHaveAttribute(
      "title",
      "staging at ffffffff against master at 52c66950, read 2026-09-23T14:00:00.000Z",
    );
    expect(screen.getByText("staging ffffffff vs master 52c66950 · read 2026-09-23 14:00")).toBeVisible();
    expect(screen.queryByText(/on production/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/belongs? to no issue/)).not.toBeInTheDocument();
  });

  it("counts the waiting commits that belong to no issue, and names them on hover", () => {
    render(
      rail({
        ...measured,
        state: "none_waiting",
        unowned: [
          { sha: "d06bf1db".padEnd(40, "0"), subject: "style(client): satisfy pint" },
          { sha: "07002be8".padEnd(40, "0"), subject: "fix(campaign): stop resetting status" },
        ],
      }),
    );
    expect(screen.getByText("Nothing waiting for master")).toBeInTheDocument();
    const count = screen.getByText("2 waiting commits belong to no issue");
    expect(count).toHaveAttribute(
      "title",
      "d06bf1db style(client): satisfy pint\n07002be8 fix(campaign): stop resetting status",
    );
    expect(screen.queryByText(/on production/i)).not.toBeInTheDocument();
  });

  it("says one waiting commit belongs to no issue in the singular", () => {
    render(
      rail({
        ...measured,
        state: "none_waiting",
        unowned: [{ sha: "d06bf1db".padEnd(40, "0"), subject: "style(client): satisfy pint" }],
      }),
    );
    expect(screen.getByText("1 waiting commit belongs to no issue")).toBeInTheDocument();
  });

  it("shows no Production row where core gives no reading", () => {
    render(rail(null));
    expect(screen.queryByText("Production")).not.toBeInTheDocument();
  });
});
