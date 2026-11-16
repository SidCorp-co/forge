// The ⌘K palette is the one search door (ISS-1256): what is typed is found over every record type,
// hits grouped by type and faceted by type, module and status, each with its path in the module tree.
// Opening a hit records the read and walks to its node on the map; a hit with no node opens where core
// says it is read. A search with no hit reads as a gap. The palette's commands still answer beneath.
//
// @direct-test-of packages/web-v2/src/features/modules/components/find-results.tsx
// @direct-test-of packages/web-v2/src/features/modules/find.ts
// @direct-test-of packages/web-v2/src/design/patterns/command-palette.tsx

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Command, CommandPalette } from "@/design";
import { FIND_CHIA_SLOT, FIND_NOTHING, MAP_PROJECT } from "@/test/module-map";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { FindResults } from "./find-results";

const push = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push }) }));

// cmdk scrolls the chosen item into view, which jsdom does not lay out
Element.prototype.scrollIntoView = () => {};

let calls: Call[] = [];
const commands: Command[] = [{ label: "Issues", icon: "board", group: "navigate", keywords: "issues list" }];

const palette = (query: string) =>
  renderWithQuery(<CommandPalette open onClose={() => {}} commands={commands} initialQuery={query} search={(q, close) => <FindResults projectId={MAP_PROJECT} slug="hop" query={q} onClose={close} />} />);

beforeEach(() => {
  push.mockClear();
  calls = fakeCore((c) => {
    if (c.method === "POST" && c.path === `/projects/${MAP_PROJECT}/find`) return { body: (c.body as { q: string }).q === "blorp" ? FIND_NOTHING : FIND_CHIA_SLOT };
    if (c.path.startsWith(`/projects/${MAP_PROJECT}/find/open`)) return { body: { hit: {}, url: "/projects/hop/issues/ISS-1255", text: "" } };
    return undefined;
  });
});

describe("the ⌘K search", () => {
  it("finds the term by its other name first, grouped by type, with its path in the tree", async () => {
    palette("chia slot");
    const groups = await screen.findAllByTestId(/^find-group-/);
    expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual(["find-group-term", "find-group-issue"]);
    const first = within(groups[0]).getByTestId("find-hit");
    expect(first.textContent).toContain("Run slots");
    expect(within(first).getByTestId("find-hit-path").textContent).toBe("Execution › Terms · active");
    expect(first.textContent).toContain("Matched “chia slot”");
    expect(calls[0]).toMatchObject({ method: "POST", path: `/projects/${MAP_PROJECT}/find`, body: { q: "chia slot" } });
  });

  it("leads with the find's hits and keeps the matching commands beneath", async () => {
    palette("issues");
    await screen.findAllByTestId("find-hit");
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options[0]).toContain("Run slots");
    expect(options.at(-1)).toContain("Issues");
  });

  it("walks an opened hit to its node on the map and records the read", async () => {
    palette("chia slot");
    fireEvent.click((await screen.findAllByTestId("find-hit"))[0]);
    expect(push).toHaveBeenCalledWith("/projects/hop/modules/execution?type=term&node=term%3Arun-slots");
    await waitFor(() => expect(calls.map((c) => c.path)).toContain(`/projects/${MAP_PROJECT}/find/open?id=term%3Arun-slots`));
  });

  it("opens a hit with no node where core says it is read", async () => {
    palette("chia slot");
    const issue = within(await screen.findByTestId("find-group-issue")).getByTestId("find-hit");
    fireEvent.click(issue);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/hop/issues/ISS-1255"));
  });

  it("narrows by a facet, sending it with the words", async () => {
    palette("chia slot");
    const facets = await screen.findByTestId("find-facets");
    fireEvent.click(within(facets).getAllByTestId("find-facet-module")[0]);
    await waitFor(() => expect(calls.at(-1)?.body).toEqual({ q: "chia slot", module: ["execution"] }));
    expect(within(facets).getAllByTestId("find-facet-module")[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("reads a search with no hit as a gap", async () => {
    palette("blorp");
    expect((await screen.findByTestId("find-gap")).textContent).toBe("No match · noted as a gap");
  });
});
