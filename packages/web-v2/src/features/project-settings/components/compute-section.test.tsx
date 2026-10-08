// The live QA of ISS-427 (2026-10-08): no project document held a `compute` key and no settings tab
// showed it, so computation was off only by absence and nobody could see or change it. Advanced now
// carries it: whether the assistant may compute at all, and which sandboxes may take the data, each
// with its effect in a line, saved through the project document's own write at the revision read.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V1Read } from "@/features/project-config/types";
import { type Call, fakeCore } from "@/test/render";
import { ComputeSection } from "./compute-section";

const P = "11111111-1111-4111-8111-111111111111";

const doc = (extra: Record<string, unknown> = {}) => ({
  $schema: "https://forge.sidcorp.co/schemas/project-v1.json",
  version: 1,
  project: { id: P, slug: "hop", name: "Hop" },
  ...extra,
});

function core(read: V1Read): Call[] {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path === `/projects/${P}/config`) return { body: read };
    if (c.method === "PUT" && c.path === `/projects/${P}/config`) {
      return { body: { declared: true, revision: 7, document: (c.body as { document: unknown }).document, created: false } };
    }
    return undefined;
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ComputeSection projectId={P} slug="hop" canEdit />
    </QueryClientProvider>,
  );
}

const toggle = (name: string) => screen.getByRole("switch", { name });

async function save() {
  await act(async () => {
    fireEvent.click(within(screen.getByTestId("save-bar")).getByRole("button", { name: "Save changes" }));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("the compute setting in Advanced", () => {
  it("reads off where the document has no compute key, with each effect in a line and the sandbox choices held", async () => {
    core({ declared: true, revision: 6, document: doc() });
    mount();
    expect(await screen.findByRole("switch", { name: "Computation" })).not.toBeChecked();
    expect(screen.getByText(/run a short script over this project's data in an isolated sandbox/)).toBeInTheDocument();
    expect(screen.getByText(/whose data leaves Forge for a third party/)).toBeInTheDocument();
    expect(screen.getByText(/declares zero data retention/)).toBeInTheDocument();
    expect(toggle("Third-party sandboxes")).toHaveAttribute("aria-disabled", "true");
    expect(toggle("Zero data retention only")).toHaveAttribute("aria-disabled", "true");
  });

  it("turns computation on with a third-party sandbox admitted, saved at the revision read", async () => {
    const calls = core({ declared: true, revision: 6, document: doc() });
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Computation" }));
    fireEvent.click(toggle("Third-party sandboxes"));
    await save();
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body).toMatchObject({ baseRevision: 6, document: { compute: { enabled: true, thirdParty: true } } });
    });
  });

  it("turning it off removes the key where nothing else is set, which core reads as off", async () => {
    const calls = core({ declared: true, revision: 6, document: doc({ compute: { enabled: true } }) });
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Computation" }));
    await save();
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeDefined());
    expect(calls.find((c) => c.method === "PUT")?.body).not.toHaveProperty("document.compute");
    expect(calls.find((c) => c.method === "PUT")?.body).toHaveProperty("document.project.slug", "hop");
  });

  it("turning it off keeps the admitted sandboxes, written enabled: false", async () => {
    const calls = core({ declared: true, revision: 6, document: doc({ compute: { enabled: true, zdrOnly: true } }) });
    mount();
    fireEvent.click(await screen.findByRole("switch", { name: "Computation" }));
    await save();
    await waitFor(() => {
      expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ document: { compute: { enabled: false, zdrOnly: true } } });
    });
  });
});
