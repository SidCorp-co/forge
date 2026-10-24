// @vitest-environment jsdom
//
// ISS-1421 r5 — judge-33 found the Label and Coolify application inputs of a deploy target with no
// accessible name: the column labels are spans above the first row only, tied to no input.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoolifyTargetsField } from "./targets-field";

expect.extend(matchers);

let applications: { uuid: string; name: string }[] = [];
let listError: Error | null = null;

vi.mock("../../hooks", () => ({
  useCoolifyApplications: () => ({
    data: listError ? undefined : { applications },
    isError: listError !== null,
    error: listError,
    isLoading: false,
  }),
  useCoolifyTargets: () => ({ data: { targets: [] } }),
}));

afterEach(() => {
  cleanup();
  applications = [];
  listError = null;
});

function renderField(targets: { label: string; resourceUuid: string }[], canFixCredentials = true) {
  render(
    <CoolifyTargetsField
      projectId="p1"
      stage="live"
      integrationId="int-1"
      baseUrl=""
      apiToken=""
      targets={targets}
      onChange={() => {}}
      inherited={false}
      canFixCredentials={canFixCredentials}
    />,
  );
}

describe("CoolifyTargetsField", () => {
  it("names the Label and the application input of a single target, typed by hand", () => {
    renderField([{ label: "", resourceUuid: "" }]);
    expect(screen.getByRole("textbox", { name: "Label" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Coolify application" })).toBeInTheDocument();
  });

  it("names the application picker when Coolify lists the applications", () => {
    applications = [{ uuid: "abcdef0123456789", name: "web" }];
    renderField([{ label: "", resourceUuid: "" }]);
    expect(screen.getByRole("combobox", { name: "Coolify application" })).toBeInTheDocument();
  });

  it("gives every row's inputs a name of its own, past the first row the column labels sit over", () => {
    renderField([
      { label: "Backend", resourceUuid: "" },
      { label: "Frontend", resourceUuid: "" },
    ]);
    for (const n of [1, 2]) {
      expect(screen.getByRole("textbox", { name: `Label of target ${n}` })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: `Coolify application of target ${n}` })).toBeInTheDocument();
    }
  });

  // ISS-1421 r26, judge-105 (283a): a plain member over the org's removed connection was told to fix
  // a token the drawer locks them out of.
  it("tells only a reader who may fix the base URL and token to fix them", () => {
    listError = new Error("This connection was removed and holds no key.");
    renderField([{ label: "", resourceUuid: "" }], false);
    expect(
      screen.getByText(/Could not read the application list\. This connection was removed and holds no key\. Enter the resource UUID by hand\.$/),
    ).toBeInTheDocument();
    cleanup();
    renderField([{ label: "", resourceUuid: "" }], true);
    expect(screen.getByText(/or fix the base URL and token above and try again\.$/)).toBeInTheDocument();
  });
});
