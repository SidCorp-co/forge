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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

vi.mock("./landing-shape-control", () => ({
  LandingShapeControl: () => null,
}));

const controlProps: Array<Record<string, unknown>> = [];
vi.mock("./merge-marker-control", () => ({
  MergeMarkerControl: (props: Record<string, unknown>) => {
    controlProps.push(props);
    return null;
  },
}));

afterEach(cleanup);

const MERGED_AT = "2026-09-20T14:59:37.646Z";
const SHA = "9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8";

function rail(
  mark?: IssueDetail["mergeMark"],
  mergedCommitSha?: string | null,
  mergedLanding?: string | null,
  landingShape?: IssueDetail["landingShape"],
  mergedClaimedCommit?: string | null,
): ReactNode {
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
    mergedLanding,
    mergedClaimedCommit,
    landingShape,
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

  it("says an unverified claim is claimed, shows its commit and says it is not verified (ISS-1409)", () => {
    render(rail("asserted", null, null, "git", SHA));
    expect(screen.getByText("claimed")).toBeInTheDocument();
    // ISS-1421 — seven characters to read, the whole commit on hover.
    expect(screen.getByTestId("merged-claim")).toHaveTextContent(`${SHA.slice(0, 7)} — not verified`);
    expect(screen.getByTestId("merged-claim")).not.toHaveTextContent(SHA.slice(0, 8));
    expect(screen.getByTestId("merged-claim").getAttribute("title")?.startsWith(`Commit ${SHA}. `)).toBe(true);
    expect(screen.queryByText("observed")).toBeNull();
  });

  it("shows a plain claim with no commit as before, with no not-verified line (ISS-1409)", () => {
    render(rail("asserted", null, null, "git", null));
    expect(screen.getByText("claimed")).toBeInTheDocument();
    expect(screen.queryByTestId("merged-claim")).toBeNull();
  });

  // ISS-1300 r3: a person's commit the repository holds is the mark's commit, and still a claim.
  it("shows a commit a person named as claimed and in the repository, never observed", () => {
    render(rail("asserted", SHA, null, "git", null));
    expect(screen.getByText("claimed")).toBeInTheDocument();
    expect(screen.getByTestId("merged-stated")).toHaveTextContent(`${SHA.slice(0, 7)} — in the repository`);
    expect(screen.getByTestId("merged-stated").getAttribute("title")).toContain("A person named it");
    expect(screen.queryByText("observed")).toBeNull();
    expect(screen.queryByTestId("merged-claim")).toBeNull();
  });

  it("never shows a claimed commit beside an observed merge (ISS-1409)", () => {
    render(rail("observed", SHA, null, "git", SHA));
    expect(screen.getByText("observed")).toBeInTheDocument();
    expect(screen.queryByTestId("merged-claim")).toBeNull();
  });

  it("says a merge Forge observed is observed", () => {
    render(rail("observed", SHA));
    expect(screen.getByText("observed")).toBeInTheDocument();
    expect(screen.queryByText("claimed")).toBeNull();
  });

  it("names the commit a reader would check the observed merge against", () => {
    render(rail("observed", SHA));
    expect(screen.getByTitle(SHA, { exact: false })).toBeInTheDocument();
  });

  // ISS-1421 r8, criterion 132: judge-40 saw only the date and "observed" after a move, the commit
  // kept on a hover nobody reaches at 390.
  it("shows an observed commit by seven characters, the whole commit on hover", () => {
    render(rail("observed", SHA));
    const commit = screen.getByTestId("merged-commit");
    expect(commit).toHaveTextContent(SHA.slice(0, 7));
    expect(commit).not.toHaveTextContent(SHA.slice(0, 8));
    expect(commit.getAttribute("title")).toBe(`Forge observed this merge at commit ${SHA}.`);
  });

  it("says a claim's commit was not checked without saying no reader exists", () => {
    render(rail("asserted", null, null, "git", SHA));
    const title = screen.getByTestId("merged-claim").getAttribute("title") ?? "";
    expect(title).toContain("could not check it against the repository");
    expect(title).not.toContain("no way to read");
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

describe("a mark naming where the work landed outside git (ISS-1327)", () => {
  const LANDING = "https://mowmentbrand.com/products/linen-tee";

  it("says landed, and shows the landing as text in the same row", () => {
    render(rail("landed", null, LANDING));
    expect(screen.getByText("landed")).toBeInTheDocument();
    // Visible text, not a hover: keyboard, touch and screen-reader users read it too.
    expect(screen.getByTestId("merged-landing")).toHaveTextContent(LANDING);
    expect(screen.queryByText("claimed")).toBeNull();
    expect(screen.queryByText("observed")).toBeNull();
  });

  it("explains a website mark naming no landing by the landing, never by a pull request", () => {
    // Owner ruling on ISS-1327: outside git no commit is the normal record, not a sign of a false mark.
    render(rail("asserted", null, null, "outside_git"));
    expect(screen.getByTitle(/names no landing/)).toBeInTheDocument();
    expect(screen.queryByTitle(/pull request/)).toBeNull();
  });
});

// ISS-1421 r37, judge-151: the Commit hint promised a claim on a project whose named repository Forge
// cannot read. The rail hands the control what core read for this issue's project.
describe("Mark merged is told what a commit meets on this project", () => {
  it.each(["checked", "claim", "refused", null] as const)("hands on %s, on an unmarked and a marked issue", (check) => {
    for (const mergedAt of [null, MERGED_AT]) {
      controlProps.length = 0;
      const issue = {
        id: "i1",
        displayId: "ISS-1126",
        status: "developed",
        agentStatus: "idle",
        priority: "critical",
        complexity: "m",
        labels: [],
        mergedAt,
        mergeMark: mergedAt ? "asserted" : undefined,
        landingShape: "git",
        markCommitCheck: check,
      } as unknown as IssueDetail;
      render(
        <QueryClientProvider client={new QueryClient()}>
          <PropertiesRail
            issue={issue}
            slug="p1"
            cost={undefined}
            deps={undefined}
            pending={false}
            canMarkMerged
            onPatch={vi.fn()}
            onTransition={vi.fn()}
          />
        </QueryClientProvider>,
      );
      expect(controlProps.length).toBeGreaterThan(0);
      for (const props of controlProps) expect(props.commitCheck).toBe(check);
      cleanup();
    }
  });
});

