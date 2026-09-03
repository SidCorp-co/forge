// @vitest-environment jsdom
//
// The panel's job is to say what is MISSING before an issue runs. So every
// case below asserts a specific sentence, never merely that a banner rendered
// — a panel that shows one generic warning for five different gaps is the
// thing this replaced.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseSection } from "./components/release-section";
import type { ReleaseReadiness } from "./types";

expect.extend(matchers);
afterEach(cleanup);

const query = vi.fn();
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return { ...actual, useReleaseReadiness: () => query() };
});

const BASE: ReleaseReadiness = {
  hasProduction: false,
  baseBranch: "main",
  productionBranch: "main",
  provider: null,
  releaseRunnerLabel: null,
  rollback: null,
  hasVerify: false,
  gaps: [],
};

function renderWith(data: Partial<ReleaseReadiness>) {
  query.mockReturnValue({
    data: { ...BASE, ...data },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return render(<ReleaseSection projectId="p1" slug="forge-dev" />);
}

describe("ReleaseSection", () => {
  it("renders a skeleton while loading, not an empty panel", () => {
    query.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() });
    const { container } = render(<ReleaseSection projectId="p1" slug="forge-dev" />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders a retryable error rather than collapsing to nothing", () => {
    const refetch = vi.fn();
    query.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      refetch,
    });
    render(<ReleaseSection projectId="p1" slug="forge-dev" />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  // cm:guard the AND is the product rule and the copy has to carry it: an operator on a trunk repo with a sentry binding has "an integration" and no release, and a panel that says only "no production" sends them to add a second binding that changes nothing.
  it("says which half is missing on a trunk project that has a binding", () => {
    renderWith({ hasProduction: false, provider: "sentry" });

    expect(screen.getByText(/A project has production when it has an active/i)).toBeInTheDocument();
    expect(screen.getByText("main (trunk)")).toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("shows the promotion when the project does declare production", () => {
    renderWith({
      hasProduction: true,
      productionBranch: "production",
      provider: "coolify",
      releaseRunnerLabel: "prod-box",
      rollback: "redeploy the previous tag",
      hasVerify: true,
    });

    expect(screen.getByText("main → production")).toBeInTheDocument();
    expect(screen.getByText("declared", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("prod-box")).toBeInTheDocument();
  });

  // cm:guard each gap gets its OWN sentence naming its own consequence. These five arrive from different places and are fixed in different screens; one banner reading "configuration incomplete" would be the same non-answer a job gives hours later.
  it("names every gap separately, with the consequence of leaving it", () => {
    renderWith({
      hasProduction: true,
      productionBranch: "production",
      gaps: ["build-commands", "test-commands", "release-procedure", "release-runner", "rollback"],
    });

    expect(screen.getByText(/nothing to build with/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to prove its work with/i)).toBeInTheDocument();
    expect(screen.getByText(/written for another repo/i)).toBeInTheDocument();
    expect(screen.getByText(/refused rather than sent to an arbitrary box/i)).toBeInTheDocument();
    expect(screen.getByText(/aborts and comments/i)).toBeInTheDocument();
  });

  // cm:guard a fact gap sends the reader to Project Facts and a binding gap to Integrations — the two are edited on different screens, so one shared link would be wrong for whichever half it is not.
  it("sends each gap to the screen that fixes it", () => {
    renderWith({
      hasProduction: true,
      productionBranch: "production",
      gaps: ["release-procedure", "release-runner"],
    });

    expect(screen.getByRole("link", { name: /Project Facts/i })).toHaveAttribute(
      "href",
      "/projects/forge-dev/settings?tab=facts",
    );
    expect(screen.getByRole("link", { name: /production binding/i })).toHaveAttribute(
      "href",
      "/projects/forge-dev/settings?tab=integrations",
    );
  });

  it("shows no banner at all when nothing is missing", () => {
    renderWith({ hasProduction: true, productionBranch: "production", gaps: [] });

    expect(screen.queryByText(/nothing to build with/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  // cm:guard an undeclared rollback is a DEFAULT the operator is running under, not an absence — the release aborts and comments rather than rolling back blind, and a dash here would read as "unknown".
  it("states the abort-and-comment default rather than a dash", () => {
    renderWith({ hasProduction: true, productionBranch: "production", rollback: null });

    expect(screen.getByText("abort and comment")).toBeInTheDocument();
  });
});
