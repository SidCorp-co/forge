// A requirement revised by hand from its Revisions view (lane 3): on an agreed requirement a new
// revision opens with the reason it is opened for and the head's criteria, a criterion is written as a
// statement or as Given / When / Then steps, and the open draft is edited in place. Only a draft is
// ever offered for writing: the agreed head and a proposal stand as they are, and a refusal core names
// is drawn on the criterion or field its path names.

import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, PROJECT } from "@/test/requirement-progress";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import type { RequirementDetail, RequirementRevision } from "../types";
import { RequirementPage } from "./requirement-detail";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

afterEach(() => vi.unstubAllGlobals());

const head = reqDetail.revisions.find((r) => r.state === "current") as RequirementRevision;
const proposed = reqDetail.revisions.find((r) => r.state === "proposed") as RequirementRevision;
const draft = { ...proposed, state: "draft", proposedAt: null } as RequirementRevision;

/** The fixture with only these revisions: agreed with nothing open, a draft open, or a proposal open. */
const withRevisions = (...revisions: RequirementRevision[]) =>
  ({ ...reqDetail, status: "agreed", revisions, standing: { ...reqDetail.standing, attentionGroup: "moving" } }) as RequirementDetail;
const agreed = withRevisions(head);
const drafting = withRevisions(draft, head);
const proposing = withRevisions(proposed, head);

const REVISIONS = `/projects/${PROJECT}/requirements/REQ-1/revisions`;

/** Core over fetch: the writes the editor sends answer `write`, every read hangs. */
function core(write: (c: Call) => { status?: number; body: unknown }) {
  return fakeCore((c) => (c.method === "GET" ? HANG : write(c)));
}

const refusal = (...refusals: { code: string; path: string; detail: string }[]) => ({ status: 422, body: { error: { code: refusals[0]?.code, message: "refused", refusals } } });

function show(d: RequirementDetail) {
  renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="revisions" onTab={() => {}} />, client(d));
  return screen.getByTestId("view-revisions");
}

const typeInto = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("a new revision on an agreed requirement", () => {
  it("opens with the head's criteria, needs its reason, and sends a scenario's steps as one body core parses", async () => {
    const calls = core(() => ({ body: drafting }));
    const view = show(agreed);
    fireEvent.click(within(view).getByTestId("revision-new"));
    const form = await screen.findByTestId("revision-form");
    expect(form).toHaveAttribute("data-target", "new");
    expect(within(form).getAllByTestId("criterion-draft")).toHaveLength(head.criteria.length);
    const submit = within(form).getByRole("button", { name: "Open draft" });
    // the reason it is opened for is owed before anything is sent
    expect(submit).toBeDisabled();
    typeInto(within(form).getByRole("textbox", { name: /Why it changes/ }), "Clinics asked for a weekly export");
    expect(submit).toBeEnabled();

    const second = within(form).getAllByTestId("criterion-draft")[1];
    fireEvent.click(within(second).getByRole("button", { name: "Scenario" }));
    typeInto(within(second).getByTestId("criterion-when"), "the week ends\nthe clinic is open");
    typeInto(within(second).getByTestId("criterion-then"), "a sheet is sent");
    fireEvent.click(submit);

    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const sent = calls.find((c) => c.method === "POST");
    expect(sent?.path).toBe(REVISIONS);
    expect(sent?.body).toMatchObject({
      baseRevision: 1,
      reason: "Clinics asked for a weekly export",
      criteria: [
        { code: "BC-1", body: head.criteria[0]?.body, form: "statement" },
        { code: "BC-2", body: `Given ${head.criteria[1]?.body}\nWhen the week ends\nAnd the clinic is open\nThen a sheet is sent`, form: "scenario" },
        { code: "BC-3", body: head.criteria[2]?.body, form: "statement" },
      ],
    });
    expect(sent?.body).not.toHaveProperty("kind");
  });

  it("sends an added criterion with no code and leaves a removed one out", async () => {
    const calls = core(() => ({ body: drafting }));
    const view = show(agreed);
    fireEvent.click(within(view).getByTestId("revision-new"));
    const form = await screen.findByTestId("revision-form");
    typeInto(within(form).getByRole("textbox", { name: /Why it changes/ }), "Narrower");
    fireEvent.click(within(form).getByRole("button", { name: "Remove criterion 3" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add criterion" }));
    typeInto(within(form).getByRole("textbox", { name: "Statement 3" }), "The sheet names each column");
    fireEvent.click(within(form).getByRole("button", { name: "Open draft" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const codes = (calls.find((c) => c.method === "POST")?.body as { criteria: { code?: string; body: string }[] }).criteria;
    expect(codes.map((c) => c.code ?? c.body)).toEqual(["BC-1", "BC-2", "The sheet names each column"]);
  });

  it("is not offered while a revision is open, draft or proposed", () => {
    core(() => ({ body: {} }));
    expect(within(show(drafting)).queryByTestId("revision-new")).toBeNull();
  });
});

describe("the open draft", () => {
  it("is edited in place and saved over its own revision", async () => {
    const calls = core(() => ({ body: drafting }));
    const view = show(drafting);
    fireEvent.click(within(view).getByTestId("revision-edit"));
    const form = await screen.findByTestId("revision-form");
    expect(form).toHaveAttribute("data-target", "draft");
    expect(within(form).getByRole("textbox", { name: /Why it changes/ })).toHaveValue(draft.reason);
    typeInto(within(form).getByRole("textbox", { name: "Statement 1" }), "Staff open the root page");
    fireEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`${REVISIONS}/2`);
    expect((put?.body as { criteria: unknown[] }).criteria[0]).toEqual({ code: "BC-1", body: "Staff open the root page", form: "statement" });
  });

  it("draws a refusal at one criterion on that criterion, and one no field owns under the form", async () => {
    core(() =>
      refusal(
        { code: "CRITERION_SCENARIO_UNPARSEABLE", path: "/criteria/1/body", detail: "A scenario reads Given, When, Then." },
        { code: "REQUIREMENT_REVISION_NOT_DRAFT", path: "/revision", detail: "r2 is proposed; write a new revision." },
      ),
    );
    const view = show(drafting);
    fireEvent.click(within(view).getByTestId("revision-edit"));
    const form = await screen.findByTestId("revision-form");
    fireEvent.click(within(form).getByRole("button", { name: "Save draft" }));
    const second = within(form).getAllByTestId("criterion-draft")[1];
    expect(await within(second).findByText("A scenario reads Given, When, Then.")).toBeInTheDocument();
    expect(within(form).getAllByTestId("criterion-draft")[0]).not.toHaveTextContent("A scenario reads");
    expect(within(form).getByTestId("revision-refusal")).toHaveTextContent("r2 is proposed; write a new revision.");
    expect(within(form).getByTestId("revision-refusal")).not.toHaveTextContent("A scenario reads");
  });
});

describe("what is never written here", () => {
  it("offers no editor on a proposal: it is accepted or returned, not rewritten", () => {
    core(() => ({ body: {} }));
    const view = show(proposing);
    expect(within(view).queryByTestId("revision-edit")).toBeNull();
    expect(within(view).queryByTestId("revision-new")).toBeNull();
  });

  it("offers no editor on the agreed head: a change to it is a new revision", () => {
    core(() => ({ body: {} }));
    const view = show(agreed);
    expect(within(view).queryByTestId("revision-edit")).toBeNull();
    expect(within(view).getByTestId("revision-new")).toBeInTheDocument();
  });

  it("offers nothing to write on a requirement that is done", () => {
    core(() => ({ body: {} }));
    const done = { ...agreed, status: "accepted", standing: { ...agreed.standing, attentionGroup: "done" } } as RequirementDetail;
    expect(within(show(done)).queryByTestId("revision-new")).toBeNull();
  });
});
