// REQ-35 (ISS-459): a requirement's picture is each revision's own, drawn on the requirement and
// shown at once with no accept, so a mockup is no longer proposed about a requirement. The chat
// board still offered "Propose on REQ-n", which core then always refused with its raw sentence.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardStore } from "@/features/board/board-store";
import { fakeCore, renderWithQuery } from "@/test/render";
import { BoardPanel } from "./board-panel";

vi.mock("@/features/board/board-canvas", () => ({ default: () => null }));

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => boardStore.load({ v: "wireframe-v1", title: "Checkout", shapes: [{ id: "a", type: "frame", x: 0, y: 0, w: 10, h: 10 }] } as never));

function board() {
  const calls = fakeCore((c) =>
    c.method === "POST" ? { status: 201, body: { mockup: { key: "MK-1", target: { key: (c.body as { target: Record<string, string> }).target.issue ?? "FB-2" } } } } : undefined,
  );
  renderWithQuery(<BoardPanel projectId="p1" />);
  const field = screen.getByRole("textbox", { name: "Issue or feedback item to propose the board on" });
  const type = (key: string) => fireEvent.change(field, { target: { value: key } });
  return { calls, field, type };
}

describe("the chat board proposes on an issue or a feedback item only", () => {
  it("names no requirement in its label or placeholder", () => {
    const { field } = board();
    expect(field).toHaveAttribute("placeholder", "ISS-… FB-…");
    expect(screen.queryByText(/requirement or feedback/)).toBeNull();
  });

  it("refuses a requirement key by name, in the board, and sends nothing", () => {
    const { calls, type } = board();
    type("req-8");
    expect(screen.getByRole("button", { name: /Propose on/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("REQ-8 is a requirement, and a mockup is no longer proposed on one: its picture is drawn on the requirement itself");
    expect(calls).toEqual([]);
  });

  it.each([
    ["ISS-1", { issue: "ISS-1" }],
    ["FB-2", { feedback: "FB-2" }],
  ])("proposes on %s as itself, reading no requirement", async (key, target) => {
    const { calls, type } = board();
    type(key);
    fireEvent.click(screen.getByRole("button", { name: `Propose on ${key}` }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls.map((c) => [c.method, c.path])).toEqual([["POST", "/projects/p1/mockups"]]);
    expect(calls[0]?.body).toMatchObject({ target, kind: "wireframe" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
