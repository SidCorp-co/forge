// @vitest-environment jsdom
//
// ISS-1421 r5 — judge-33 found the Label and Coolify application inputs of a deploy target with no
// accessible name: the column labels are spans above the first row only, tied to no input.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoolifyTargetsField, mayFixCredentials } from "./targets-field";

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

function renderField(
  targets: { label: string; resourceUuid: string }[],
  canFixCredentials = true,
  canEditTargets = true,
) {
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
      canEditTargets={canEditTargets}
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

  // ISS-1421 r27: a plain member, whose targets the drawer locks, was asked to type a UUID by hand.
  it("asks for a UUID by hand only of a reader who may change the targets", () => {
    listError = new Error("This connection was removed and holds no key.");
    renderField([{ label: "", resourceUuid: "" }], false, false);
    expect(
      screen.getByText(/Could not read the application list\. This connection was removed and holds no key\.$/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/by hand/)).toBeNull();
  });

  // ISS-1421 r36, judge-145 on 344: a turned-off deploy target's drawer read core's "answers nothing:
  // it is switched off" and then "fix the base URL and token above and try again", which cannot turn
  // it on.
  it("never tells a reader to fix the base URL and token of a deploy target that is turned off", () => {
    expect(mayFixCredentials({ active: false }, false)).toBe(false);
    expect(mayFixCredentials({ active: true }, false)).toBe(true);
    expect(mayFixCredentials(undefined, false)).toBe(true);
    expect(mayFixCredentials({ active: true }, true)).toBe(false);
    listError = new Error(
      "This project's Coolify deploy target answers nothing: it is turned off for this project, and an admin of this project can turn it back on with Enabled on its Integrations tab. Nothing was asked of Coolify.",
    );
    renderField([{ label: "", resourceUuid: "" }], mayFixCredentials({ active: false }, false));
    expect(screen.getByText(/it is turned off for this project, and an admin of this project can turn it back on/)).toBeInTheDocument();
    expect(screen.queryByText(/base URL and token/)).toBeNull();
  });
});
