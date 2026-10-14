// @vitest-environment jsdom
//
// ISS-1262: the settings pages are flat. A section carries no card chrome of its own, and the only
// rule between sections is the hairline above the second and every later one.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsSection } from "./settings-section";

afterEach(cleanup);

describe("SettingsSection", () => {
  it("carries no card chrome of its own", () => {
    render(<SettingsSection aria-label="one">x</SettingsSection>);
    expect(screen.getByLabelText("one").className).not.toMatch(/(^|\s)(rounded[-\w]*|shadow[-\w]*|bg-surface|border)(\s|$)/);
  });

  it("is told apart from what is above it by a hairline, which the first one does not have", () => {
    render(
      <div>
        <SettingsSection aria-label="first">a</SettingsSection>
        <SettingsSection aria-label="second">b</SettingsSection>
      </div>,
    );
    for (const name of ["first", "second"]) {
      const classes = screen.getByLabelText(name).className;
      expect(classes).toContain("[&:not(:first-child)]:border-t");
      expect(classes).toContain("[&:not(:first-child)]:border-line");
    }
  });
});
