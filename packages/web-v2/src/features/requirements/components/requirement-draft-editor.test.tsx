// A draft revision written in place shows a refused save's plain words on the field each refusal
// names (REQ-34 BC-18, ISS-457): the summary or the criteria, and only what neither owns under the form.

import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import type { RequirementDetail, RequirementRevision } from "../types";
import { DraftEditor } from "./requirement-draft-editor";

afterEach(() => vi.unstubAllGlobals());

const d = { key: "REQ-4" } as RequirementDetail;
const draft = { revision: 2, tldr: "Staff open the root page", spec: {}, criteria: [{ code: "BC-1", body: "The page opens", form: "statement" }] } as unknown as RequirementRevision;

const refuse = (...refusals: { code: string; path: string; detail: string }[]) =>
  fakeCore((c) => (c.method === "PUT" ? { status: 422, body: { error: { code: refusals[0]?.code, message: "refused", refusals } } } : HANG));

function save() {
  renderWithQuery(<DraftEditor projectId="p1" d={d} draft={draft} />);
  fireEvent.click(screen.getByRole("button", { name: "Write r2" }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
}

describe("the draft editor", () => {
  it("shows each refusal on the field it names", async () => {
    refuse(
      { code: "CRITERION_SCENARIO_UNPARSEABLE", path: "/criteria/0/body", detail: "A scenario criterion reads Given, When, Then." },
      { code: "BAD_REQUEST", path: "/tldr", detail: "The summary is too long." },
    );
    save();
    const criteria = await screen.findByRole("textbox", { name: "One criterion per line", description: "A scenario criterion reads Given, When, Then." });
    expect(criteria).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "Summary, one sentence" })).toHaveAccessibleDescription("The summary is too long.");
    expect(screen.queryByTestId("refusal")).toBeNull();
  });

  it("keeps a refusal no field owns on the line under the form", async () => {
    refuse({ code: "REQUIREMENT_REVISION_NOT_DRAFT", path: "/revision", detail: "r2 is proposed; write a new draft." });
    save();
    expect(await screen.findByTestId("refusal")).toHaveTextContent("r2 is proposed; write a new draft.");
    expect(screen.getByRole("textbox", { name: "One criterion per line" })).not.toHaveAttribute("aria-invalid");
  });
});
