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
  hasReleaseGate: false,
  releaseModel: "none",
  releaseStrategy: null,
  baseBranch: "main",
  liveBranch: null,
  targetUndeclared: false,
  providers: [],
  releaseRunnerLabel: null,
  rollback: null,
  rollbackMode: null,
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

  it("says the session closes issues directly only when the project declares no release", () => {
    renderWith({ hasReleaseGate: false, releaseModel: "none" });

    expect(screen.getByText(/declares no release, so a session closes its issues directly/i)).toBeInTheDocument();
  });

  it("says a declared model with no live target is refused, never closed directly", () => {
    const { container } = renderWith({
      hasReleaseGate: false,
      releaseModel: "publish",
      targetUndeclared: true,
      gaps: ["release-target"],
    });

    expect(screen.getByText(/refused by name until a live deploy binding is declared/i)).toBeInTheDocument();
    const onScreen = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(onScreen).not.toMatch(/closes its issues directly/i);
  });

  it("tells a project with no live target to ADD one, not to set something on it", () => {
    const { container } = renderWith({
      hasReleaseGate: false,
      releaseModel: "publish",
      targetUndeclared: true,
      gaps: ["release-target"],
    });

    expect(screen.getByRole("link", { name: /Add a live deploy binding/i })).toBeInTheDocument();
    const onScreen = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(onScreen).not.toMatch(/Set it on the live binding/i);
  });

  it("sends the live-endpoint gap to the Testing tab and not to the live binding", () => {
    const { container } = renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      providers: ["coolify"],
      gaps: ["live-commit-endpoint"],
    });

    const link = screen.getByRole("link", { name: /record the live commit endpoint/i });
    expect(link).toHaveAttribute("href", "/projects/forge-dev/settings?tab=testing");
    const onScreen = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(onScreen).toMatch(/records no live commit endpoint/i);
    expect(onScreen).not.toMatch(/Set it on the live binding/i);
  });

  it("still says set it on the live binding where the binding is the thing that is there", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "publish",
      providers: ["coolify"],
      gaps: ["verify-probes"],
    });

    expect(screen.getByRole("link", { name: /Set it on the live binding/i })).toBeInTheDocument();
  });

  it("says issues wait at the gate when both halves are declared", () => {
    const { container } = renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      providers: ["coolify"],
    });

    expect(screen.getByText(/declares both, so its issues wait at/i)).toBeInTheDocument();
    const onScreen = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(onScreen).not.toMatch(/closes its issues directly/i);
  });

  it("says which half is missing on a trunk project that has a binding", () => {
    renderWith({ hasReleaseGate: false, releaseModel: "none", providers: ["sentry"] });

    expect(
      screen.getByText(/A project has a release gate when it declares what releasing it means/i),
    ).toBeInTheDocument();
    expect(screen.getByText("main (no branch moves)")).toBeInTheDocument();
    expect(screen.getByText("none", { selector: "span" })).toBeInTheDocument();
  });

  it("says the target is missing when the project declares a release and has none", () => {
    renderWith({
      hasReleaseGate: false,
      releaseModel: "publish",
      targetUndeclared: true,
      gaps: ["release-target"],
    });

    expect(
      screen.getByText(/declares a release but has no active/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no live deploy binding to send it to/i)).toBeInTheDocument();
  });

  it("shows the promotion when the project does declare one", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      releaseStrategy: "merge-branch",
      liveBranch: "production",
      providers: ["coolify"],
      releaseRunnerLabel: "prod-box",
      rollback: null,
      rollbackMode: "coolify-image",
      hasVerify: true,
    });

    expect(screen.getByText("main → production")).toBeInTheDocument();
    expect(
      screen.getByText("promote — code moves to a live branch", { selector: "span" }),
    ).toBeInTheDocument();
    expect(screen.getByText("prod-box")).toBeInTheDocument();
  });

  it("renders no branch promotion for a publish project that still carries a live branch", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "publish",
      liveBranch: "production",
      providers: ["epodsystem"],
    });

    expect(screen.queryByText("main → production")).toBeNull();
    expect(screen.getByText("main (no branch moves)")).toBeInTheDocument();
    expect(
      screen.getByText("publish — an act on a live target", { selector: "span" }),
    ).toBeInTheDocument();
  });

  it("names every gap separately, with the consequence of leaving it", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      gaps: ["build-commands", "test-commands", "release-procedure", "release-runner", "rollback"],
    });

    expect(screen.getByText(/nothing to build with/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to prove its work with/i)).toBeInTheDocument();
    expect(screen.getByText(/written for another repo/i)).toBeInTheDocument();
    expect(screen.getByText(/refused rather than sent to an arbitrary box/i)).toBeInTheDocument();
    expect(screen.getByText(/aborts and comments/i)).toBeInTheDocument();
  });

  it("sends each gap to the screen that fixes it", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      gaps: ["release-procedure", "release-runner"],
    });

    expect(screen.getByRole("link", { name: /Knowledge rules/i })).toHaveAttribute(
      "href",
      "/projects/forge-dev/library?tab=knowledge&sub=rules",
    );
    expect(screen.getByRole("link", { name: /live binding/i })).toHaveAttribute(
      "href",
      "/projects/forge-dev/settings?tab=integrations",
    );
  });

  it("says why a project with two live deploy bindings cannot cut a release", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "publish",
      providers: ["coolify", "coolify"],
      releaseRunnerLabel: "prod-box",
      hasVerify: true,
      rollbackMode: "coolify-image",
      gaps: ["release-multi-channel"],
    });

    expect(screen.getByText(/ONE check of ONE address/i)).toBeInTheDocument();
    expect(screen.getByText(/refused by name until then/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Review the live deploy bindings/i }),
    ).toHaveAttribute("href", "/projects/forge-dev/settings?tab=integrations");
  });

  it("shows no banner at all when nothing is missing", () => {
    renderWith({ hasReleaseGate: true, releaseModel: "promote", liveBranch: "production", gaps: [] });

    expect(screen.queryByText(/nothing to build with/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("states the abort-and-comment default rather than a dash", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      rollbackMode: null,
    });

    expect(screen.getByText("abort and comment")).toBeInTheDocument();
  });

  it("says a coolify binding's free text is not executed", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      rollback: "ssh in and redeploy",
      rollbackMode: "unrepresentable",
      gaps: ["rollback-prose"],
    });

    expect(screen.getByText(/not executed, abort and comment/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer executes/i)).toBeInTheDocument();
  });

  it("says Forge performs the rollback when the binding declares the action", () => {
    renderWith({
      hasReleaseGate: true,
      releaseModel: "promote",
      liveBranch: "production",
      rollbackMode: "coolify-image",
    });

    expect(screen.getByText(/Forge rolls back to a Coolify image/i)).toBeInTheDocument();
  });
});
