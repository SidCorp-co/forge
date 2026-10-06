// Whose turn it is, said the same way on every list and page: core's waiting-on drawn as a mark,
// the name in bold and the act, with the rule that put it there on the tooltip.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WaitBanner, WaitingOn } from "./waiting-on";

describe("WaitingOn", () => {
  it("names who and what they owe, with the rule on the tooltip", () => {
    render(<WaitingOn w={{ kind: "master", who: "Master", act: "triage FB-3", rule: "high feedback waits on the master" }} />);
    const cell = screen.getByTestId("waiting-on");
    expect(cell).toHaveTextContent("Master · triage FB-3");
    expect(cell).toHaveAttribute("data-kind", "master");
    expect(cell).toHaveAttribute("title", "Master · triage FB-3 — high feedback waits on the master");
  });

  it("draws an act-less wait as the name alone", () => {
    render(<WaitingOn w={{ kind: "person", who: "A holder of feedback.approve", act: "" }} />);
    expect(screen.getByTestId("waiting-on").querySelector("b")).toHaveTextContent(/^A holder of feedback\.approve$/);
    expect(screen.getByTestId("waiting-on")).not.toHaveTextContent("·");
  });

  it("draws a wait on nobody as plain text with no mark", () => {
    render(<WaitingOn w={{ kind: "none", who: "Nobody", act: "" }} />);
    expect(screen.getByTestId("waiting-on")).toHaveAttribute("data-kind", "none");
  });

  it("puts a node the reader can open in place of the name", () => {
    render(<WaitingOn w={{ kind: "issue", who: "ISS-4", act: "ship" }} whoNode={<a href="/i/4">ISS-4</a>} />);
    expect(screen.getByRole("link", { name: "ISS-4" })).toBeInTheDocument();
  });
});

describe("WaitBanner", () => {
  it("is one line: its lead, its body, and the rule on the tooltip", () => {
    render(<WaitBanner tone="you" head="Waiting on you:" body="approve r2" rule="a proposed revision waits on a sign-off" />);
    const banner = screen.getByTestId("wait-banner");
    expect(banner).toHaveTextContent("Waiting on you:");
    expect(banner).toHaveTextContent("approve r2");
    expect(banner).toHaveAttribute("title", "a proposed revision waits on a sign-off");
  });
});
