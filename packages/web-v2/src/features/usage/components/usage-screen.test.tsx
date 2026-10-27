// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: { id: "o1", name: "Acme" } }) }));
const { UsageScreen } = await import("./usage-screen");

afterEach(cleanup);

describe("the Usage page (ISS-1229 r48: it said spend metering \"isn't wired up yet\")", () => {
  it("says what Forge does not total yet, in plain words, never wired up", () => {
    render(<UsageScreen />);
    expect(document.body.textContent).not.toMatch(/wired up/i);
    expect(screen.getByText(/Forge does not total token spend for Acme yet/)).toBeTruthy();
  });
});
