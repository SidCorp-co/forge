// @vitest-environment jsdom
//
// The one save bar of a page: Save is there to be pressed only while something is unsaved and
// nothing blocks it, Discard appears with the first edit, and a reason that blocks Save is said in
// the bar rather than left to a button that will not press.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsFormBar } from "./settings-form-bar";

expect.extend(matchers);
afterEach(cleanup);

const bar = (props: Partial<Parameters<typeof SettingsFormBar>[0]> = {}) => {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  render(<SettingsFormBar dirty={false} onSave={onSave} onDiscard={onDiscard} {...props} />);
  return { onSave, onDiscard };
};

describe("SettingsFormBar", () => {
  it("says nothing is unsaved, and offers neither Save nor Discard to press", () => {
    bar();
    expect(screen.getByText("No unsaved changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("offers Save and Discard once something is unsaved, and each does its own work", () => {
    const { onSave, onDiscard } = bar({ dirty: true });
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("says what blocks Save instead of leaving a button that will not press", () => {
    const { onSave } = bar({ dirty: true, blockedBy: "Clear that pool before saving." });
    expect(screen.getByText("Clear that pool before saving.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the notices it is handed above its own line", () => {
    bar({ dirty: true, children: <p>Nothing was saved.</p> });
    expect(screen.getByText("Nothing was saved.")).toBeInTheDocument();
  });

  it("holds Discard while a save is in flight", () => {
    bar({ dirty: true, saving: true });
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });
});
