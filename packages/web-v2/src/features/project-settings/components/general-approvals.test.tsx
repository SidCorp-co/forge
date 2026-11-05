// REQ-34 r2 BC-25: each step's person gate is a switch on General, off where the document says
// nothing but triage, which is on until a project turns it off (ISS-639), and the readiness choice it
// replaced is gone.
// @direct-test-of packages/web-v2/src/features/project-settings/components/general-section.tsx

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects";
import { fakeCore } from "@/test/render";
import { Seeded } from "@/test/vi-chrome-requirements";
import { GeneralSettings } from "./general-section";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], archivedAt: null } as unknown as ProjectDetail;
const DOC = { $schema: "https://forge.sidcorp.co/schemas/project-v1.json", version: 1, approvals: { designs: true } };

const LABELS = [
  "A person agrees each requirement",
  "A person accepts each requirement revision and re-pin",
  "A person accepts each breakdown",
  "A person admits each new issue",
  "A person accepts each delivered requirement",
  "A person approves each workflow design",
  "Person approves triage",
];
const TRIAGE = "Person approves triage";

describe("the person gates on General", () => {
  it("shows one switch per step, on only where the document turns it on", () => {
    render(
      <Seeded data={[[["project", P, "config"], { declared: true, revision: 3, document: DOC }]]}>
        <GeneralSettings project={DETAIL} canEdit />
      </Seeded>,
    );
    const on = LABELS.map((l) => screen.getByRole("switch", { name: l }).getAttribute("aria-checked"));
    expect(on).toEqual(["false", "false", "false", "false", "false", "true", "true"]);
    expect(screen.queryByText("Requirement readiness check")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: LABELS[0] }));
    expect(screen.getByRole("switch", { name: LABELS[0] }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("the triage gate on General (ISS-639)", () => {
  it("reads on where the document sets nothing, and saves approvals.triage false at the revision read", async () => {
    const bare = { $schema: DOC.$schema, version: 1 };
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === `/projects/${P}/config`) return { body: { declared: true, revision: 4, document: bare } };
      if (c.method === "PUT" && c.path === `/projects/${P}/config`)
        return { body: { declared: true, revision: 5, document: (c.body as { document: unknown }).document, created: false } };
      return undefined;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <GeneralSettings project={DETAIL} canEdit />
      </QueryClientProvider>,
    );
    const triage = await screen.findByRole("switch", { name: TRIAGE });
    expect(triage.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(triage);
    expect(screen.getByRole("switch", { name: TRIAGE }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(screen.getByTestId("save-bar")).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ baseRevision: 4, document: { approvals: { triage: false } } });
  });
});
