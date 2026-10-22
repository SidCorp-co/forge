// @vitest-environment jsdom
//
// ISS-1229 r34, judge-93: a room's tool card says what was done and, for a refused call, why; the stored
// name, the arguments and the raw result are behind Technical details, folded until opened.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallData } from "@/features/session/types";
import { RoomToolCard } from "./room-tool-card";

expect.extend(matchers);
afterEach(cleanup);

const refused: ToolCallData = {
  id: "t1",
  name: "forge",
  input: { argv: ["new", "-", "--title", "Footer typo", "--category", "bug"], body: "## Summary" },
  result: { exitCode: 1, stdout: "", stderr: "Hold — this files an issue the flow cannot carry. Each line below…" },
  isError: true,
};

describe("a room's tool card", () => {
  it("says what was refused and why, and shows no stored name, argument or result while folded", () => {
    render(<RoomToolCard tool={refused} />);
    const card = screen.getByTestId("room-tool-card");
    expect(screen.getByTestId("room-tool-said")).toHaveTextContent("Couldn't file “Footer typo”");
    expect(screen.getByTestId("room-tool-refusal")).toHaveTextContent("Hold — this files an issue the flow cannot carry.");
    expect(card).not.toHaveTextContent(/Failed|Object|fields|exitCode|argv|--category/);
    expect(card.textContent).not.toMatch(/\bforge\b/);
    expect(screen.queryByTestId("room-tool-technical")).not.toBeInTheDocument();
  });

  it("shows the stored name, the arguments and the raw result once Technical details is opened", () => {
    render(<RoomToolCard tool={refused} />);
    const toggle = screen.getByRole("button", { name: "Technical details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    const technical = screen.getByTestId("room-tool-technical");
    expect(technical).toHaveTextContent("forge");
    expect(technical).toHaveTextContent('"--category"');
    expect(technical).toHaveTextContent('"exitCode": 1');
  });

  it("says Used a tool for one the room has no words for, its name only under Technical details", () => {
    render(<RoomToolCard tool={{ id: "o", name: "mcp__acme__frobnicate", input: { level: 3 }, result: { ok: true } }} />);
    expect(screen.getByTestId("room-tool-said")).toHaveTextContent("Used a tool");
    expect(screen.getByTestId("room-tool-card")).not.toHaveTextContent(/frobnicate|level/);
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByTestId("room-tool-technical")).toHaveTextContent("mcp__acme__frobnicate");
  });
});
