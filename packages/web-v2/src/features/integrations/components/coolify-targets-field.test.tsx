// @vitest-environment jsdom
//
// ISS-925 — the deploy target stopped being a uuid an operator copied out of
// another browser tab. What the tests below pin is the two halves of that: the
// field offers what Coolify lists, and a binding that points at something
// Coolify does not list says so in Forge.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoolifyTargetsField } from "./coolify-targets-field";
import type { CoolifyApplication, CoolifyTargetIdentity } from "../types";

expect.extend(matchers);
afterEach(cleanup);

const applications = vi.fn<() => CoolifyApplication[]>(() => []);
const identities = vi.fn<() => CoolifyTargetIdentity[]>(() => []);
const appsError = vi.fn<() => boolean>(() => false);

vi.mock("../hooks", () => ({
  useCoolifyApplications: () => ({
    data: { applications: applications() },
    isError: appsError(),
  }),
  useCoolifyTargets: () => ({ data: { targets: identities() }, isError: false }),
}));

const APP: CoolifyApplication = {
  uuid: "app-1",
  name: "forge-api",
  fqdn: "https://api.example",
  gitRepository: "git@github.com:acme/forge.git",
  gitBranch: "main",
  gitCommitSha: "abc1234def",
  status: "running",
};

function renderField(targets = [{ id: "t1", label: "Backend", resourceUuid: "app-1" }]) {
  return render(
    <CoolifyTargetsField
      projectId="p1"
      environment="prod"
      integrationId="b1"
      baseUrl="https://coolify.example"
      apiToken=""
      targets={targets}
      onChange={vi.fn()}
      inherited={false}
    />,
  );
}

describe("CoolifyTargetsField", () => {
  it("offers the applications Coolify lists instead of a uuid to transcribe", () => {
    applications.mockReturnValue([APP]);
    renderField();

    const select = screen.getByLabelText("Coolify application") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(
      [...select.options].map((o) => o.value).includes("app-1"),
    ).toBe(true);
    expect(screen.getByText(/forge-api/)).toBeInTheDocument();
  });

  it("shows a bound target's identity so a wrong binding is visible in Forge", () => {
    applications.mockReturnValue([APP]);
    identities.mockReturnValue([
      { ...APP, targetId: "t1", label: "Backend", found: true },
    ]);
    renderField();

    expect(screen.getByText(/api\.example/)).toBeInTheDocument();
    expect(screen.getByText(/main@abc1234/)).toBeInTheDocument();
  });

  // cm:guard a bound uuid Coolify does not list must be SAID, not rendered as an ordinary row — that silence is the "deploys the wrong repo" trap the healthcheck already refuses to stop at (ISS-925).
  it("names a bound uuid Coolify does not list", () => {
    applications.mockReturnValue([APP]);
    identities.mockReturnValue([
      {
        uuid: "app-gone",
        name: null,
        fqdn: null,
        gitRepository: null,
        gitBranch: null,
        gitCommitSha: null,
        status: null,
        targetId: "t2",
        label: "Frontend",
        found: false,
      },
    ]);
    renderField([{ id: "t2", label: "Frontend", resourceUuid: "app-gone" }]);

    expect(screen.getByText(/does not list this application/i)).toBeInTheDocument();
  });

  // cm:guard the free-text fallback is the ONLY way to configure a target when Coolify cannot be read, so removing it would make an unreachable Coolify an unconfigurable integration rather than a slower one.
  it("falls back to a typed uuid when the list cannot be read", () => {
    applications.mockReturnValue([]);
    appsError.mockReturnValue(true);
    renderField();

    expect(screen.getByPlaceholderText(/application uuid from Coolify/i)).toBeInTheDocument();
    expect(screen.getByText(/Could not read the application list/i)).toBeInTheDocument();
  });
});
