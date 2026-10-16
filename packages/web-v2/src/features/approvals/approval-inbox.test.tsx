// The approval inbox (REQ-8, REQ-11): one list of what waits on the viewer's approve-type decision,
// drawn from core's one approvals read. Each row says what it is, who asked and since when; Approve
// confirms and posts the row's own body to the record's route, a reason only where the route keeps
// one; Decline will not send without the reason its asker reads; a row decided elsewhere opens there;
// a record core could not make a row of is named after the rows, with the way to its page.
//
// @direct-test-of packages/web-v2/src/features/approvals/components/approval-entry.tsx

import { type ApprovalInbox as Inbox, type ApprovalItem, type ApprovalUnreadable, approvalInboxSchema } from "@forge/contracts/approvals";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ApprovalInbox } from "./components/approval-inbox";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const P = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const mockup: ApprovalItem = {
  kind: "mockup",
  id: "mockup:m-1",
  key: "MK-3",
  title: "the checkout as it should look",
  suggestionKind: null,
  mockupKind: "html",
  revision: null,
  askedBy: { kind: "person", name: "Ana" },
  since: ago(3),
  opens: { kind: "issue", key: "ISS-4" },
  approve: { act: "mockup.accept", path: `/api/projects/${P}/mockups/MK-3/accept`, body: {}, reason: "optional" },
  decline: { act: "mockup.return", path: `/api/projects/${P}/mockups/MK-3/return`, body: {}, reason: "required" },
};
const suggestion: ApprovalItem = {
  ...mockup,
  kind: "suggestion",
  id: "suggestion:s-1",
  key: "REQ-2",
  title: "",
  suggestionKind: "revision_diff",
  mockupKind: null,
  askedBy: { kind: "assistant", name: "Bo" },
  since: ago(5),
  opens: { kind: "requirement", key: "REQ-2" },
  approve: { act: "suggestion.accept", path: `/api/projects/${P}/suggestions/s-1/accept`, body: {}, reason: "optional" },
  decline: { act: "suggestion.reject", path: `/api/projects/${P}/suggestions/s-1/reject`, body: {}, reason: "required" },
};
const preview: ApprovalItem = {
  ...mockup,
  kind: "preview",
  id: "preview:p-1",
  key: "ISS-9",
  title: "Pay by card",
  mockupKind: null,
  askedBy: null,
  since: ago(1),
  opens: { kind: "issue", key: "ISS-9" },
  approve: { act: "preview.approve", path: "/api/previews/p-1/approve", body: {}, reason: "none" },
  decline: null,
};
const repin: ApprovalItem = {
  ...mockup,
  kind: "repin",
  id: "repin:intake",
  key: "intake",
  title: "",
  mockupKind: null,
  askedBy: null,
  since: null,
  opens: { kind: "workflow", key: "intake" },
  approve: null,
  decline: null,
};

const inbox = (items: ApprovalItem[], unreadable: ApprovalUnreadable[] = []): Inbox =>
  approvalInboxSchema.parse({ generatedAt: "2026-10-16T00:00:00.000Z", items, unreadable, total: items.length + unreadable.length });

function core(read: Inbox, answer: (path: string) => { status?: number; body: unknown } = () => ({ body: {} })) {
  return fakeCore((c) => (c.method === "GET" && c.path === `/projects/${P}/approvals` ? { body: read } : answer(c.path)));
}

const rowOf = async (key: string) => {
  const rows = await screen.findAllByTestId("approval-entry");
  const row = rows.find((r) => within(r).queryByText(key));
  if (!row) throw new Error(`no row for ${key}`);
  return row;
};

describe("the approval inbox", () => {
  it("draws each row as what it is, who asked, how long it waited, and where it opens", async () => {
    core(inbox([suggestion, mockup, preview, repin]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const s = await rowOf("REQ-2");
    expect(s).toHaveTextContent("A suggestion on REQ-2");
    expect(s).toHaveTextContent("Suggestion · Revision diff");
    expect(s).toHaveTextContent("Assistant, for Bo");
    expect(s).toHaveTextContent("Waiting 5d");
    expect(within(s).getByTestId("approval-open")).toHaveAttribute("href", "/projects/hop/requirements/REQ-2");

    const m = await rowOf("MK-3");
    expect(m).toHaveTextContent("Asked by Ana");
    expect(within(m).getByTestId("approval-open")).toHaveAttribute("href", "/projects/hop/issues/ISS-4");
    expect(await rowOf("ISS-9")).toHaveTextContent("Asker not recorded");
  });

  it("holds a long title to two lines, the whole of it on hover", async () => {
    const long = "Route every refund over the limit to the payments team ".repeat(9).trim();
    core(inbox([{ ...mockup, title: long }]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const shown = within(await rowOf("MK-3")).getByTestId("approval-title");
    expect(shown.className).toMatch(/\bline-clamp-2\b/);
    expect(shown).toHaveAttribute("title", long);
  });

  it("offers a row decided on its own page no button, only the way there", async () => {
    core(inbox([repin]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const r = await rowOf("intake");
    expect(r).toHaveTextContent("Decided on its page");
    expect(within(r).queryByTestId("approval-approve")).toBeNull();
    expect(within(r).queryByTestId("approval-decline")).toBeNull();
    expect(within(r).getByTestId("approval-open")).toHaveAttribute("href", "/projects/hop/workflows/intake");
  });

  it("says nothing waits when nothing does, and draws no kind filter", async () => {
    core(inbox([]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-kinds")).toBeNull();
  });

  it("names a record core could not make a row of, beside the rows that answer, with the way to its page", async () => {
    const broken: ApprovalUnreadable = {
      kind: "suggestion",
      id: "suggestion:s-9",
      key: "ISS-12",
      opens: { kind: "issue", key: "ISS-12" },
      problem: "the asker's name is longer than 200 characters",
    };
    core(inbox([mockup], [broken]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const entry = await screen.findByTestId("approval-unreadable");
    expect(entry).toHaveTextContent("Suggestion ISS-12 could not be read here");
    expect(within(entry).getByTestId("approval-unreadable-problem")).toHaveTextContent("Unreadable: the asker's name is longer than 200 characters");
    expect(within(entry).getByTestId("approval-open")).toHaveAttribute("href", "/projects/hop/issues/ISS-12");
    expect(within(entry).queryByTestId("approval-approve")).toBeNull();
    expect(await rowOf("MK-3")).toBeInTheDocument();
    expect(screen.getByTestId("approval-kind-suggestion")).toHaveTextContent("Suggestion1");
  });

  it("narrows to one kind by its chip, with a count per kind", async () => {
    core(inbox([suggestion, mockup, preview]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    await rowOf("MK-3");
    const chip = screen.getByTestId("approval-kind-mockup");
    expect(chip).toHaveTextContent("Mockup1");
    expect(screen.queryByTestId("approval-kind-release")).toBeNull();
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getAllByTestId("approval-entry")).toHaveLength(1));
    expect(screen.getByTestId("approval-entry")).toHaveTextContent("MK-3");
  });

  it("approves through a confirm step that says what it does, posting the reason the route keeps", async () => {
    const calls = core(inbox([mockup]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const row = await rowOf("MK-3");
    fireEvent.click(within(row).getByTestId("approval-approve"));
    expect(within(row).getByTestId("accept-step")).toHaveTextContent("Accepts mockup MK-3.");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.change(within(row).getByRole("textbox"), { target: { value: "matches the brief" } });
    fireEvent.click(within(within(row).getByTestId("accept-step")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeDefined());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      path: `/projects/${P}/mockups/MK-3/accept`,
      body: { reason: "matches the brief" },
    });
  });

  it("sends no reason to a route that reads none", async () => {
    const calls = core(inbox([preview]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const row = await rowOf("ISS-9");
    fireEvent.click(within(row).getByTestId("approval-approve"));
    const confirm = within(row).getByTestId("approval-confirm");
    expect(within(confirm).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/previews/p-1/approve", body: {} }));
  });

  it("will not decline without the reason its asker reads", async () => {
    const calls = core(inbox([suggestion]));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const row = await rowOf("REQ-2");
    fireEvent.click(within(row).getByTestId("approval-decline"));
    const step = within(row).getByTestId("reject-step");
    const send = within(step).getByRole("button", { name: "Decline" });
    expect(send).toBeDisabled();
    fireEvent.change(within(step).getByRole("textbox"), { target: { value: "  " } });
    expect(send).toBeDisabled();
    fireEvent.change(within(step).getByRole("textbox"), { target: { value: "it drops BC-2" } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: `/projects/${P}/suggestions/s-1/reject`, body: { reason: "it drops BC-2" } }),
    );
  });

  it("shows core's refusal by name where a press is refused, and keeps the row", async () => {
    core(inbox([mockup]), () => ({
      status: 409,
      body: { error: { code: "MOCKUP_REFUSED", message: "refused", refusals: [{ code: "MOCKUP_DECIDED", path: "", detail: "MK-3 was already returned" }] } },
    }));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    const row = await rowOf("MK-3");
    fireEvent.click(within(row).getByTestId("approval-approve"));
    fireEvent.click(within(within(row).getByTestId("accept-step")).getByRole("button", { name: "Approve" }));
    expect(await within(row).findByTestId("refusal")).toHaveTextContent("MK-3 was already returned");
    expect(row).toHaveTextContent("MK-3");
  });

  it("names the failure when the read itself fails", async () => {
    fakeCore(() => ({ status: 500, body: { error: { code: "INTERNAL", message: "the read failed" } } }));
    renderWithQuery(<ApprovalInbox projectId={P} slug="hop" />);
    expect(await screen.findByText("Approvals did not load")).toBeInTheDocument();
  });
});
