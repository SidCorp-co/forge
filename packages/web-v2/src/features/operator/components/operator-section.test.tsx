// @vitest-environment jsdom
// ISS-1229 r48 (judge-142): /admin/alerts points at the Overview's Alerts section instead of "wired up" jargon.
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OperatorSection } from "./operator-section";
import { OperatorTopbar } from "./operator-topbar";

expect.extend(matchers);
afterEach(cleanup);

describe("the admin Alerts page", () => {
  it("never says the alerts are not wired up, in the page or its top bar", () => {
    render(<OperatorTopbar section="alerts" onAccount={() => {}} onSignOut={() => {}} />);
    render(<OperatorSection section="alerts" />);
    expect(document.body.textContent).not.toMatch(/wired up/i);
  });

  it("points at the Overview's Alerts section, and links to it", () => {
    render(<OperatorSection section="alerts" />);
    expect(screen.getByRole("heading", { level: 1, name: "Alerts are on the Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the Overview's Alerts" })).toHaveAttribute("href", "/admin");
  });
});
