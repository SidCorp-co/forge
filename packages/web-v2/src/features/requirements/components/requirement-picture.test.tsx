// ISS-460, REQ-35 BC-1..4, BC-10..12: a requirement's page opens on its picture, under the progress
// strip and above every text view, drawn by its kind: a process its linked workflow with the steps
// and links its criteria trace lit, else its rough flow; a rule its example table; a screen its
// wireframe inline; a report its sample chart. Each is labelled a rough sketch and named for a screen
// reader by its text alternative. A person holding project.write sets the kind and draws or replaces
// the picture there, and what core refuses shows in its words on the field it names.

import { type RequirementPictureView, writePictureRequestSchema } from "@forge/contracts/requirement-pictures";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasHighlight } from "@/features/workflows/canvas/workflow-canvas";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail, RequirementRevision } from "../types";
import { RequirementPage } from "./requirement-detail";
import { RequirementPicture } from "./requirement-picture";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

// React Flow cannot lay a canvas out in jsdom; what the page hands the canvas is the claim here
const canvases = vi.hoisted(() => [] as { flow: string; highlight: CanvasHighlight | null | undefined }[]);
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({
  WorkflowCanvas: (p: { doc: { flow: string }; highlight?: CanvasHighlight | null }) => {
    canvases.push({ flow: p.doc.flow, highlight: p.highlight });
    return <div data-testid="canvas-stub" />;
  },
}));
// Excalidraw does not run in jsdom: the read-only board says what it was handed, the drawing board hands a scene back
vi.mock("@/features/board/board-canvas", () => ({
  default: ({ doc }: { doc: { shapes: unknown[] } }) => <div data-testid="board-stub">{doc.shapes.length} shapes</div>,
}));
vi.mock("@/features/board/board-editor", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({ onScene }: { onScene: (els: unknown[]) => void }) => {
      useEffect(() => {
        onScene([{ id: "pay", type: "rectangle", x: 10, y: 10, width: 100, height: 40, customData: { wf: "button" } }]);
      }, [onScene]);
      return <div data-testid="board-editor-stub" />;
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  canvases.length = 0;
});

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";
const at = "2026-10-08T10:00:00.000Z";

const pic = (kind: RequirementPictureView["kind"], content: unknown, alt: string): RequirementPictureView => ({
  id: `p-${kind}`,
  kind,
  content: content as RequirementPictureView["content"],
  alt,
  roughSketch: true,
  drawnFor: 1,
  writtenBy: "u1",
  writtenByName: "Lan",
  writtenAgency: "human",
  writtenAt: at,
});

const TABLE = pic("example_table", { rows: [{ input: "Order of 120 EUR", expected: "Free delivery" }] }, "Orders over 100 EUR ship free.");
const FLOW = pic("flow", { nodes: [{ id: "cart", label: "Cart" }, { id: "pay", label: "Pay" }], edges: [{ from: "cart", to: "pay" }] }, "Cart leads to pay.");
const BOARD = pic("wireframe", { board: { v: "wireframe-v1", shapes: [{ type: "button", id: "b", x: 0, y: 0, w: 80, h: 30, label: "Pay" }] } }, "A pay button.");
const CHART = pic(
  "chart",
  { variant: "bar", x: "label", y: ["value"], frame: { fields: [{ name: "label", type: "string", label: "Week" }, { name: "value", type: "number", label: "Orders" }], rows: [{ label: "W1", value: 3 }] } },
  "Orders per week, three in week one.",
);

function detail(rev: Partial<RequirementRevision>, over: Partial<RequirementDetail> = {}): RequirementDetail {
  const current = reqDetail.revisions.find((r) => r.state === "current") as RequirementRevision;
  return { ...reqDetail, revisions: [{ ...current, kind: null, picture: null, ...rev }], workflows: [], traces: [], ...over };
}

const workflow = {
  revision: 3,
  writer: "u1",
  writerName: "Lan",
  design: { status: "approved", approvedRevision: 3 },
  document: {
    id: "w1",
    flow: "checkout",
    title: "Checkout",
    summary: "",
    kind: "flow",
    version: 1,
    steps: [
      { id: "cart", title: "Cart", does: "", after: [] },
      { id: "pay", title: "Pay", does: "", after: ["cart"] },
      { id: "done", title: "Done", does: "", after: ["pay"] },
    ],
    edges: [],
  },
};

/** Core as the page reads it: the viewer's role, the project's workflows, and what each write answers. */
function core(role: "viewer" | "member", write: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((c) => {
    if (c.method === "PUT") return write(c);
    if (c.path === "/projects") return { body: [{ id: PROJECT, slug: "hop", name: "Hop", role }] };
    if (c.path === `/projects/${PROJECT}/workflows`) return { body: { workflows: [workflow], returned: 1 } };
    if (c.path === `/projects/${PROJECT}/workflow-templates`) return { body: { templates: [] } };
    return HANG;
  });
}

function picture(d: RequirementDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, d.key], d);
  return renderWithQuery(<RequirementPicture d={d} projectId={PROJECT} slug="hop" inset="" />, client);
}

/** The whole page, reading the requirement from the query a write answers into. */
function page(d: RequirementDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, d.key], d);
  return renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey={d.key} tab="overview" onTab={() => {}} />, client);
}

const figure = (name: string) => screen.findByRole("figure", { name });

/** Every picture the page sent, each checked against the schema core's route judges it by. */
function sentPictures(calls: Call[]) {
  const sent = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/picture")).map((c) => c.body);
  for (const body of sent) expect(writePictureRequestSchema.safeParse(body).error?.issues ?? []).toEqual([]);
  return sent;
}

describe("the requirement page opens on its picture", () => {
  it("draws the picture under the progress strip and above the tabs and every text view", async () => {
    core("viewer");
    page(detail({ kind: "rule", picture: TABLE }));
    const region = await screen.findByTestId("requirement-picture");
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByTestId("requirement-progress"), region)).toBe(true);
    expect(follows(region, screen.getByTestId("requirement-tabs"))).toBe(true);
    expect(follows(region, screen.getByTestId("view-overview"))).toBe(true);
  });

  it("shows an empty slot, not prose, where no kind or no picture is named, and nothing to change for a viewer", async () => {
    core("viewer");
    const none = picture(detail({}));
    expect(within(none.container).getByTestId("picture-empty")).toHaveTextContent("does not say what it is");
    expect(screen.queryByRole("figure")).toBeNull();
    none.unmount();
    picture(detail({ kind: "screen" }));
    expect(screen.getByTestId("picture-empty")).toHaveTextContent("No wireframe is drawn yet");
    await screen.findByText("Screen");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Draw/ })).toBeNull();
  });

  it("draws a rule as its example table of input and expected result, labelled a rough sketch and named by its text alternative", async () => {
    core("viewer");
    picture(detail({ kind: "rule", picture: TABLE }));
    const f = await figure("Orders over 100 EUR ship free.");
    expect(within(f).getByText("Rough sketch, not final design")).toBeVisible();
    expect(within(f).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Input", "Expected result"]);
    expect(within(f).getByRole("cell", { name: "Free delivery" })).toBeInTheDocument();
  });

  it("draws a screen's wireframe inline, with nothing to open, and a report's chart marked sample", async () => {
    core("viewer");
    const board = picture(detail({ kind: "screen", picture: BOARD }));
    const f = await figure("A pay button.");
    expect(await within(f).findByTestId("board-stub")).toHaveTextContent("1 shapes");
    expect(within(f).getByText("Rough sketch, not final design")).toBeInTheDocument();
    board.unmount();
    picture(detail({ kind: "report", picture: CHART }));
    const c = await figure("Orders per week, three in week one.");
    expect(within(c).getByText("Sample figures")).toBeInTheDocument();
    expect(within(c).getByText("Rough sketch, not final design")).toBeInTheDocument();
  });

  it("draws a process that links no workflow as its rough flow", async () => {
    core("viewer");
    picture(detail({ kind: "process", picture: FLOW }));
    const f = await figure("Cart leads to pay.");
    expect(within(f).getByText("Rough sketch, not final design")).toBeInTheDocument();
    expect(screen.queryByTestId("picture-workflow")).toBeNull();
  });

  it("draws a process's linked workflow with the steps and links its live criteria trace lit, a retired criterion's trace lighting nothing", async () => {
    core("viewer");
    picture(
      detail(
        { kind: "process", picture: FLOW },
        {
          workflows: [{ workflowId: "w1", flow: "checkout", title: "Checkout", designStatus: "approved", approvedRevision: 3 }],
          traces: [
            { code: "BC-1", workflowId: "w1", flow: "checkout", steps: ["pay"], edges: [{ from: "cart", to: "pay" }] },
            { code: "BC-9", workflowId: "w1", flow: "checkout", steps: ["done"], edges: [] },
          ],
        },
      ),
    );
    const f = await figure("The Checkout workflow, with the steps its criteria trace lit: Pay.");
    expect(within(f).getByText("Rough sketch, not final design")).toBeInTheDocument();
    expect(within(f).getByTestId("canvas-stub")).toBeInTheDocument();
    const last = canvases.at(-1);
    expect(last?.flow).toBe("checkout");
    expect([...(last?.highlight?.steps ?? [])]).toEqual(["pay"]);
    expect([...(last?.highlight?.edges ?? [])]).toEqual(["cart>pay"]);
    expect(screen.queryByRole("figure", { name: "Cart leads to pay." })).toBeNull();
  });
});

describe("a project.write holder sets the kind and draws the picture on the page", () => {
  it("sets the kind, and the page then shows that kind's slot", async () => {
    const calls = core("member", (c) => ({ body: detail({ kind: (c.body as { kind: "rule" }).kind }) }));
    page(detail({}));
    expect(await screen.findByTestId("picture-empty")).toHaveTextContent("does not say what it is");
    fireEvent.change(await screen.findByRole("combobox", { name: "What this requirement is" }), { target: { value: "rule" } });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toEqual([{ method: "PUT", path: `/projects/${PROJECT}/requirements/REQ-1/revisions/1/kind`, body: { kind: "rule" } }]));
    expect(await screen.findByText("No example table is drawn yet. Nothing waits on it: the requirement moves on without one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draw the example table" })).toBeInTheDocument();
  });

  it("draws an example table with the text alternative they write, and shows it at once", async () => {
    const calls = core("member", () => ({ body: detail({ kind: "rule", picture: TABLE }) }));
    page(detail({ kind: "rule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw the example table" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Input of row 1" }), { target: { value: "Order of 120 EUR" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Expected result of row 1" }), { target: { value: "Free delivery" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Text alternative/ }), { target: { value: "Orders over 100 EUR ship free." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PUT")).toEqual([
        {
          method: "PUT",
          path: `/projects/${PROJECT}/requirements/REQ-1/revisions/1/picture`,
          body: { kind: "example_table", alt: "Orders over 100 EUR ship free.", content: { rows: [{ input: "Order of 120 EUR", expected: "Free delivery" }] } },
        },
      ]),
    );
    expect(await figure("Orders over 100 EUR ship free.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("picture-editor")).toBeNull());
    expect(screen.getByRole("button", { name: "Replace the example table" })).toBeInTheDocument();
  });

  it("shows what core refuses in its words on the field it names", async () => {
    core("member", () => ({
      status: 400,
      body: {
        error: {
          code: "REQUIREMENT_REFUSED",
          message: "refused",
          refusals: [
            { code: "REQUIREMENT_PICTURE_ALT_REQUIRED", path: "/alt", detail: "a picture carries a short text alternative, read by a screen reader in its place." },
            { code: "REQUIREMENT_PICTURE_ROW_INCOMPLETE", path: "/content/rows/0", detail: "row 1 of the example table has no expected result." },
          ],
        },
      },
    }));
    picture(detail({ kind: "rule" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw the example table" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Input of row 1" }), { target: { value: "Order of 120 EUR" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    expect(await screen.findByRole("textbox", { name: /Text alternative/ })).toHaveAccessibleDescription("a picture carries a short text alternative, read by a screen reader in its place.");
    expect(await screen.findByText("row 1 of the example table has no expected result.")).toBeInTheDocument();
  });

  it("draws a flow from steps and links, and names a link to a step that is not there before sending anything", async () => {
    const calls = core("member", () => ({ body: detail({ kind: "process", picture: FLOW }) }));
    picture(detail({ kind: "process" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw the flow" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Steps, one per line" }), { target: { value: "Cart\nPay" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Links, one per line" }), { target: { value: "Cart -> Ship" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Text alternative/ }), { target: { value: "Cart leads to pay." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    expect(screen.getByRole("textbox", { name: "Links, one per line" })).toHaveAccessibleDescription("Line 1 names “Ship”, which is not one of the steps above.");
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    fireEvent.change(screen.getByRole("textbox", { name: "Links, one per line" }), { target: { value: "Cart -> Pay: checkout" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    await waitFor(() =>
      expect(sentPictures(calls)).toEqual([
        { kind: "flow", alt: "Cart leads to pay.", content: { nodes: [{ id: "cart", label: "Cart" }, { id: "pay", label: "Pay" }], edges: [{ from: "cart", to: "pay", label: "checkout" }] } },
      ]),
    );
  });

  it("replaces a sample chart from its labelled figures", async () => {
    const calls = core("member", () => ({ body: detail({ kind: "report", picture: CHART }) }));
    picture(detail({ kind: "report", picture: CHART }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace the sample chart" }));
    expect(screen.getByRole("textbox", { name: /Text alternative/ })).toHaveValue(CHART.alt);
    fireEvent.change(screen.getByRole("textbox", { name: "Figure of row 1" }), { target: { value: "five" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    expect(await screen.findByText("Row 1's figure is not a number.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Figure of row 1" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    await waitFor(() =>
      expect(sentPictures(calls)).toEqual([
        {
          kind: "chart",
          alt: CHART.alt,
          content: { variant: "bar", x: "label", y: ["value"], frame: { fields: [{ name: "label", type: "string", label: "Week" }, { name: "value", type: "number", label: "Orders" }], rows: [{ label: "W1", value: 5 }] } },
        },
      ]),
    );
  });

  it("draws a screen's wireframe on the board and sends it as a wireframe-v1 board", async () => {
    const calls = core("member", () => ({ body: detail({ kind: "screen", picture: BOARD }) }));
    picture(detail({ kind: "screen" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draw the wireframe" }));
    await screen.findByTestId("board-editor-stub");
    fireEvent.change(screen.getByRole("textbox", { name: /Text alternative/ }), { target: { value: "A pay button." } });
    fireEvent.click(screen.getByRole("button", { name: "Save the picture" }));
    await waitFor(() =>
      expect(sentPictures(calls)).toEqual([
        { kind: "wireframe", alt: "A pay button.", content: { board: { v: "wireframe-v1", shapes: [{ type: "button", id: "pay", x: 10, y: 10, w: 100, h: 40, label: "" }] } } },
      ]),
    );
  });
});
