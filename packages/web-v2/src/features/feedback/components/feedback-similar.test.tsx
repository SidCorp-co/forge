// Similar feedback: the filed items nearest one item, and the likely duplicates of a draft before it is
// sent. A read core could not compare says why in its own words, never as an empty list that would
// read as "nothing similar"; a draft is compared only once its title says enough.

import type { SimilarFeedbackResponse } from "@forge/contracts/feedback";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { DraftDuplicates, SimilarFeedback } from "./feedback-similar";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const P = "p1";
const HITS: SimilarFeedbackResponse = {
  status: "ok",
  hits: [
    { key: "FB-9", title: "Export drops the header row", phase: "planned", similarity: 0.82 },
    { key: "FB-3", title: "Export is missing a column", phase: "new", similarity: 0.61 },
    { key: "FB-5", title: "CSV export is empty", phase: "resolved", similarity: 0.55 },
    { key: "FB-6", title: "Export is slow", phase: "verified", similarity: 0.41 },
  ],
};

describe("similar feedback on an item's page", () => {
  it("lists the nearest items, linked, with how alike each is", async () => {
    const calls = fakeCore((c) => (c.path === `/projects/${P}/feedback/FB-4/similar` ? { body: HITS } : undefined));
    renderWithQuery(<SimilarFeedback projectId={P} slug="hop" fbKey="FB-4" />);
    const hits = await screen.findAllByTestId("similar-hit");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /projects/${P}/feedback/FB-4/similar`]);
    expect(hits.map((h) => h.dataset.key)).toEqual(["FB-9", "FB-3", "FB-5", "FB-6"]);
    expect(hits[0]?.textContent).toContain("82% alike");
    expect(within(hits[0]).getByRole("link", { name: "FB-9" }).getAttribute("href")).toBe("/projects/hop/feedback/FB-9");
  });

  it("says none were found, rather than drawing an empty section", async () => {
    fakeCore(() => ({ body: { status: "ok", hits: [] } }));
    renderWithQuery(<SimilarFeedback projectId={P} slug="hop" fbKey="FB-4" />);
    expect((await screen.findByTestId("similar-none")).textContent).toBe("None found");
  });

  it.each([
    ["not_embedded", "Not compared yet"],
    ["provider_not_configured", "Provider not set up"],
    ["failed", "Not compared: the embedding provider failed"],
    ["withheld_by_policy", "Withheld by policy"],
  ] as const)("a read core could not compare (%s) says why, never 'none found'", async (status, line) => {
    fakeCore(() => ({ body: { status, message: "core's words", hits: [] } }));
    renderWithQuery(<SimilarFeedback projectId={P} slug="hop" fbKey="FB-4" />);
    const not = await screen.findByTestId("similar-not-compared");
    expect(not.dataset.status).toBe(status);
    expect(not.textContent).toBe(line);
    expect(screen.queryByTestId("similar-none")).toBeNull();
  });

  it("says the read failed instead of reading as nothing similar", async () => {
    fakeCore(() => ({ status: 500, body: { error: "INTERNAL", message: "boom" } }));
    renderWithQuery(<SimilarFeedback projectId={P} slug="hop" fbKey="FB-4" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Similar feedback could not be read");
  });
});

/** A form's title and body, typed into, with the duplicates panel beside them. */
function Draft() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <>
      <input aria-label="title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea aria-label="body" value={body} onChange={(e) => setBody(e.target.value)} />
      <DraftDuplicates projectId={P} slug="hop" title={title} body={body} />
    </>
  );
}

const drafts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === `/projects/${P}/feedback/similar`);

describe("likely duplicates of a draft", () => {
  it("compares nothing while the title has fewer than three words", async () => {
    const calls = fakeCore(() => ({ body: HITS }));
    renderWithQuery(<Draft />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Export broken" } });
    await new Promise((r) => setTimeout(r, 900));
    expect(drafts(calls)).toHaveLength(0);
    expect(screen.queryByTestId("feedback-draft-duplicates")).toBeNull();
  });

  it("compares a title of three words once typing pauses, sending the body too, and shows three at most", async () => {
    const calls = fakeCore(() => ({ body: HITS }));
    renderWithQuery(<Draft />);
    fireEvent.change(screen.getByLabelText("body"), { target: { value: "  The header row is gone.  " } });
    fireEvent.change(screen.getByLabelText("title"), { target: { value: " Export drops header " } });
    await waitFor(() => expect(screen.getAllByTestId("similar-hit")).toHaveLength(3), { timeout: 3000 });
    expect(drafts(calls).map((c) => c.body)).toEqual([{ title: "Export drops header", body: "The header row is gone." }]);
    expect(screen.queryByText("FB-6")).toBeNull();
  });

  it("sends no body key when the body is blank", async () => {
    const calls = fakeCore(() => ({ body: { status: "provider_not_configured", hits: [] } }));
    renderWithQuery(<Draft />);
    fireEvent.change(screen.getByLabelText("title"), { target: { value: "Export drops header" } });
    expect((await screen.findByTestId("similar-not-compared", {}, { timeout: 3000 })).dataset.status).toBe("provider_not_configured");
    expect(drafts(calls).map((c) => c.body)).toEqual([{ title: "Export drops header" }]);
  });
});
