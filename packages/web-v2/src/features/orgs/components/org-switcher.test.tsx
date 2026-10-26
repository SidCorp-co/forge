// @vitest-environment jsdom
//
// ISS-1229 r45, judge-129: at 1280x900 the rail's organization switcher drew "QA J129 rooms" as
// "QA J129 roo…". r46, judge-135: wrapping the whole name there pushed the rail's last label out of view
// once the name took four lines. The narrow rail shows the organization's mark, never the name, so it is
// one height whatever the name; the whole name is its accessible name and tooltip, and is printed where
// there is room for it: the expanded rail, the phone's drawer and the open menu.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgSwitcher } from "./org-switcher";

const LONG = "QA J135 organization whose name runs well past the rail width";
const org = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  isPersonal: false,
  role: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
});

const state = vi.hoisted(() => ({ single: false, name: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../active-org", () => ({
  useActiveOrg: () => {
    const active = org("o1", state.name);
    return {
      orgs: state.single ? [active] : [active, org("o2", "Scratch")],
      activeOrg: active,
      setActiveOrg: vi.fn(),
      isSingle: state.single,
    };
  },
}));

afterEach(() => {
  cleanup();
  state.single = false;
  state.name = LONG;
});
state.name = LONG;

function control(single: boolean): HTMLElement {
  return screen.getByRole(single ? "link" : "button", { name: new RegExp(LONG) });
}

describe("the organization switcher on the narrow rail", () => {
  for (const single of [false, true]) {
    const which = single ? "one org" : "several";

    it(`shows the organization's mark and prints no name, so a long name never makes it taller (${which})`, () => {
      state.single = single;
      render(<OrgSwitcher variant="compact" />);
      const shown = control(single);
      expect(shown.textContent).toBe("QJ");
      expect(shown.querySelector("[data-testid=org-mark]")).toBeTruthy();
    });

    it(`holds the whole name in its tooltip and its accessible name (${which})`, () => {
      state.single = single;
      render(<OrgSwitcher variant="compact" />);
      expect(control(single).getAttribute("title")).toBe(LONG);
    });
  }

  it("names the switch in its accessible name", () => {
    render(<OrgSwitcher variant="compact" />);
    expect(screen.getByRole("button", { name: `Switch organization — current ${LONG}` })).toBeTruthy();
  });

  it("prints the whole name in the menu it opens", () => {
    render(<OrgSwitcher variant="compact" />);
    fireEvent.click(control(false));
    expect(screen.getByRole("menuitem", { name: new RegExp(LONG) }).textContent).toContain(LONG);
  });
});

describe("the organization switcher where there is room for the name", () => {
  for (const single of [false, true]) {
    it(`prints a long name whole, wrapping instead of cutting it (${single ? "one org" : "several"})`, () => {
      state.single = single;
      render(<OrgSwitcher variant="expanded" />);
      const label = [...control(single).querySelectorAll("span")].find((s) => s.textContent === LONG);
      if (!label) throw new Error("the switcher shows no label holding the whole name");
      const classes = label.className.split(/\s+/);
      expect(classes).not.toContain("truncate");
      expect(classes).toEqual(expect.arrayContaining(["whitespace-normal", "[overflow-wrap:anywhere]"]));
    });
  }
});
