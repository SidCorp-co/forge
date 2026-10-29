// ISS-641 (REQ-34 BC-3): the ready checklist replaced the readiness suggestion, so the requirement
// page's developer view no longer reads one as "Readiness advice" beside the criteria, even where a
// readiness suggestion still sits in what the page has read.

import { QueryClient } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuggestionView } from "@/features/suggestions";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import { reqDetail } from "@/test/vi-chrome-requirements";
import { RequirementPage } from "./requirement-detail";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

const PROJECT = "7f1c1d1e-0000-4000-8000-000000000001";

const readiness = {
  id: "s-ready",
  kind: "readiness",
  status: "proposed",
  target: { type: "requirement", id: "r1" },
  baseRevision: 2,
  payload: { checks: [{ check: "has a scope", passed: true }, { check: "has a persona", passed: false }] },
  producerKind: "ba_assistant",
  createdAt: "2026-10-07T10:00:00Z",
} as unknown as SuggestionView;

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the requirement's criteria, in the developer view", () => {
  it("shows the wording's revision and no readiness advice, a readiness suggestion having been read", async () => {
    fakeCore(() => HANG);
    window.history.replaceState(null, "", "/?view=developer");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    client.setQueryData(["requirement", PROJECT, "REQ-1"], reqDetail);
    client.setQueryData(["suggestions", PROJECT, { requirement: "REQ-1" }], { suggestions: [readiness] });
    renderWithQuery(<RequirementPage projectId={PROJECT} slug="hop" reqKey="REQ-1" tab="criteria" onTab={() => {}} />, client);
    const strip = await screen.findByTestId("criteria-developer");
    expect(strip).toHaveTextContent(`r${reqDetail.standing.shownRevision}`);
    expect(screen.queryByTestId("readiness")).toBeNull();
    expect(document.body).not.toHaveTextContent(/Readiness advice|checks met/);
  });
});
