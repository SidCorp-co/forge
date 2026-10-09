// The requirement picture's test world (ISS-460, REQ-35): one picture of each kind, a requirement
// revision carrying it, the workflow a process links, and core as the page reads it. The canvas and
// the board are mocked by each test file, since vi.mock is hoisted per file.

import { type RequirementPictureView, writePictureRequestSchema } from "@forge/contracts/requirement-pictures";
import { QueryClient } from "@tanstack/react-query";
import { expect } from "vitest";
import { RequirementPage } from "@/features/requirements/components/requirement-detail";
import { RequirementPicture } from "@/features/requirements/components/requirement-picture";
import type { RequirementDetail, RequirementRevision } from "@/features/requirements/types";
import { type Call, fakeCore, HANG, renderWithQuery } from "./render";
import { reqDetail } from "./vi-chrome-requirements";

export const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";
const at = "2026-10-08T10:00:00.000Z";

export const pic = (kind: RequirementPictureView["kind"], content: unknown, alt: string): RequirementPictureView => ({
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

export const TABLE = pic("example_table", { rows: [{ input: "Order of 120 EUR", expected: "Free delivery" }] }, "Orders over 100 EUR ship free.");
export const FLOW = pic("flow", { nodes: [{ id: "cart", label: "Cart" }, { id: "pay", label: "Pay" }], edges: [{ from: "cart", to: "pay" }] }, "Cart leads to pay.");
export const BOARD = pic("wireframe", { board: { v: "wireframe-v1", shapes: [{ type: "button", id: "b", x: 0, y: 0, w: 80, h: 30, label: "Pay" }] } }, "A pay button.");
export const CHART = pic(
  "chart",
  { variant: "bar", x: "label", y: ["value"], frame: { fields: [{ name: "label", type: "string", label: "Week" }, { name: "value", type: "number", label: "Orders" }], rows: [{ label: "W1", value: 3 }] } },
  "Orders per week, three in week one.",
);

/** The fixture requirement with its current revision carrying `rev`, linking no workflow unless `over` says so. */
export function detail(rev: Partial<RequirementRevision>, over: Partial<RequirementDetail> = {}): RequirementDetail {
  const current = reqDetail.revisions.find((r) => r.state === "current") as RequirementRevision;
  return { ...reqDetail, revisions: [{ ...current, kind: null, picture: null, ...rev }], workflows: [], traces: [], ...over };
}

/** The Checkout workflow a process requirement links, in its current design: cart, pay, done. */
export const workflow = {
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

/** The link a process requirement has to the Checkout workflow. */
export const CHECKOUT_LINK = { workflowId: "w1", flow: "checkout", title: "Checkout", designStatus: "approved" as const, approvedRevision: 3 };

/** Core as the page reads it: the viewer's role, the project's workflows, and what each write answers. */
export function core(role: "viewer" | "member", write: (c: Call) => { status?: number; body: unknown } | undefined = () => undefined) {
  return fakeCore((c) => {
    if (c.method === "PUT") return write(c);
    if (c.path === "/projects") return { body: [{ id: PROJECT, slug: "hop", name: "Hop", role }] };
    if (c.path === `/projects/${PROJECT}/workflows`) return { body: { workflows: [workflow], returned: 1 } };
    if (c.path === `/projects/${PROJECT}/workflow-templates`) return { body: { templates: [] } };
    return HANG;
  });
}

function clientOf(d: RequirementDetail) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["requirement", PROJECT, d.key], d);
  return client;
}

/** The picture region alone. */
export const picture = (d: RequirementDetail) => renderWithQuery(<RequirementPicture d={d} projectId={PROJECT} slug="hop" inset="" />, clientOf(d));

/** The whole page, reading the requirement from the query a write answers into. */
export const page = (d: RequirementDetail) =>
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey={d.key} tab="overview" onTab={() => {}} />, clientOf(d));

/** Every write the page sent, by the path under the requirement. */
export const puts = (calls: Call[]) =>
  calls.filter((c) => c.method === "PUT").map((c) => ({ path: c.path.replace(`/projects/${PROJECT}/requirements/REQ-1/`, ""), body: c.body }));

/** Every picture the page sent, each checked against the schema core's route judges it by. */
export function sentPictures(calls: Call[]) {
  const sent = calls.filter((c) => c.method === "PUT" && c.path.endsWith("/picture")).map((c) => c.body);
  for (const body of sent) expect(writePictureRequestSchema.safeParse(body).error?.issues ?? []).toEqual([]);
  return sent;
}

/** Core refusing a write with the refusals given, in its envelope. */
export const refusing = (...refusals: { code: string; path: string; detail: string }[]) => ({
  status: 400,
  body: { error: { code: "REQUIREMENT_REFUSED", message: "refused", refusals } },
});
