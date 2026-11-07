// Routine approval is a defect (owner, 2026-11-06) and Forge is English only (owner, 2026-10-08), so
// project settings offer no "A person approves/accepts…" switch and no language of their own
// (ISS-1071). The project document keeps what it holds: a project that had a step on still has it,
// read by core's gate profile, and a save of another field writes it back unchanged.
// @direct-test-of packages/web-v2/src/features/project-settings/components/general-section.tsx
// @direct-test-of packages/web-v2/src/features/project-settings/components/delivery-section.tsx

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects";
import { fakeCore } from "@/test/render";
import { Seeded } from "@/test/vi-chrome-requirements";
import { DeliverySettings } from "./delivery-section";
import { GeneralSettings } from "./general-section";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const P = "11111111-1111-4111-8111-111111111111";
const DETAIL = { id: P, slug: "hop", name: "Hop", orgId: "o1", baseBranch: "dev", members: [], labels: [], devicePool: [], archivedAt: null } as unknown as ProjectDetail;
const SCHEMA = "https://forge.sidcorp.co/schemas/project-v1.json";
const STORED = {
  $schema: SCHEMA,
  version: 1,
  project: { name: "Hop" },
  contentLanguage: "vi",
  keepTermsInEnglish: ["checkout"],
  approvals: { designs: true, triage: false },
  plan: { approval: { required: true } },
  release: { approval: { required: true } },
};

/** Every switch or picker the two screens draw, by its accessible name. */
const controls = () => [...screen.queryAllByRole("switch"), ...screen.queryAllByRole("combobox")].map((c) => c.getAttribute("aria-label") ?? c.textContent ?? "");

describe("project settings after the rulings of 2026-11-06 and 2026-10-08", () => {
  it("offer no person-approval switch and no language on General or Delivery", () => {
    render(
      <Seeded data={[[["project", P, "config"], { declared: true, revision: 3, document: STORED }]]}>
        <GeneralSettings project={DETAIL} canEdit />
        <DeliverySettings project={DETAIL} canEdit />
      </Seeded>,
    );
    const text = document.body.textContent ?? "";
    expect(controls().filter((n) => /A person (approves|accepts|agrees|admits)|approves triage/i.test(n))).toEqual([]);
    expect(text).not.toMatch(/A person (approves|accepts|agrees|admits)|Person approves triage/);
    // a plan's approval is a routine one too: no switch for it (ISS-1071 round 2)
    expect(controls().filter((n) => /approv/i.test(n))).toEqual([]);
    expect(text).not.toMatch(/Plans need approval/i);
    expect(text).not.toMatch(/Content language|Keep in English|Keep these terms/i);
    expect(screen.queryByRole("region", { name: /language/i })).toBeNull();
  });

  it("writes the stored approvals and language back unchanged when another field is saved", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET" && c.path === `/projects/${P}/config`) return { body: { declared: true, revision: 4, document: STORED } };
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
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Hop Clinic" } });
    fireEvent.click(within(screen.getByTestId("save-bar")).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({
      baseRevision: 4,
      document: { project: { name: "Hop Clinic" }, contentLanguage: "vi", keepTermsInEnglish: ["checkout"], approvals: { designs: true, triage: false }, plan: { approval: { required: true } }, release: { approval: { required: true } } },
    });
  });
});
