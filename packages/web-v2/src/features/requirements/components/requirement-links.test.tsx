// What a requirement builds on, linked by hand from its rail (lane 3): a design of this project, and a
// contract the project publishes or consumes as its interface names it. One already linked is not
// offered again; core's refusal is shown by name; the peek reads the links and offers no act on them.

import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, PROJECT } from "@/test/requirement-progress";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail } from "../types";
import { RequirementProperties } from "./requirement-facts";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const d = { ...reqDetail, contracts: [{ providerProjectId: "p2", contract: "kho/api", contractSlug: "api", currentVersion: "1.2.0" }], standing: { ...reqDetail.standing, attentionGroup: "moving" } } as RequirementDetail;
const designs = ["w1", "w2", "w3"].map((id, i) => ({ document: { id, flow: `f${i}`, title: `Design ${id}`, steps: [] } }));

function core(write: (c: Call) => { status?: number; body: unknown } = () => ({ body: d })) {
  return fakeCore((c) => {
    if (c.method !== "GET") return write(c);
    if (c.path === `/projects/${PROJECT}/workflows`) return { body: { workflows: designs, returned: 3 } };
    if (c.path === `/projects/${PROJECT}/interface`) return { body: { declared: true, document: { publishes: { events: {} }, consumes: [{ contract: "kho/api" }, { contract: "lab/results" }] } } };
    return HANG;
  });
}

function rail(detail: RequirementDetail = d, full = true) {
  renderWithQuery(<RequirementProperties d={detail} slug="hop" projectId={PROJECT} onOpenRevisions={full ? () => {} : undefined} />, client(detail));
}

describe("linking a design", () => {
  it("offers only the designs not yet linked, and links the one picked", async () => {
    const calls = core();
    rail();
    const group = screen.getByTestId("facts-design");
    fireEvent.click(within(group).getByTestId("link-design-open"));
    const pick = within(group).getByTestId("link-design");
    const user = userEvent.setup();
    await user.click(await within(pick).findByRole("combobox"));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Design w3"]);
    await user.click(options[0]);
    await user.click(within(pick).getByRole("button", { name: "Link" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `/projects/${PROJECT}/requirements/REQ-1/workflows`, body: { workflowId: "w3" } });
  });

  it("takes a design's link away by its id", async () => {
    const calls = core();
    rail();
    fireEvent.click(within(screen.getByTestId("facts-design")).getByRole("button", { name: "Unlink Thanh toan" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/projects/${PROJECT}/requirements/REQ-1/workflows/w1`);
  });
});

describe("linking a contract", () => {
  it("offers what the interface publishes under the project's slug and what it consumes, less what is linked", async () => {
    const calls = core();
    rail();
    const group = screen.getByTestId("facts-contracts");
    expect(within(group).getByTestId("rail-contract")).toHaveTextContent("kho/api");
    expect(within(group).getByTestId("rail-contract")).toHaveTextContent("1.2.0");
    fireEvent.click(within(group).getByTestId("link-contract-open"));
    const user = userEvent.setup();
    await user.click(await within(within(group).getByTestId("link-contract")).findByRole("combobox"));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["hop/events", "lab/results"]);
    await user.click(options[1]);
    await user.click(within(group).getByRole("button", { name: "Link" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `/projects/${PROJECT}/requirements/REQ-1/contracts`, body: { contract: "lab/results" } });
  });

  it("takes a contract's link away by its project and slug", async () => {
    const calls = core();
    rail();
    fireEvent.click(within(screen.getByTestId("facts-contracts")).getByRole("button", { name: "Unlink kho/api" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.path).toBe(`/projects/${PROJECT}/requirements/REQ-1/contracts/kho/api`);
  });

  it("shows core's refusal by name", async () => {
    core(() => ({ status: 422, body: { error: { code: "REQUIREMENT_REFUSED", message: "refused", refusals: [{ code: "REQUIREMENT_CONTRACT_UNKNOWN", path: "/contract", detail: "kho/api is neither published nor consumed." }] } } }));
    rail();
    fireEvent.click(within(screen.getByTestId("facts-contracts")).getByRole("button", { name: "Unlink kho/api" }));
    expect(await screen.findByTestId("link-contract-refusal")).toHaveTextContent("REQUIREMENT_CONTRACT_UNKNOWN");
  });
});

describe("where no link is offered", () => {
  it("reads the links in the peek and offers no act on them", () => {
    core();
    rail(d, false);
    expect(screen.queryByTestId("link-design-open")).toBeNull();
    expect(screen.queryByTestId("link-contract-open")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unlink/ })).toBeNull();
    expect(screen.getByTestId("rail-contract")).toHaveTextContent("kho/api");
  });

  it("offers no act on a requirement that is done", () => {
    core();
    rail({ ...d, standing: { ...d.standing, attentionGroup: "done" } });
    expect(screen.queryByTestId("link-design-open")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unlink/ })).toBeNull();
  });
});
