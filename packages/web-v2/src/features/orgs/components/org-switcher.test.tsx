// @vitest-environment jsdom
//
// ISS-1229 r45, judge-129: at 1280x900 the rail's organization switcher drew "QA J129 rooms" as
// "QA J129 roo…". The switcher is a label on the rail like the others, so it shows the whole name.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgSwitcher } from "./org-switcher";

const LONG = "Quality assurance desk for the J129 rooms";
const org = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  isPersonal: false,
  role: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
});

const state = vi.hoisted(() => ({ single: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../active-org", () => ({
  useActiveOrg: () => {
    const active = org("o1", "Quality assurance desk for the J129 rooms");
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
});

function nameShown(control: HTMLElement): HTMLElement {
  const label = [...control.querySelectorAll("span")].find((s) => s.textContent === LONG);
  if (!label) throw new Error("the switcher shows no label holding the whole name");
  return label;
}

describe("the organization switcher on the rail", () => {
  for (const variant of ["compact", "expanded"] as const) {
    for (const single of [false, true]) {
      it(`shows a long name whole, wrapping instead of cutting it (${variant}, ${single ? "one org" : "several"})`, () => {
        state.single = single;
        render(<OrgSwitcher variant={variant} />);
        const control = screen.getByRole(single ? "link" : "button", { name: new RegExp(LONG) });
        const classes = nameShown(control).className.split(/\s+/);
        expect(classes).not.toContain("truncate");
        expect(classes).toEqual(expect.arrayContaining(["whitespace-normal", "[overflow-wrap:anywhere]"]));
      });
    }
  }

  it("holds the whole name in its accessible name", () => {
    render(<OrgSwitcher variant="compact" />);
    expect(screen.getByRole("button", { name: `Switch organization — current ${LONG}` })).toBeTruthy();
  });
});
