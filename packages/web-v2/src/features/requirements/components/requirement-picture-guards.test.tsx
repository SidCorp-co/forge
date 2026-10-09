// ISS-460 round 2, REQ-35 BC-2, BC-3, BC-10, BC-12: what the picture region guards. A kind change
// that would drop a drawn picture asks first, naming it; the kind control is labelled where it is
// seen and held while the editor is open; a picture that does not fit the kind is refused on the
// kind field in plain words; the wireframe editor saves neither before its board has loaded nor an
// empty board; a linked process offers no flow to draw; traces whose steps left the workflow light
// nothing and say so; and a keyboard user skips the picture in one step.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasHighlight } from "@/features/workflows/canvas/workflow-canvas";
import { BOARD, CHECKOUT_LINK, core, detail, FLOW, page, picture, puts, refusing, TABLE } from "@/test/requirement-pictures";
import type { Call } from "@/test/render";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

const canvases = vi.hoisted(() => [] as { flow: string; highlight: CanvasHighlight | null | undefined }[]);
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({
  WorkflowCanvas: (p: { doc: { flow: string }; highlight?: CanvasHighlight | null }) => {
    canvases.push({ flow: p.doc.flow, highlight: p.highlight });
    return <div data-testid="canvas-stub" />;
  },
}));
vi.mock("@/features/board/board-canvas", () => ({
  default: ({ doc }: { doc: { shapes: unknown[] } }) => (
    <div data-testid="board-stub">
      {doc.shapes.length} shapes <button type="button">Zoom in</button>
    </div>
  ),
}));
// The drawing board reports the scene it is set to; null is a board that has not loaded (its chunk
// still on the way, or failed), which reports nothing.
const board = vi.hoisted(() => ({ scene: null as unknown[] | null }));
vi.mock("@/features/board/board-editor", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({ onScene }: { onScene: (els: unknown[]) => void }) => {
      useEffect(() => {
        if (board.scene) onScene(board.scene);
      }, [onScene]);
      return <div data-testid={board.scene ? "board-editor-stub" : "board-editor-loading"} />;
    },
  };
});

afterEach(() => {
  canvases.length = 0;
  board.scene = null;
});

const kindField = () => screen.getByRole("combobox", { name: "What this requirement is" });

/** Core's kind write as `picture.ts:writeKind` makes it: the picture stays only where it fits the new kind. */
function kindWriter() {
  let rev = { kind: "rule" as string | null, picture: TABLE as typeof TABLE | null };
  const fits: Record<string, string> = { process: "flow", rule: "example_table", screen: "wireframe", report: "chart" };
  return {
    now: () => detail(rev as never),
    write: (c: Call) => {
      if (!c.path.endsWith("/kind")) return undefined;
      const kind = (c.body as { kind: string | null }).kind;
      rev = { kind, picture: rev.picture && kind && fits[kind] === rev.picture.kind ? rev.picture : null };
      return { body: detail(rev as never) };
    },
  };
}

describe("a kind change that would drop a drawn picture asks first (criteria 14, 15)", () => {
  it("labels the kind control where it is seen", async () => {
    core("member");
    picture(detail({ kind: "rule", picture: TABLE }));
    const field = await screen.findByRole("combobox", { name: "What this requirement is" });
    expect(field).not.toHaveAttribute("aria-label");
    expect(screen.getByText("What this requirement is").tagName).toBe("LABEL");
  });

  it("names the picture it removes and who drew it, and sends nothing on Cancel", async () => {
    const k = kindWriter();
    const calls = core("member", k.write);
    page(k.now());
    fireEvent.change(await screen.findByRole("combobox", { name: "What this requirement is" }), { target: { value: "screen" } });
    const ask = await screen.findByRole("alertdialog");
    expect(ask).toHaveTextContent("Make this a screen requirement?");
    expect(ask).toHaveTextContent("The example table Lan drew is removed");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(puts(calls)).toEqual([]);
    expect(screen.getByRole("figure", { name: TABLE.alt })).toBeInTheDocument();
    expect(kindField()).toHaveValue("rule");
  });

  it("sends the kind only on the dialog's change, and the picture then leaves as core says", async () => {
    const k = kindWriter();
    const calls = core("member", k.write);
    page(k.now());
    fireEvent.change(await screen.findByRole("combobox", { name: "What this requirement is" }), { target: { value: "screen" } });
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Change it and remove the picture" }));
    await waitFor(() => expect(puts(calls)).toEqual([{ path: "revisions/1/kind", body: { kind: "screen" } }]));
    expect(await screen.findByText(/No wireframe is drawn yet/)).toBeInTheDocument();
  });

  it("asks nothing where no picture is drawn", async () => {
    const calls = core("member", (c) => ({ body: detail({ kind: (c.body as { kind: "rule" }).kind }) }));
    picture(detail({ kind: "screen" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "What this requirement is" }), { target: { value: "rule" } });
    await waitFor(() => expect(puts(calls)).toEqual([{ path: "revisions/1/kind", body: { kind: "rule" } }]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("holds the kind control while the picture editor is open, saying why, so typed rows stay", async () => {
    core("member");
    picture(detail({ kind: "rule", picture: TABLE }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace the example table" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Input of row 1" }), { target: { value: "Order of 100 EUR exactly" } });
    expect(kindField()).toBeDisabled();
    expect(kindField()).toHaveAccessibleDescription("Save or cancel the picture first to change what this requirement is.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(kindField()).not.toBeDisabled();
  });
});

describe("a picture that does not fit the kind is refused on the kind field, in plain words (criterion 16)", () => {
  it("shows core's words on the kind field, with no code, route or internal kind name", async () => {
    const said = "REQ-1 r1 is a rule requirement, whose picture is an example table, not a flow; draw an example table, or correct its kind first.";
    core("member", () => refusing({ code: "REQUIREMENT_PICTURE_KIND_MISMATCH", path: "/kind", detail: said }));
    picture(detail({ kind: "process" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw the flow" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Steps, one per line" }), { target: { value: "Cart\nPay" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Text alternative/ }), { target: { value: "Cart leads to pay." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    await waitFor(() => expect(kindField()).toHaveAccessibleDescription(said));
    expect(screen.queryByText(/REQUIREMENT_PICTURE_KIND_MISMATCH/)).toBeNull();
    expect(screen.queryByTestId("refusal")).toBeNull();
  });
});

describe("the wireframe editor never replaces a drawn board with an empty one (criterion 17)", () => {
  it("cannot save before its board has loaded", async () => {
    const calls = core("member");
    picture(detail({ kind: "screen", picture: BOARD }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace the wireframe" }));
    await screen.findByTestId("board-editor-loading");
    const save = screen.getByRole("button", { name: "Save the picture" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(puts(calls)).toEqual([]);
    expect(screen.getByText("The board is still loading; it can be saved once it shows.")).toBeInTheDocument();
  });

  it("refuses an empty board before anything is sent", async () => {
    board.scene = [{ id: "gone", type: "rectangle", x: 0, y: 0, width: 10, height: 10, isDeleted: true }];
    const calls = core("member");
    picture(detail({ kind: "screen", picture: BOARD }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace the wireframe" }));
    await screen.findByTestId("board-editor-stub");
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    expect(await screen.findByText("The board is empty. Draw the wireframe on it, or cancel to keep the one shown.")).toBeInTheDocument();
    expect(puts(calls)).toEqual([]);
  });
});

describe("the board names what it cannot keep (criterion 18)", () => {
  it.each([
    ["ellipse", "an ellipse"],
    ["diamond", "a diamond"],
    ["line", "a line"],
    ["embeddable", "an embedded page"],
    ["sticker", "a shape it calls “sticker”"],
  ])("refuses a board holding the element %s, named as %s", async (type, named) => {
    board.scene = [{ id: "odd", type, x: 0, y: 0, width: 10, height: 10 }];
    const calls = core("member");
    picture(detail({ kind: "screen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw the wireframe" }));
    await screen.findByTestId("board-editor-stub");
    fireEvent.change(screen.getByRole("textbox", { name: /Text alternative/ }), { target: { value: "A frame." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    expect(await screen.findByText(`The board holds ${named}, which a wireframe does not keep. Use boxes, text, arrows and pen strokes.`)).toBeInTheDocument();
    expect(puts(calls)).toEqual([]);
  });
});

describe("a process that links a workflow (criteria 19, 20)", () => {
  it("offers no flow to draw, since the workflow is its picture", async () => {
    core("member");
    picture(detail({ kind: "process", picture: FLOW }, { workflows: [CHECKOUT_LINK], traces: [{ code: "BC-1", workflowId: "w1", flow: "checkout", steps: ["pay"], edges: [] }] }));
    await screen.findByTestId("canvas-stub");
    expect(screen.queryByRole("button", { name: /Draw the flow|Replace the flow/ })).toBeNull();
    expect(kindField()).toBeInTheDocument();
  });

  it("lights nothing and says so where every traced step has left the workflow", async () => {
    core("viewer");
    picture(detail({ kind: "process" }, { workflows: [CHECKOUT_LINK], traces: [{ code: "BC-1", workflowId: "w1", flow: "checkout", steps: ["shipping"], edges: [{ from: "cart", to: "shipping" }] }] }));
    await screen.findByTestId("canvas-stub");
    const f = screen.getByRole("figure");
    expect(f).toHaveAccessibleName("The Checkout workflow. None of the steps its criteria trace is in its current design: shipping.");
    expect(within(f).getByText("None of the steps its criteria trace is in this workflow's current design, so nothing is lit.")).toBeInTheDocument();
    expect(canvases.at(-1)?.highlight ?? null).toBeNull();
  });

  it("lights the traced steps still in the design and names the ones that left", async () => {
    core("viewer");
    picture(detail({ kind: "process" }, { workflows: [CHECKOUT_LINK], traces: [{ code: "BC-1", workflowId: "w1", flow: "checkout", steps: ["pay", "shipping"], edges: [] }] }));
    await screen.findByTestId("canvas-stub");
    await waitFor(() => expect(screen.getByRole("figure")).toHaveAccessibleName("The Checkout workflow, with the steps its criteria trace lit: Pay."));
    expect(screen.getByText("Traced but no longer in it: shipping.")).toBeInTheDocument();
    expect([...(canvases.at(-1)?.highlight?.steps ?? [])]).toEqual(["pay"]);
  });
});

describe("a keyboard user moves past the picture in one step (criterion 21)", () => {
  it("offers a skip link first in the picture that lands past it, before the tabs", async () => {
    core("viewer");
    page(detail({ kind: "process" }, { workflows: [CHECKOUT_LINK], traces: [{ code: "BC-1", workflowId: "w1", flow: "checkout", steps: ["pay"], edges: [] }] }));
    const skip = await screen.findByRole("link", { name: "Skip past the picture" });
    const figure = await screen.findByRole("figure");
    expect(Boolean(skip.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    fireEvent.click(skip);
    const landed = document.activeElement as HTMLElement;
    expect(landed).toHaveAttribute("data-testid", "picture-end");
    expect(Boolean(figure.compareDocumentPosition(landed) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(landed.compareDocumentPosition(screen.getByTestId("requirement-tabs")) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("holds nothing a keyboard can reach in the read-only board", async () => {
    core("viewer");
    picture(detail({ kind: "screen", picture: BOARD }));
    const f = await screen.findByRole("figure", { name: BOARD.alt });
    const shown = await within(f).findByTestId("picture-board");
    expect(shown).toHaveAttribute("inert");
    expect(shown.closest("[inert]")).toBe(shown);
  });
});
