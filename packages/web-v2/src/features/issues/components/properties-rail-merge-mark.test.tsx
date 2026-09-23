// @vitest-environment jsdom
//
// ISS-1126 — the rail tells a reader which kind of merge mark an issue carries.
//
// The property is that the two kinds render DIFFERENTLY. A merged date alone reads as "shipped"
// either way, which is the defect: every one of this project's 851 marks is a claim Forge did not
// observe, and nothing on this screen has ever said so.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { IssueDetail } from "../types";
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

const MERGED_AT = "2026-09-20T14:59:37.646Z";
const SHA = "9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8";

function rail(mark?: IssueDetail["mergeMark"], mergedCommitSha?: string | null): ReactNode {
  const issue = {
    id: "i1",
    displayId: "ISS-1126",
    status: "developed",
    agentStatus: "idle",
    priority: "critical",
    complexity: "m",
    labels: [],
    mergedAt: MERGED_AT,
    mergeMark: mark,
    mergedCommitSha,
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

describe("the merge mark on the issue rail", () => {
  it("says a mark Forge did not observe is a claim", () => {
    render(rail("asserted", null));
    expect(screen.getByText("claimed")).toBeInTheDocument();
    expect(screen.queryByText("observed")).toBeNull();
  });

  it("says a merge Forge observed is observed", () => {
    render(rail("observed", SHA));
    expect(screen.getByText("observed")).toBeInTheDocument();
    expect(screen.queryByText("claimed")).toBeNull();
  });

  it("names the commit a reader would check the observed merge against", () => {
    render(rail("observed", SHA));
    expect(screen.getByTitle(new RegExp(SHA))).toBeInTheDocument();
  });

  it("says why the claim is a claim, rather than only labelling it", () => {
    render(rail("asserted", null));
    expect(screen.getByTitle(/holds no merged pull request/)).toBeInTheDocument();
  });

  it("renders nothing rather than guessing when the server sends no mark", () => {
    // An older API answer carries `mergedAt` and no `mergeMark`. Rendering "observed" there would
    // be the browser inventing a reading core did not make.
    render(rail(undefined, null));
    expect(screen.queryByText("claimed")).toBeNull();
    expect(screen.queryByText("observed")).toBeNull();
  });
});
