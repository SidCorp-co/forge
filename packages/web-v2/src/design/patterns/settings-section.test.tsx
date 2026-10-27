// @vitest-environment jsdom
//
// ISS-1262: the settings pages are flat. A section carries no card chrome of its own, and the only
// rule between sections is the hairline above the second and every later one.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// ISS-1236 r9, judge-149: the refused-repository toast's link to `?tab=shape#repository` opened Shape
// & release at its top at 390, with Repository under the sticky Save bar.
describe("a section the page's fragment names", () => {
  const scrolled: { el: Element; how: unknown }[] = [];
  const was = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = was;
    scrolled.length = 0;
    window.location.hash = "";
  });
  const watchScrolls = () => {
    Element.prototype.scrollIntoView = function (this: Element, how?: unknown) {
      scrolled.push({ el: this, how });
    };
  };

  it("brings its heading to the start of the view, under a sticky top bar", () => {
    watchScrolls();
    window.location.hash = "#repository";
    const bar = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { bottom: this.tagName === "HEADER" ? 61 : 0 } as DOMRect;
    });
    try {
      render(
        <div>
          <header style={{ position: "sticky" }}>bar</header>
          <SettingsSection aria-label="shape" id="shape">a</SettingsSection>
          <SettingsSection aria-label="repository" id="repository">b</SettingsSection>
        </div>,
      );
      const section = screen.getByLabelText("repository");
      expect(scrolled.map((s) => s.el)).toEqual([section]);
      expect(scrolled[0]?.how).toEqual({ block: "start" });
      expect(section.style.scrollMarginTop).toBe("73px");
      expect(section.id).toBe("repository");
    } finally {
      bar.mockRestore();
    }
  });

  it("leaves the page where it is when the fragment names another section, or none", () => {
    watchScrolls();
    window.location.hash = "#release-path";
    render(<SettingsSection aria-label="repository" id="repository">b</SettingsSection>);
    cleanup();
    window.location.hash = "";
    render(<SettingsSection aria-label="repository" id="repository">b</SettingsSection>);
    expect(scrolled).toEqual([]);
  });
});
