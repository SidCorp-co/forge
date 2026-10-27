// @vitest-environment node
// @gate-input whole-tree
//
// ISS-1132 — the issue page's Description and release note are drawn flat, like the sections below
// them: a hairline above and a label heading, no border on four sides, no rounded filled panel. This
// is laid out in a real Chrome over the app's own stylesheet at the two screens the owner reads the
// page on, because a class list says what was asked for and not what was drawn.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeChrome, WARM_HOOK_MS, warmChrome } from "@/test-support/chrome-layout";
import { type Drawn, drawnAt } from "@/test-support/flat-in-chrome";
import type { IssueDetail } from "../types";
import { DescriptionSection } from "./description-section";
import { FlatSection } from "./flat-section";
import { ReleaseNoteSection } from "./release-note-section";

vi.mock("../hooks", () => ({ useSaveDescription: () => ({ mutate: vi.fn(), isPending: false }) }));

beforeAll(() => warmChrome(), WARM_HOOK_MS);
afterAll(() => closeChrome());

const issue = {
  id: "i1",
  description: "What the issue says.\n\nA second paragraph that is long enough to wrap on a phone, so the section is measured with real text in it.",
  descriptionFormat: "markdown",
  status: "developed",
  agentStatus: null,
  releaseNotes: { userFacing: "You will see the page drawn flat.", section: "Changed" },
} as unknown as IssueDetail;

const page = () =>
  renderToStaticMarkup(
    <>
      <ReleaseNoteSection issue={issue} canWrite={false} />
      <DescriptionSection issue={issue} attachments={[]} canWrite />
      <FlatSection title="Steps">
        <p>None yet.</p>
      </FlatSection>
    </>,
  );

const at = (drawn: Drawn, label: string) => {
  const found = drawn.sections.find((s) => s.label === label);
  if (!found) throw new Error(`no section labelled ${label}; drew ${drawn.sections.map((s) => s.label).join(", ")}`);
  return found;
};

const TRANSPARENT = /^(transparent|rgba\(.*[, /]\s*0\))$/;

describe.each([1280, 390])("the issue page's top sections at %ipx", (viewport) => {
  it("draws Description under a hairline only: no side or bottom border, no radius, no shadow, no fill", async () => {
    const d = at(await drawnAt(page(), viewport), "Description");
    expect([d.borderTop, d.borderRight, d.borderBottom, d.borderLeft]).toEqual([1, 0, 0, 0]);
    expect(d.radius).toBe("0px");
    expect(d.shadow).toBe("none");
    expect(d.background).toMatch(TRANSPARENT);
    expect([d.paddingLeft, d.paddingRight]).toEqual(["0px", "0px"]);
  });

  it("draws Description exactly as it draws Steps below it: same rule, same inset, same width, same heading", async () => {
    const drawn = await drawnAt(page(), viewport);
    const { label: _a, ...description } = at(drawn, "Description");
    const { label: _b, ...steps } = at(drawn, "Steps");
    expect(description).toEqual(steps);
  });

  it("draws the release note flat too, so no card stands above the flat sections", async () => {
    const note = at(await drawnAt(page(), viewport), "What will change once it ships");
    expect([note.borderTop, note.borderRight, note.borderBottom, note.borderLeft]).toEqual([1, 0, 0, 0]);
    expect(note.radius).toBe("0px");
    expect(note.background).toMatch(TRANSPARENT);
  });

  it("draws nothing inside the column as a boxed container, and the column does not scroll sideways", async () => {
    const drawn = await drawnAt(page(), viewport);
    expect(drawn.boxed).toEqual([]);
    expect(drawn.scrollsSideways).toBe(false);
  });
});
