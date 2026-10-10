// REQ-35 BC-8 and BC-12 on the feedback page (ISS-462; Feedback lifecycle step `evidence`): the item
// opens on its screenshots, its recordings and the workflow step it hits, above its text and actions;
// each screenshot and recording is read by a text alternative, never its file name; and the step is
// lit on that workflow with the requirement picture's highlight. The canvas is stood in for, since
// jsdom lays nothing out; it reports what it was asked to light.
//
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-step.tsx
// @direct-test-of packages/web-v2/src/features/feedback/hooks.ts

import { RECORDING_ROUTES } from "@forge/contracts/reproduce";
import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { FeedbackPage } from "./feedback-detail";
import { FeedbackEvidence } from "./feedback-evidence";
import { LinkedFeedback } from "./feedback-facts";

// the page's room entry (REQ-44) reads the router to open the room it starts; nothing here navigates
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({
  WorkflowCanvas: ({ highlight }: { highlight: { steps: Set<string>; edges: Set<string> } | null }) => (
    <div data-testid="canvas" data-steps={[...(highlight?.steps ?? [])].join(",")} data-edges={[...(highlight?.edges ?? [])].join(",")} />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const P = "22222222-2222-4222-8222-222222222222";
const ANN = "66666666-6666-4666-8666-666666666666";
const LIST = RECORDING_ROUTES.ofFeedback.replace(":id", P).replace(":fb", "FB-52").replace(/^\/api/, "");
const NONE = { triage: false, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: false, message: false, tellShipped: false, note: false, attach: false };

const file = (id: string, name: string, mime: string) => ({
  id,
  from: null,
  name,
  mime,
  size: 4096,
  flagged: false,
  uploadedBy: ANN,
  uploadedByName: "Ann",
  createdAt: "2026-10-09T10:00:00.000Z",
  url: `/api/projects/${P}/feedback/FB-52/attachments/${id}`,
});
const SHOT = file("a1", "IMG_0042.png", "image/png");

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f52",
    key: "FB-52",
    title: "Save order fails",
    writtenLang: "en",
    kind: "bug",
    severity: "high",
    status: "new",
    phase: "new",
    attentionGroup: "needs_you",
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: RULE }),
    target: { type: "screen", key: "Orders", title: null },
    route: null,
    reporter: { id: ANN, name: "Ann", agency: "human" },
    body: "Clicking Save shows a spinner forever.",
    whereSeen: null,
    duplicateOf: null,
    duplicates: [],
    source: null,
    decisions: [],
    attachments: [],
    reporters: [],
    messages: [],
    clarification: null,
    openSuggestions: 0,
    verified: null,
    autoVerify: null,
    verifyHeld: null,
    shipNotice: null,
    snoozed: null,
    redacted: false,
    redactedAt: null,
    createdAt: "2026-10-09T09:00:00.000Z",
    updatedAt: "2026-10-09T09:00:00.000Z",
    can: NONE,
    ...over,
  }) as FeedbackView;

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
    ],
    edges: [],
  },
};

/** Core with no recording for the item, the Checkout workflow, and every other read left in flight. */
const core = () =>
  fakeCore((c) => {
    if (c.path === LIST) return { body: { recordings: [] } };
    if (c.path === `/projects/${P}/workflows`) return { body: { workflows: [workflow], returned: 1 } };
    if (c.path === `/projects/${P}/workflow-templates`) return { body: { templates: [] } };
    return HANG;
  });

const at = (node: Node, other: Node) => node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;

describe("a feedback item opens on its evidence", () => {
  it("opens on its screenshot, above what the reporter said and the actions", async () => {
    core();
    const f = view({ attachments: [SHOT], can: { ...NONE, triage: true } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["feedback-item", P, f.key], { feedback: f });
    renderWithQuery(<FeedbackPage projectId={P} slug="hop" fbKey={f.key} tab="overview" onTab={() => {}} />, client);
    const evidence = await screen.findByTestId("feedback-evidence");
    const shot = within(evidence).getByRole("img", { name: "Screenshot 1 of 1 for FB-52: Save order fails" });
    expect(shot.getAttribute("src")).toBe(SHOT.url);
    expect(at(evidence, screen.getByTestId("feedback-body")), "the screenshot sits above the reporter's text").toBeTruthy();
    expect(at(evidence, document.getElementById("feedback-act") as Node), "the screenshot sits above the actions").toBeTruthy();
    expect(screen.queryByRole("img", { name: "IMG_0042.png" }), "no image is read by its file name").toBeNull();
  });

  it("reads every screenshot by its place and the item, never its file name", () => {
    core();
    renderWithQuery(<FeedbackEvidence projectId={P} slug="hop" f={view({ attachments: [SHOT, file("a2", "Screen Shot 2.png", "image/png")] })} />);
    expect(screen.getAllByRole("button", { name: /^Screenshot \d of 2 for FB-52: Save order fails$/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /IMG_0042|Screen Shot 2/ })).toBeNull();
  });

  it("draws nothing for an item with no screenshot, recording or step", async () => {
    const calls = core();
    renderWithQuery(<FeedbackEvidence projectId={P} slug="hop" f={view()} />);
    await vi.waitFor(() => expect(calls.some((c) => c.path === LIST)).toBe(true));
    expect(screen.queryByTestId("feedback-evidence")).toBeNull();
  });
});

describe("the workflow step a report hits", () => {
  const onWorkflow = (node: unknown, stepNames?: Record<string, string>) =>
    view({ target: { type: "workflow", key: "checkout", title: "Checkout", node, ...(stepNames ? { stepNames } : {}) } as FeedbackView["target"] });

  it("lights the step on that workflow, named by its text alternative", async () => {
    core();
    renderWithQuery(<FeedbackEvidence projectId={P} slug="hop" f={onWorkflow({ step: "pay" })} />);
    const figure = await screen.findByRole("figure", { name: "Checkout workflow with Pay highlighted" });
    expect(within(figure).getByTestId("canvas").getAttribute("data-steps")).toBe("pay");
    expect(within(figure).getByRole("link", { name: "Open workflow" }).getAttribute("href")).toBe("/projects/hop/workflows/checkout");
  });

  it("lights the link an item names between two steps", async () => {
    core();
    renderWithQuery(<FeedbackEvidence projectId={P} slug="hop" f={onWorkflow({ edge: { from: "cart", to: "pay" } })} />);
    const figure = await screen.findByRole("figure", { name: "Checkout workflow with Cart to Pay highlighted" });
    const canvas = within(figure).getByTestId("canvas");
    expect([canvas.getAttribute("data-steps"), canvas.getAttribute("data-edges")]).toEqual(["", "cart>pay"]);
  });

  it("names a step the design no longer has, and lights nothing", async () => {
    core();
    renderWithQuery(<FeedbackEvidence projectId={P} slug="hop" f={onWorkflow({ step: "refund" })} />);
    const figure = await screen.findByRole("figure", { name: "refund is no longer in Checkout" });
    expect(within(figure).getByTestId("canvas").getAttribute("data-steps")).toBe("");
  });

  it("shows no step for a workflow item that names none", async () => {
    const calls = core();
    renderWithQuery(<FeedbackEvidence projectId={P} slug="hop" f={onWorkflow(undefined)} />);
    await vi.waitFor(() => expect(calls.some((c) => c.path === LIST)).toBe(true));
    expect(screen.queryByRole("figure")).toBeNull();
  });

  it("names the step in the item's About fact by the words its design gives it", () => {
    renderWithQuery(<LinkedFeedback f={onWorkflow({ step: "pay" }, { pay: "Pay" })} slug="hop" />);
    expect(screen.getByTestId("facts-about")).toHaveTextContent("Step: Pay");
  });

  it("names the link in the item's About fact by its steps' words", () => {
    renderWithQuery(<LinkedFeedback f={onWorkflow({ edge: { from: "cart", to: "pay" } }, { cart: "Cart", pay: "Pay" })} slug="hop" />);
    expect(screen.getByTestId("facts-about")).toHaveTextContent("Link: Cart to Pay");
  });

  it("reads a step the design no longer names by its id", () => {
    renderWithQuery(<LinkedFeedback f={onWorkflow({ step: "pay" }, {})} slug="hop" />);
    expect(screen.getByTestId("facts-about")).toHaveTextContent("Step: pay");
  });
});
