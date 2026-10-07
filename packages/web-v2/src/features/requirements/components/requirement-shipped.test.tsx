// FB-102: dev's REQ-16 delivered and named no release, and its issues none either. The facts rail
// now names each release that shipped its issues, and each issue the release that shipped it.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IssueShippedLink, RequirementShipped } from "./requirement-facts";

const R72 = { version: "0.4.0-dev.72", at: "2026-10-05T12:00:00.000Z" };
const R80 = { version: "0.4.0-dev.80", at: "2026-10-06T12:00:00.000Z" };

describe("the releases that shipped a requirement", () => {
  it("names each as a link to the release, oldest first", () => {
    render(<RequirementShipped releases={[R72, R80]} slug="forge" />);
    const links = within(screen.getByTestId("facts-shipped-in")).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["0.4.0-dev.72", "/projects/forge/releases/0.4.0-dev.72"],
      ["0.4.0-dev.80", "/projects/forge/releases/0.4.0-dev.80"],
    ]);
  });

  it("says nothing where no release shipped any of its issues", () => {
    const { container } = render(<RequirementShipped releases={[]} slug="forge" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links an issue to the release that shipped it", () => {
    render(<IssueShippedLink shippedIn={R72} slug="forge" />);
    expect(screen.getByRole("link", { name: "Shipped in 0.4.0-dev.72" }).getAttribute("href")).toBe("/projects/forge/releases/0.4.0-dev.72");
  });
});
